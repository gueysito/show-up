import { randomUUID } from "node:crypto";
import type pg from "pg";
import { hash, token } from "./crypto";
import { AppFailure } from "../http/security";

export const sessionCookie = "__Host-showup-session";
export const browserCookie = "__Host-showup-login";
export const cookieOptions = { secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" };
export const sessionSeconds = 60 * 60 * 24;

export type Session = { accountId: string; tokenHash: string; roles: string[] };

export async function findSession(pool: pg.Pool, value?: string): Promise<Session | null> {
  if (!value || !/^[\w-]{43}$/.test(value)) return null;
  const tokenHash = hash(value);
  const result = await pool.query(
    `
    SELECT s.account_id FROM app_sessions s JOIN app_accounts a ON a.id=s.account_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
      AND a.state='active'`,
    [tokenHash],
  );
  if (!result.rowCount) return null;
  const accountId = result.rows[0].account_id as string;
  const roles = await pool.query("SELECT role FROM app_roles WHERE account_id=$1", [accountId]);
  return { accountId, tokenHash, roles: roles.rows.map((row) => row.role as string) };
}

export async function requireSession(pool: pg.Pool, value?: string) {
  const session = await findSession(pool, value);
  if (!session) throw new AppFailure(401, "Sign in again to continue.");
  return session;
}

export async function newSession(client: pg.PoolClient, accountId: string, previousHash?: string) {
  const value = token();
  if (previousHash)
    await client.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [
      previousHash,
    ]);
  await client.query(
    `INSERT INTO app_sessions (token_hash, account_id, expires_at)
    VALUES ($1,$2,clock_timestamp() + $3 * interval '1 second')`,
    [hash(value), accountId, sessionSeconds],
  );
  return value;
}

export async function revokeSession(pool: pg.Pool, session: Session, all = false) {
  await pool.query(
    `UPDATE app_sessions SET revoked_at=clock_timestamp()
    WHERE account_id=$1 AND ($2 OR token_hash=$3)`,
    [session.accountId, all, session.tokenHash],
  );
  await pool.query(
    "INSERT INTO app_audit (id, actor_id, action) VALUES ($1,$2,'session.revoked')",
    [randomUUID(), session.accountId],
  );
}
