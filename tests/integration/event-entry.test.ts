import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { readEventEntry } from "../../src/server/events/entry";
import { issueInvitation, redeemInvitation } from "../../src/server/invitations/service";
import { AppFailure } from "../../src/server/http/security";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";
import { v1EventFixture } from "../fixtures/v1-event";

test("event progress uses the viewer's verified receipt and hides it from other viewers", async () => {
  const f = await v1EventFixture();
  try {
    const read = (session?: string) =>
      readEventEntry(f.pool, f.config, f.eventId, session, f.transport, true);
    assert.equal((await read()).progress, undefined);
    assert.equal((await read(f.sessions[0])).progress, undefined);
    assert.deepEqual((await read(f.sessions[1])).progress, {
      registered: true,
      funded: true,
      attended: false,
      paid: false,
      ended: false,
      cancelled: false,
    });
    f.registrations.get(f.ids[0])!.attended = true;
    assert.equal((await read(f.sessions[1])).progress!.attended, true);
    assert.equal((await read(f.sessions[2])).progress!.attended, false);
    f.event().status = "cancelled";
    f.claims.set(f.ids[0], {
      recipient: "attendee-1.near",
      remaining: "1000000",
      paid: "0",
      pending: false,
      in_flight: "0",
    });
    assert.equal((await read(f.sessions[1])).progress!.paid, false);
    f.claims.set(f.ids[0], {
      recipient: "attendee-1.near",
      remaining: "0",
      paid: "1000000",
      pending: false,
      in_flight: "0",
    });
    const refunded = (await read(f.sessions[1])).progress!;
    assert.equal(refunded.paid, true);
    assert.equal(refunded.cancelled, true);
    await f.pool.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [
      f.sessions[1],
    ]);
    assert.equal((await read(f.sessions[1])).progress, undefined);
  } finally {
    await f.cleanup();
  }
});

test("published event entry exposes public terms, preserves private invitation access and excludes answers and account identifiers", async () => {
  const f = await accountFixtures([["host"], [], []]),
    id = randomUUID();
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  })!;
  const host = hash(f.accounts[0].value),
    attendee = hash(f.accounts[1].value),
    foreign = hash(f.accounts[2].value);
  try {
    const data = { ...validDraft(), access: "invitation" as const };
    await saveAccountDraft(f.pool, config.encryptionKey, host, {
      id,
      operationId: randomUUID(),
      revision: 0,
      data,
    });
    const missing = (error: unknown) => error instanceof AppFailure && error.status === 404;
    await assert.rejects(readEventEntry(f.pool, config, id, host), missing);
    // Published-state engineering fixture only; no route/funding is qualified.
    await f.pool.query(
      "UPDATE app_events SET state='published',rules_hash=$2,published_at=clock_timestamp() WHERE id=$1",
      [id, "a".repeat(64)],
    );
    await assert.rejects(readEventEntry(f.pool, config, id), missing);
    const invitation = await issueInvitation(f.pool, config, host, randomUUID(), {
      kind: "event",
      eventId: id,
    });
    await redeemInvitation(
      f.pool,
      config,
      attendee,
      randomUUID(),
      new URL(invitation.url).hash.slice(1),
      true,
    );
    const entry = await readEventEntry(f.pool, config, id, attendee);
    assert.equal(entry.viewer, "attendee");
    assert.equal(entry.registration, "verification_required");
    assert.equal(entry.data.title, data.title);
    const publicData = JSON.stringify(entry);
    for (const account of f.accounts) assert.equal(publicData.includes(account.id), false);
    assert.equal(Object.hasOwn(entry.data, "quizzes"), false);
    assert.equal(Object.hasOwn(entry.data, "nft"), false);
    await assert.rejects(readEventEntry(f.pool, config, id, foreign), missing);
    await f.pool.query(
      "UPDATE app_events SET data=jsonb_set(data,'{access}','\"open\"'),state='closed' WHERE id=$1",
      [id],
    );
    const closed = await readEventEntry(f.pool, config, id);
    assert.equal(closed.registration, "closed");
    assert.equal(closed.viewer, "anonymous");
    assert.equal(closed.hostAlias, entry.hostAlias);
  } finally {
    await f.cleanup();
  }
});
