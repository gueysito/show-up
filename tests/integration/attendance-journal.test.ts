import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, randomBytes, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { attendanceFixtures } from "../fixtures/attendance";
import {
  attendanceCandidateMaterial,
  persistAttendanceCandidate,
} from "../../src/server/attendance/attempts";
import { loadAttendanceAdmission } from "../../src/server/attendance/admission";
import {
  freezeAttendanceEvidence,
  prepareAttendanceCheckpoint,
} from "../../src/server/attendance/journal";
import { activateHostCodeWindow } from "../../src/server/attendance/codes";
import { hash, unseal } from "../../src/server/auth/crypto";
import { AppFailure } from "../../src/server/http/security";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { parseRpcJson } from "../../src/server/protocol/rpc";
import { exportOwnData } from "../../src/server/privacy/export";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { confirmedDeletion } from "../fixtures/deletion";
import { runSandboxAttendanceDelivery } from "../../src/worker/attendance";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Evidence journal checks require disposable data");
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
async function fixture(withCandidate = true, withQuiz = false, ledgerVersion?: bigint) {
  const f = await attendanceFixtures("digital", withQuiz);
  if (withCandidate) await f.attempt();
  const row = (
    await f.pool.query("SELECT * FROM app_attendance_candidates WHERE event_id=$1", [f.eventId])
  ).rows[0];
  const candidate = row ? attendanceCandidateMaterial(f.config, row) : null;
  const observed = structuredClone(f.source),
    event = observed.views.event as Record<string, unknown>,
    terms = event.terms as { end_ms: number };
  const at = terms.end_ms - 600_000;
  event.attendance = withCandidate ? 1 : 0;
  event.ledger_version = ledgerVersion ?? (withCandidate ? 2 : 1);
  event.ended_ms = at - 300_000;
  (observed.views.registration as { attendance: string | null }).attendance =
    candidate?.packet.classification ?? null;
  observed.block = { height: "101", hash: encodeBase58(Buffer.alloc(32, 9)), timestampMs: at };
  const key = generateKeyPairSync("ed25519"),
    publicKey = Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url").toString(
      "base64",
    );
  const accepted = candidate
    ? [
        {
          candidateId: row.id as string,
          receipt: candidate.packet.receipt,
          proof: sign(null, Buffer.from(candidate.packet.canonical), key.privateKey).toString(
            "base64",
          ),
        },
      ]
    : [];
  if (candidate) {
    const delivered = await runSandboxAttendanceDelivery(f.pool, f.config, row.id, {
      context: f.source.context,
      evidencePublicKey: publicKey,
      read: async () => structuredClone(observed),
      sign: async () => accepted[0].proof,
      submit: async () => {
        throw new Error("Observed fixture receipt must not be submitted again");
      },
    });
    assert.equal(delivered.status, "observed");
  }
  const freeze = (source = observed, now = at, authority = publicKey) =>
    freezeAttendanceEvidence(f.pool, f.config, f.eventId, source, authority, now);
  const prepare = (sources = [observed], evidence = accepted, now = at) =>
    prepareAttendanceCheckpoint(
      f.pool,
      f.config,
      { eventId: f.eventId, sources, accepted: evidence },
      now,
    );
  return { ...f, row, candidate, observed, at, accepted, publicKey, freeze, prepare };
}

test("a frozen accepted-candidate manifest and signed contract observations produce one persistent restart-safe sandbox checkpoint", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.prepare(), status(409));
    const barriers = await Promise.all(Array.from({ length: 6 }, () => f.freeze()));
    assert.equal(new Set(barriers.map((value) => value.frozenAt)).size, 1);
    assert.equal(barriers[0].candidateCount, 1);
    const checkpoints = await Promise.all(Array.from({ length: 6 }, () => f.prepare()));
    assert.equal(new Set(checkpoints.map((value) => value.id)).size, 1);
    assert.equal(checkpoints[0].status, "sandbox_checkpoint_prepared");
    assert.equal(checkpoints[0].sourceQualified, false);
    assert.equal(checkpoints[0].liveSubmissionAllowed, false);
    const row = (
      await f.pool.query("SELECT * FROM app_attendance_checkpoints WHERE event_id=$1", [f.eventId])
    ).rows[0];
    const stored = unseal(
      f.config.encryptionKey,
      `attendance-checkpoint:${f.eventId}:${row.id}`,
      row.encrypted_checkpoint,
    ) as { accepted: unknown[] };
    assert.deepEqual(stored.accepted, f.accepted);
    assert.deepEqual(await f.prepare(), checkpoints[0]);
    const hostSession = hash(f.accounts[1].value),
      host = await exportOwnData(f.pool, f.config, hostSession),
      attendee = await exportOwnData(f.pool, f.config, f.session);
    assert.equal(host.hostedEvidenceBarriers.length, 1);
    assert.equal(host.hostedAttendanceCheckpoints.length, 1);
    assert.equal(attendee.hostedEvidenceBarriers.length, 0);
    assert.equal(attendee.hostedAttendanceCheckpoints.length, 0);
    assert.equal(
      JSON.stringify(host.hostedAttendanceCheckpoints).includes(f.accepted[0].proof),
      false,
    );
    const deleted = await requestAccountDeletion(
      f.pool,
      f.config,
      hostSession,
      confirmedDeletion(f.config, f.accounts[1].id, hostSession),
    );
    assert.equal(deleted.state, "pending_reconciliation");
    const recovery = await exportOwnData(f.pool, f.config, hash(deleted.sessionValue!));
    assert.deepEqual(recovery.hostedAttendanceCheckpoints, host.hostedAttendanceCheckpoints);
    assert.equal(
      (
        await f.pool.query(
          "SELECT encrypted_checkpoint FROM app_attendance_checkpoints WHERE id=$1",
          [row.id],
        )
      ).rows[0].encrypted_checkpoint,
      row.encrypted_checkpoint,
    );
  } finally {
    await f.cleanup();
  }
});

test("freezing denies new admission and host rotations while original candidate retries remain read-only", async () => {
  const f = await fixture(false);
  try {
    await assert.rejects(f.freeze(f.observed, f.at - 1), status(409));
    await f.freeze();
    await assert.rejects(f.attempt(), status(409));
    await assert.rejects(
      activateHostCodeWindow(f.pool, f.config, hash(f.accounts[1].value), {
        eventId: f.eventId,
        operationId: randomUUID(),
        phrase: "Never activated after freeze",
      }),
      status(409),
    );
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
      0,
    );
    const neutral = await f.prepare();
    assert.equal(neutral.checkpoint.ledger_version, "1");
  } finally {
    await f.cleanup();
  }
  const replay = await fixture();
  try {
    await replay.freeze();
    const original = await replay.attempt();
    assert(original.status === "pending_contract");
    assert.equal(original.id, replay.row.id);
    assert.equal(
      (
        await replay.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [
          replay.eventId,
        ])
      ).rowCount,
      1,
    );
  } finally {
    await replay.cleanup();
  }
});

test("freezing waits for an admitted candidate transaction and includes its committed result before closing the set", async () => {
  const f = await fixture(false),
    writer = await f.pool.connect(),
    probe = await f.pool.connect();
  let pending: ReturnType<typeof f.freeze> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT id FROM app_accounts WHERE id=$1 FOR UPDATE", [f.accounts[0].id]);
    await writer.query("SELECT id FROM app_events WHERE id=$1 FOR SHARE", [f.eventId]);
    pending = f.freeze();
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      waiting = (
        await probe.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM app_events WHERE id=%FOR UPDATE') AS waiting`)
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true);
    const admitted = await loadAttendanceAdmission(
      writer,
      f.config,
      f.accounts[0].id,
      f.eventId,
      f.consent.id,
      f.received,
      randomBytes(32).toString("hex"),
      "live_code",
      f.engineering,
    );
    const stored = await persistAttendanceCandidate(writer, f.config, admitted, f.window.id);
    await writer.query("COMMIT");
    assert.equal((await pending).candidateCount, 1);
    const row = (
      await f.pool.query("SELECT * FROM app_attendance_evidence_barriers WHERE event_id=$1", [
        f.eventId,
      ])
    ).rows[0];
    const value = unseal(
      f.config.encryptionKey,
      `attendance-barrier:${f.eventId}`,
      row.encrypted_manifest,
    ) as { items: { id: string }[] };
    assert.equal(value.items[0].id, stored.id);
    await assert.rejects(f.prepare(), status(409));
  } finally {
    await writer.query("ROLLBACK");
    await pending?.catch(() => {});
    probe.release();
    writer.release();
    await f.cleanup();
  }
});

test("missing, duplicate, changed or wrongly signed evidence never produces a normal-close packet", async () => {
  const f = await fixture();
  try {
    await f.freeze();
    await assert.rejects(f.prepare([f.observed], []), status(409));
    await assert.rejects(f.prepare([f.observed], [...f.accepted, ...f.accepted]), status(409));
    await assert.rejects(
      f.prepare([f.observed], [{ ...f.accepted[0], proof: "a".repeat(88) }]),
      status(409),
    );
    await assert.rejects(
      f.prepare(
        [f.observed],
        [{ ...f.accepted[0], receipt: { ...f.accepted[0].receipt, nonce: "f".repeat(64) } }],
      ),
      status(409),
    );
    await assert.rejects(
      f.freeze(f.observed, f.at, Buffer.alloc(32, 4).toString("base64")),
      status(409),
    );
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_attendance_checkpoints WHERE event_id=$1", [
          f.eventId,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("source forks, stale ledgers and observations without the accepted classification are rejected without replacing the manifest", async () => {
  const f = await fixture();
  try {
    await f.freeze();
    const before = (
      await f.pool.query(
        "SELECT manifest_hash,encrypted_manifest FROM app_attendance_evidence_barriers WHERE event_id=$1",
        [f.eventId],
      )
    ).rows[0];
    const fork = structuredClone(f.observed);
    fork.block.hash = encodeBase58(Buffer.alloc(32, 10));
    await assert.rejects(f.prepare([fork]), status(409));
    const missing = structuredClone(f.observed);
    (missing.views.event as { attendance: number; ledger_version: number }).attendance = 0;
    (missing.views.event as { attendance: number; ledger_version: number }).ledger_version = 1;
    (missing.views.registration as { attendance: null }).attendance = null;
    missing.block.height = "102";
    missing.block.hash = encodeBase58(Buffer.alloc(32, 11));
    await assert.rejects(f.prepare([missing]), status(409));
    const unended = structuredClone(f.observed);
    (unended.views.event as { ended_ms: null }).ended_ms = null;
    unended.block.height = "102";
    await assert.rejects(f.prepare([unended]), status(409));
    await assert.rejects(f.prepare([f.observed], f.accepted, f.at + 2_700_001), status(410));
    const after = (
      await f.pool.query(
        "SELECT manifest_hash,encrypted_manifest FROM app_attendance_evidence_barriers WHERE event_id=$1",
        [f.eventId],
      )
    ).rows[0];
    assert.deepEqual(after, before);
  } finally {
    await f.cleanup();
  }
});

test("unreconciled quiz, nonlocal origin and live-profile context cannot freeze a sandbox closing journal", async () => {
  const f = await fixture(false, true);
  try {
    await assert.rejects(
      f.freeze(),
      (error) =>
        status(409)(error) && (error as AppFailure).message.includes("Complete quiz evidence"),
    );
    await assert.rejects(
      freezeAttendanceEvidence(
        f.pool,
        { ...f.config, origin: "https://other.invalid" },
        f.eventId,
        f.observed,
        f.publicKey,
        f.at,
      ),
      status(409),
    );
    const live = structuredClone(f.observed);
    live.context.environment = "mainnet";
    await assert.rejects(f.freeze(live), status(409));
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_attendance_evidence_barriers WHERE event_id=$1", [
          f.eventId,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("unsafe-range u64 ledger versions survive PostgreSQL and bare-number checkpoint wire without rounding", async () => {
  const f = await fixture(true, false, 18446744073709551615n);
  try {
    await f.freeze();
    const packet = await f.prepare();
    assert.equal(packet.checkpoint.ledger_version, "18446744073709551615");
    assert.equal(
      (parseRpcJson(packet.wire) as { ledger_version: bigint }).ledger_version,
      18446744073709551615n,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT ledger_version FROM app_attendance_checkpoints WHERE event_id=$1",
          [f.eventId],
        )
      ).rows[0].ledger_version,
      "18446744073709551615",
    );
  } finally {
    await f.cleanup();
  }
});

test("evidence-barrier migration rolls back and bounds checkpoint u64 columns", async () => {
  const f = await fixture(false),
    client = await f.pool.connect(),
    schema = `journal_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query("CREATE TABLE app_events(id uuid PRIMARY KEY)");
    await client.query(await readFile("migrations/017-attendance-evidence-barriers.sql", "utf8"));
    await client.query("INSERT INTO app_events VALUES($1)", [f.eventId]);
    await client.query(
      `INSERT INTO app_attendance_evidence_barriers VALUES($1,'sandbox',$2,0,300000,0,$2,'opaque')`,
      [f.eventId, "a".repeat(64)],
    );
    await client.query("SAVEPOINT overflow");
    await assert.rejects(
      client.query(
        `INSERT INTO app_attendance_checkpoints VALUES($1,$2,$3,1,'block',18446744073709551616,'opaque')`,
        [randomUUID(), f.eventId, "b".repeat(64)],
      ),
      (error) => (error as { code: string }).code === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT overflow");
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
