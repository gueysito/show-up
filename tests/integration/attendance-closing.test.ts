import { closingProcess } from "../../scripts/attendance-delivery-peer";
import { exportOwnData } from "../../src/server/privacy/export";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { confirmedDeletion } from "../fixtures/deletion";
import assert from "node:assert/strict";
import { sign, randomUUID, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { checkpointFixture } from "../fixtures/attendance-checkpoint";
import { attendanceCheckpointWire } from "../../src/server/attendance/checkpoint-wire";
import {
  runSandboxAttendanceClosing,
  type SandboxClosingGateway,
} from "../../src/worker/attendance-closing";
import { hash, unseal } from "../../src/server/auth/crypto";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { AppFailure } from "../../src/server/http/security";

const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
async function fixture(hasCandidate = true) {
  const f = await checkpointFixture(hasCandidate);
  await f.freeze();
  const prepared = await f.prepare();
  let current = structuredClone(f.observed),
    signatures = 0,
    submissions = 0;
  function close() {
    const event = current.views.event as Record<string, unknown>;
    event.status = hasCandidate ? "closed" : "aborted";
    (current.views.registration as { state: string }).state = "refund_owed";
    current.views.principal = {
      total: "5000000",
      paid: "0",
      attempts: 0,
      pending: null,
      destination: (current.context.authorization as { payout: unknown }).payout,
    };
    current.views.accounting = {
      received: "5000000",
      delivered: "0",
      owed: "5000000",
      unallocated: "0",
    };
    current.block = {
      height: "102",
      hash: encodeBase58(Buffer.alloc(32, 11)),
      timestampMs: f.at + 1,
    };
  }
  const gateway: SandboxClosingGateway = {
    context: f.source.context,
    evidencePublicKey: f.publicKey,
    read: async () => structuredClone(current),
    sign: async (value) => {
      signatures++;
      return sign(null, Buffer.from(attendanceCheckpointWire(value)), f.key.privateKey).toString(
        "base64",
      );
    },
    submit: async () => {
      submissions++;
      close();
    },
  };
  return {
    ...f,
    prepared,
    gateway,
    close,
    source: () => current,
    setSource: (value: typeof current) => {
      current = value;
    },
    counts: () => ({ signatures, submissions }),
    row: async () =>
      (await f.pool.query("SELECT * FROM app_attendance_closings WHERE event_id=$1", [f.eventId]))
        .rows[0],
    run: (adapter = gateway) => runSandboxAttendanceClosing(f.pool, f.config, prepared.id, adapter),
  };
}

test("closing persists the exact signed checkpoint before submission and keeps one original decision on replay", async () => {
  const f = await fixture();
  try {
    const submit = f.gateway.submit;
    f.gateway.submit = async (...args) => {
      const row = await f.row();
      assert.equal(row.state, "broadcast_unknown");
      const stored = unseal(
        f.config.encryptionKey,
        `attendance-closing:${f.prepared.id}`,
        row.encrypted_signed,
      ) as { signature: string };
      assert.equal(stored.signature, args[1]);
      assert.equal(attendanceCheckpointWire(args[0]), f.prepared.wire);
      await submit(...args);
    };
    const result = await f.run();
    assert.equal(result.status, "observed");
    assert.equal(result.settlementConfirmed, false);
    const row = await f.row();
    assert.deepEqual(await f.run(), result);
    assert.equal((await f.row()).encrypted_signed, row.encrypted_signed);
    assert.deepEqual(f.counts(), { signatures: 1, submissions: 1 });
  } finally {
    await f.cleanup();
  }
});

test("unknown close acknowledgement recovers the observed decision without another signature or submission", async () => {
  const f = await fixture();
  try {
    const submit = f.gateway.submit;
    assert.equal(
      (
        await f.run({
          ...f.gateway,
          submit: async (...args) => {
            await submit(...args);
            throw new Error("Lost acknowledgement");
          },
        })
      ).status,
      "broadcast_unknown",
    );
    const before = await f.row();
    assert.equal(
      (
        await f.run({
          ...f.gateway,
          sign: async () => {
            throw new Error("No resign");
          },
          submit: async () => {
            throw new Error("No resend");
          },
        })
      ).status,
      "observed",
    );
    assert.equal((await f.row()).encrypted_signed, before.encrypted_signed);
    assert.equal((await f.row()).attempts, 2);
    assert.deepEqual(f.counts(), { signatures: 1, submissions: 1 });
  } finally {
    await f.cleanup();
  }
});

test("zero attendance closes fail-neutral and a successful RPC with no source effect stays unknown", async () => {
  const f = await fixture(false);
  try {
    assert.equal(
      (await f.run({ ...f.gateway, submit: async () => {} })).status,
      "broadcast_unknown",
    );
    const first = await f.row();
    assert.equal((await f.run()).status, "observed");
    assert.equal((await f.row()).encrypted_signed, first.encrypted_signed);
    assert.deepEqual(f.counts(), { signatures: 1, submissions: 1 });
    assert.equal((f.source().views.event as { status: string }).status, "aborted");
  } finally {
    await f.cleanup();
  }
});

test("source transport is retryable but same-height forks and changed ledgers latch a conflict", async () => {
  for (const failure of ["fork", "ledger", "context"]) {
    const f = await fixture();
    try {
      assert.equal(
        (
          await f.run({
            ...f.gateway,
            read: async () => {
              throw new Error("Unavailable");
            },
          })
        ).status,
        "unavailable",
      );
      const next = structuredClone(f.source());
      if (failure === "fork") next.block.hash = encodeBase58(Buffer.alloc(32, 12));
      if (failure === "ledger") {
        (next.views.event as { ledger_version: number }).ledger_version = 3;
        next.block.height = "102";
      }
      if (failure === "context") next.context.rulesHash = "a".repeat(64);
      f.setSource(next);
      assert.equal((await f.run()).status, "conflict");
      f.setSource(structuredClone(f.observed));
      assert.equal((await f.run()).status, "conflict");
      assert.deepEqual(f.counts(), { signatures: 0, submissions: 0 });
    } finally {
      await f.cleanup();
    }
  }
});

test("an expired unsigned checkpoint and an already-closed unsigned decision require reconciliation", async () => {
  for (const kind of ["expired", "closed"]) {
    const f = await fixture();
    try {
      if (kind === "closed") f.close();
      else {
        const next = structuredClone(f.source());
        next.block = {
          height: "102",
          hash: encodeBase58(Buffer.alloc(32, 12)),
          timestampMs: f.prepared.checkpoint.expires_ms + 1,
        };
        f.setSource(next);
      }
      assert.equal((await f.run()).status, "awaiting_reconciliation");
      assert.deepEqual(f.counts(), { signatures: 0, submissions: 0 });
    } finally {
      await f.cleanup();
    }
  }
});

test("invalid signer, changed frozen authority and nonlocal profiles cannot submit or replace the checkpoint", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      runSandboxAttendanceClosing(
        f.pool,
        { ...f.config, origin: "https://other.invalid" },
        f.prepared.id,
        f.gateway,
      ),
      status(409),
    );
    await assert.rejects(
      f.run({ ...f.gateway, evidencePublicKey: Buffer.alloc(32, 3).toString("base64") }),
      status(409),
    );
    const key = generateKeyPairSync("ed25519");
    assert.equal(
      (
        await f.run({
          ...f.gateway,
          sign: async (value) =>
            sign(null, Buffer.from(attendanceCheckpointWire(value)), key.privateKey).toString(
              "base64",
            ),
        })
      ).status,
      "conflict",
    );
    assert.equal((await f.row()).encrypted_signed, null);
    assert.deepEqual(f.counts(), { signatures: 0, submissions: 0 });
  } finally {
    await f.cleanup();
  }
});

test("a held closing claim prevents duplicate work and a stale worker cannot overwrite its successor", async () => {
  const f = await fixture();
  let release: () => void = () => {},
    started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
      started = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  let first: Promise<unknown> | undefined;
  try {
    first = f.run({
      ...f.gateway,
      sign: async (value, signal) => {
        started();
        await blocked;
        return f.gateway.sign(value, signal);
      },
    });
    await Promise.race([
      ready,
      first.then(() => {
        throw new Error("Worker exited before claim");
      }),
    ]);
    assert.equal((await f.run()).status, "processing");
    assert.deepEqual(f.counts(), { signatures: 0, submissions: 0 });
    await f.pool.query(
      "UPDATE app_attendance_closings SET claim_until=clock_timestamp()-interval '1 second' WHERE event_id=$1",
      [f.eventId],
    );
    assert.equal((await f.run()).status, "observed");
    const row = await f.row();
    release();
    await first;
    assert.equal((await f.row()).encrypted_signed, row.encrypted_signed);
    assert.equal((await f.row()).state, "observed");
    assert.equal(f.counts().submissions, 1);
  } finally {
    release();
    await first;
    await f.cleanup();
  }
});

test("closing migration rolls back and forbids partially-held claims and unsigned observed state", async () => {
  const f = await fixture(),
    client = await f.pool.connect(),
    schema = `closing_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query("CREATE TABLE app_events(id uuid PRIMARY KEY)");
    await client.query("CREATE TABLE app_attendance_checkpoints(id uuid PRIMARY KEY)");
    await client.query(await readFile("migrations/020-attendance-closing-delivery.sql", "utf8"));
    await client.query("INSERT INTO app_events VALUES($1)", [f.eventId]);
    await client.query("INSERT INTO app_attendance_checkpoints VALUES($1)", [f.prepared.id]);
    for (const fragment of ["claim_token", "state"]) {
      await client.query("SAVEPOINT invalid");
      await assert.rejects(
        client.query(
          `INSERT INTO app_attendance_closings(event_id,checkpoint_id,profile_hash,${fragment}) VALUES($1,$2,$3,$4)`,
          [
            f.eventId,
            f.prepared.id,
            "a".repeat(64),
            fragment === "state" ? "observed" : randomUUID(),
          ],
        ),
        (error) => (error as { code: string }).code === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid");
    }
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

test("expiry during signing keeps the original signature but never sends an expired checkpoint", async () => {
  const f = await fixture();
  try {
    const original = f.gateway.sign;
    const result = await f.run({
      ...f.gateway,
      sign: async (...args) => {
        const signature = await original(...args);
        const next = structuredClone(f.source());
        next.block = {
          height: "102",
          hash: encodeBase58(Buffer.alloc(32, 12)),
          timestampMs: f.prepared.checkpoint.expires_ms + 1,
        };
        f.setSource(next);
        return signature;
      },
    });
    assert.equal(result.status, "awaiting_reconciliation");
    assert((await f.row()).encrypted_signed);
    assert.deepEqual(f.counts(), { signatures: 1, submissions: 0 });
  } finally {
    await f.cleanup();
  }
});

test("the original host alone exports closing metadata and restricted deletion recovery preserves its proof", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run()).status, "observed");
    const hostSession = hash(f.accounts[1].value);
    const host = await exportOwnData(f.pool, f.config, hostSession),
      attendee = await exportOwnData(f.pool, f.config, f.session);
    assert.equal(host.hostedAttendanceClosings.length, 1);
    assert.equal(attendee.hostedAttendanceClosings.length, 0);
    assert.deepEqual(Object.keys(host.hostedAttendanceClosings[0]).sort(), [
      "attempts",
      "checkpoint_id",
      "event_id",
      "last_error",
      "observed_hash",
      "observed_height",
      "state",
    ]);
    const before = await f.row();
    const deleted = await requestAccountDeletion(
      f.pool,
      f.config,
      hostSession,
      confirmedDeletion(f.config, f.accounts[1].id, hostSession),
    );
    assert.equal(deleted.state, "pending_reconciliation");
    const recovered = await exportOwnData(f.pool, f.config, hash(deleted.sessionValue!));
    assert.deepEqual(recovered.hostedAttendanceClosings, host.hostedAttendanceClosings);
    assert.equal((await f.row()).encrypted_signed, before.encrypted_signed);
  } finally {
    await f.cleanup();
  }
});

test("a later prepared checkpoint cannot replace the original event closing decision", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.run({
          ...f.gateway,
          read: async () => {
            throw new Error("Unavailable");
          },
        })
      ).status,
      "unavailable",
    );
    const next = structuredClone(f.observed);
    (next.views.event as { ledger_version: number }).ledger_version = 3;
    next.block = { height: "102", hash: encodeBase58(Buffer.alloc(32, 13)), timestampMs: f.at + 1 };
    const alternate = await f.prepare([next], f.accepted, f.at + 1);
    assert.notEqual(alternate.id, f.prepared.id);
    await assert.rejects(
      runSandboxAttendanceClosing(f.pool, f.config, alternate.id, f.gateway),
      status(409),
    );
    assert.equal((await f.row()).checkpoint_id, f.prepared.id);
    assert.deepEqual(f.counts(), { signatures: 0, submissions: 0 });
  } finally {
    await f.cleanup();
  }
});

test("source observations within one closing must advance without intermediate forks or regressions", async () => {
  for (const kind of ["height", "fork", "time"]) {
    const f = await fixture();
    try {
      const first = structuredClone(f.source()),
        second = structuredClone(f.source());
      first.block = {
        height: "103",
        hash: encodeBase58(Buffer.alloc(32, 14)),
        timestampMs: f.at + 3,
      };
      second.block = {
        height: kind === "height" ? "102" : kind === "fork" ? "103" : "104",
        hash: encodeBase58(Buffer.alloc(32, 15)),
        timestampMs: kind === "time" ? first.block.timestampMs - 1 : first.block.timestampMs,
      };
      let reads = 0;
      const result = await f.run({
        ...f.gateway,
        read: async () => structuredClone(reads++ === 0 ? first : second),
      });
      assert.equal(result.status, "conflict");
      assert.equal(f.counts().submissions, 0);
      assert.equal((await f.row()).last_error, "source_conflict");
    } finally {
      await f.cleanup();
    }
  }
});

test("closing source watermarks survive a failed signer process before any submission", async () => {
  const f = await fixture();
  try {
    const fresh = structuredClone(f.source());
    fresh.block = {
      height: "103",
      hash: encodeBase58(Buffer.alloc(32, 14)),
      timestampMs: f.at + 3,
    };
    assert.equal(
      (
        await closingProcess(f.config, f.prepared.id, {
          ...f.gateway,
          read: async () => structuredClone(fresh),
          sign: async () => {
            assert.equal((await f.row()).observed_height, "103");
            throw new Error("Signer unavailable");
          },
        })
      ).status,
      "unavailable",
    );
    assert.equal((await f.row()).observed_height, "103");
    const older = structuredClone(fresh);
    older.block = { ...fresh.block, height: "102", hash: encodeBase58(Buffer.alloc(32, 15)) };
    assert.equal(
      (
        await closingProcess(f.config, f.prepared.id, {
          ...f.gateway,
          read: async () => structuredClone(older),
        })
      ).status,
      "conflict",
    );
    assert.equal((await f.row()).observed_height, "103");
    assert.deepEqual(f.counts(), { signatures: 0, submissions: 0 });
  } finally {
    await f.cleanup();
  }
});
