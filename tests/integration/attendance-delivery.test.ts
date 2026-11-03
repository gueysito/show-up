import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { attendanceFixtures } from "../fixtures/attendance";
import { attendanceCandidateMaterial } from "../../src/server/attendance/attempts";
import {
  runSandboxAttendanceDelivery,
  type SandboxAttendanceGateway,
} from "../../src/worker/attendance";
import { hash, unseal } from "../../src/server/auth/crypto";
import { canonicalJson } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { AppFailure } from "../../src/server/http/security";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { exportOwnData } from "../../src/server/privacy/export";
import { confirmedDeletion } from "../fixtures/deletion";
import { deliveryProcess } from "../../scripts/attendance-delivery-peer";

if (process.env.SHOWUP_ENV !== "test") throw new Error("Delivery checks require disposable data");
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
async function fixture() {
  const f = await attendanceFixtures();
  await f.attempt();
  const row = (
    await f.pool.query("SELECT * FROM app_attendance_candidates WHERE event_id=$1", [f.eventId])
  ).rows[0];
  const candidate = attendanceCandidateMaterial(f.config, row),
    key = generateKeyPairSync("ed25519"),
    publicKey = Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url").toString(
      "base64",
    );
  let current = structuredClone(f.source),
    signatures = 0,
    submissions = 0;
  const observe = () => {
    const next = structuredClone(current);
    (next.views.event as { attendance: number; ledger_version: number }).attendance = 1;
    (next.views.event as { attendance: number; ledger_version: number }).ledger_version = 2;
    (next.views.registration as { attendance: string }).attendance =
      candidate.packet.classification;
    next.block = {
      height: "101",
      hash: encodeBase58(Buffer.alloc(32, 10)),
      timestampMs: candidate.packet.receipt.received_ms + 10,
    };
    current = next;
  };
  const gateway: SandboxAttendanceGateway = {
    context: f.source.context,
    evidencePublicKey: publicKey,
    read: async () => structuredClone(current),
    sign: async (receipt) => {
      signatures++;
      return sign(null, Buffer.from(canonicalJson(receipt)), key.privateKey).toString("base64");
    },
    submit: async () => {
      submissions++;
      observe();
    },
  };
  const run = (adapter = gateway) =>
    runSandboxAttendanceDelivery(f.pool, f.config, row.id, adapter);
  const delivery = async () =>
    (await f.pool.query("SELECT * FROM app_attendance_deliveries WHERE candidate_id=$1", [row.id]))
      .rows[0];
  return {
    ...f,
    row,
    candidate,
    gateway,
    run,
    delivery,
    observe,
    setSource: (value: typeof current) => {
      current = value;
    },
    counts: () => ({ signatures, submissions }),
  };
}

test("a signature is durable before submission and terminal replay keeps the original signed receipt and nonce", async () => {
  const f = await fixture();
  try {
    const submit = f.gateway.submit;
    f.gateway.submit = async (receipt, signature, signal) => {
      const row = await f.delivery();
      assert.equal(row.state, "broadcast_unknown");
      assert(row.encrypted_signed);
      const stored = unseal(
        f.config.encryptionKey,
        `attendance-delivery:${f.row.id}`,
        row.encrypted_signed,
      ) as { receipt: unknown; signature: string };
      assert.deepEqual(stored.receipt, receipt);
      assert.equal(stored.signature, signature);
      assert.equal(receipt.nonce, f.candidate.packet.receipt.nonce);
      await submit(receipt, signature, signal);
    };
    const result = await f.run();
    assert.equal(result.status, "observed");
    assert.equal(result.attendanceConfirmed, false);
    const before = await f.delivery();
    assert.deepEqual(await f.run(), result);
    assert.equal((await f.delivery()).encrypted_signed, before.encrypted_signed);
    assert.deepEqual(f.counts(), { signatures: 1, submissions: 1 });
  } finally {
    await f.cleanup();
  }
});

test("lost submission acknowledgment recovers from the actual observed effect without another signature or send", async () => {
  const f = await fixture();
  try {
    const original = f.gateway.submit;
    const first = await f.run({
      ...f.gateway,
      submit: async (...args) => {
        await original(...args);
        throw new Error("Lost acknowledgment");
      },
    });
    assert.equal(first.status, "broadcast_unknown");
    const before = await f.delivery();
    assert.equal(before.last_error, "submission_unknown");
    const next = await f.run({
      ...f.gateway,
      sign: async () => {
        throw new Error("Must reuse signature");
      },
      submit: async () => {
        throw new Error("Must reconcile before resend");
      },
    });
    assert.equal(next.status, "observed");
    assert.equal(next.attempts, 2);
    const after = await f.delivery();
    assert.equal(after.encrypted_signed, before.encrypted_signed);
    assert.equal(after.signed_hash, before.signed_hash);
    assert.deepEqual(f.counts(), { signatures: 1, submissions: 1 });
  } finally {
    await f.cleanup();
  }
});

test("an unexpired claim prevents competing sends and an expired worker cannot overwrite its replacement", async () => {
  const f = await fixture();
  let release: () => void = () => {},
    started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
      started = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  let first: ReturnType<typeof f.run> | undefined;
  try {
    const original = f.gateway.sign;
    first = f.run({
      ...f.gateway,
      sign: async (receipt, signal) => {
        started();
        await blocked;
        return original(receipt, signal);
      },
    });
    await Promise.race([
      ready,
      first.then(() => {
        throw new Error("Delivery exited before the signing probe");
      }),
    ]);
    const busy = await Promise.all(Array.from({ length: 5 }, () => f.run()));
    assert(busy.every((value) => value.status === "processing"));
    assert.equal(f.counts().submissions, 0);
    await f.pool.query(
      "UPDATE app_attendance_deliveries SET claim_until=clock_timestamp()-interval '1 second' WHERE candidate_id=$1",
      [f.row.id],
    );
    const replacement = await f.run();
    assert.equal(replacement.status, "observed");
    const saved = await f.delivery();
    release();
    assert.equal((await first).status, "observed");
    assert.equal((await f.delivery()).encrypted_signed, saved.encrypted_signed);
    assert.equal(f.counts().submissions, 1);
    assert.equal((await f.delivery()).attempts, 2);
  } finally {
    release();
    await first?.catch(() => {});
    await f.cleanup();
  }
});

test("source unavailability retains the candidate and fixed error class, then recovers without losing original authority", async () => {
  const f = await fixture();
  try {
    const unavailable = await f.run({
      ...f.gateway,
      read: async () => {
        throw new Error("Private transport internals");
      },
    });
    assert.equal(unavailable.status, "unavailable");
    const row = await f.delivery();
    assert.equal(row.last_error, "source_unavailable");
    assert.equal(row.encrypted_signed, null);
    assert.equal((await f.run()).status, "observed");
    assert.equal((await f.delivery()).last_error, null);
    assert.deepEqual(f.counts(), { signatures: 1, submissions: 1 });
  } finally {
    await f.cleanup();
  }
});

test("changed source context latches a conflict and cannot be cleared by a later good response or another authority key", async () => {
  const f = await fixture();
  try {
    const changed = structuredClone(f.source);
    changed.context.token = "different-test-token.near";
    assert.equal((await f.run({ ...f.gateway, read: async () => changed })).status, "conflict");
    assert.equal((await f.run()).status, "conflict");
    assert.deepEqual(f.counts(), { signatures: 0, submissions: 0 });
    await assert.rejects(
      f.run({ ...f.gateway, evidencePublicKey: Buffer.alloc(32, 8).toString("base64") }),
      status(409),
    );
    assert.equal((await f.delivery()).attempts, 1);
  } finally {
    await f.cleanup();
  }
  const fork = await fixture();
  try {
    const changed = structuredClone(fork.source);
    changed.block.hash = encodeBase58(Buffer.alloc(32, 13));
    assert.equal(
      (await fork.run({ ...fork.gateway, read: async () => changed })).status,
      "conflict",
    );
    assert.deepEqual(fork.counts(), { signatures: 0, submissions: 0 });
  } finally {
    await fork.cleanup();
  }
});

test("an RPC success without contract attendance remains unknown until a matching source observation arrives", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.run({ ...f.gateway, submit: async () => {} })).status,
      "broadcast_unknown",
    );
    const before = await f.delivery();
    assert(before.encrypted_signed);
    f.observe();
    assert.equal((await f.run()).status, "observed");
    assert.equal((await f.delivery()).encrypted_signed, before.encrypted_signed);
    assert.equal(f.counts().signatures, 1);
    assert.equal(f.counts().submissions, 0);
  } finally {
    await f.cleanup();
  }
});

test("expired unobserved receipts require reconciliation and are neither newly signed nor submitted", async () => {
  const f = await fixture();
  try {
    const expired = structuredClone(f.source);
    expired.block.height = "101";
    expired.block.hash = encodeBase58(Buffer.alloc(32, 12));
    expired.block.timestampMs = f.candidate.packet.receipt.expires_ms + 1;
    f.setSource(expired);
    assert.equal((await f.run()).status, "awaiting_reconciliation");
    assert.equal((await f.delivery()).last_error, "receipt_expired");
    assert.deepEqual(f.counts(), { signatures: 0, submissions: 0 });
  } finally {
    await f.cleanup();
  }
});

test("a signer response from another key never becomes durable or reaches a contract", async () => {
  const f = await fixture();
  try {
    const wrong = generateKeyPairSync("ed25519");
    const result = await f.run({
      ...f.gateway,
      sign: async (receipt) =>
        sign(null, Buffer.from(canonicalJson(receipt)), wrong.privateKey).toString("base64"),
    });
    assert.equal(result.status, "conflict");
    assert.equal((await f.delivery()).encrypted_signed, null);
    assert.equal(f.counts().submissions, 0);
  } finally {
    await f.cleanup();
  }
});

test("restricted deletion recovery preserves accepted delivery obligations and exports only the owner's metadata", async () => {
  const f = await fixture();
  try {
    const deletion = await requestAccountDeletion(
      f.pool,
      f.config,
      f.session,
      confirmedDeletion(f.config, f.accounts[0].id, f.session),
    );
    assert.equal(deletion.state, "pending_reconciliation");
    assert.equal((await f.run()).status, "observed");
    const own = await exportOwnData(f.pool, f.config, hash(deletion.sessionValue!));
    assert.equal(own.attendanceDeliveries.length, 1);
    assert.equal(own.attendanceDeliveries[0].state, "observed");
    assert.deepEqual(
      (await exportOwnData(f.pool, f.config, hash(f.accounts[2].value))).attendanceDeliveries,
      [],
    );
    for (const key of [
      "encrypted_signed",
      "signature",
      "evidencePublicKey",
      "claim_token",
      "profile_hash",
    ])
      assert.equal(Object.hasOwn(own.attendanceDeliveries[0], key), false);
  } finally {
    await f.cleanup();
  }
});

test("the worker process preserves a full-u64 source ledger across private IPC and encrypted observation storage", async () => {
  const f = await fixture();
  try {
    f.observe();
    const source = await f.gateway.read(AbortSignal.timeout(1000));
    (source.views.event as { ledger_version: unknown }).ledger_version = 18446744073709551615n;
    f.setSource(source);
    const result = await deliveryProcess(f.config, f.row.id, f.gateway);
    assert.equal(result.status, "observed");
    const row = await f.delivery();
    const observation = unseal(
      f.config.encryptionKey,
      `attendance-delivery-observation:${f.row.id}`,
      row.encrypted_observation,
    ) as { ledgerVersion: string };
    assert.equal(observation.ledgerVersion, "18446744073709551615");
  } finally {
    await f.cleanup();
  }
});

test("delivery migrations seed prior candidates, roll back and reject partial leases or unsigned observed states", async () => {
  const f = await fixture(),
    client = await f.pool.connect(),
    schema = `delivery_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query("CREATE TABLE app_attendance_candidates(id uuid PRIMARY KEY)");
    await client.query("INSERT INTO app_attendance_candidates VALUES($1)", [f.row.id]);
    await client.query(await readFile("migrations/018-attendance-delivery.sql", "utf8"));
    await client.query(await readFile("migrations/019-attendance-observed-signature.sql", "utf8"));
    assert.equal(
      (await client.query("SELECT state FROM app_attendance_deliveries")).rows[0].state,
      "pending",
    );
    for (const sql of [
      "UPDATE app_attendance_deliveries SET claim_token=$1",
      "UPDATE app_attendance_deliveries SET state='observed',observed_height=1,observed_hash='block',encrypted_observation='opaque' WHERE candidate_id=$1",
    ]) {
      await client.query("SAVEPOINT invalid_state");
      await assert.rejects(
        client.query(sql, [f.row.id]),
        (error) => (error as { code: string }).code === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_state");
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

test("source observations within one receipt delivery must advance without intermediate forks or regressions", async () => {
  for (const kind of ["height", "fork", "time"]) {
    const f = await fixture();
    try {
      const first = structuredClone(f.source),
        second = structuredClone(f.source);
      first.block = {
        height: "103",
        hash: encodeBase58(Buffer.alloc(32, 14)),
        timestampMs: f.candidate.packet.receipt.received_ms + 3,
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
      assert.equal((await f.delivery()).last_error, "source_conflict");
    } finally {
      await f.cleanup();
    }
  }
});

test("receipt source watermarks survive a failed signer process before any submission", async () => {
  const f = await fixture();
  try {
    const fresh = structuredClone(f.source);
    fresh.block = {
      height: "103",
      hash: encodeBase58(Buffer.alloc(32, 14)),
      timestampMs: f.candidate.packet.receipt.received_ms + 3,
    };
    assert.equal(
      (
        await deliveryProcess(f.config, f.row.id, {
          ...f.gateway,
          read: async () => structuredClone(fresh),
          sign: async () => {
            assert.equal((await f.delivery()).observed_height, "103");
            throw new Error("Signer unavailable");
          },
        })
      ).status,
      "unavailable",
    );
    assert.equal((await f.delivery()).observed_height, "103");
    const older = structuredClone(fresh);
    older.block = { ...fresh.block, height: "102", hash: encodeBase58(Buffer.alloc(32, 15)) };
    assert.equal(
      (
        await deliveryProcess(f.config, f.row.id, {
          ...f.gateway,
          read: async () => structuredClone(older),
        })
      ).status,
      "conflict",
    );
    assert.equal((await f.delivery()).observed_height, "103");
    assert.deepEqual(f.counts(), { signatures: 0, submissions: 0 });
  } finally {
    await f.cleanup();
  }
});
