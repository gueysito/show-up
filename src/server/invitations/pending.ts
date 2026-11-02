import type pg from "pg";
import { hash, seal, unseal } from "../auth/crypto";
import { AppFailure } from "../http/security";

export const invitationCookie = "__Host-showup-invitation";

export async function inspectInvitation(pool: pg.Pool, value: string) {
  if (!/^[\w-]{43}$/.test(value)) throw new AppFailure(404, "Invitation unavailable.");
  const result = await pool.query(
    `SELECT kind,event_id AS "eventId",expires_at AS "expiresAt",
    (revoked_at IS NOT NULL) AS revoked,(redeemed_at IS NOT NULL) AS redeemed
    FROM app_invitations WHERE token_hash=$1`,
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
