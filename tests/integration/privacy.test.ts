import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { authConfig, issuers } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { establishIdentity } from "../../src/server/auth/identities";
import { findSession } from "../../src/server/auth/sessions";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { AppFailure } from "../../src/server/http/security";
import { findPrivacySession } from "../../src/server/privacy/access";
import { exportOwnData } from "../../src/server/privacy/export";
import { ownDeletionRequest, requestAccountDeletion } from "../../src/server/privacy/deletion";
import { issueWalletChallenge } from "../../src/server/wallets/service";
import { validDraft } from "../fixtures/draft";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Privacy checks require the disposable test database");
const { pool } = createDatabase(),
  accounts: string[] = [],
  operations: string[] = [];
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
  SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
  SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
})!;
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
before(() => migrate(pool));
after(async () => {
  await pool.query("DELETE FROM processed_operations WHERE operation_id=ANY($1::uuid[])", [
    operations,
  ]);
  await pool.query("DELETE FROM outbox WHERE operation_id=ANY($1::uuid[])", [operations]);
  await pool.query("DELETE FROM app_events WHERE owner_id=ANY($1::uuid[])", [accounts]);
  for (const table of ["app_mutations", "app_audit", "app_roles", "app_identities", "app_sessions"])
    await pool.query(
      `DELETE FROM ${table} WHERE ${["app_mutations", "app_audit"].includes(table) ? "actor_id" : "account_id"}=ANY($1::uuid[])`,
      [accounts],
    );
  await pool.query("DELETE FROM app_deletion_requests WHERE account_id=ANY($1::uuid[])", [
    accounts,
  ]);
  await pool.query("DELETE FROM app_accounts WHERE id=ANY($1::uuid[])", [accounts]);
  await pool.end();
});
async function account() {
  const subject = randomUUID(),
    result = await establishIdentity(pool, config, "telegram", {
      issuer: issuers.telegram,
      subject,
    });
  accounts.push(result.accountId);
  return { ...result, subject, session: hash(result.value) };
}

test("deletion request migration rolls back and rejects a completed request that still holds obligations", async () => {
  const owner = await account(),
    client = await pool.connect(),
    schema = `privacy_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query(await readFile("migrations/011-account-deletion-requests.sql", "utf8"));
    await client.query("SAVEPOINT invalid_completion");
    await assert.rejects(
      client.query(
        `INSERT INTO app_deletion_requests(account_id,id,operation_id,completed_at,hold_reasons)
      VALUES ($1,$2,$3,clock_timestamp(),ARRAY['financial_reconciliation'])`,
        [owner.accountId, randomUUID(), randomUUID()],
      ),
      (error) => (error as { code: string }).code === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_completion");
    assert.equal(
      (await client.query("SELECT count(*) FROM app_deletion_requests")).rows[0].count,
      "0",
    );
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query("SELECT to_regnamespace($1) AS schema", [schema])).rows[0].schema,
      null,
    );
    assert.equal(
      Boolean(
        (await pool.query("SELECT to_regclass('public.app_accounts') AS relation")).rows[0]
          .relation,
      ),
      true,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("confirmed deletion clears an unfunded account atomically and cannot remove another account", async () => {
  const owner = await account(),
    other = await account(),
    operationId = randomUUID();
  await pool.query("INSERT INTO app_roles(account_id,role) VALUES ($1,'host')", [owner.accountId]);
  const saveId = randomUUID();
  operations.push(saveId);
  await saveAccountDraft(pool, config.encryptionKey, owner.session, {
    id: randomUUID(),
    operationId: saveId,
    revision: 0,
    data: validDraft(),
  });
  await issueWalletChallenge(pool, config, owner.session, {
    operationId: randomUUID(),
    network: "near",
    address: "fictional.near",
  });
  await assert.rejects(
    requestAccountDeletion(pool, owner.session, {
      operationId,
      confirmation: "delete",
      acknowledgeOnChain: true,
    }),
    status(400),
  );
  assert.equal((await findSession(pool, owner.value))!.accountId, owner.accountId);
  const result = await requestAccountDeletion(pool, owner.session, {
    operationId,
    confirmation: "DELETE",
    acknowledgeOnChain: true,
  });
  assert.equal(result.state, "completed");
  assert.equal(result.sessionValue, null);
  assert.equal(await findPrivacySession(pool, owner.value), null);
  await assert.rejects(exportOwnData(pool, config, owner.session), status(401));
  for (const table of [
    "app_identities",
    "app_sessions",
    "app_wallet_challenges",
    "app_wallets",
    "app_roles",
    "app_event_credentials",
  ])
    assert.equal(
      (await pool.query(`SELECT count(*) FROM ${table} WHERE account_id=$1`, [owner.accountId]))
        .rows[0].count,
      "0",
    );
  assert.equal(
    (await pool.query("SELECT count(*) FROM app_events WHERE owner_id=$1", [owner.accountId]))
      .rows[0].count,
    "0",
  );
  assert.equal((await findPrivacySession(pool, other.value))!.accountId, other.accountId);
  await assert.rejects(
    requestAccountDeletion(pool, other.session, {
      operationId,
      confirmation: "DELETE",
      acknowledgeOnChain: true,
    }),
    status(409),
  );
  assert.equal((await findSession(pool, other.value))!.accountId, other.accountId);
  const fresh = await establishIdentity(pool, config, "telegram", {
    issuer: issuers.telegram,
    subject: owner.subject,
  });
  accounts.push(fresh.accountId);
  assert.notEqual(fresh.accountId, owner.accountId);
  assert.equal(fresh.recoveryOnly, false);
});

test("published obligations retain restricted sign-in, export and original event records while normal authority stays disabled", async () => {
  const owner = await account(),
    saveId = randomUUID(),
    eventId = randomUUID();
  operations.push(saveId);
  await pool.query("INSERT INTO app_roles(account_id,role) VALUES ($1,'host')", [owner.accountId]);
  await saveAccountDraft(pool, config.encryptionKey, owner.session, {
    id: eventId,
    operationId: saveId,
    revision: 0,
    data: validDraft(),
  });
  // Published engineering fixture only; this is not attributable funded publication.
  const otherSession = await establishIdentity(pool, config, "telegram", {
    issuer: issuers.telegram,
    subject: owner.subject,
  });
  await pool.query(
    "UPDATE app_events SET state='published',rules_hash=$2,published_at=clock_timestamp() WHERE id=$1",
    [eventId, "a".repeat(64)],
  );
  const result = await requestAccountDeletion(pool, owner.session, {
    operationId: randomUUID(),
    confirmation: "DELETE",
    acknowledgeOnChain: true,
  });
  assert.equal(result.state, "pending_reconciliation");
  assert.deepEqual(result.holdReasons, ["published_event_obligations"]);
  assert.equal(Boolean(result.sessionValue), true);
  assert.equal(await findPrivacySession(pool, owner.value), null);
  assert.equal(await findPrivacySession(pool, otherSession.value), null);
  const restored = await establishIdentity(pool, config, "telegram", {
    issuer: issuers.telegram,
    subject: owner.subject,
  });
  assert.equal(restored.accountId, owner.accountId);
  assert.equal(restored.recoveryOnly, true);
  assert.equal(await findSession(pool, restored.value), null);
  const session = hash(restored.value);
  assert.equal((await ownDeletionRequest(pool, session))!.id, result.id);
  const exported = await exportOwnData(pool, config, session);
  assert.equal(exported.hostedEvents[0].id, eventId);
  assert.deepEqual(exported.roles, []);
  assert.equal(exported.deletionRequest.id, result.id);
  const replay = await requestAccountDeletion(pool, session, {
    operationId: randomUUID(),
    confirmation: "DELETE",
    acknowledgeOnChain: true,
  });
  assert.equal(replay.id, result.id);
  assert.equal(replay.sessionValue, null);
  await assert.rejects(
    establishIdentity(
      pool,
      config,
      "google",
      { issuer: issuers.google, subject: randomUUID() },
      session,
      session,
    ),
    status(401),
  );
  await assert.rejects(
    saveAccountDraft(pool, config.encryptionKey, session, {
      id: randomUUID(),
      operationId: randomUUID(),
      revision: 0,
      data: validDraft(),
    }),
    status(401),
  );
});

test("own export includes private authored answers while excluding other accounts and authentication material", async () => {
  const owner = await account(),
    other = await account();
  await pool.query("INSERT INTO app_roles(account_id,role) VALUES ($1,'host')", [owner.accountId]);
  const draft = validDraft();
  draft.quizzes = [
    {
      question: "Fictional private question",
      type: "short",
      options: [],
      correctOption: 0,
      aliases: ["private author answer"],
      plannedAt: new Date(Date.parse(draft.startsAt) + 900_000).toISOString(),
      durationSeconds: 90,
    },
  ];
  const operationId = randomUUID();
  operations.push(operationId);
  await saveAccountDraft(pool, config.encryptionKey, owner.session, {
    id: randomUUID(),
    operationId,
    revision: 0,
    data: draft,
  });
  const exported = await exportOwnData(pool, config, owner.session);
  assert.equal(exported.account.id, owner.accountId);
  assert.equal(exported.linkedIdentities[0].subject, owner.subject);
  assert.deepEqual(exported.hostedEvents[0].data.quizzes[0].aliases, ["private author answer"]);
  assert.deepEqual((await exportOwnData(pool, config, other.session)).hostedEvents, []);
  const json = JSON.stringify(exported);
  for (const value of [other.accountId, other.subject, owner.value, owner.session])
    assert.equal(json.includes(value), false);
  for (const field of ["token_hash", "identity_hash", "encrypted_identity", "encrypted_receipt"])
    assert.equal(json.includes(field), false);
});

test("restricted deletion-state reads cannot regain normal authority, and disabled/revoked sessions cannot export", async () => {
  const owner = await account();
  await pool.query("UPDATE app_accounts SET state='deletion_requested' WHERE id=$1", [
    owner.accountId,
  ]);
  assert.equal(await findSession(pool, owner.value), null);
  assert.equal((await findPrivacySession(pool, owner.value))!.state, "deletion_requested");
  assert.equal(
    (await exportOwnData(pool, config, owner.session)).account.state,
    "deletion_requested",
  );
  await assert.rejects(
    issueWalletChallenge(pool, config, owner.session, {
      operationId: randomUUID(),
      network: "near",
      address: "fictional.near",
    }),
    status(401),
  );
  await pool.query("UPDATE app_accounts SET state='disabled' WHERE id=$1", [owner.accountId]);
  assert.equal(await findPrivacySession(pool, owner.value), null);
  await assert.rejects(exportOwnData(pool, config, owner.session), status(401));
  await pool.query("UPDATE app_accounts SET state='active' WHERE id=$1", [owner.accountId]);
  await pool.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [
    owner.session,
  ]);
  await assert.rejects(exportOwnData(pool, config, owner.session), status(401));
});
