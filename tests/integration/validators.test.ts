import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { authConfig, issuers } from "../../src/server/auth/config";
import { establishIdentity } from "../../src/server/auth/identities";
import { hash, unseal } from "../../src/server/auth/crypto";
import { duplicateAccountEvent, saveAccountDraft } from "../../src/server/events/accounts";
import { readEventValidators, removeEventValidator } from "../../src/server/events/validators";
import { issueInvitation, redeemInvitation } from "../../src/server/invitations/service";
import { inspectInvitation } from "../../src/server/invitations/pending";
import { prepareCommitmentConsent } from "../../src/server/commitments/service";
import { AppFailure } from "../../src/server/http/security";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { exportOwnData } from "../../src/server/privacy/export";
import { accountFixtures } from "../fixtures/accounts";
import { financialFixtures } from "../fixtures/financial-records";
import { confirmedDeletion } from "../fixtures/deletion";
import { validDraft } from "../fixtures/draft";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Validator checks require disposable test data");
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
  SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
  SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
})!;
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
const capability = (url: string) => new URL(url).hash.slice(1);

async function fixtures() {
  const f = await accountFixtures([["host"], [], [], ["host"], ["admin"]]);
  // Verified-claim fixtures only, not live OIDC. Real encrypted identity rows
  // make deletion checks prove erasure rather than start from empty tables.
  for (const index of [0, 1, 3]) {
    const session = hash(f.accounts[index].value);
    const linked = await establishIdentity(
      f.pool,
      config,
      "telegram",
      { issuer: issuers.telegram, subject: randomUUID() },
      session,
      session,
    );
    assert.equal(linked.accountId === f.accounts[index].id, true);
    f.accounts[index].value = linked.value;
  }
  const eventId = randomUUID(),
    data = { ...validDraft(), mode: "physical" as const, venue: "Fictional test venue" },
    session = hash(f.accounts[0].value),
    operations = [randomUUID()];
  await saveAccountDraft(f.pool, config.encryptionKey, session, {
    id: eventId,
    revision: 0,
    operationId: operations[0],
    data,
  });
  return {
    ...f,
    eventId,
    data,
    session,
    operations,
    cleanup: async () => {
      await f.pool.query("DELETE FROM processed_operations WHERE operation_id=ANY($1::uuid[])", [
        operations,
      ]);
      await f.pool.query("DELETE FROM outbox WHERE operation_id=ANY($1::uuid[])", [operations]);
      await f.cleanup();
    },
    issue: () =>
      issueInvitation(f.pool, config, session, randomUUID(), { kind: "validator", eventId }),
    redeem: (url: string, account = 1, operation = randomUUID()) =>
      redeemInvitation(
        f.pool,
        config,
        hash(f.accounts[account].value),
        operation,
        capability(url),
        true,
      ),
    publish: () =>
      f.pool.query(
        "UPDATE app_events SET state='published',rules_hash='engineering-validator-fixture',published_at=clock_timestamp() WHERE id=$1",
        [eventId],
      ),
  };
}

test("validator grants are event-scoped, explicit and stable across retries without global or financial authority", async () => {
  const f = await fixtures();
  try {
    const invitation = await f.issue(),
      details = await inspectInvitation(f.pool, capability(invitation.url)),
      operation = randomUUID();
    assert.equal(details.eventTitle, f.data.title);
    assert.equal(details.startsAt, f.data.startsAt);
    await assert.rejects(
      redeemInvitation(
        f.pool,
        config,
        hash(f.accounts[1].value),
        randomUUID(),
        capability(invitation.url),
        false,
      ),
      status(400),
    );
    const results = await Promise.all([
      f.redeem(invitation.url, 1, operation),
      f.redeem(invitation.url, 1, operation),
    ]);
    assert.deepEqual(results[0], results[1]);
    const roster = await readEventValidators(f.pool, f.session, f.eventId);
    assert.equal(roster.revision, 2);
    assert.equal(roster.frozen, false);
    assert.equal(roster.validators.length, 1);
    assert.match(roster.validators[0].alias, /^Validator [0-9a-f]{16}$/);
    for (const account of f.accounts)
      assert.equal(JSON.stringify(roster.validators).includes(account.id), false);
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_roles WHERE account_id=$1", [f.accounts[1].id]))
        .rowCount,
      0,
    );
    await assert.rejects(f.redeem(invitation.url, 2), status(409));
    await assert.rejects(
      readEventValidators(f.pool, hash(f.accounts[3].value), f.eventId),
      status(404),
    );
    await assert.rejects(
      readEventValidators(f.pool, hash(f.accounts[1].value), f.eventId),
      status(403),
    );
    assert.equal(
      (await readEventValidators(f.pool, hash(f.accounts[4].value), f.eventId)).validators.length,
      1,
    );
    const credentials = (
      await f.pool.query(
        "SELECT account_id,encrypted_credential FROM app_event_credentials WHERE event_id=$1",
        [f.eventId],
      )
    ).rows;
    assert.equal(credentials.length, 2);
    const duplicateOperation = randomUUID();
    f.operations.push(duplicateOperation);
    const copy = await duplicateAccountEvent(
      f.pool,
      config.encryptionKey,
      f.session,
      duplicateOperation,
      f.eventId,
    );
    const ownerCredential = credentials.find((row) => row.account_id === f.accounts[0].id);
    const copiedCredential = (
      await f.pool.query(
        "SELECT encrypted_credential FROM app_event_credentials WHERE event_id=$1 AND account_id=$2",
        [copy.id, f.accounts[0].id],
      )
    ).rows[0];
    assert.equal(Boolean(copiedCredential), true);
    assert.equal(
      unseal(
        config.encryptionKey,
        `event-credential:${f.accounts[0].id}:${copy.id}`,
        copiedCredential.encrypted_credential,
      ) !==
        unseal(
          config.encryptionKey,
          `event-credential:${f.accounts[0].id}:${f.eventId}`,
          ownerCredential.encrypted_credential,
        ),
      true,
    );
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_event_validators WHERE event_id=$1", [copy.id]))
        .rowCount,
      0,
    );
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_invitations WHERE event_id=$1", [copy.id])).rowCount,
      0,
    );
    const staff = credentials.find((row) => row.account_id === f.accounts[1].id);
    const credential = unseal(
      config.encryptionKey,
      `event-credential:${f.accounts[1].id}:${f.eventId}`,
      staff.encrypted_credential,
    );
    const removal = await removeEventValidator(f.pool, config.encryptionKey, f.session, {
      eventId: f.eventId,
      validatorId: roster.validators[0].id,
      operationId: randomUUID(),
    });
    assert.equal(removal.revision, 3);
    await assert.rejects(f.redeem(invitation.url), status(410));
    const fresh = await f.issue();
    await f.redeem(fresh.url);
    const again = await readEventValidators(f.pool, f.session, f.eventId);
    assert.equal(again.validators[0].alias, roster.validators[0].alias);
    assert.equal(again.revision, 4);
    const after = (
      await f.pool.query(
        "SELECT encrypted_credential FROM app_event_credentials WHERE event_id=$1 AND account_id=$2",
        [f.eventId, f.accounts[1].id],
      )
    ).rows[0];
    assert.equal(
      unseal(
        config.encryptionKey,
        `event-credential:${f.accounts[1].id}:${f.eventId}`,
        after.encrypted_credential,
      ),
      credential,
    );
    await assert.rejects(
      saveAccountDraft(f.pool, config.encryptionKey, f.session, {
        id: f.eventId,
        revision: 1,
        operationId: randomUUID(),
        data: f.data,
      }),
      status(409),
    );
  } finally {
    await f.cleanup();
  }
});

test("publication freezes assignments and closes unused draft validator invitations", async () => {
  const f = await fixtures();
  try {
    const accepted = await f.issue(),
      unused = await f.issue();
    await f.redeem(accepted.url);
    const roster = await readEventValidators(f.pool, f.session, f.eventId);
    await f.publish();
    await assert.rejects(f.issue(), status(409));
    await assert.rejects(f.redeem(unused.url, 2), status(410));
    await assert.rejects(
      removeEventValidator(f.pool, config.encryptionKey, f.session, {
        eventId: f.eventId,
        validatorId: roster.validators[0].id,
        operationId: randomUUID(),
      }),
      status(409),
    );
    assert.equal((await readEventValidators(f.pool, f.session, f.eventId)).frozen, true);
    assert.equal((await f.redeem(accepted.url)).granted, true);
  } finally {
    await f.cleanup();
  }
});

test("approved commitment records prevent validator promotion and assigned validators cannot prepare new commitments", async () => {
  process.env.SHOWUP_E2E_ENCRYPTION_KEY = config.encryptionKey;
  process.env.SHOWUP_E2E_INDEX_KEY = config.indexKey;
  const f = await financialFixtures();
  try {
    const eventId = f.consent.terms.event,
      host = hash(f.accounts[1].value);
    await f.pool.query(
      "UPDATE app_events SET state='draft',rules_hash=NULL,published_at=NULL WHERE id=$1",
      [eventId],
    );
    const invitation = await issueInvitation(f.pool, config, host, randomUUID(), {
      kind: "validator",
      eventId,
    });
    await assert.rejects(
      redeemInvitation(
        f.pool,
        config,
        hash(f.accounts[0].value),
        randomUUID(),
        capability(invitation.url),
        true,
      ),
      status(409),
    );
    await redeemInvitation(
      f.pool,
      config,
      hash(f.accounts[2].value),
      randomUUID(),
      capability(invitation.url),
      true,
    );
    await f.pool.query(
      "UPDATE app_events SET state='published',rules_hash=$2,published_at=clock_timestamp() WHERE id=$1",
      [eventId, f.consent.terms.rulesHash],
    );
    const { registration, participant, reservationExpiresAt, ...terms } = f.consent.terms;
    void registration;
    void participant;
    void reservationExpiresAt;
    await assert.rejects(
      prepareCommitmentConsent(f.pool, config, hash(f.accounts[2].value), {
        operationId: randomUUID(),
        terms,
        wallets: { source: randomUUID(), refund: randomUUID(), payout: randomUUID() },
      }),
      status(403),
    );
  } finally {
    await f.cleanup();
  }
});

test("draft deletion cascades staff grants and credentials without keeping off-chain identity", async () => {
  const f = await fixtures();
  try {
    await f.redeem((await f.issue()).url);
    const own = await exportOwnData(f.pool, config, hash(f.accounts[1].value));
    assert.equal(own.validatorAssignments.length, 1);
    assert.equal(own.hostedValidators.length, 0);
    const deleted = await requestAccountDeletion(
      f.pool,
      config,
      f.session,
      confirmedDeletion(config, f.accounts[0].id, f.session),
    );
    assert.equal(deleted.state, "completed");
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_identities WHERE account_id=$1", [f.accounts[0].id]))
        .rowCount,
      0,
    );
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_identities WHERE account_id=$1", [f.accounts[1].id]))
        .rowCount,
      1,
    );
    for (const table of ["app_event_validators", "app_event_credentials", "app_invitations"])
      assert.equal(
        (await f.pool.query(`SELECT 1 FROM ${table} WHERE event_id=$1`, [f.eventId])).rowCount,
        0,
      );
  } finally {
    await f.cleanup();
  }
});

test("validator deletion removes draft authority but retains only fixed published exclusion metadata", async () => {
  for (const published of [false, true]) {
    const f = await fixtures();
    try {
      await f.redeem((await f.issue()).url);
      if (published) await f.publish();
      const session = hash(f.accounts[1].value);
      assert.equal(
        (await f.pool.query("SELECT 1 FROM app_identities WHERE account_id=$1", [f.accounts[1].id]))
          .rowCount,
        1,
      );
      const deleted = await requestAccountDeletion(
        f.pool,
        config,
        session,
        confirmedDeletion(config, f.accounts[1].id, session),
      );
      assert.equal(deleted.state, "completed");
      assert.equal(
        (await f.pool.query("SELECT 1 FROM app_identities WHERE account_id=$1", [f.accounts[1].id]))
          .rowCount,
        0,
      );
      const roster = await readEventValidators(f.pool, f.session, f.eventId);
      assert.equal(roster.validators.length, published ? 1 : 0);
      if (published) assert.equal(roster.validators[0].available, false);
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM app_event_credentials WHERE event_id=$1 AND account_id=$2",
            [f.eventId, f.accounts[1].id],
          )
        ).rowCount,
        published ? 1 : 0,
      );
      assert.equal(
        (await f.pool.query("SELECT 1 FROM app_sessions WHERE account_id=$1", [f.accounts[1].id]))
          .rowCount,
        0,
      );
      assert.equal(roster.revision, published ? 2 : 3);
    } finally {
      await f.cleanup();
    }
  }
});

test("validator schema upgrades legacy invitation scopes transactionally and rolls back", async () => {
  const f = await fixtures(),
    client = await f.pool.connect(),
    schema = `validators_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query("CREATE TABLE app_accounts(id uuid PRIMARY KEY)");
    await client.query(await readFile("migrations/004-invitations-events.sql", "utf8"));
    await client.query(await readFile("migrations/009-event-participant-credentials.sql", "utf8"));
    await client.query(await readFile("migrations/014-event-validators.sql", "utf8"));
    const constraint = (
      await client.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='app_invitations'::regclass AND conname='invitation_kind'",
      )
    ).rows[0].definition;
    assert.equal(constraint.includes("validator"), true);
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query("SELECT to_regnamespace($1) AS schema", [schema])).rows[0].schema,
      null,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await f.cleanup();
  }
});

test("validator redemption waiting for the event cannot hold the invitation against its event writer", async () => {
  const f = await fixtures(),
    held = await f.pool.connect();
  let redeeming: ReturnType<typeof f.redeem> | undefined;
  try {
    const invitation = await f.issue();
    await held.query("BEGIN");
    await held.query("SELECT 1 FROM app_events WHERE id=$1 FOR UPDATE", [f.eventId]);
    const pid = (await held.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    redeeming = f.redeem(invitation.url);
    const deadline = Date.now() + 2000;
    let blocked = false;
    while (Date.now() < deadline) {
      blocked = Boolean(
        (
          await f.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND $1=ANY(pg_blocking_pids(pid))",
            [pid],
          )
        ).rowCount,
      );
      if (blocked) break;
      await setTimeout(10);
    }
    assert.equal(blocked, true, "Redemption did not reach the controlled event lock");
    await held.query("SET LOCAL lock_timeout='250ms'");
    await held.query("SELECT 1 FROM app_invitations WHERE id=$1 FOR UPDATE", [invitation.id]);
    await held.query("ROLLBACK");
    assert.equal((await redeeming).granted, true);
  } finally {
    await held.query("ROLLBACK");
    held.release();
    await redeeming;
    await f.cleanup();
  }
});

test("two hosts deleting drafts while assigned to each other's event finish without retaining identities or grants", async () => {
  const f = await fixtures();
  try {
    const otherEvent = randomUUID(),
      operation = randomUUID(),
      otherSession = hash(f.accounts[3].value);
    f.operations.push(operation);
    await saveAccountDraft(f.pool, config.encryptionKey, otherSession, {
      id: otherEvent,
      revision: 0,
      operationId: operation,
      data: f.data,
    });
    await f.redeem((await f.issue()).url, 3);
    const invitation = await issueInvitation(f.pool, config, otherSession, randomUUID(), {
      kind: "validator",
      eventId: otherEvent,
    });
    await redeemInvitation(
      f.pool,
      config,
      f.session,
      randomUUID(),
      capability(invitation.url),
      true,
    );
    const results = await Promise.all([
      requestAccountDeletion(
        f.pool,
        config,
        f.session,
        confirmedDeletion(config, f.accounts[0].id, f.session),
      ),
      requestAccountDeletion(
        f.pool,
        config,
        otherSession,
        confirmedDeletion(config, f.accounts[3].id, otherSession),
      ),
    ]);
    assert.deepEqual(
      results.map((result) => result.state),
      ["completed", "completed"],
    );
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_identities WHERE account_id=ANY($1::uuid[])", [
          [f.accounts[0].id, f.accounts[3].id],
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_events WHERE id=ANY($1::uuid[])", [
          [f.eventId, otherEvent],
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_event_validators WHERE event_id=ANY($1::uuid[])", [
          [f.eventId, otherEvent],
        ])
      ).rowCount,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
