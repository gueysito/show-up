import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { DraftFailure } from "../events/drafts";

export const workspaceCookie = "showup-harness-workspace";

export async function getWorkspace(pool: pg.Pool, token: string | undefined, create: boolean) {
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const hash = createHash("sha256").update(token).digest("hex");
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM harness_workspaces WHERE token_hash=$1 AND expires_at > now()",
      [hash],
    );
    if (result.rows[0]) return { id: result.rows[0].id, token: null };
  }
  if (!create) throw new DraftFailure(401, "Workspace expired. Reload to start a new workspace.");
  const newToken = randomBytes(32).toString("hex");
  const id = randomUUID();
  await pool.query(
    "INSERT INTO harness_workspaces (id,token_hash,expires_at) VALUES ($1,$2,now()+interval '24 hours')",
    [id, createHash("sha256").update(newToken).digest("hex")],
  );
  return { id, token: newToken };
}

export async function rateLimit(pool: pg.Pool, id: string) {
  const result = await pool.query(
    `UPDATE harness_workspaces SET
     request_count = CASE WHEN window_started_at < now()-interval '1 minute' THEN 1 ELSE request_count+1 END,
     window_started_at = CASE WHEN window_started_at < now()-interval '1 minute' THEN now() ELSE window_started_at END
     WHERE id=$1 AND (request_count < 60 OR window_started_at < now()-interval '1 minute') RETURNING id`,
    [id],
  );
  if (!result.rowCount)
    throw new DraftFailure(429, "Too many workspace requests. Wait a minute and retry.");
}
