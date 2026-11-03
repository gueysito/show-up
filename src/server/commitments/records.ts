import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { unseal } from "../auth/crypto";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { canonicalHash } from "../protocol/canonical";
import type { CommitmentConsent, ConsentTerms } from "./consent";
import { settlementWatchSnapshot } from "./reconciliation";
import { attendanceCandidateRecord, type OwnAttendanceCandidate } from "../attendance/attempts";
import { attendanceSchedule } from "../attendance/evidence";

export type OwnAttendanceWindow = {
  mode: "digital" | "physical";
  opensAt: string;
  onTimeThrough: string;
  cutoff: string;
};
function attendanceWindow(row: Record<string, unknown>): OwnAttendanceWindow | null {
  if (row.event_mode !== "digital" && row.event_mode !== "physical") return null;
  try {
    const schedule = attendanceSchedule(
      Date.parse(String(row.event_start)),
      Date.parse(String(row.event_end)),
    );
    return {
      mode: row.event_mode,
      opensAt: new Date(schedule.opensAt).toISOString(),
      onTimeThrough: new Date(schedule.onTimeThrough).toISOString(),
      cutoff: new Date(schedule.cutoff).toISOString(),
    };
  } catch {
    // A damaged event preview must not hide original financial obligations.
    return null;
  }
}

export type OwnReconciliation = {
  status:
    | "not_linked"
    | "awaiting_observation"
    | "source_unavailable"
    | "paused"
    | "unqualified_observation";
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  block: { height: string; hash: string; timestampMs: number } | null;
  principalRemaining: string | null;
  returnedRemaining: string | null;
  eventState: string | null;
  registrationState: string | null;
  sourceQualified: false;
};

export type OwnPrincipalRecovery = {
  status: string;
  lastEffect: "withdraw" | "fail_neutral" | null;
  updatedAt: string;
  requestReference: string;
  sourceQualified: false;
  paymentConfirmed: false;
};

export type OwnFinancialRecord = {
  id: string;
  eventId: string;
  eventTitle: string;
  eventState: string;
  terms: ConsentTerms;
  createdAt: string;
  authorizedAt: string | null;
  escrowState: "not_confirmed";
  fundingAllowed: false;
  reconciliation: OwnReconciliation;
  attendance: OwnAttendanceCandidate | null;
  attendanceWindow: OwnAttendanceWindow | null;
  principalRecovery: OwnPrincipalRecovery | null;
};
export async function listOwnFinancialRecords(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  before?: string,
  eventId?: string,
): Promise<{
  records: OwnFinancialRecord[];
  nextCursor: string | null;
}> {
  if ((before !== undefined && !isUuid(before)) || (eventId !== undefined && !isUuid(eventId)))
    throw new AppFailure(400, "Invalid financial history reference.");
  return transaction(pool, async (client) => {
    const current = await client.query(
      `SELECT a.id FROM app_sessions s JOIN app_accounts a ON a.id=s.account_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.state IN ('active','deletion_requested') FOR SHARE OF a,s`,
      [session],
    );
    if (!current.rowCount)
      throw new AppFailure(401, "Sign in again to view your financial authorizations.");
    const actor = current.rows[0].id;
    if (before) {
      const cursor = (
        await client.query(
          "SELECT id FROM app_commitment_consents WHERE id=$1 AND account_id=$2 AND ($3::uuid IS NULL OR event_id=$3)",
          [before, actor, eventId ?? null],
        )
      ).rows[0];
      if (!cursor) throw new AppFailure(404, "Private financial history unavailable.");
    }
    const result = await client.query(
      `SELECT c.*,e.data->>'title' AS event_title,e.state AS event_state,
      e.data->>'mode' AS event_mode,e.data->>'startsAt' AS event_start,e.data->>'endsAt' AS event_end
      FROM app_commitment_consents c JOIN app_events e ON e.id=c.event_id WHERE c.account_id=$1
      AND ($3::uuid IS NULL OR c.event_id=$3)
      AND ($2::uuid IS NULL OR (c.created_at,c.id)<(SELECT older.created_at,older.id
        FROM app_commitment_consents older WHERE older.id=$2 AND older.account_id=$1))
      ORDER BY c.created_at DESC,c.id DESC LIMIT 51`,
      [actor, before ?? null, eventId ?? null],
    );
    const rows = result.rows.slice(0, 50);
    const observations = await client.query(
      `SELECT l.consent_id,w.* FROM app_commitment_settlement_links l
      JOIN app_settlement_watches w ON w.id=l.watch_id WHERE l.consent_id=ANY($1::uuid[])`,
      [rows.map((row) => row.id)],
    );
    const linked = new Map(observations.rows.map((row) => [row.consent_id, row]));
    const recoveries = await client.query(
      `SELECT consent_id,state,last_effect,updated_at,request_hash FROM app_principal_recoveries
       WHERE consent_id=ANY($1::uuid[])`,
      [rows.map((row) => row.id)],
    );
    const recovery = new Map(recoveries.rows.map((row) => [row.consent_id, row]));
    const candidates = await client.query(
      "SELECT * FROM app_attendance_candidates WHERE account_id=$1 AND consent_id=ANY($2::uuid[])",
      [actor, rows.map((row) => row.id)],
    );
    const attendance = new Map(
      candidates.rows.map((row) => [row.consent_id, attendanceCandidateRecord(config, row)]),
    );
    const records = rows.map((row) => {
      const { consent } = unseal(
        config.encryptionKey,
        `commitment-consent:${actor}:${row.id}`,
        row.encrypted_consent,
      ) as { consent: CommitmentConsent };
      if (canonicalHash(consent) !== row.consent_hash)
        throw new Error("Financial record integrity failure");
      const observation = linked.get(row.id),
        snapshot = observation ? settlementWatchSnapshot(config, observation) : null;
      const reconciliation: OwnReconciliation = {
        status: !snapshot
          ? "not_linked"
          : snapshot.paused
            ? "paused"
            : !snapshot.facts
              ? observation!.last_attempt_at
                ? "source_unavailable"
                : "awaiting_observation"
              : snapshot.available
                ? "unqualified_observation"
                : "source_unavailable",
        lastSuccessAt: observation?.last_success_at?.toISOString() ?? null,
        lastAttemptAt: observation?.last_attempt_at?.toISOString() ?? null,
        block: snapshot?.facts?.block ?? null,
        principalRemaining: snapshot?.facts?.principal?.remaining ?? null,
        returnedRemaining: snapshot?.facts?.returned?.remaining ?? null,
        eventState: snapshot?.facts?.eventState ?? null,
        registrationState: snapshot?.facts?.registration?.state ?? null,
        sourceQualified: false,
      };
      return {
        id: row.id,
        eventId: row.event_id,
        eventTitle: row.event_title ?? "Event",
        eventState: row.event_state,
        terms: consent.terms,
        createdAt: row.created_at.toISOString(),
        authorizedAt: row.authorized_at?.toISOString() ?? null,
        escrowState: "not_confirmed" as const,
        fundingAllowed: false as const,
        reconciliation,
        attendance: attendance.get(row.id) ?? null,
        attendanceWindow: attendanceWindow(row),
        principalRecovery: recovery.has(row.id)
          ? {
              status: recovery.get(row.id)!.state as string,
              lastEffect: recovery.get(row.id)!.last_effect as OwnPrincipalRecovery["lastEffect"],
              updatedAt: recovery.get(row.id)!.updated_at.toISOString(),
              requestReference: recovery.get(row.id)!.request_hash as string,
              sourceQualified: false as const,
              paymentConfirmed: false as const,
            }
          : null,
      };
    });
    return { records, nextCursor: result.rows.length > 50 ? rows.at(-1)!.id : null };
  });
}
