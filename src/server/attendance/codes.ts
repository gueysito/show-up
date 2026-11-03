import { randomUUID } from "node:crypto";
import type pg from "pg";
import { normalizeAnswer, type EventDraft } from "../../domain/event-draft";
import type { AuthConfig } from "../auth/config";
import { identityIndex, seal, unseal } from "../auth/crypto";
import { hasRole, mutate } from "../auth/mutations";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { attendanceSchedule } from "./evidence";

type Keys = Pick<AuthConfig, "encryptionKey" | "indexKey">;
export type HostCodeWindow = {
  id: string;
  eventId: string;
  phrase: string;
  openedAt: string;
  expiresAt: string;
  active: boolean;
};

export function normalizeAttendanceCode(value: unknown) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 256)
    throw new AppFailure(422, "Choose a word or short phrase of at most 80 characters.");
  const normalized = normalizeAnswer(value);
  if (
    !normalized ||
    [...normalized].length > 80 ||
    /[\p{Cc}\p{Cf}]/u.test(normalized) ||
    Buffer.from(normalized).toString("utf8") !== normalized
  )
    throw new AppFailure(422, "Choose a visible word or short phrase of at most 80 characters.");
  return normalized;
}

export function attendanceCodeIndex(
  keys: Pick<Keys, "indexKey">,
  eventId: string,
  phrase: unknown,
) {
  if (!isUuid(eventId)) throw new AppFailure(400, "Choose a saved event.");
  return identityIndex(
    keys.indexKey,
    "showup.attendance.code.v1",
    JSON.stringify([eventId, normalizeAttendanceCode(phrase)]),
  );
}

export function attendanceCodeWindowOpen(
  opened: number,
  expires: number,
  received: number,
  retired: number | null = null,
) {
  return (
    [opened, expires, received, ...(retired === null ? [] : [retired])].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    expires > opened &&
    expires <= opened + 180_000 &&
    received >= opened &&
    received < opened + 180_000 &&
    received <= expires &&
    (retired === null || received < retired)
  );
}

async function serverTime(client: pg.PoolClient) {
  return Number(
    (await client.query("SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS ms"))
      .rows[0].ms,
  );
}

function windowFromRow(keys: Keys, row: Record<string, unknown>, now: number): HostCodeWindow {
  const code = unseal(
    keys.encryptionKey,
    `attendance-code:${row.event_id}:${row.id}`,
    row.encrypted_code as string,
  ) as { phrase: string };
  if (attendanceCodeIndex(keys, row.event_id as string, code.phrase) !== row.code_index)
    throw new Error("Attendance code integrity failure");
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    phrase: code.phrase,
    openedAt: (row.opened_at as Date).toISOString(),
    expiresAt: (row.expires_at as Date).toISOString(),
    active: attendanceCodeWindowOpen(
      (row.opened_at as Date).getTime(),
      (row.expires_at as Date).getTime(),
      now,
      (row.retired_at as Date | null)?.getTime() ?? null,
    ),
  };
}

export async function readHostCodeWindow(
  pool: pg.Pool,
  keys: Keys,
  sessionHash: string,
  eventId: string,
) {
  if (!isUuid(eventId)) throw new AppFailure(400, "Choose a saved event.");
  return transaction(pool, async (client) => {
    // Match mutation/deletion ordering: account/session before the event row.
    const actor = (
      await client.query(
        `SELECT a.id FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
        WHERE s.token_hash=$1 AND a.state='active' AND s.revoked_at IS NULL
        AND s.expires_at>clock_timestamp() AND EXISTS
        (SELECT 1 FROM app_roles r WHERE r.account_id=a.id AND r.role='host') FOR SHARE OF a,s`,
        [sessionHash],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(404, "Private event unavailable.");
    const event = (
      await client.query("SELECT id FROM app_events WHERE id=$1 AND owner_id=$2 FOR SHARE", [
        eventId,
        actor.id,
      ])
    ).rows[0];
    if (!event) throw new AppFailure(404, "Private event unavailable.");
    const row = (
      await client.query(
        "SELECT * FROM app_attendance_code_windows WHERE event_id=$1 AND retired_at IS NULL",
        [eventId],
      )
    ).rows[0];
    return row ? windowFromRow(keys, row, await serverTime(client)) : null;
  });
}

// Codes carry no money authority. Acceptance still needs a separately qualified,
// funded registration, persisted server receipt and exact contract evidence.
export async function activateHostCodeWindow(
  pool: pg.Pool,
  keys: Keys,
  sessionHash: string,
  input: { eventId: string; operationId: string; phrase: unknown },
) {
  const codeIndex = attendanceCodeIndex(keys, input.eventId, input.phrase),
    phrase = (input.phrase as string).trim();
  return mutate(
    pool,
    keys.encryptionKey,
    sessionHash,
    input.operationId,
    { eventId: input.eventId, codeIndex },
    "attendance.code-activated",
    async (client, actor) => {
      hasRole(actor, "host");
      const event = (
        await client.query("SELECT * FROM app_events WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
          input.eventId,
          actor.id,
        ])
      ).rows[0];
      if (!event) throw new AppFailure(404, "Private event unavailable.");
      const data = event.data as EventDraft;
      if (event.state !== "published" || data.mode !== "digital")
        throw new AppFailure(409, "Live codes require a published online event.");
      const now = await serverTime(client),
        schedule = attendanceSchedule(Date.parse(data.startsAt), Date.parse(data.endsAt));
      if (now < schedule.opensAt || now >= schedule.cutoff)
        throw new AppFailure(409, "The published check-in window is closed.");
      if (
        (
          await client.query(
            "SELECT 1 FROM app_attendance_code_windows WHERE event_id=$1 AND code_index=$2",
            [input.eventId, codeIndex],
          )
        ).rowCount
      )
        throw new AppFailure(409, "Choose a fresh phrase. This event already used that code.");
      const id = randomUUID(),
        openedAt = new Date(now).toISOString(),
        expiresAt = new Date(Math.min(now + 180_000, schedule.cutoff)).toISOString();
      await client.query(
        "UPDATE app_attendance_code_windows SET retired_at=$2 WHERE event_id=$1 AND retired_at IS NULL",
        [input.eventId, openedAt],
      );
      await client.query(
        `INSERT INTO app_attendance_code_windows(id,event_id,code_index,encrypted_code,opened_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          id,
          input.eventId,
          codeIndex,
          seal(keys.encryptionKey, `attendance-code:${input.eventId}:${id}`, { phrase }),
          openedAt,
          expiresAt,
        ],
      );
      return { id, eventId: input.eventId, openedAt, expiresAt };
    },
  );
}
