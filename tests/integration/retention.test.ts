import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { authConfig } from "../../src/server/auth/config";
import { hash, seal } from "../../src/server/auth/crypto";
import { duplicateAccountEvent } from "../../src/server/events/accounts";
import { AppFailure } from "../../src/server/http/security";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { retirePrivacyRecords } from "../../src/server/privacy/retention";
import { createWalletChallenge } from "../../src/server/wallets/proof";
import { financialFixtures } from "../fixtures/financial-records";
import { confirmedDeletion } from "../fixtures/deletion";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Retention checks require the disposable test database");
process.env.SHOWUP_E2E_ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.SHOWUP_E2E_INDEX_KEY = randomBytes(32).toString("hex");
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
  SHOWUP_IDENTITY_KEY: process.env.SHOWUP_E2E_ENCRYPTION_KEY,
  SHOWUP_IDENTITY_INDEX_KEY: process.env.SHOWUP_E2E_INDEX_KEY,
})!;
const day = 86400_000;
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;

test("the actual worker retires eligible legacy material with its existing key and stops cleanly", async () => {
  const f = await financialFixtures(),
    operation = randomUUID(),
    actor = f.accounts[1];
  const challenge = createWalletChallenge(
    config.origin,
    "near",
    "fictional.near",
    Date.now() - 8 * day,
  );
  await f.pool.query(
    `INSERT INTO app_mutations(operation_id,actor_id,request_hash,encrypted_receipt,created_at)
    VALUES ($1,$2,$3,$4,clock_timestamp()-interval '8 days')`,
    [
      operation,
      actor.id,
      "a".repeat(64),
      seal(config.encryptionKey, `mutation:${actor.id}:${operation}`, challenge),
    ],
  );
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/main.ts"], {
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      SHOWUP_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL,
      SHOWUP_AUTH: "0",
      SHOWUP_HARNESS: "0",
      SHOWUP_IDENTITY_KEY: config.encryptionKey,
    },
  });
  try {
    const deadline = Date.now() + 10000;
    let retired = false;
    while (Date.now() < deadline) {
      assert.equal(
        child.exitCode === null && child.signalCode === null,
        true,
        "Worker exited before privacy maintenance completed",
      );
      retired = Boolean(
        (
          await f.pool.query("SELECT payload_retired_at FROM app_mutations WHERE operation_id=$1", [
            operation,
          ])
        ).rows[0].payload_retired_at,
      );
      if (retired) break;
      await setTimeout(100);
    }
    assert.equal(retired, true, "Worker did not retire eligible material within the deadline");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const clean = await Promise.race([
        exited.then(() => true),
        setTimeout(5000, false, { ref: false }),
      ]);
      if (!clean) {
        child.kill("SIGKILL");
        await exited;
      }
      await f.cleanup();
      assert.equal(clean, true, "Worker required forced termination");
      assert.equal(child.exitCode, 0);
    } else {
      await f.cleanup();
    }
  }
});

test("actual control challenge material expires at seven days after its deadline, never before", async () => {
  const f = await financialFixtures();
  try {
    const row = (
      await f.pool.query(
        `SELECT operation_id,payload_expires_at FROM app_mutations WHERE actor_id=$1
      AND payload_expires_at<created_at+interval '8 days'`,
        [f.accounts[0].id],
      )
    ).rows[0];
    assert.equal(Boolean(row), true);
    const before = await retirePrivacyRecords(
      f.pool,
      undefined,
      100,
      new Date(row.payload_expires_at.getTime() - 1),
    );
    assert.equal(before.payloads, 0);
    assert.equal(before.challenges, 0);
    const at = await retirePrivacyRecords(f.pool, undefined, 100, row.payload_expires_at);
    assert.equal(at.payloads, 1);
    assert.equal(at.challenges, 1);
    assert.equal(
      (
        await f.pool.query("SELECT encrypted_receipt FROM app_mutations WHERE operation_id=$1", [
          row.operation_id,
        ])
      ).rows[0].encrypted_receipt,
      "",
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) FROM app_commitment_consents WHERE account_id=$1 AND encrypted_proof IS NOT NULL",
          [f.accounts[0].id],
        )
      ).rows[0].count,
      "1",
    );
  } finally {
    await f.cleanup();
  }
});

test("retention migration preserves prior payloads, enforces atomic erasure and rolls back its schema", async () => {
  const { pool } = createDatabase();
  await migrate(pool);
  const client = await pool.connect(),
    schema = `retention_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query(
      "CREATE TABLE app_mutations(operation_id uuid PRIMARY KEY,actor_id uuid,request_hash text,encrypted_receipt text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())",
    );
    await client.query("CREATE TABLE app_audit(created_at timestamptz)");
    await client.query("CREATE TABLE app_wallet_challenges(expires_at timestamptz)");
    await client.query(
      "INSERT INTO app_mutations(operation_id,encrypted_receipt) VALUES ($1,'opaque fixture')",
      [randomUUID()],
    );
    await client.query(await readFile("migrations/012-private-receipt-retention.sql", "utf8"));
    assert.equal(
      (await client.query("SELECT encrypted_receipt FROM app_mutations")).rows[0].encrypted_receipt,
      "opaque fixture",
    );
    await client.query("SAVEPOINT invalid_retirement");
    await assert.rejects(
      client.query("UPDATE app_mutations SET payload_retired_at=clock_timestamp()"),
      (error) => (error as { code: string }).code === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT invalid_retirement");
    await client.query(
      "UPDATE app_mutations SET encrypted_receipt='',payload_retired_at=clock_timestamp()",
    );
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query("SELECT to_regnamespace($1) AS schema", [schema])).rows[0].schema,
      null,
    );
    assert.equal(
      Boolean(
        (await pool.query("SELECT to_regclass('public.app_mutations') AS relation")).rows[0]
          .relation,
      ),
      true,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

test("retired private receipts retain replay barriers and never discard approved financial originals or pending deletion holds", async () => {
  const f = await financialFixtures();
  try {
    const host = f.accounts[1],
      operation = randomUUID(),
      session = hash(host.value),
      source = f.consent.terms.event;
    await duplicateAccountEvent(f.pool, config.encryptionKey, session, operation, source);
    const before = (
      await f.pool.query(
        "SELECT encrypted_consent,encrypted_proof FROM app_commitment_consents WHERE id=$1",
        [f.consent.id],
      )
    ).rows[0];
    await f.linkFictionalIdentity(randomUUID());
    const actorSession = hash(f.accounts[0].value);
    const pending = await requestAccountDeletion(
      f.pool,
      config,
      actorSession,
      confirmedDeletion(config, f.accounts[0].id, actorSession),
    );
    assert.equal(pending.state, "pending_reconciliation");
    const clearSession = hash(f.accounts[2].value);
    const completed = await requestAccountDeletion(
      f.pool,
      config,
      clearSession,
      confirmedDeletion(config, f.accounts[2].id, clearSession),
    );
    assert.equal(completed.state, "completed");
    const count = (
      await f.pool.query("SELECT count(*) FROM app_events WHERE owner_id=$1", [host.id])
    ).rows[0].count;
    const progress = await retirePrivacyRecords(
      f.pool,
      config.encryptionKey,
      100,
      new Date(Date.now() + 91 * day),
    );
    assert(progress.payloads > 0);
    assert(progress.audit > 0);
    assert.equal(progress.completedRequests, 1);
    const row = (
      await f.pool.query(
        "SELECT encrypted_receipt,payload_retired_at FROM app_mutations WHERE operation_id=$1",
        [operation],
      )
    ).rows[0];
    assert.equal(row.encrypted_receipt, "");
    assert.equal(Boolean(row.payload_retired_at), true);
    await assert.rejects(
      duplicateAccountEvent(f.pool, config.encryptionKey, session, operation, source),
      status(410),
    );
    await assert.rejects(
      duplicateAccountEvent(f.pool, config.encryptionKey, session, operation, randomUUID()),
      status(409),
    );
    assert.equal(
      (await f.pool.query("SELECT count(*) FROM app_events WHERE owner_id=$1", [host.id])).rows[0]
        .count,
      count,
    );
    const after = (
      await f.pool.query(
        "SELECT encrypted_consent,encrypted_proof FROM app_commitment_consents WHERE id=$1",
        [f.consent.id],
      )
    ).rows[0];
    assert.equal(before.encrypted_consent === after.encrypted_consent, true);
    assert.equal(before.encrypted_proof === after.encrypted_proof, true);
    assert.equal(
      (
        await f.pool.query("SELECT id FROM app_deletion_requests WHERE account_id=$1", [
          f.accounts[0].id,
        ])
      ).rows[0].id,
      pending.id,
    );
    assert.equal(
      (
        await f.pool.query("SELECT count(*) FROM app_event_credentials WHERE account_id=$1", [
          f.accounts[0].id,
        ])
      ).rows[0].count,
      "1",
    );
  } finally {
    await f.cleanup();
  }
});

test("legacy control nonces retire after expiry plus seven days; missing keys cannot starve known deadlines", async () => {
  const f = await financialFixtures();
  try {
    const actor = f.accounts[1],
      now = Date.now(),
      oldChallenge = createWalletChallenge(config.origin, "near", "fictional.near", now - 8 * day);
    const legacy = randomUUID(),
      known = randomUUID();
    for (const [operation, value, deadline] of [
      [legacy, oldChallenge, null],
      [known, { minimal: "fixture" }, new Date(now - 1000)],
    ] as const)
      await f.pool.query(
        `INSERT INTO app_mutations(operation_id,actor_id,request_hash,encrypted_receipt,created_at,payload_expires_at)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          operation,
          actor.id,
          "a".repeat(64),
          seal(config.encryptionKey, `mutation:${actor.id}:${operation}`, value),
          new Date(now - 8 * day),
          deadline,
        ],
      );
    const unkeyed = await retirePrivacyRecords(f.pool, undefined, 1);
    assert.equal(unkeyed.legacyNeedsKey, true);
    assert.equal(unkeyed.payloads, 1);
    assert.equal(
      Boolean(
        (
          await f.pool.query("SELECT payload_retired_at FROM app_mutations WHERE operation_id=$1", [
            legacy,
          ])
        ).rows[0].payload_retired_at,
      ),
      false,
    );
    const keyed = await retirePrivacyRecords(f.pool, config.encryptionKey, 100);
    assert.equal(keyed.legacyNeedsKey, false);
    assert.equal(keyed.payloads, 1);
    assert.equal(
      (
        await f.pool.query("SELECT encrypted_receipt FROM app_mutations WHERE operation_id=$1", [
          legacy,
        ])
      ).rows[0].encrypted_receipt,
      "",
    );
    assert.equal((await retirePrivacyRecords(f.pool, config.encryptionKey)).payloads, 0);
  } finally {
    await f.cleanup();
  }
});

test("concurrent bounded sweeps skip locked work, preserve unexpired records and roll back on a wrong legacy key", async () => {
  const f = await financialFixtures();
  try {
    const actor = f.accounts[1],
      ids: string[] = [],
      now = Date.now();
    for (let i = 0; i < 3; i++) {
      const operation = randomUUID();
      ids.push(operation);
      await f.pool.query(
        "INSERT INTO app_mutations(operation_id,actor_id,request_hash,encrypted_receipt,payload_expires_at) VALUES ($1,$2,$3,$4,$5)",
        [
          operation,
          actor.id,
          "a".repeat(64),
          seal(config.encryptionKey, `mutation:${actor.id}:${operation}`, { minimal: i }),
          new Date(now - 1000),
        ],
      );
    }
    const held = await f.pool.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT 1 FROM app_mutations WHERE operation_id=$1 FOR UPDATE", [ids[0]]);
      const progress = await Promise.all([
        retirePrivacyRecords(f.pool, undefined, 1),
        retirePrivacyRecords(f.pool, undefined, 1),
      ]);
      assert.equal(
        progress.reduce((sum, row) => sum + row.payloads, 0),
        2,
      );
      assert.equal(
        Boolean(
          (
            await f.pool.query(
              "SELECT payload_retired_at FROM app_mutations WHERE operation_id=$1",
              [ids[0]],
            )
          ).rows[0].payload_retired_at,
        ),
        false,
      );
      await held.query("ROLLBACK");
    } finally {
      await held.query("ROLLBACK");
      held.release();
    }
    assert.equal((await retirePrivacyRecords(f.pool)).payloads, 1);
    const legacy = randomUUID(),
      audit = randomUUID();
    const challenge = createWalletChallenge(config.origin, "near", "fictional.near", now - 8 * day);
    await f.pool.query(
      "INSERT INTO app_mutations(operation_id,actor_id,request_hash,encrypted_receipt,created_at) VALUES ($1,$2,$3,$4,$5)",
      [
        legacy,
        actor.id,
        "a".repeat(64),
        seal(config.encryptionKey, `mutation:${actor.id}:${legacy}`, challenge),
        new Date(now - 8 * day),
      ],
    );
    await f.pool.query(
      "INSERT INTO app_audit(id,actor_id,action,created_at) VALUES ($1,$2,'retention.fixture',$3)",
      [audit, actor.id, new Date(now - 91 * day)],
    );
    await assert.rejects(retirePrivacyRecords(f.pool, randomBytes(32).toString("hex")));
    assert.equal(
      (await f.pool.query("SELECT count(*) FROM app_audit WHERE id=$1", [audit])).rows[0].count,
      "1",
    );
    assert.equal(
      Boolean(
        (
          await f.pool.query("SELECT payload_retired_at FROM app_mutations WHERE operation_id=$1", [
            legacy,
          ])
        ).rows[0].payload_retired_at,
      ),
      false,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) FROM app_mutations WHERE actor_id=$1 AND payload_retired_at IS NULL AND payload_expires_at>clock_timestamp()",
          [f.accounts[0].id],
        )
      ).rows[0].count !== "0",
      true,
    );
    await retirePrivacyRecords(f.pool, config.encryptionKey);
  } finally {
    await f.cleanup();
  }
});
