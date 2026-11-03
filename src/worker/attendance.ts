import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../server/auth/config";
import { hash, seal, unseal } from "../server/auth/crypto";
import { databaseConfig } from "../server/config";
import { transaction } from "../server/db/client";
import { isUuid } from "../server/events/drafts";
import { AppFailure } from "../server/http/security";
import { canonicalHash, canonicalJson } from "../server/protocol/canonical";
import {
  settlementContextHash,
  validateSettlementState,
  type SettlementContext,
} from "../server/protocol/settlement-state";
import {
  attendanceCandidateMaterial,
  type AttendanceCandidateInput,
} from "../server/attendance/attempts";
import { verifyAttendancePacket, type AttendanceReceipt } from "../server/attendance/evidence";
import type { SandboxAttendanceObservation } from "../server/attendance/admission";

export type SandboxAttendanceGateway = {
  context: SettlementContext;
  evidencePublicKey: string;
  read: (signal: AbortSignal) => Promise<SandboxAttendanceObservation>;
  sign: (receipt: AttendanceReceipt, signal: AbortSignal) => Promise<string>;
  submit: (receipt: AttendanceReceipt, signature: string, signal: AbortSignal) => Promise<void>;
};
type Keys = Pick<AuthConfig, "encryptionKey" | "origin">;
type Facts = ReturnType<typeof validateSettlementState>;
type SignedDelivery = {
  candidateHash: string;
  profileHash: string;
  receipt: AttendanceReceipt;
  signature: string;
  evidencePublicKey: string;
};
class SourceConflict extends Error {}

function summary(row: Record<string, unknown>) {
  return {
    candidateId: row.candidate_id as string,
    status: row.state as string,
    attempts: row.attempts as number,
    sourceQualified: false as const,
    attendanceConfirmed: false as const,
    liveSubmissionAllowed: false as const,
  };
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Attendance gateway deadline"));
    }, 10_000);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
function signedMaterial(
  config: Keys,
  row: Record<string, unknown>,
  candidate: AttendanceCandidateInput,
  candidateHash: string,
  profileHash: string,
  evidencePublicKey: string,
) {
  if (!row.encrypted_signed) return null;
  const value = unseal(
    config.encryptionKey,
    `attendance-delivery:${row.candidate_id}`,
    row.encrypted_signed as string,
  ) as SignedDelivery;
  if (
    value.candidateHash !== candidateHash ||
    value.profileHash !== profileHash ||
    value.evidencePublicKey !== evidencePublicKey ||
    hash(value.signature) !== row.signed_hash ||
    canonicalJson(value.receipt) !== candidate.packet.canonical ||
    !verifyAttendancePacket(candidate.packet, value.receipt, value.signature, evidencePublicKey)
  )
    throw new SourceConflict("Stored attendance signature binding differs");
  return value;
}

// Explicit sandbox engine only. No normal worker startup or HTTP flag constructs
// this gateway; it may not sign/broadcast on a public network or use owner data.
export async function runSandboxAttendanceDelivery(
  pool: pg.Pool,
  config: Keys,
  candidateId: string,
  gateway: SandboxAttendanceGateway,
) {
  const context = structuredClone(gateway.context),
    evidencePublicKey = gateway.evidencePublicKey;
  if (
    !isUuid(candidateId) ||
    databaseConfig().purpose !== "test" ||
    new URL(config.origin).hostname !== "localhost" ||
    context.environment !== "sandbox" ||
    context.domain !== "showup.sandbox.authorization.v1" ||
    !(await pool.query("SELECT current_database()='showup_test' AS disposable")).rows[0].disposable
  )
    throw new AppFailure(
      409,
      "Attendance delivery requires explicit localhost/disposable sandbox context.",
    );
  if (
    Buffer.from(evidencePublicKey, "base64").length !== 32 ||
    Buffer.from(evidencePublicKey, "base64").toString("base64") !== evidencePublicKey
  )
    throw new AppFailure(400, "Use the frozen sandbox evidence authority.");
  const original = (
    await pool.query("SELECT * FROM app_attendance_candidates WHERE id=$1", [candidateId])
  ).rows[0];
  if (!original) throw new AppFailure(404, "Attendance candidate unavailable.");
  const candidate = attendanceCandidateMaterial(config, original),
    contextHash = settlementContextHash(context);
  if (candidate.binding.environment !== "sandbox" || candidate.source.contextHash !== contextHash)
    throw new AppFailure(409, "The delivery profile differs from the original accepted candidate.");
  const profileHash = canonicalHash({ contextHash, evidencePublicKey }),
    claimToken = randomUUID();
  const claimed = await transaction(pool, async (client) => {
    const row = (
      await client.query(
        "SELECT * FROM app_attendance_deliveries WHERE candidate_id=$1 FOR UPDATE",
        [candidateId],
      )
    ).rows[0];
    if (!row) throw new AppFailure(404, "Attendance delivery unavailable.");
    if (row.profile_hash && row.profile_hash !== profileHash)
      throw new AppFailure(409, "The frozen attendance delivery profile cannot be replaced.");
    if (
      row.state === "observed" &&
      !signedMaterial(
        config,
        row,
        candidate,
        original.candidate_hash,
        profileHash,
        evidencePublicKey,
      )
    )
      throw new SourceConflict("Observed attendance lost its original signed evidence");
    if (["observed", "conflict", "awaiting_reconciliation"].includes(row.state))
      return { row, claimed: false };
    const held = (
      await client.query("SELECT $1::timestamptz>clock_timestamp() AS held", [row.claim_until])
    ).rows[0].held;
    if (held) return { row, claimed: false };
    const next = (
      await client.query(
        `UPDATE app_attendance_deliveries SET state='processing',profile_hash=$2,claim_token=$3,
      claim_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1,updated_at=clock_timestamp() WHERE candidate_id=$1 RETURNING *`,
        [candidateId, profileHash, claimToken],
      )
    ).rows[0];
    return { row: next, claimed: true };
  });
  if (!claimed.claimed) return summary(claimed.row);
  let stage: "read" | "sign" | "submit" = "read";
  async function finish(state: string, error: string | null, facts?: Facts) {
    return transaction(pool, async (client) => {
      await client.query(
        `UPDATE app_attendance_deliveries SET state=$3,last_error=$4,claim_token=NULL,claim_until=NULL,
        observed_height=COALESCE($5,observed_height),observed_hash=COALESCE($6,observed_hash),
        encrypted_observation=COALESCE($7,encrypted_observation),updated_at=clock_timestamp()
        WHERE candidate_id=$1 AND claim_token=$2`,
        [
          candidateId,
          claimToken,
          state,
          error,
          facts?.block.height ?? null,
          facts?.block.hash ?? null,
          facts
            ? seal(config.encryptionKey, `attendance-delivery-observation:${candidateId}`, facts)
            : null,
        ],
      );
      return summary(
        (
          await client.query("SELECT * FROM app_attendance_deliveries WHERE candidate_id=$1", [
            candidateId,
          ])
        ).rows[0],
      );
    });
  }
  async function read() {
    const source = await bounded((signal) => gateway.read(signal));
    let facts: Facts;
    try {
      if (settlementContextHash(source.context) !== contextHash)
        throw new SourceConflict("Attendance source context changed");
      facts = validateSettlementState(context, source.views, source.block);
    } catch {
      throw new SourceConflict("Attendance source evidence is invalid or changed");
    }
    if (
      BigInt(facts.block.height) < BigInt(candidate.source.facts.block.height) ||
      BigInt(facts.ledgerVersion) < BigInt(candidate.source.facts.ledgerVersion) ||
      facts.block.timestampMs < candidate.source.facts.block.timestampMs ||
      (facts.block.height === candidate.source.facts.block.height &&
        canonicalHash(facts) !== canonicalHash(candidate.source.facts))
    )
      throw new SourceConflict("Attendance source regressed");
    if (
      facts.registration?.attendance &&
      facts.registration.attendance !== candidate.packet.classification
    )
      throw new SourceConflict("Attendance classification differs");
    return facts;
  }
  function observed(facts: Facts) {
    return (
      facts.registration?.attendance === candidate.packet.classification &&
      facts.block.timestampMs >= candidate.packet.receipt.received_ms &&
      BigInt(facts.ledgerVersion) > BigInt(candidate.source.facts.ledgerVersion)
    );
  }
  try {
    let facts = await read();
    if (!observed(facts) && (facts.eventState !== "published" || !facts.registration?.booked))
      return finish("awaiting_reconciliation", "source_conflict", facts);
    if (
      !observed(facts) &&
      Math.max(Date.now(), facts.block.timestampMs) > candidate.packet.receipt.expires_ms
    )
      return finish("awaiting_reconciliation", "receipt_expired", facts);
    let signed = signedMaterial(
      config,
      claimed.row,
      candidate,
      original.candidate_hash,
      profileHash,
      evidencePublicKey,
    );
    if (!signed) {
      stage = "sign";
      const signature = await bounded((signal) => gateway.sign(candidate.packet.receipt, signal));
      if (
        !verifyAttendancePacket(
          candidate.packet,
          candidate.packet.receipt,
          signature,
          evidencePublicKey,
        )
      )
        throw new SourceConflict("Attendance signer differs from frozen authority");
      signed = {
        candidateHash: original.candidate_hash,
        profileHash,
        receipt: candidate.packet.receipt,
        signature,
        evidencePublicKey,
      };
      const saved = await pool.query(
        `UPDATE app_attendance_deliveries SET signed_hash=$3,encrypted_signed=$4,updated_at=clock_timestamp()
        WHERE candidate_id=$1 AND claim_token=$2 RETURNING candidate_id`,
        [
          candidateId,
          claimToken,
          hash(signature),
          seal(config.encryptionKey, `attendance-delivery:${candidateId}`, signed),
        ],
      );
      if (!saved.rowCount)
        return summary(
          (
            await pool.query("SELECT * FROM app_attendance_deliveries WHERE candidate_id=$1", [
              candidateId,
            ])
          ).rows[0],
        );
    }
    if (observed(facts)) return finish("observed", null, facts);
    stage = "read";
    facts = await read();
    if (observed(facts)) return finish("observed", null, facts);
    if (facts.eventState !== "published" || !facts.registration?.booked)
      return finish("awaiting_reconciliation", "source_conflict", facts);
    if (Math.max(Date.now(), facts.block.timestampMs) > candidate.packet.receipt.expires_ms)
      return finish("awaiting_reconciliation", "receipt_expired", facts);
    const sending = await pool.query(
      `UPDATE app_attendance_deliveries SET state='broadcast_unknown',updated_at=clock_timestamp()
      WHERE candidate_id=$1 AND claim_token=$2 RETURNING candidate_id`,
      [candidateId, claimToken],
    );
    if (!sending.rowCount)
      return summary(
        (
          await pool.query("SELECT * FROM app_attendance_deliveries WHERE candidate_id=$1", [
            candidateId,
          ])
        ).rows[0],
      );
    stage = "submit";
    await bounded((signal) => gateway.submit(signed.receipt, signed.signature, signal));
    facts = await read();
    return observed(facts)
      ? finish("observed", null, facts)
      : finish("broadcast_unknown", "submission_unknown", facts);
  } catch (error) {
    if (error instanceof SourceConflict) return finish("conflict", "source_conflict");
    return finish(
      stage === "submit" ? "broadcast_unknown" : "unavailable",
      stage === "sign"
        ? "signing_unavailable"
        : stage === "submit"
          ? "submission_unknown"
          : "source_unavailable",
    );
  }
}
