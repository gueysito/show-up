import { settlementObservationFollows } from "../server/commitments/reconciliation";
import { recordWorkerSourceObservation, workerSourceObservation } from "./source-observation";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../server/auth/config";
import { hash, seal, unseal } from "../server/auth/crypto";
import { databaseConfig } from "../server/config";
import { transaction } from "../server/db/client";
import { isUuid } from "../server/events/drafts";
import { AppFailure } from "../server/http/security";
import { canonicalHash, canonicalJson } from "../server/protocol/canonical";
import { record } from "../server/protocol/quote-signature";
import {
  settlementContextHash,
  validateSettlementState,
  type SettlementContext,
} from "../server/protocol/settlement-state";
import type { SandboxAttendanceObservation } from "../server/attendance/admission";
import { attendanceCheckpointMaterial } from "../server/attendance/journal";
import {
  verifyAttendanceCheckpoint,
  type AttendanceCheckpoint,
} from "../server/attendance/checkpoint-wire";

export type SandboxClosingGateway = {
  context: SettlementContext;
  evidencePublicKey: string;
  read: (signal: AbortSignal) => Promise<SandboxAttendanceObservation>;
  sign: (checkpoint: AttendanceCheckpoint, signal: AbortSignal) => Promise<string>;
  submit: (
    checkpoint: AttendanceCheckpoint,
    signature: string,
    signal: AbortSignal,
  ) => Promise<void>;
};
type Keys = Pick<AuthConfig, "encryptionKey" | "origin">;
type Facts = ReturnType<typeof validateSettlementState>;
type Signed = { checkpointHash: string; profileHash: string; signature: string };
class SourceConflict extends Error {}

function summary(row: Record<string, unknown>) {
  return {
    eventId: row.event_id as string,
    checkpointId: row.checkpoint_id as string,
    status: row.state as string,
    attempts: row.attempts as number,
    sourceQualified: false as const,
    settlementConfirmed: false as const,
    liveSubmissionAllowed: false as const,
  };
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>) {
  const signal = AbortSignal.timeout(10_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Closing gateway deadline")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function eventProfile(context: SettlementContext, evidencePublicKey: string) {
  return canonicalHash({
    context: Object.fromEntries(Object.entries(context).filter(([key]) => key !== "authorization")),
    evidencePublicKey,
  });
}

// Backend-only engineering entrypoint. No runtime flag or ordinary worker startup
// constructs a signing gateway. A complete live intake watermark is still required.
export async function runSandboxAttendanceClosing(
  pool: pg.Pool,
  config: Keys,
  checkpointId: string,
  gateway: SandboxClosingGateway,
) {
  const context = structuredClone(gateway.context),
    evidencePublicKey = gateway.evidencePublicKey;
  if (
    !isUuid(checkpointId) ||
    databaseConfig().purpose !== "test" ||
    new URL(config.origin).hostname !== "localhost" ||
    context.environment !== "sandbox" ||
    context.domain !== "showup.sandbox.authorization.v1" ||
    !(await pool.query("SELECT current_database()='showup_test' AS disposable")).rows[0].disposable
  )
    throw new AppFailure(409, "Closing delivery requires localhost/disposable sandbox context.");
  const checkpointRow = (
    await pool.query("SELECT * FROM app_attendance_checkpoints WHERE id=$1", [checkpointId])
  ).rows[0];
  if (!checkpointRow) throw new AppFailure(404, "Closing checkpoint unavailable.");
  const barrier = (
    await pool.query("SELECT * FROM app_attendance_evidence_barriers WHERE event_id=$1", [
      checkpointRow.event_id,
    ])
  ).rows[0];
  const { bundle, frozen } = attendanceCheckpointMaterial(config, checkpointRow, barrier),
    checkpoint = bundle.packet.checkpoint,
    baseline = bundle.observations.find(
      (facts) => facts.registrationId === record(context.authorization).registration,
    ),
    contextHash = settlementContextHash(context),
    profileHash = canonicalHash({ contextHash, evidencePublicKey }),
    claimToken = randomUUID();
  if (
    eventProfile(context, evidencePublicKey) !== frozen.contextHash ||
    evidencePublicKey !== frozen.evidencePublicKey ||
    !baseline ||
    baseline.registration?.authorizationHash !== canonicalHash(context.authorization) ||
    checkpoint.event !== context.event ||
    checkpoint.rules_hash !== context.rulesHash
  )
    throw new AppFailure(409, "The closing profile differs from the frozen event evidence.");
  function signed(row: Record<string, unknown>) {
    if (!row.encrypted_signed) return null;
    const value = unseal(
      config.encryptionKey,
      `attendance-closing:${checkpointId}`,
      row.encrypted_signed as string,
    ) as Signed;
    if (
      value.checkpointHash !== checkpointRow.checkpoint_hash ||
      value.profileHash !== profileHash ||
      hash(value.signature) !== row.signed_hash ||
      !verifyAttendanceCheckpoint(checkpoint, value.signature, evidencePublicKey)
    )
      throw new SourceConflict("Stored closing signature binding differs");
    return value;
  }
  const claimed = await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO app_attendance_closings(event_id,checkpoint_id,profile_hash) VALUES($1,$2,$3)
       ON CONFLICT(event_id) DO NOTHING`,
      [checkpointRow.event_id, checkpointId, profileHash],
    );
    const row = (
      await client.query("SELECT * FROM app_attendance_closings WHERE event_id=$1 FOR UPDATE", [
        checkpointRow.event_id,
      ])
    ).rows[0];
    if (row.checkpoint_id !== checkpointId || row.profile_hash !== profileHash)
      throw new AppFailure(409, "The original closing checkpoint and profile cannot be replaced.");
    if (row.state === "observed" && !signed(row)) throw new SourceConflict("Closing proof missing");
    if (["observed", "conflict", "awaiting_reconciliation"].includes(row.state))
      return { row, claimed: false };
    if (
      (await client.query("SELECT $1::timestamptz>clock_timestamp() AS held", [row.claim_until]))
        .rows[0].held
    )
      return { row, claimed: false };
    return {
      row: (
        await client.query(
          `UPDATE app_attendance_closings SET state='processing',claim_token=$2,
         claim_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1,updated_at=clock_timestamp()
         WHERE event_id=$1 RETURNING *`,
          [row.event_id, claimToken],
        )
      ).rows[0],
      claimed: true,
    };
  });
  if (!claimed.claimed) return summary(claimed.row);
  let stage: "read" | "sign" | "submit" = "read",
    submitted = false;
  async function finish(state: string, error: string | null, facts?: Facts) {
    return transaction(pool, async (client) => {
      await client.query(
        `UPDATE app_attendance_closings SET state=$3,last_error=$4,claim_token=NULL,claim_until=NULL,
         observed_height=COALESCE($5,observed_height),observed_hash=COALESCE($6,observed_hash),
         encrypted_observation=COALESCE($7,encrypted_observation),updated_at=clock_timestamp()
         WHERE checkpoint_id=$1 AND claim_token=$2`,
        [
          checkpointId,
          claimToken,
          state,
          error,
          facts?.block.height ?? null,
          facts?.block.hash ?? null,
          facts
            ? seal(config.encryptionKey, `attendance-closing-observation:${checkpointId}`, facts)
            : null,
        ],
      );
      return summary(
        (
          await client.query("SELECT * FROM app_attendance_closings WHERE checkpoint_id=$1", [
            checkpointId,
          ])
        ).rows[0],
      );
    });
  }
  let previous = baseline!,
    restored = false;
  async function read() {
    stage = "read";
    const source = structuredClone(await bounded((signal) => gateway.read(signal)));
    let facts: Facts;
    try {
      if (settlementContextHash(source.context) !== contextHash) throw new SourceConflict();
      facts = validateSettlementState(context, source.views, source.block);
    } catch {
      throw new SourceConflict("Closing source context or facts differ");
    }
    if (!restored) {
      const stored = workerSourceObservation(config, "closing", checkpointId, claimed.row);
      if (stored && !settlementObservationFollows(previous, stored))
        throw new SourceConflict("Stored closing source regressed");
      previous = stored ?? previous;
      restored = true;
    }
    if (
      !settlementObservationFollows(previous, facts) ||
      canonicalJson(facts.funded) !== canonicalJson(baseline!.funded) ||
      facts.attendance !== baseline!.attendance ||
      facts.registration?.attendance !== baseline!.registration?.attendance
    )
      throw new SourceConflict("Closing source regressed or its frozen attendee set changed");
    const expectedState = baseline!.attendance === 0 ? "aborted" : "closed";
    if (facts.eventState === "published") {
      const withoutBlock = (value: Facts) =>
        Object.fromEntries(Object.entries(value).filter(([key]) => key !== "block"));
      const before = withoutBlock(baseline!),
        current = withoutBlock(facts);
      if (canonicalJson(before) !== canonicalJson(current))
        throw new SourceConflict("Closing ledger changed");
    } else if (
      facts.eventState !== expectedState ||
      facts.ledgerVersion !== checkpoint.ledger_version
    )
      throw new SourceConflict("Closing outcome differs from the frozen decision");
    await recordWorkerSourceObservation(pool, config, "closing", checkpointId, claimToken, facts);
    previous = facts;
    return { source, facts };
  }
  try {
    let current = await read(),
      proof = signed(claimed.row);
    if (current.facts.eventState !== "published")
      return finish(
        proof ? "observed" : "awaiting_reconciliation",
        proof ? null : "source_conflict",
        current.facts,
      );
    function expired() {
      return current.facts.block.timestampMs > checkpoint.expires_ms;
    }
    if (expired()) return finish("awaiting_reconciliation", "checkpoint_expired", current.facts);
    function windowPending() {
      const event = record(current.source.views.event),
        terms = record(event.terms);
      return (
        current.facts.block.timestampMs < checkpoint.complete_through_ms + 300_000 ||
        (event.ended_ms === null &&
          current.facts.block.timestampMs < Number(terms.end_ms) + 2_100_000)
      );
    }
    if (windowPending()) return finish("unavailable", "source_unavailable", current.facts);
    if (!proof) {
      stage = "sign";
      const signature = await bounded((signal) =>
        gateway.sign(structuredClone(checkpoint), signal),
      );
      if (!verifyAttendanceCheckpoint(checkpoint, signature, evidencePublicKey))
        throw new SourceConflict("Invalid closing authority signature");
      proof = { checkpointHash: checkpointRow.checkpoint_hash, profileHash, signature };
      const persisted = await pool.query(
        `UPDATE app_attendance_closings SET signed_hash=$3,encrypted_signed=$4,updated_at=clock_timestamp()
         WHERE checkpoint_id=$1 AND claim_token=$2`,
        [
          checkpointId,
          claimToken,
          hash(signature),
          seal(config.encryptionKey, `attendance-closing:${checkpointId}`, proof),
        ],
      );
      if (!persisted.rowCount) return finish("unavailable", "source_unavailable");
    }
    current = await read();
    if (current.facts.eventState !== "published") return finish("observed", null, current.facts);
    if (expired()) return finish("awaiting_reconciliation", "checkpoint_expired", current.facts);
    if (windowPending()) return finish("unavailable", "source_unavailable", current.facts);
    const ready = await pool.query(
      `UPDATE app_attendance_closings SET state='broadcast_unknown',updated_at=clock_timestamp()
       WHERE checkpoint_id=$1 AND claim_token=$2`,
      [checkpointId, claimToken],
    );
    if (!ready.rowCount) return finish("unavailable", "source_unavailable");
    stage = "submit";
    submitted = true;
    await bounded((signal) =>
      gateway.submit(structuredClone(checkpoint), proof!.signature, signal),
    );
    current = await read();
    return finish(
      current.facts.eventState === "published" ? "broadcast_unknown" : "observed",
      current.facts.eventState === "published" ? "submission_unknown" : null,
      current.facts,
    );
  } catch (error) {
    if (error instanceof SourceConflict) return finish("conflict", "source_conflict");
    return finish(
      submitted ? "broadcast_unknown" : "unavailable",
      submitted
        ? "submission_unknown"
        : stage === "sign"
          ? "signing_unavailable"
          : "source_unavailable",
    );
  }
}
