import type pg from "pg";
import { hash, seal, unseal } from "../auth/crypto";
import { AppFailure } from "../http/security";

export const invitationCookie = "__Host-showup-invitation";

export async function inspectInvitation(pool: pg.Pool, value: string) {
  if (!/^[\w-]{43}$/.test(value)) throw new AppFailure(404, "Invitation unavailable.");
  const result = await pool.query(
    `SELECT i.kind,i.event_id AS "eventId",i.expires_at AS "expiresAt",
    (i.revoked_at IS NOT NULL) AS revoked,(i.redeemed_at IS NOT NULL) AS redeemed,
    e.data->>'title' AS "eventTitle",e.data->>'startsAt' AS "startsAt",e.data->>'timeZone' AS "timeZone"
    FROM app_invitations i LEFT JOIN app_events e ON e.id=i.event_id WHERE i.token_hash=$1`,
    [hash(value)],
  );
  const row = result.rows[0];
  if (!row) throw new AppFailure(404, "Invitation unavailable.");
  return row as {
    kind: string;
    eventId: string | null;
    expiresAt: Date;
    revoked: boolean;
    redeemed: boolean;
    eventTitle: string | null;
    startsAt: string | null;
    timeZone: string | null;
  };
}

export function pendingInvitation(key: string, value?: string): string | null {
  if (!value) return null;
  try {
    const pending = unseal(key, "pending-invitation", value) as {
      token: string;
      expiresAt: number;
    };
    return pending.expiresAt > Date.now() && /^[\w-]{43}$/.test(pending.token)
      ? pending.token
      : null;
  } catch {
    return null;
  }
}

export function encodePendingInvitation(key: string, value: string) {
  return seal(key, "pending-invitation", { token: value, expiresAt: Date.now() + 15 * 60000 });
}
