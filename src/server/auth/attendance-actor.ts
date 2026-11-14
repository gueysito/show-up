import type pg from "pg";
import { AppFailure } from "../http/security";

const replies = new WeakMap<object, string>();
declare const replyAuthority: unique symbol;
export type TelegramAttendanceActor = { readonly [replyAuthority]: true };
export type MutationCredential = string | TelegramAttendanceActor;
// A server-only, nonserializable capability for one persisted bot reply. No web
// session is created and no HTTP field can be used as this object.
export function telegramReplyCredential(replyId: string): TelegramAttendanceActor {
  const credential = Object.freeze({});
  replies.set(credential, replyId);
  return credential as TelegramAttendanceActor;
}
export async function mutationActor(
  client: pg.PoolClient,
  credential: MutationCredential,
  lock: "SHARE" | "UPDATE",
  action: string,
  request: unknown,
  operationId: string,
) {
  let row;
  if (typeof credential === "string") {
    row = (
      await client.query(
        `SELECT a.id FROM app_sessions s JOIN app_accounts a ON a.id=s.account_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
       AND a.state='active' FOR ${lock} OF a,s`,
        [credential],
      )
    ).rows[0];
  } else {
    const id = replies.get(credential),
      body = request as Record<string, unknown>;
    if (!id || action !== "attendance.code-attempt")
      throw new AppFailure(403, "This bot reply can only submit its bound attendance code.");
    const owner = (
      await client.query(
        `SELECT c.account_id FROM app_telegram_attendance_replies r JOIN app_telegram_attendance_prompts p ON p.id=r.prompt_id
       JOIN app_telegram_connections c ON c.id=p.connection_id WHERE r.id=$1`,
        [id],
      )
    ).rows[0];
    if (!owner) throw new AppFailure(401, "Reconnect this attendance prompt.");
    await client.query(`SELECT id FROM app_accounts WHERE id=$1 FOR ${lock}`, [owner.account_id]);
    row = (
      await client.query(
        `SELECT a.id FROM app_telegram_attendance_replies r
       JOIN app_telegram_attendance_prompts p ON p.id=r.prompt_id
       JOIN app_telegram_connections c ON c.id=p.connection_id
       JOIN app_accounts a ON a.id=c.account_id
       WHERE r.id=$1 AND r.operation_id=$2 AND p.event_id=$3 AND p.consent_id=$4
       AND r.code_index=$5 AND r.environment=$6 AND c.bot_id=r.bot_id AND a.state='active'
       FOR ${lock} OF c`,
        [id, operationId, body.eventId, body.consentId, body.codeIndex, body.environment],
      )
    ).rows[0];
  }
  if (!row) throw new AppFailure(401, "Sign in again or reconnect this attendance prompt.");
  return { id: row.id as string };
}
