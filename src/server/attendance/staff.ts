import type pg from "pg";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { attendanceSchedule } from "./evidence";

export type StaffAttendanceEvent = {
  eventId: string;
  title: string;
  assignment: "host" | "validator";
  opensAt: string;
  cutoff: string;
  timeZone: string;
};
// Discovery grants no attendance authority. Each POST independently rechecks the
// frozen credential/exclusion roster, current actor, original consent and source.
export async function listStaffAttendanceEvents(
  pool: pg.Pool,
  sessionHash: string,
  options: { eventId?: string; before?: string } = {},
): Promise<{ events: StaffAttendanceEvent[]; nextCursor: string | null }> {
  if (
    (options.eventId !== undefined && !isUuid(options.eventId)) ||
    (options.before !== undefined && !isUuid(options.before)) ||
    (options.eventId && options.before)
  )
    throw new AppFailure(400, "Choose an assigned physical event.");
  return transaction(pool, async (client) => {
    const actor = (
      await client.query(
        `SELECT a.id FROM app_sessions s JOIN app_accounts a ON a.id=s.account_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND a.state='active' FOR SHARE OF a,s`,
        [sessionHash],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(401, "Sign in again to review staff assignments.");
    const eligible = `WITH eligible AS (
      SELECT e.id,e.published_at,e.data->>'title' AS title,e.data->>'startsAt' AS starts,
      e.data->>'endsAt' AS ends,e.data->>'timeZone' AS zone,(e.owner_id=$1) AS host
      FROM app_events e WHERE e.state='published' AND e.published_at IS NOT NULL
      AND e.data->>'mode'='physical'
      AND EXISTS(SELECT 1 FROM app_event_credentials c WHERE c.event_id=e.id AND c.account_id=$1
        AND c.created_at<=e.published_at)
      AND ((e.owner_id=$1 AND EXISTS(SELECT 1 FROM app_roles r WHERE r.account_id=$1 AND r.role='host'))
        OR EXISTS(SELECT 1 FROM app_event_validators v WHERE v.event_id=e.id AND v.account_id=$1
        AND v.revoked_at IS NULL AND v.assigned_at<=e.published_at)))`;
    if (
      options.before &&
      !(
        await client.query(`${eligible} SELECT id FROM eligible WHERE id=$2`, [
          actor.id,
          options.before,
        ])
      ).rowCount
    )
      throw new AppFailure(404, "Private staff event history unavailable.");
    const result = await client.query(
      `${eligible} SELECT * FROM eligible
      WHERE ($2::uuid IS NULL OR (published_at,id)<(SELECT published_at,id FROM eligible WHERE id=$2))
      AND ($3::uuid IS NULL OR id=$3) ORDER BY published_at DESC,id DESC LIMIT 51`,
      [actor.id, options.before ?? null, options.eventId ?? null],
    );
    if (options.eventId && !result.rowCount)
      throw new AppFailure(404, "Assigned physical event unavailable.");
    return {
      events: result.rows.slice(0, 50).flatMap((row) => {
        try {
          const schedule = attendanceSchedule(Date.parse(row.starts), Date.parse(row.ends));
          new Intl.DateTimeFormat("en-US", { timeZone: row.zone }).format();
          if (typeof row.title !== "string" || !row.title || row.title.length > 240) return [];
          return [
            {
              eventId: row.id,
              title: row.title,
              assignment: row.host ? ("host" as const) : ("validator" as const),
              opensAt: new Date(schedule.opensAt).toISOString(),
              cutoff: new Date(schedule.cutoff).toISOString(),
              timeZone: row.zone,
            },
          ];
        } catch {
          return [];
        }
      }),
      nextCursor: result.rows.length > 50 ? result.rows[49].id : null,
    };
  });
}
