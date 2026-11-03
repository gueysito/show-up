import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { checkpointFixture } from "../fixtures/attendance-checkpoint";
import { issueAttendanceQr } from "../../src/server/attendance/qr";
import {
  prepareAttendanceCheckpoint,
  attendanceCheckpointMaterial,
} from "../../src/server/attendance/journal";
import { signFixtureCoverage } from "../fixtures/intake-coverage";
import { AppFailure } from "../../src/server/http/security";
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;

test("an action for the wrong attendance mode cannot manufacture a service outage", async () => {
  const f = await checkpointFixture(false);
  try {
    await assert.rejects(
      issueAttendanceQr(
        f.pool,
        f.config,
        f.session,
        { eventId: f.eventId, consentId: f.consent.id, operationId: randomUUID() },
        f.engineering,
      ),
      status(409),
    );
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_attendance_intake_events WHERE event_id=$1", [
          f.eventId,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("normal checkpoint preparation requires bound signed coverage even with all accepted receipt/source evidence", async () => {
  const f = await checkpointFixture();
  try {
    await f.freeze();
    const request = { eventId: f.eventId, sources: [f.observed], accepted: f.accepted };
    await assert.rejects(prepareAttendanceCheckpoint(f.pool, f.config, request, f.at), status(409));
    const complete = await f.coverage(),
      missing = structuredClone(complete.packet);
    missing.intervals = missing.intervals.filter((interval) => interval.channel !== "admission");
    await assert.rejects(
      prepareAttendanceCheckpoint(
        f.pool,
        f.config,
        { ...request, coverage: signFixtureCoverage(missing, f.key.privateKey) },
        f.at,
      ),
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
    const prepared = await prepareAttendanceCheckpoint(
      f.pool,
      f.config,
      { ...request, coverage: complete },
      f.at,
    );
    const row = (
        await f.pool.query("SELECT * FROM app_attendance_checkpoints WHERE id=$1", [prepared.id])
      ).rows[0],
      barrier = (
        await f.pool.query("SELECT * FROM app_attendance_evidence_barriers WHERE event_id=$1", [
          f.eventId,
        ])
      ).rows[0];
    assert.deepEqual(
      attendanceCheckpointMaterial(f.config, row, barrier).bundle.coverage,
      complete,
    );
    assert.equal(
      (
        await prepareAttendanceCheckpoint(
          f.pool,
          f.config,
          { ...request, coverage: complete },
          f.at,
        )
      ).id,
      prepared.id,
    );
  } finally {
    await f.cleanup();
  }
});
