import { randomBytes, randomUUID } from "node:crypto";
import { personalAttendanceQr, type PersonalAttendanceQr } from "../../domain/attendance-qr";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { identityIndex, seal, token, unseal } from "../auth/crypto";
import { mutate, type Actor } from "../auth/mutations";
import { contractReference } from "../commitments/contract-authorization";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { canonicalJson } from "../protocol/canonical";
import {
  loadAttendanceAdmission,
  receivedAttendanceTime,
  type AttendanceEngineeringInput,
} from "./admission";
import { persistAttendanceCandidate } from "./attempts";
import { attendanceSchedule } from "./evidence";

export type AttendanceQr = PersonalAttendanceQr;
export type QrInspection = {
  scanId: string;
  eventId: string;
  alias: string;
  expiresAt: number;
  status: "presence_confirmation_required";
  attendanceConfirmed: false;
};

export function parseAttendanceQr(value: unknown): AttendanceQr {
  const parsed = personalAttendanceQr(value);
  if (!parsed) throw new AppFailure(400, "Scan a valid personal attendance QR.");
  return parsed;
}

function qrIndex(config: AuthConfig, payload: AttendanceQr) {
  return identityIndex(config.indexKey, "showup.attendance.qr.v1", canonicalJson(payload));
}
function checkIds(input: Record<string, unknown>, fields: string[]) {
  if (
    Object.keys(input).sort().join() !== [...fields].sort().join() ||
    fields
      .filter((key) => key !== "payload" && key !== "confirmPresence")
      .some((key) => !isUuid(input[key]))
  )
    throw new AppFailure(400, "Choose the original private attendance action.");
}
function qrOpen(row: Record<string, unknown>, received: number) {
  const issued = (row.issued_at as Date).getTime(),
    expires = (row.expires_at as Date).getTime();
  if (
    received < issued ||
    received >= issued + 60_000 ||
    received > expires ||
    (row.retired_at && received >= (row.retired_at as Date).getTime()) ||
    row.consumed_at
  )
    throw new AppFailure(
      410,
      "This personal QR is expired, replaced or already used. Request a fresh QR.",
    );
}
async function requireAttendee(client: pg.PoolClient, accountId: string) {
  if (
    !(await client.query("SELECT 1 FROM app_accounts WHERE id=$1 AND state='active'", [accountId]))
      .rowCount
  )
    throw new AppFailure(410, "This attendance credential is unavailable.");
}

async function validatorCredential(
  client: pg.PoolClient,
  config: AuthConfig,
  actor: Actor,
  eventId: string,
) {
  const event = (await client.query("SELECT * FROM app_events WHERE id=$1 FOR SHARE", [eventId]))
    .rows[0];
  if (
    !event ||
    event.state !== "published" ||
    !event.published_at ||
    event.data.mode !== "physical"
  )
    throw new AppFailure(404, "Assigned physical event unavailable.");
  const assigned = (
    await client.query(
      `SELECT 1 FROM app_event_validators WHERE event_id=$1 AND account_id=$2
    AND revoked_at IS NULL AND assigned_at<=$3`,
      [eventId, actor.id, event.published_at],
    )
  ).rowCount;
  if (!(event.owner_id === actor.id && actor.roles.includes("host")) && !assigned)
    throw new AppFailure(
      403,
      "Only this event's published host or assigned validator can confirm presence.",
    );
  const row = (
    await client.query(
      `SELECT encrypted_credential FROM app_event_credentials
    WHERE event_id=$1 AND account_id=$2 AND created_at<=$3`,
      [eventId, actor.id, event.published_at],
    )
  ).rows[0];
  if (!row) throw new AppFailure(403, "Published staff credential unavailable.");
  const credential = unseal(
    config.encryptionKey,
    `event-credential:${actor.id}:${eventId}`,
    row.encrypted_credential,
  );
  if (!isUuid(credential)) throw new Error("Validator credential integrity failure");
  return credential as string;
}

function requireFixedExclusion(
  admission: Awaited<ReturnType<typeof loadAttendanceAdmission>>,
  credential: string,
) {
  if (!admission.source.excluded.includes(contractReference(credential)))
    throw new AppFailure(
      409,
      "The evidence does not bind this validator to the published exclusion roster.",
    );
}

export async function issueAttendanceQr(
  pool: pg.Pool,
  config: AuthConfig,
  sessionHash: string,
  input: { eventId: string; consentId: string; operationId: string },
  engineering?: AttendanceEngineeringInput,
  serverReceivedMs?: number,
) {
  checkIds(input, ["eventId", "consentId", "operationId"]);
  const received = receivedAttendanceTime(engineering, serverReceivedMs);
  return mutate(
    pool,
    config.encryptionKey,
    sessionHash,
    input.operationId,
    { ...input, environment: engineering ? "sandbox" : "mainnet" },
    "attendance.qr-issued",
    async (client, actor) => {
      if (
        (
          await client.query(
            "SELECT 1 FROM app_attendance_candidates WHERE event_id=$1 AND account_id=$2",
            [input.eventId, actor.id],
          )
        ).rowCount
      )
        throw new AppFailure(409, "Attendance evidence is already pending for this event.");
      await loadAttendanceAdmission(
        client,
        config,
        actor.id,
        input.eventId,
        input.consentId,
        received,
        randomBytes(32).toString("hex"),
        "staff_qr",
        engineering,
      );
      const latest = (
        await client.query(
          "SELECT issued_at FROM app_attendance_qr WHERE event_id=$1 AND account_id=$2 ORDER BY issued_at DESC LIMIT 1",
          [input.eventId, actor.id],
        )
      ).rows[0];
      if (latest && received < latest.issued_at.getTime())
        throw new AppFailure(409, "A newer personal QR was already issued. Request a fresh QR.");
      const data = (await client.query("SELECT data FROM app_events WHERE id=$1", [input.eventId]))
        .rows[0].data;
      const cutoff = attendanceSchedule(Date.parse(data.startsAt), Date.parse(data.endsAt)).cutoff;
      const expiry = Math.min(received + 60_000, cutoff);
      if (expiry <= received)
        throw new AppFailure(409, "The attendance window is closing; a fresh QR cannot be issued.");
      const payload: AttendanceQr = {
        format: "showup.attendance.qr.v1",
        eventId: input.eventId,
        credential: token(),
        nonce: randomBytes(32).toString("hex"),
        expiresAt: expiry,
      };
      const id = randomUUID();
      await client.query(
        "UPDATE app_attendance_qr SET retired_at=$3 WHERE event_id=$1 AND account_id=$2 AND retired_at IS NULL AND consumed_at IS NULL",
        [input.eventId, actor.id, new Date(received)],
      );
      await client.query(
        `INSERT INTO app_attendance_qr(id,event_id,account_id,consent_id,credential_index,encrypted_payload,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          input.eventId,
          actor.id,
          input.consentId,
          qrIndex(config, payload),
          seal(config.encryptionKey, `attendance-qr:${actor.id}:${id}`, payload),
          new Date(received),
          new Date(expiry),
        ],
      );
      return {
        payload: canonicalJson(payload),
        expiresAt: expiry,
        status: "scan_required" as const,
        environment: "sandbox" as const,
        liveSubmissionAllowed: false as const,
        attendanceConfirmed: false as const,
      };
    },
  );
}

export async function scanAttendanceQr(
  pool: pg.Pool,
  config: AuthConfig,
  sessionHash: string,
  input: { eventId: string; operationId: string; payload: unknown },
  engineering?: AttendanceEngineeringInput,
  serverReceivedMs?: number,
): Promise<QrInspection> {
  checkIds(input, ["eventId", "operationId", "payload"]);
  const received = receivedAttendanceTime(engineering, serverReceivedMs),
    payload = parseAttendanceQr(input.payload);
  if (payload.eventId !== input.eventId)
    throw new AppFailure(400, "This QR belongs to another event.");
  const index = qrIndex(config, payload),
    peek = (
      await pool.query("SELECT account_id FROM app_attendance_qr WHERE credential_index=$1", [
        index,
      ])
    ).rows[0];
  if (!peek) throw new AppFailure(404, "Personal QR unavailable.");
  return mutate(
    pool,
    config.encryptionKey,
    sessionHash,
    input.operationId,
    { eventId: input.eventId, index, environment: engineering ? "sandbox" : "mainnet" },
    "attendance.qr-scanned",
    async (client, actor) => {
      const credential = await validatorCredential(client, config, actor, input.eventId);
      const row = (
        await client.query(
          "SELECT * FROM app_attendance_qr WHERE credential_index=$1 AND account_id=$2 FOR UPDATE",
          [index, peek.account_id],
        )
      ).rows[0];
      if (!row) throw new AppFailure(404, "Personal QR unavailable.");
      await requireAttendee(client, row.account_id);
      qrOpen(row, received);
      const original = unseal(
        config.encryptionKey,
        `attendance-qr:${row.account_id}:${row.id}`,
        row.encrypted_payload,
      );
      if (canonicalJson(original) !== canonicalJson(payload))
        throw new Error("QR payload integrity failure");
      const candidate = await loadAttendanceAdmission(
        client,
        config,
        row.account_id,
        input.eventId,
        row.consent_id,
        received,
        payload.nonce,
        "staff_qr",
        engineering,
      );
      requireFixedExclusion(candidate, credential);
      const scan = (
        await client.query(
          `INSERT INTO app_attendance_qr_scans(id,qr_id,validator_id,session_hash,scanned_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(qr_id,validator_id,session_hash) DO UPDATE SET qr_id=EXCLUDED.qr_id RETURNING *`,
          [randomUUID(), row.id, actor.id, sessionHash, new Date(received)],
        )
      ).rows[0];
      return {
        scanId: scan.id,
        eventId: input.eventId,
        alias: `Attendee ${identityIndex(config.indexKey, "showup.attendance.alias.v1", `${input.eventId}:${candidate.packet.receipt.participant}`).slice(0, 16)}`,
        expiresAt: payload.expiresAt,
        status: "presence_confirmation_required",
        attendanceConfirmed: false,
      };
    },
    [peek.account_id],
  );
}

export async function confirmAttendanceQr(
  pool: pg.Pool,
  config: AuthConfig,
  sessionHash: string,
  input: { eventId: string; operationId: string; scanId: string; confirmPresence: boolean },
  engineering?: AttendanceEngineeringInput,
  serverReceivedMs?: number,
) {
  checkIds(input, ["eventId", "operationId", "scanId", "confirmPresence"]);
  if (input.confirmPresence !== true)
    throw new AppFailure(
      400,
      "Inspect the scanned alias and explicitly confirm the person is present.",
    );
  const received = receivedAttendanceTime(engineering, serverReceivedMs);
  const peek = (
    await pool.query(
      `SELECT q.account_id FROM app_attendance_qr_scans s JOIN app_attendance_qr q ON q.id=s.qr_id
    WHERE s.id=$1 AND q.event_id=$2`,
      [input.scanId, input.eventId],
    )
  ).rows[0];
  if (!peek) throw new AppFailure(404, "Scanned attendance credential unavailable.");
  return mutate(
    pool,
    config.encryptionKey,
    sessionHash,
    input.operationId,
    { ...input, environment: engineering ? "sandbox" : "mainnet" },
    "attendance.qr-confirmed",
    async (client, actor) => {
      const credential = await validatorCredential(client, config, actor, input.eventId);
      const scan = (
        await client.query(
          `SELECT s.* FROM app_attendance_qr_scans s WHERE id=$1 AND validator_id=$2 AND session_hash=$3 FOR UPDATE`,
          [input.scanId, actor.id, sessionHash],
        )
      ).rows[0];
      if (!scan) throw new AppFailure(404, "Scan again with this signed-in validator session.");
      const row = (
        await client.query(
          "SELECT * FROM app_attendance_qr WHERE id=$1 AND event_id=$2 AND account_id=$3 FOR UPDATE",
          [scan.qr_id, input.eventId, peek.account_id],
        )
      ).rows[0];
      if (!row) throw new AppFailure(404, "Personal QR unavailable.");
      await requireAttendee(client, row.account_id);
      qrOpen(row, received);
      if (received < scan.scanned_at.getTime())
        throw new AppFailure(409, "Confirm presence after scanning.");
      if (
        (
          await client.query(
            "SELECT 1 FROM app_attendance_candidates WHERE event_id=$1 AND account_id=$2",
            [input.eventId, row.account_id],
          )
        ).rowCount
      )
        throw new AppFailure(409, "Attendance evidence is already pending for this event.");
      const payload = parseAttendanceQr(
        canonicalJson(
          unseal(
            config.encryptionKey,
            `attendance-qr:${row.account_id}:${row.id}`,
            row.encrypted_payload,
          ),
        ),
      );
      const admission = await loadAttendanceAdmission(
        client,
        config,
        row.account_id,
        input.eventId,
        row.consent_id,
        received,
        payload.nonce,
        "staff_qr",
        engineering,
      );
      requireFixedExclusion(admission, credential);
      const candidate = await persistAttendanceCandidate(client, config, {
        ...admission,
        validator: {
          credential,
          scanId: scan.id,
          scannedAt: scan.scanned_at.getTime(),
          confirmedAt: received,
        },
      });
      await client.query("UPDATE app_attendance_qr_scans SET confirmed_at=$2 WHERE id=$1", [
        scan.id,
        new Date(received),
      ]);
      await client.query(
        "UPDATE app_attendance_qr SET consumed_at=$2,candidate_id=$3 WHERE id=$1",
        [row.id, new Date(received), candidate.id],
      );
      // Staff sees the event alias and pending result, never the attendee account,
      // financial approval, source, proof or original candidate identifier.
      return {
        scanId: scan.id,
        eventId: input.eventId,
        status: "pending_contract" as const,
        attendanceConfirmed: false as const,
        liveSubmissionAllowed: false as const,
        receivedAt: candidate.receivedAt,
        classification: candidate.classification,
      };
    },
    [peek.account_id],
  );
}
