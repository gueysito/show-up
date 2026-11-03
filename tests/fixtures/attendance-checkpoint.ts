import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { attendanceFixtures } from "./attendance";
import { attendanceCandidateMaterial } from "../../src/server/attendance/attempts";
import {
  freezeAttendanceEvidence,
  prepareAttendanceCheckpoint,
} from "../../src/server/attendance/journal";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { runSandboxAttendanceDelivery } from "../../src/worker/attendance";
import { fixtureIntakeCoveragePacket, signFixtureCoverage } from "./intake-coverage";
export async function checkpointFixture(
  withCandidate = true,
  withQuiz = false,
  ledgerVersion?: bigint,
) {
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
  const coverage = async (source = observed) =>
    signFixtureCoverage(
      await fixtureIntakeCoveragePacket(f.pool, f.eventId, source),
      key.privateKey,
    );
  const prepare = async (sources = [observed], evidence = accepted, now = at) =>
    prepareAttendanceCheckpoint(
      f.pool,
      f.config,
      {
        eventId: f.eventId,
        sources,
        accepted: evidence,
        coverage: sources.length ? await coverage(sources[0]) : undefined,
      },
      now,
    );
  return {
    ...f,
    row,
    candidate,
    observed,
    at,
    accepted,
    publicKey,
    key,
    freeze,
    prepare,
    coverage,
  };
}
