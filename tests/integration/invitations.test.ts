import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { authConfig, issuers } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { establishIdentity } from "../../src/server/auth/identities";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import {
  issueInvitation,
  redeemInvitation,
  revokeInvitation,
} from "../../src/server/invitations/service";
import { AppFailure } from "../../src/server/http/security";
import { validDraft } from "../fixtures/draft";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Invitation tests require the disposable test database");
const { pool } = createDatabase();
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
  SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
  SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
})!;
const ids: string[] = [];
before(() => migrate(pool));
after(async () => {
  await pool.query(
    "DELETE FROM app_event_access WHERE account_id=ANY($1::uuid[]) OR event_id IN (SELECT id FROM app_events WHERE owner_id=ANY($1::uuid[]))",
    [ids],
  );
  await pool.query("DELETE FROM app_invitations WHERE issuer_id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM app_events WHERE owner_id=ANY($1::uuid[])", [ids]);
  for (const table of ["app_mutations", "app_audit", "app_roles", "app_identities", "app_sessions"])
    await pool.query(
      `DELETE FROM ${table} WHERE ${["app_audit", "app_mutations"].includes(table) ? "actor_id" : "account_id"}=ANY($1::uuid[])`,
      [ids],
    );
  await pool.query("DELETE FROM app_accounts WHERE id=ANY($1::uuid[])", [ids]);
  await pool.end();
});

async function account(role?: "host" | "admin") {
  const result = await establishIdentity(pool, config, "google", {
    issuer: issuers.google,
    subject: randomUUID(),
  });
  ids.push(result.accountId);
  if (role)
    await pool.query("INSERT INTO app_roles (account_id,role) VALUES ($1,$2)", [
      result.accountId,
      role,
    ]);
  return { id: result.accountId, session: hash(result.value) };
}
function capability(url: string) {
  return new URL(url).hash.slice(1);
}
const status = (expected: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === expected;

test("only admin issues host links; concurrent retries return one encrypted durable link", async () => {
  const admin = await account("admin");
  const host = await account("host");
  const attendee = await account();
  for (const actor of [host, attendee])
    await assert.rejects(
      issueInvitation(pool, config, actor.session, randomUUID(), { kind: "host" }),
      status(403),
    );
  const operation = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      issueInvitation(pool, config, admin.session, operation, { kind: "host" }),
    ),
  );
  assert.ok(
    results.every((result) => result.url === results[0].url && result.id === results[0].id),
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM app_invitations WHERE issuer_id=$1", [admin.id])).rowCount,
    1,
  );
  const remaining = Date.parse(results[0].expiresAt) - Date.now();
  assert.ok(remaining > 15 * 86400000 - 10000 && remaining <= 15 * 86400000);
  const stored = await pool.query(
    "SELECT encrypted_receipt FROM app_mutations WHERE operation_id=$1",
    [operation],
  );
  assert.equal(stored.rows[0].encrypted_receipt.includes(capability(results[0].url)), false);
  await assert.rejects(
    issueInvitation(pool, config, host.session, operation, { kind: "host" }),
    status(409),
  );
});

test("redemption races bind exactly one account and surviving access is independent of expiry", async () => {
  const admin = await account("admin");
  const one = await account();
  const two = await account();
  const invitation = await issueInvitation(pool, config, admin.session, randomUUID(), {
    kind: "host",
  });
  const value = capability(invitation.url);
  await assert.rejects(
    redeemInvitation(pool, config, one.session, randomUUID(), value, false),
    status(400),
  );
  const outcomes = await Promise.allSettled(
    [one, two].map((actor) =>
      redeemInvitation(pool, config, actor.session, randomUUID(), value, true),
    ),
  );
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const row = (
    await pool.query("SELECT redeemed_by FROM app_invitations WHERE id=$1", [invitation.id])
  ).rows[0];
  const winner = row.redeemed_by === one.id ? one : two;
  const loser = row.redeemed_by === one.id ? two : one;
  assert.equal(
    (
      await pool.query(
        "SELECT account_id FROM app_roles WHERE role='host' AND account_id=ANY($1::uuid[])",
        [[one.id, two.id]],
      )
    ).rowCount,
    1,
  );
  await pool.query(
    "UPDATE app_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [invitation.id],
  );
  assert.equal(
    (await redeemInvitation(pool, config, winner.session, randomUUID(), value, true)).granted,
    true,
  );
  await assert.rejects(
    redeemInvitation(pool, config, loser.session, randomUUID(), value, true),
    status(409),
  );
  await assert.rejects(
    revokeInvitation(pool, config, admin.session, randomUUID(), invitation.id),
    status(409),
  );
});

test("expired/revoked unused links never grant a role and revocation respects scope", async () => {
  const admin = await account("admin");
  const person = await account();
  const expired = await issueInvitation(pool, config, admin.session, randomUUID(), {
    kind: "host",
  });
  await pool.query(
    "UPDATE app_invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  await assert.rejects(
    redeemInvitation(pool, config, person.session, randomUUID(), capability(expired.url), true),
    status(410),
  );
  const revoked = await issueInvitation(pool, config, admin.session, randomUUID(), {
    kind: "host",
  });
  await assert.rejects(
    revokeInvitation(pool, config, person.session, randomUUID(), revoked.id),
    status(403),
  );
  const operation = randomUUID();
  await revokeInvitation(pool, config, admin.session, operation, revoked.id);
  assert.equal(
    (await revokeInvitation(pool, config, admin.session, operation, revoked.id)).revoked,
    true,
  );
  await assert.rejects(
    redeemInvitation(pool, config, person.session, randomUUID(), capability(revoked.url), true),
    status(410),
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM app_roles WHERE account_id=$1", [person.id])).rowCount,
    0,
  );
});

test("event grants bind one event/account, expire at close, preserve closed access and reserve no seats", async () => {
  const host = await account("host");
  const outsider = await account("host");
  const attendee = await account();
  const eventId = randomUUID();
  const data = validDraft();
  // Explicit engineering fixture. The application cannot publish without protocol proofs.
  await pool.query(
    `INSERT INTO app_events (id,owner_id,revision,data,state,rules_hash,published_at,registration_closes_at)
    VALUES ($1,$2,1,$3,'published','fixture-not-qualified',clock_timestamp(),$4)`,
    [eventId, host.id, data, data.startsAt],
  );
  await assert.rejects(
    issueInvitation(pool, config, outsider.session, randomUUID(), { kind: "event", eventId }),
    status(404),
  );
  const invite = await issueInvitation(pool, config, host.session, randomUUID(), {
    kind: "event",
    eventId,
  });
  assert.equal(invite.expiresAt, data.startsAt);
  const result = await redeemInvitation(
    pool,
    config,
    attendee.session,
    randomUUID(),
    capability(invite.url),
    true,
  );
  assert.equal(result.eventId, eventId);
  const grant = await pool.query(
    "SELECT event_id,account_id FROM app_event_access WHERE account_id=$1",
    [attendee.id],
  );
  assert.deepEqual(grant.rows, [{ event_id: eventId, account_id: attendee.id }]);
  await pool.query(
    "UPDATE app_events SET state='closed',registration_closes_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [eventId],
  );
  assert.equal(
    (
      await redeemInvitation(
        pool,
        config,
        attendee.session,
        randomUUID(),
        capability(invite.url),
        true,
      )
    ).granted,
    true,
  );
  await assert.rejects(
    issueInvitation(pool, config, host.session, randomUUID(), { kind: "event", eventId }),
    status(409),
  );
});

test("session revocation and role loss are rechecked at the durable mutation boundary", async () => {
  const actor = await account("admin");
  await pool.query("DELETE FROM app_roles WHERE account_id=$1", [actor.id]);
  await assert.rejects(
    issueInvitation(pool, config, actor.session, randomUUID(), { kind: "host" }),
    status(403),
  );
  await pool.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [
    actor.session,
  ]);
  await assert.rejects(
    issueInvitation(pool, config, actor.session, randomUUID(), { kind: "host" }),
    status(401),
  );
});
