import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { checkpointFixture } from "../fixtures/attendance-checkpoint";
import { attemptAttendanceCode } from "../../src/server/attendance/attempts";
import { AppFailure } from "../../src/server/http/security";
import { knownAttendanceIntake } from "../../src/server/attendance/intake";
import { exportOwnData } from "../../src/server/privacy/export";
import { hash } from "../../src/server/auth/crypto";
import { retirePrivacyRecords } from "../../src/server/privacy/retention";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { confirmedDeletion } from "../fixtures/deletion";
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Intake boundary was not reached before the test deadline");
}
for (const boundary of ["before_candidate", "after_candidate"] as const) {
  test(`actual SIGKILL ${boundary}: durable intake blocks freezing until the original immutable operation drains`, async () => {
    const f = await checkpointFixture(false),
      hold = await f.pool.connect(),
      ack = await f.pool.connect();
    const operationId = randomUUID(),
      input = f.input(undefined, operationId);
    const child = fork("tests/fixtures/attendance-intake-process.ts", [], {
      execArgv: ["--import", "tsx"],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        SHOWUP_ENV: "test",
        DATABASE_URL: "postgresql://showup@127.0.0.1:55433/showup_test",
      },
    });
    try {
      await hold.query("BEGIN");
      await hold.query("SELECT id FROM app_attendance_code_windows WHERE id=$1 FOR UPDATE", [
        f.window.id,
      ]);
      child.send({
        encryptionKey: f.config.encryptionKey,
        indexKey: f.config.indexKey,
        session: f.session,
        input,
        engineering: f.engineering,
      });
      await waitFor(async () =>
        Boolean(
          (
            await f.pool.query(
              "SELECT 1 FROM app_attendance_intakes WHERE operation_id=$1 AND completed_at IS NULL",
              [operationId],
            )
          ).rowCount,
        ),
      );
      if (boundary === "after_candidate") {
        await ack.query("BEGIN");
        await ack.query("SELECT id FROM app_attendance_intakes WHERE operation_id=$1 FOR UPDATE", [
          operationId,
        ]);
        await hold.query("ROLLBACK");
        await waitFor(async () =>
          Boolean(
            (await f.pool.query("SELECT 1 FROM app_mutations WHERE operation_id=$1", [operationId]))
              .rowCount,
          ),
        );
      }
      const stopped = once(child, "exit");
      assert(child.kill("SIGKILL"));
      const [code, signal] = await stopped;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      await hold.query("ROLLBACK");
      await ack.query("ROLLBACK");
      const original = (
        await f.pool.query(
          "SELECT candidate_hash,encrypted_candidate FROM app_attendance_candidates WHERE event_id=$1",
          [f.eventId],
        )
      ).rows[0];
      assert.equal(Boolean(original), boundary === "after_candidate");
      await assert.rejects(f.freeze(), status(409));
      const result = await f.attempt(undefined, operationId);
      assert.equal(result.status, "pending_contract");
      const row = (
        await f.pool.query(
          "SELECT candidate_hash,encrypted_candidate FROM app_attendance_candidates WHERE event_id=$1",
          [f.eventId],
        )
      ).rows;
      assert.equal(row.length, 1);
      if (original) assert.deepEqual(row[0], original);
      const summary = (
        await f.pool.query("SELECT * FROM app_attendance_intake_events WHERE event_id=$1", [
          f.eventId,
        ])
      ).rows[0];
      assert.equal(summary.pending_count, "0");
      assert.equal(summary.had_unavailable, false);
      assert.equal(summary.received_count, boundary === "after_candidate" ? "1" : "2");
      assert.equal((await f.freeze()).candidateCount, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGKILL");
        await stopped;
      }
      await hold.query("ROLLBACK");
      await ack.query("ROLLBACK");
      hold.release();
      ack.release();
      await f.cleanup();
    }
  });
}

test("a real backend decryption failure stays latched after successful same-operation recovery", async () => {
  const f = await checkpointFixture(false),
    operation = randomUUID();
  try {
    await assert.rejects(
      attemptAttendanceCode(
        f.pool,
        { ...f.config, encryptionKey: "0".repeat(64) },
        f.session,
        f.input(undefined, operation),
        f.engineering,
      ),
    );
    let summary = (
      await f.pool.query("SELECT * FROM app_attendance_intake_events WHERE event_id=$1", [
        f.eventId,
      ])
    ).rows[0];
    assert.equal(summary.pending_count, "1");
    assert.equal(summary.had_unavailable, true);
    await assert.rejects(f.freeze(), status(409));
    await f.attempt(undefined, operation);
    summary = (
      await f.pool.query("SELECT * FROM app_attendance_intake_events WHERE event_id=$1", [
        f.eventId,
      ])
    ).rows[0];
    assert.equal(summary.pending_count, "0");
    assert.equal(summary.had_unavailable, true);
    await assert.rejects(f.freeze(), status(409));
    const own = await exportOwnData(f.pool, f.config, f.session),
      staff = await exportOwnData(f.pool, f.config, hash(f.accounts[2].value));
    assert.equal(own.attendanceIntakes.length, 2);
    assert.deepEqual(staff.attendanceIntakes, []);
    assert.deepEqual(Object.keys(own.attendanceIntakes[0]).sort(), [
      "action",
      "completed_at",
      "event_id",
      "outcome",
      "received_at_ms",
    ]);
    await f.pool.query(
      "UPDATE app_attendance_intakes SET completed_at=now()-interval '91 days' WHERE event_id=$1",
      [f.eventId],
    );
    assert.equal((await retirePrivacyRecords(f.pool, undefined, 1)).intakes, 1);
    assert.equal(
      (
        await f.pool.query("SELECT count(*) FROM app_attendance_intakes WHERE event_id=$1", [
          f.eventId,
        ])
      ).rows[0].count,
      "1",
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT had_unavailable FROM app_attendance_intake_events WHERE event_id=$1",
          [f.eventId],
        )
      ).rows[0].had_unavailable,
      true,
    );
  } finally {
    await f.cleanup();
  }
});

test("rejected and out-of-window work cannot manufacture a known attendance outage or expose foreign metadata", async () => {
  const f = await checkpointFixture(false);
  try {
    const source = structuredClone(f.engineering);
    (source.source.context.authorization.payout as Record<string, unknown>).address =
      "other-fixture.near";
    await assert.rejects(f.attempt(undefined, randomUUID(), source), status(409));
    const client = await f.pool.connect();
    try {
      const known = await knownAttendanceIntake(client, f.eventId);
      assert.equal(known?.pending, "0");
      assert.equal(known?.hadUnavailable, false);
    } finally {
      client.release();
    }
    const before = (
      await f.pool.query(
        "SELECT received_count FROM app_attendance_intake_events WHERE event_id=$1",
        [f.eventId],
      )
    ).rows[0].received_count;
    await assert.rejects(
      attemptAttendanceCode(f.pool, f.config, f.session, f.input(), undefined, f.at + 10_000_000),
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT received_count FROM app_attendance_intake_events WHERE event_id=$1",
          [f.eventId],
        )
      ).rows[0].received_count,
      before,
    );
    await assert.rejects(
      attemptAttendanceCode(f.pool, f.config, hash(f.accounts[2].value), f.input(), f.engineering),
      status(404),
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT received_count FROM app_attendance_intake_events WHERE event_id=$1",
          [f.eventId],
        )
      ).rows[0].received_count,
      before,
    );
    assert.equal((await f.freeze()).candidateCount, 0);
  } finally {
    await f.cleanup();
  }
});

test("normal checkpoint preparation refuses a changed frozen intake aggregate", async () => {
  const f = await checkpointFixture();
  try {
    await f.freeze();
    await f.prepare();
    await f.pool.query(
      "UPDATE app_attendance_intake_events SET revision=revision+1 WHERE event_id=$1",
      [f.eventId],
    );
    await assert.rejects(f.prepare(), status(409));
  } finally {
    await f.cleanup();
  }
});

test("restricted account deletion preserves unresolved intake and its event failure aggregate", async () => {
  const f = await checkpointFixture(false);
  try {
    await assert.rejects(
      attemptAttendanceCode(
        f.pool,
        { ...f.config, encryptionKey: "0".repeat(64) },
        f.session,
        f.input(),
        f.engineering,
      ),
    );
    const before = (
      await f.pool.query("SELECT * FROM app_attendance_intake_events WHERE event_id=$1", [
        f.eventId,
      ])
    ).rows[0];
    const deletion = await requestAccountDeletion(
      f.pool,
      f.config,
      f.session,
      confirmedDeletion(f.config, f.accounts[0].id, f.session),
    );
    assert.equal(deletion.state, "pending_reconciliation");
    const after = (
      await f.pool.query("SELECT * FROM app_attendance_intake_events WHERE event_id=$1", [
        f.eventId,
      ])
    ).rows[0];
    assert.deepEqual(after, before);
    assert.equal(after.had_unavailable, true);
    assert.equal(after.pending_count, "1");
    const own = await exportOwnData(f.pool, f.config, hash(deletion.sessionValue!));
    assert.equal(own.attendanceIntakes.length, 1);
    assert.equal(own.attendanceIntakes[0].completed_at, null);
    await assert.rejects(f.freeze(), status(409));
  } finally {
    await f.cleanup();
  }
});
