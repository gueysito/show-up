import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { settlementFixture, settlementTransport } from "../fixtures/settlement";
import { unseal } from "../../src/server/auth/crypto";
import {
  createSettlementWatch,
  refreshSettlementWatch,
} from "../../src/server/commitments/reconciliation";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { AppFailure } from "../../src/server/http/security";
import { encodeBase58 } from "../../src/server/protocol/encoding";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Reconciliation checks require the disposable test database");
const { pool } = createDatabase(),
  watches = new Set<string>();
before(() => migrate(pool));
after(async () => {
  await pool.query("DELETE FROM app_settlement_watches WHERE id=ANY($1::uuid[])", [[...watches]]);
  await pool.end();
});
async function fixture() {
  const keys = {
    encryptionKey: randomBytes(32).toString("hex"),
    indexKey: randomBytes(32).toString("hex"),
  };
  const sample = settlementFixture(Date.now(), "mainnet");
  const id = await createSettlementWatch(pool, keys, sample.context);
  watches.add(id);
  return {
    keys,
    sample,
    id,
    refresh: () => refreshSettlementWatch(pool, keys, id, settlementTransport(sample)),
  };
}
function advance(sample: ReturnType<typeof settlementFixture>, count = 1) {
  sample.block.height = (BigInt(sample.block.height) + BigInt(count)).toString();
  sample.block.hash = encodeBase58(
    Buffer.alloc(32, Number(BigInt(sample.block.height) % 200n) + 10),
  );
  sample.block.timestampMs += count;
}
function release(sample: ReturnType<typeof settlementFixture>) {
  const event = sample.views.event as Record<string, unknown>,
    registration = sample.views.registration as Record<string, unknown>;
  event.funded = [];
  event.ledger_version = 2;
  registration.state = "released";
  sample.views.principal = {
    destination: sample.context.authorization.payout,
    total: "5000000",
    paid: "0",
    attempts: 0,
    pending: null,
  };
  sample.views.accounting = {
    received: "5000000",
    delivered: "0",
    owed: "5000000",
    unallocated: "0",
  };
}

test("watch creation is race-safe, immutable and encrypted without exposing wallet addresses in indexes", async () => {
  const f = await fixture();
  const ids = await Promise.all([
    createSettlementWatch(pool, f.keys, f.sample.context),
    createSettlementWatch(pool, f.keys, f.sample.context),
  ]);
  assert.deepEqual(ids, [f.id, f.id]);
  const row = (await pool.query("SELECT * FROM app_settlement_watches WHERE id=$1", [f.id]))
    .rows[0];
  assert.equal(row.encrypted_context.includes("fictional-wallet.near"), false);
  assert.match(row.context_index, /^[0-9a-f]{64}$/);
  const changed = structuredClone(f.sample.context);
  (changed.authorization.payout as Record<string, unknown>).address = "attacker.near";
  await assert.rejects(
    () => createSettlementWatch(pool, f.keys, changed),
    (error) => error instanceof AppFailure && error.status === 409,
  );
  assert.deepEqual(
    unseal(f.keys.encryptionKey, `settlement-watch:${f.id}`, row.encrypted_context),
    f.sample.context,
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM app_settlement_watches WHERE id=$1", [f.id])).rows[0]
      .count,
    "1",
  );
});

test("durable refresh replays the same block without rewriting state and retains exact u64 versions", async () => {
  const f = await fixture(),
    first = await f.refresh();
  assert.equal(first.status, "observed");
  assert.equal(first.available, true);
  assert.equal(first.facts?.fundingAllowed, false);
  const before = (await pool.query("SELECT * FROM app_settlement_watches WHERE id=$1", [f.id]))
    .rows[0];
  assert.equal(
    before.encrypted_state.includes(String(f.sample.context.authorization.registration)),
    false,
  );
  const replay = await f.refresh();
  assert.equal(replay.status, "replayed");
  assert.deepEqual(replay.facts, first.facts);
  assert.equal(
    (await pool.query("SELECT encrypted_state FROM app_settlement_watches WHERE id=$1", [f.id]))
      .rows[0].encrypted_state,
    before.encrypted_state,
  );
  advance(f.sample);
  (f.sample.views.event as Record<string, unknown>).ledger_version = "18446744073709551615";
  const large = await f.refresh();
  assert.equal(large.facts?.ledgerVersion, "18446744073709551615");
  assert.equal(
    (await pool.query("SELECT ledger_version FROM app_settlement_watches WHERE id=$1", [f.id]))
      .rows[0].ledger_version,
    "18446744073709551615",
  );
});

test("out-of-order concurrent source reads cannot overwrite a later committed block or hold a DB lock during RPC", async () => {
  const f = await fixture();
  let signalStart!: () => void, unblock!: () => void;
  const started = new Promise<void>((resolve) => {
      signalStart = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
  const older = refreshSettlementWatch(
    pool,
    f.keys,
    f.id,
    settlementTransport(f.sample, {
      wait: async () => {
        signalStart();
        await gate;
      },
    }),
  );
  await started;
  advance(f.sample);
  const newer = await f.refresh();
  assert.equal(newer.status, "observed");
  unblock();
  const stale = await older;
  assert.equal(stale.status, "stale");
  assert.equal(stale.available, true);
  assert.equal(stale.facts?.block.height, f.sample.block.height);
  assert.deepEqual(stale.facts, newer.facts);
});

test("a same-height fork or changed state latches conflict and preserves the last confirmed snapshot", async () => {
  for (const kind of ["fork", "changed-state"]) {
    const f = await fixture(),
      initial = await f.refresh();
    if (kind === "fork") f.sample.block.hash = encodeBase58(Buffer.alloc(32, 8));
    else release(f.sample);
    const conflict = await f.refresh();
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.available, false);
    assert.equal(conflict.paused, true);
    assert.deepEqual(conflict.facts, initial.facts);
    const row = (await pool.query("SELECT * FROM app_settlement_watches WHERE id=$1", [f.id]))
      .rows[0];
    assert(row.encrypted_conflict);
    assert.equal(row.pause_reason, "state_regression");
    advance(f.sample);
    const stillPaused = await f.refresh();
    assert.equal(stillPaused.status, "conflict");
    assert.deepEqual(stillPaused.facts, initial.facts);
  }
});

test("transient source failure preserves pending debt and an exact successful replay restores availability", async () => {
  const f = await fixture();
  release(f.sample);
  const initial = await f.refresh();
  assert.equal(initial.facts?.principal?.remaining, "5000000");
  const failed = await refreshSettlementWatch(
    pool,
    f.keys,
    f.id,
    settlementTransport(f.sample, { fail: true }),
  );
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.available, false);
  assert.equal(failed.paused, false);
  assert.deepEqual(failed.facts, initial.facts);
  const recovered = await f.refresh();
  assert.equal(recovered.status, "replayed");
  assert.equal(recovered.available, true);
  assert.equal(recovered.facts?.principal?.remaining, "5000000");
});

test("source-pair disagreement latches even before the first snapshot and later agreement cannot silently clear it", async () => {
  const f = await fixture(),
    second = structuredClone(f.sample.views);
  (second.event as Record<string, unknown>).ledger_version = 2;
  const conflict = await refreshSettlementWatch(
    pool,
    f.keys,
    f.id,
    settlementTransport(f.sample, { second }),
  );
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.paused, true);
  assert.equal(conflict.facts, null);
  const row = (
    await pool.query("SELECT pause_reason FROM app_settlement_watches WHERE id=$1", [f.id])
  ).rows[0];
  assert.equal(row.pause_reason, "source_conflict");
  const later = await f.refresh();
  assert.equal(later.status, "conflict");
  assert.equal(later.available, false);
  assert.equal(later.facts, null);
});

test("finalized header forks and code changes are persistent conflicts rather than retryable outages", async () => {
  for (const mode of ["fork", "code"]) {
    const f = await fixture(),
      initial = await f.refresh(),
      base = settlementTransport(f.sample);
    const changed: typeof fetch = async (url, request) => {
      const response = await base(url, request),
        body = JSON.parse(String(request?.body));
      const parsed = await response.json();
      if (new URL(String(url)).hostname.includes("fastnear")) {
        if (mode === "fork" && body.method === "block")
          parsed.result.header.hash = encodeBase58(Buffer.alloc(32, 8));
        if (
          mode === "code" &&
          body.method === "query" &&
          body.params.request_type === "view_account"
        )
          parsed.result.code_hash = encodeBase58(Buffer.alloc(32, 9));
      }
      return Response.json(parsed);
    };
    const conflict = await refreshSettlementWatch(pool, f.keys, f.id, changed);
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.paused, true);
    assert.equal(conflict.available, false);
    assert.deepEqual(conflict.facts, initial.facts);
    assert.equal((await f.refresh()).status, "conflict");
  }
});

test("later block heights cannot resurrect released principal or decrease delivered and liability counters", async () => {
  const f = await fixture();
  release(f.sample);
  await f.refresh();
  const principal = f.sample.views.principal as Record<string, unknown>;
  advance(f.sample);
  principal.attempts = 1;
  assert.equal((await f.refresh()).facts?.principal?.remaining, "5000000");
  advance(f.sample);
  principal.attempts = 2;
  principal.paid = "5000000";
  f.sample.views.accounting = {
    received: "5000000",
    delivered: "5000000",
    owed: "0",
    unallocated: "0",
  };
  f.sample.views.tokenBalance = "0";
  const paid = await f.refresh();
  assert.equal(paid.facts?.principal?.remaining, "0");
  advance(f.sample);
  principal.paid = "4000000";
  f.sample.views.accounting = {
    received: "5000000",
    delivered: "4000000",
    owed: "1000000",
    unallocated: "0",
  };
  f.sample.views.tokenBalance = "1000000";
  const regressed = await f.refresh();
  assert.equal(regressed.status, "conflict");
  assert.deepEqual(regressed.facts, paid.facts);
});

test("every partial observation and out-of-range counter is rejected without altering the confirmed state", async () => {
  const f = await fixture(),
    initial = await f.refresh();
  for (const column of [
    "observed_height",
    "observed_hash",
    "observed_time_ms",
    "observed_state_hash",
    "ledger_version",
    "encrypted_state",
  ]) {
    await assert.rejects(
      () => pool.query(`UPDATE app_settlement_watches SET ${column}=NULL WHERE id=$1`, [f.id]),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
  }
  for (const [column, value] of [
    ["observed_height", "18446744073709551616"],
    ["ledger_version", "18446744073709551616"],
    ["observed_time_ms", "-1"],
  ])
    await assert.rejects(
      () => pool.query(`UPDATE app_settlement_watches SET ${column}=$2 WHERE id=$1`, [f.id, value]),
      (error: unknown) => (error as { code?: string }).code === "23514",
    );
  assert.deepEqual((await f.refresh()).facts, initial.facts);
});

test("reconciliation schema rolls back atomically without changing the prior commitment tables", async () => {
  const client = await pool.connect(),
    schema = `reconciliation_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query(await readFile("migrations/007-settlement-reconciliation.sql", "utf8"));
    await client.query(
      await readFile("migrations/008-settlement-observation-completeness.sql", "utf8"),
    );
    assert(
      (
        await client.query("SELECT to_regclass($1) AS relation", [
          `${schema}.app_settlement_watches`,
        ])
      ).rows[0].relation,
    );
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query("SELECT to_regnamespace($1) AS schema", [schema])).rows[0].schema,
      null,
    );
    assert(
      (await client.query("SELECT to_regclass('public.app_commitment_consents') AS relation"))
        .rows[0].relation,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
