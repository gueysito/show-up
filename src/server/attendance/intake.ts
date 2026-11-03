import { randomUUID } from "node:crypto";
import type pg from "pg";
import { hash } from "../auth/crypto";
import { mutate, type Actor } from "../auth/mutations";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { attendanceSchedule } from "./evidence";

type Action =
  | "attendance.code-attempt"
  | "attendance.qr-issued"
  | "attendance.qr-scanned"
  | "attendance.qr-confirmed";
type Receipt = {
  id: string | null;
  eventId: string;
  actorId: string;
  operationId: string;
  requestHash: string;
};
// This journal records known authenticated work. It cannot attest to requests
// lost before this boundary, continuous service health or external ingress.
export async function attendanceMutation<T>(
  received: number,
  pool: pg.Pool,
  encryptionKey: string,
  sessionHash: string,
  operationId: string,
  request: Record<string, unknown>,
  action: Action,
  work: (client: pg.PoolClient, actor: Actor) => Promise<T>,
  relatedAccounts: readonly string[] = [],
): Promise<T> {
  if (
    !isUuid(operationId) ||
    !isUuid(request.eventId) ||
    !Number.isSafeInteger(received) ||
    received < 0
  )
    throw new AppFailure(400, "Choose the original private attendance action.");
  const eventId = request.eventId,
    requestHash = hash(JSON.stringify({ action, request }));
  const receipt = await transaction(pool, async (client): Promise<Receipt> => {
    const actor = (
      await client.query(
        `SELECT a.id FROM app_sessions s JOIN app_accounts a ON a.id=s.account_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND a.state='active' FOR SHARE OF a,s`,
        [sessionHash],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(401, "Sign in again to continue.");
    const base = { eventId, actorId: actor.id as string, operationId, requestHash };
    const previous = (
      await client.query("SELECT actor_id,request_hash FROM app_mutations WHERE operation_id=$1", [
        operationId,
      ])
    ).rows[0];
    if (previous) {
      if (previous.actor_id !== actor.id || previous.request_hash !== requestHash)
        throw new AppFailure(
          409,
          "This operation reference was already used for a different request.",
        );
      return { ...base, id: null };
    }
    const event = (
      await client.query(
        "SELECT owner_id,published_at,data->>'mode' AS mode,data->>'startsAt' AS starts,data->>'endsAt' AS ends FROM app_events WHERE id=$1 FOR SHARE",
        [eventId],
      )
    ).rows[0];
    if (!event) throw new AppFailure(404, "Private event authorization unavailable.");
    if (action === "attendance.code-attempt" || action === "attendance.qr-issued") {
      if (
        !isUuid(request.consentId) ||
        !(
          await client.query(
            "SELECT 1 FROM app_commitment_consents WHERE id=$1 AND event_id=$2 AND account_id=$3",
            [request.consentId, eventId, actor.id],
          )
        ).rowCount
      )
        throw new AppFailure(404, "Private event authorization unavailable.");
    } else if (
      !(
        await client.query(
          `SELECT 1 WHERE
      ($1::uuid=$2::uuid AND EXISTS(SELECT 1 FROM app_roles WHERE account_id=$2 AND role='host'))
      OR EXISTS(SELECT 1 FROM app_event_validators WHERE event_id=$3 AND account_id=$2
        AND revoked_at IS NULL AND assigned_at<=$4)`,
          [event.owner_id, actor.id, eventId, event.published_at],
        )
      ).rowCount
    )
      throw new AppFailure(
        403,
        "Only this event's published host or assigned validator can confirm presence.",
      );
    if (event.mode !== (action === "attendance.code-attempt" ? "digital" : "physical"))
      throw new AppFailure(409, "Choose the published attendance mode for this event.");
    const schedule = attendanceSchedule(Date.parse(event.starts), Date.parse(event.ends));
    if (
      action === "attendance.code-attempt" &&
      (
        await client.query(
          `SELECT 1 FROM app_attendance_candidates WHERE event_id=$1 AND account_id=$2
      AND consent_id=$3 AND environment=$4`,
          [eventId, actor.id, request.consentId, request.environment],
        )
      ).rowCount
    )
      return { ...base, id: null };
    // Out-of-window requests cannot establish an attendance-service outage.
    // The action still performs its own authoritative timing/eligibility checks.
    if (received < schedule.opensAt || received > schedule.cutoff) return { ...base, id: null };
    if (
      (
        await client.query("SELECT 1 FROM app_attendance_evidence_barriers WHERE event_id=$1", [
          eventId,
        ])
      ).rowCount
    )
      throw new AppFailure(
        409,
        "Attendance evidence collection is closed; no new check-in was recorded.",
      );
    await client.query(
      "INSERT INTO app_attendance_intake_events(event_id) VALUES($1) ON CONFLICT DO NOTHING",
      [eventId],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO app_attendance_intakes(id,event_id,account_id,operation_id,request_hash,action,received_at_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, eventId, actor.id, operationId, requestHash, action, received],
    );
    await client.query(
      `UPDATE app_attendance_intake_events SET revision=revision+1,
      received_count=received_count+1,pending_count=pending_count+1 WHERE event_id=$1`,
      [eventId],
    );
    return { ...base, id };
  });
  try {
    const result = await mutate(
      pool,
      encryptionKey,
      sessionHash,
      operationId,
      request,
      action,
      work,
      relatedAccounts,
    );
    await complete(pool, receipt, "receipt");
    return result;
  } catch (error) {
    await complete(
      pool,
      receipt,
      error instanceof AppFailure && error.status >= 400 && error.status < 500
        ? "rejected"
        : "unavailable",
    );
    throw error;
  }
}
async function complete(
  pool: pg.Pool,
  receipt: Receipt,
  outcome: "receipt" | "rejected" | "unavailable",
) {
  await transaction(pool, async (client) => {
    await client.query("SELECT id FROM app_events WHERE id=$1 FOR SHARE", [receipt.eventId]);
    if (outcome === "unavailable") {
      // Preserve unresolved work. A later successful immutable receipt may drain
      // retries, but the known service failure remains latched for this event.
      if (
        receipt.id &&
        (
          await client.query(
            "SELECT 1 FROM app_attendance_intakes WHERE id=$1 AND completed_at IS NULL",
            [receipt.id],
          )
        ).rowCount
      )
        await client.query(
          `UPDATE app_attendance_intake_events SET revision=revision+1,had_unavailable=true
          WHERE event_id=$1 AND NOT had_unavailable`,
          [receipt.eventId],
        );
      return;
    }
    const result = await client.query(
      `UPDATE app_attendance_intakes SET completed_at=clock_timestamp(),outcome=$6
      WHERE event_id=$1 AND account_id=$2 AND completed_at IS NULL
      AND (($6='receipt' AND operation_id=$3 AND request_hash=$4) OR id=$5::uuid) RETURNING id`,
      [
        receipt.eventId,
        receipt.actorId,
        receipt.operationId,
        receipt.requestHash,
        receipt.id,
        outcome,
      ],
    );
    if (result.rowCount)
      await client.query(
        `UPDATE app_attendance_intake_events SET revision=revision+1,
      pending_count=pending_count-$2 WHERE event_id=$1`,
        [receipt.eventId, result.rowCount],
      );
  });
}
export async function attendanceIntakeSnapshot(client: pg.PoolClient, eventId: string) {
  const row = (
    await client.query("SELECT * FROM app_attendance_intake_events WHERE event_id=$1", [eventId])
  ).rows[0];
  if (!row) return null;
  const channels = { code_entry: "0", qr_issue: "0", qr_scan: "0", presence_confirmation: "0" },
    names = {
      "attendance.code-attempt": "code_entry",
      "attendance.qr-issued": "qr_issue",
      "attendance.qr-scanned": "qr_scan",
      "attendance.qr-confirmed": "presence_confirmation",
    } as const;
  const counts = await client.query(
    "SELECT action,count(*) AS count FROM app_attendance_intakes WHERE event_id=$1 GROUP BY action",
    [eventId],
  );
  let total = 0n;
  for (const count of counts.rows) {
    const name = names[count.action as keyof typeof names];
    if (!name) throw new Error("Unknown intake channel");
    channels[name] = String(count.count);
    total += BigInt(count.count);
  }
  if (total !== BigInt(row.received_count))
    throw new AppFailure(409, "Complete intake channel metadata is unavailable.");
  return {
    revision: String(row.revision),
    received: String(row.received_count),
    pending: String(row.pending_count),
    hadUnavailable: row.had_unavailable as boolean,
    channels,
  };
}
export async function knownAttendanceIntake(client: pg.PoolClient, eventId: string) {
  const snapshot = await attendanceIntakeSnapshot(client, eventId);
  if (!snapshot) return null;
  if (BigInt(snapshot.pending) !== 0n || snapshot.hadUnavailable)
    throw new AppFailure(
      409,
      "Unresolved intake or a recorded service failure prevents normal closing.",
    );
  return snapshot;
}
