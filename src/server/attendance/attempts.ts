import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { seal, unseal } from "../auth/crypto";
import { attendanceMutation } from "./intake";
import { isUuid } from "../events/drafts";
import { contractReference } from "../commitments/contract-authorization";
import { AppFailure } from "../http/security";
import { canonicalHash } from "../protocol/canonical";
import {
  loadAttendanceAdmission,
  receivedAttendanceTime,
  type AttendanceEngineeringInput,
} from "./admission";
import { attendanceCodeIndex, attendanceCodeWindowOpen } from "./codes";
import type { AttendanceClass } from "./evidence";

export type OwnAttendanceCandidate = {
  id: string;
  eventId: string;
  consentId: string;
  environment: "sandbox" | "mainnet";
  classification: AttendanceClass;
  receivedAt: string;
  status: "pending_contract";
  attendanceConfirmed: false;
  liveSubmissionAllowed: false;
};
export type CodeAttemptResult =
  | { status: "incorrect_code" | "attempt_limit"; remainingAttempts: number }
  | { status: "window_closed" }
  | OwnAttendanceCandidate;

export type AttendanceCandidateInput = Awaited<ReturnType<typeof loadAttendanceAdmission>> & {
  validator?: { credential: string; scanId: string; scannedAt: number; confirmedAt: number };
};

export async function persistAttendanceCandidate(
  client: pg.PoolClient,
  config: Pick<AuthConfig, "encryptionKey">,
  candidate: AttendanceCandidateInput,
  windowId: string | null = null,
) {
  await client.query("SELECT id FROM app_events WHERE id=$1 FOR SHARE", [
    candidate.binding.eventId,
  ]);
  if (
    (
      await client.query("SELECT 1 FROM app_attendance_evidence_barriers WHERE event_id=$1", [
        candidate.binding.eventId,
      ])
    ).rowCount
  )
    throw new AppFailure(
      409,
      "Attendance evidence collection is closed; no new check-in was recorded.",
    );
  const id = randomUUID();
  const row = (
    await client.query(
      `INSERT INTO app_attendance_candidates(id,event_id,account_id,consent_id,window_id,environment,classification,received_at,candidate_hash,encrypted_candidate)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id,
        candidate.binding.eventId,
        candidate.binding.accountId,
        candidate.binding.consentId,
        windowId,
        candidate.binding.environment,
        candidate.packet.classification,
        new Date(candidate.packet.receipt.received_ms),
        canonicalHash(candidate),
        seal(
          config.encryptionKey,
          `attendance-candidate:${candidate.binding.accountId}:${id}`,
          candidate,
        ),
      ],
    )
  ).rows[0];
  await client.query("INSERT INTO app_attendance_deliveries(candidate_id) VALUES($1)", [id]);
  return attendanceCandidateRecord(config, row);
}

export function attendanceCandidateMaterial(
  config: Pick<AuthConfig, "encryptionKey">,
  row: Record<string, unknown>,
): AttendanceCandidateInput {
  const value = unseal(
    config.encryptionKey,
    `attendance-candidate:${row.account_id}:${row.id}`,
    row.encrypted_candidate as string,
  ) as AttendanceCandidateInput;
  if (
    canonicalHash(value) !== row.candidate_hash ||
    value.binding.accountId !== row.account_id ||
    value.binding.eventId !== row.event_id ||
    value.binding.consentId !== row.consent_id ||
    value.binding.environment !== row.environment ||
    value.packet.receipt.event !== contractReference(row.event_id as string) ||
    value.packet.receipt.received_ms !== (row.received_at as Date).getTime() ||
    value.packet.classification !== row.classification
  )
    throw new Error("Attendance candidate integrity failure");
  return value;
}

export function attendanceCandidateRecord(
  config: Pick<AuthConfig, "encryptionKey">,
  row: Record<string, unknown>,
): OwnAttendanceCandidate {
  attendanceCandidateMaterial(config, row);
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    consentId: row.consent_id as string,
    environment: row.environment as "sandbox" | "mainnet",
    classification: row.classification as AttendanceClass,
    receivedAt: (row.received_at as Date).toISOString(),
    status: "pending_contract",
    attendanceConfirmed: false,
    liveSubmissionAllowed: false,
  };
}

export async function attemptAttendanceCode(
  pool: pg.Pool,
  config: AuthConfig,
  sessionHash: string,
  input: { eventId: string; consentId: string; operationId: string; phrase: unknown },
  engineering?: AttendanceEngineeringInput,
  serverReceivedMs?: number,
): Promise<CodeAttemptResult> {
  // Capture arrival before any lock wait. A browser cannot supply this value.
  const received = receivedAttendanceTime(engineering, serverReceivedMs);
  if (
    Object.keys(input).sort().join() !== "consentId,eventId,operationId,phrase" ||
    !isUuid(input.eventId) ||
    !isUuid(input.consentId)
  )
    throw new AppFailure(400, "Choose the original private event authorization.");
  const codeIndex = attendanceCodeIndex(config, input.eventId, input.phrase);
  return attendanceMutation(
    received,
    pool,
    config.encryptionKey,
    sessionHash,
    input.operationId,
    {
      eventId: input.eventId,
      consentId: input.consentId,
      codeIndex,
      environment: engineering ? "sandbox" : "mainnet",
    },
    "attendance.code-attempt",
    async (client, actor) => {
      const existing = (
        await client.query(
          "SELECT * FROM app_attendance_candidates WHERE event_id=$1 AND account_id=$2",
          [input.eventId, actor.id],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.consent_id !== input.consentId ||
          existing.environment !== (engineering ? "sandbox" : "mainnet")
        )
          throw new AppFailure(
            409,
            "Attendance was already recorded for its original authorization.",
          );
        return attendanceCandidateRecord(config, existing);
      }
      // Qualification precedes the code comparison, so unfunded callers do not
      // gain a word oracle. This emits no signature and never confirms a seat.
      const candidate = await loadAttendanceAdmission(
        client,
        config,
        actor.id,
        input.eventId,
        input.consentId,
        received,
        randomBytes(32).toString("hex"),
        "live_code",
        engineering,
      );
      const at = new Date(received).toISOString();
      const window = (
        await client.query(
          `SELECT * FROM app_attendance_code_windows WHERE event_id=$1 AND opened_at<=$2
      AND (retired_at IS NULL OR retired_at>$2) ORDER BY opened_at DESC,id DESC LIMIT 1 FOR SHARE`,
          [input.eventId, at],
        )
      ).rows[0];
      if (
        !window ||
        !attendanceCodeWindowOpen(
          window.opened_at.getTime(),
          window.expires_at.getTime(),
          received,
          window.retired_at?.getTime() ?? null,
        )
      )
        return { status: "window_closed" as const };
      const previous =
        (
          await client.query(
            "SELECT attempts FROM app_attendance_code_attempts WHERE window_id=$1 AND account_id=$2 FOR UPDATE",
            [window.id, actor.id],
          )
        ).rows[0]?.attempts ?? 0;
      if (previous >= 5) return { status: "attempt_limit" as const, remainingAttempts: 0 };
      await client.query(
        `INSERT INTO app_attendance_code_attempts(window_id,account_id,attempts) VALUES($1,$2,1)
      ON CONFLICT(window_id,account_id) DO UPDATE SET attempts=app_attendance_code_attempts.attempts+1`,
        [window.id, actor.id],
      );
      if (!timingSafeEqual(Buffer.from(window.code_index, "hex"), Buffer.from(codeIndex, "hex")))
        return { status: "incorrect_code" as const, remainingAttempts: 4 - previous };
      return persistAttendanceCandidate(client, config, candidate, window.id);
    },
  );
}
