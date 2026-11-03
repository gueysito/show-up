import type pg from "pg";
import { hash } from "../auth/crypto";
import { AppFailure } from "../http/security";

export type PrivacySession = {
  accountId: string;
  tokenHash: string;
  state: "active" | "deletion_requested";
};

// Restricted read/recovery access never grants active-account authority for new
// wallets, roles, events or financial commitments.
export async function findPrivacySession(
  pool: pg.Pool,
  value?: string,
): Promise<PrivacySession | null> {
  if (!value || !/^[\w-]{43}$/.test(value)) return null;
  const tokenHash = hash(value);
  const row = (
    await pool.query(
      `SELECT a.id,a.state FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
    WHERE s.token_hash=$1 AND a.state IN ('active','deletion_requested') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,
      [tokenHash],
    )
  ).rows[0];
  return row ? { accountId: row.id, state: row.state, tokenHash } : null;
}

export async function requirePrivacyActor(client: pg.PoolClient, sessionHash: string) {
  const row = (
    await client.query(
      `SELECT a.id,a.state,a.created_at FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
    WHERE s.token_hash=$1 AND a.state IN ('active','deletion_requested') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF a,s`,
      [sessionHash],
    )
  ).rows[0];
  if (!row) throw new AppFailure(401, "Sign in again to access your private data.");
  return {
    id: row.id as string,
    state: row.state as PrivacySession["state"],
    createdAt: row.created_at as Date,
  };
}
