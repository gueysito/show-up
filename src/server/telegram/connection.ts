import { randomUUID } from "node:crypto";
import type pg from "pg";
import { issuers, type AuthConfig } from "../auth/config";
import { hash, identityIndex, seal, token, unseal } from "../auth/crypto";
import { mutate } from "../auth/mutations";
import { telegramUserId, type ProviderIdentity } from "../auth/provider-identity";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { requirePrivacyActor } from "../privacy/access";
import type { TelegramBotConfig } from "./config";

type BotIdentity = Pick<TelegramBotConfig, "id" | "username">;
export function telegramSenderHash(config: AuthConfig, botId: string, sender: string) {
  return identityIndex(config.indexKey, `showup.telegram.sender.v1:${botId}`, sender);
}
async function linkedSender(client: pg.PoolClient, config: AuthConfig, accountId: string) {
  const row = (
    await client.query(
      "SELECT identity_hash,encrypted_identity FROM app_identities WHERE account_id=$1 AND provider='telegram'",
      [accountId],
    )
  ).rows[0];
  if (!row)
    throw new AppFailure(409, "Link Telegram to this account before connecting the optional bot.");
  const identity = unseal(
    config.encryptionKey,
    `identity:${row.identity_hash}`,
    row.encrypted_identity,
  ) as ProviderIdentity;
  if (
    identity.issuer !== issuers.telegram ||
    identityIndex(config.indexKey, identity.issuer, identity.subject) !== row.identity_hash
  )
    throw new Error("Telegram identity integrity failure");
  if (!identity.telegramUserId)
    throw new AppFailure(
      409,
      "Sign in with Telegram again to verify its profile before connecting the optional bot.",
    );
  return telegramUserId(identity.telegramUserId);
}
export async function createTelegramConnectionAttempt(
  pool: pg.Pool,
  config: AuthConfig,
  bot: BotIdentity,
  sessionHash: string,
  input: { operationId: string; consentMessages: boolean; eventId?: string },
) {
  if (input.consentMessages !== true || (input.eventId !== undefined && !isUuid(input.eventId)))
    throw new AppFailure(400, "Explicitly choose optional Telegram messages for this account.");
  return mutate(
    pool,
    config.encryptionKey,
    sessionHash,
    input.operationId,
    { ...input, bot },
    "telegram.connect",
    async (client, actor) => {
      if (
        input.eventId &&
        !(
          await client.query(
            `SELECT 1 FROM app_events e WHERE e.id=$1 AND e.state='published' AND
       (e.owner_id=$2 OR EXISTS(SELECT 1 FROM app_event_access a WHERE a.event_id=e.id AND a.account_id=$2)
        OR EXISTS(SELECT 1 FROM app_commitment_consents c WHERE c.event_id=e.id AND c.account_id=$2))`,
            [input.eventId, actor.id],
          )
        ).rowCount
      )
        throw new AppFailure(404, "Private event unavailable.");
      const sender = await linkedSender(client, config, actor.id),
        value = token();
      await client.query("DELETE FROM app_telegram_connection_attempts WHERE account_id=$1", [
        actor.id,
      ]);
      const row = (
        await client.query(
          `INSERT INTO app_telegram_connection_attempts(account_id,token_hash,session_hash,bot_id,expected_sender_hash,event_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '5 minutes') RETURNING expires_at`,
          [
            actor.id,
            hash(value),
            sessionHash,
            bot.id,
            telegramSenderHash(config, bot.id, sender),
            input.eventId ?? null,
          ],
        )
      ).rows[0];
      return {
        deepLink: `https://t.me/${bot.username}?start=${value}`,
        expiresAt: row.expires_at.toISOString(),
        eventId: input.eventId ?? null,
      };
    },
  );
}
export type TelegramStart = { updateId: number; sender: string; token: string };
// Transport authentication is separate. Accept only an ordinary private /start,
// never a forwarded, business, guest, channel or sender-on-behalf-of-chat message.
export function parseTelegramStart(update: Record<string, unknown>): TelegramStart | null {
  const message = update.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object" || typeof message.text !== "string") return null;
  const match = /^\/start ([A-Za-z0-9_-]{43})$/.exec(message.text);
  if (!match) return null;
  const from = message.from as Record<string, unknown> | undefined,
    chat = message.chat as Record<string, unknown> | undefined;
  if (
    !Number.isSafeInteger(update.update_id) ||
    Number(update.update_id) < 0 ||
    !from ||
    !chat ||
    from.is_bot !== false ||
    chat.type !== "private" ||
    message.sender_chat ||
    message.forward_origin ||
    message.business_connection_id ||
    message.guest_query_id ||
    message.via_bot ||
    message.is_automatic_forward ||
    !Number.isSafeInteger(message.message_id) ||
    Number(message.message_id) <= 0
  )
    throw new AppFailure(400, "Use the connection link in your private bot chat.");
  const sender = telegramUserId(from.id);
  if (telegramUserId(chat.id) !== sender)
    throw new AppFailure(400, "Use your own private bot chat.");
  return { updateId: Number(update.update_id), sender, token: match[1] };
}
// Call only after authenticating the configured Telegram webhook transport.
export async function consumeTelegramConnection(
  pool: pg.Pool,
  config: AuthConfig,
  bot: BotIdentity,
  update: TelegramStart,
) {
  const sender = telegramUserId(update.sender),
    senderHash = telegramSenderHash(config, bot.id, sender);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(update.token) ||
    !Number.isSafeInteger(update.updateId) ||
    update.updateId < 0
  )
    throw new AppFailure(400, "Invalid bot connection update.");
  return transaction(pool, async (client) => {
    const ref = (
      await client.query(
        "SELECT account_id,session_hash FROM app_telegram_connection_attempts WHERE token_hash=$1",
        [hash(update.token)],
      )
    ).rows[0];
    if (!ref)
      throw new AppFailure(409, "This connection link is unavailable. Open a new link in Showup.");
    const actor = (
      await client.query(
        `SELECT a.id FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
       WHERE a.id=$1 AND a.state='active' AND s.token_hash=$2 AND s.revoked_at IS NULL
       AND s.expires_at>clock_timestamp() FOR UPDATE OF a,s`,
        [ref.account_id, ref.session_hash],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(401, "The connection session expired. Reopen Showup.");
    const attempt = (
      await client.query(
        "SELECT *,clock_timestamp() AS now FROM app_telegram_connection_attempts WHERE token_hash=$1 AND account_id=$2 FOR UPDATE",
        [hash(update.token), actor.id],
      )
    ).rows[0];
    if (
      !attempt ||
      attempt.bot_id !== bot.id ||
      attempt.expected_sender_hash !== senderHash ||
      telegramSenderHash(config, bot.id, await linkedSender(client, config, actor.id)) !==
        senderHash
    )
      throw new AppFailure(403, "Use the same Telegram identity linked to your Showup account.");
    if (attempt.consumed_at) {
      if (
        String(attempt.consumed_update_id) !== String(update.updateId) ||
        !attempt.connection_id ||
        !(
          await client.query(
            "SELECT 1 FROM app_telegram_connections WHERE id=$1 AND account_id=$2 AND sender_hash=$3",
            [attempt.connection_id, actor.id, senderHash],
          )
        ).rowCount
      )
        throw new AppFailure(409, "This connection link was already used.");
      return { connected: true as const, eventId: attempt.event_id as string | null };
    }
    if (attempt.expires_at <= attempt.now)
      throw new AppFailure(410, "This connection link expired. Open a new link in Showup.");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [senderHash]);
    const other = (
      await client.query("SELECT account_id FROM app_telegram_connections WHERE sender_hash=$1", [
        senderHash,
      ])
    ).rows[0];
    if (other && other.account_id !== actor.id)
      throw new AppFailure(409, "This Telegram sender is already connected to another account.");
    const id = randomUUID();
    await client.query("DELETE FROM app_telegram_connections WHERE account_id=$1", [actor.id]);
    await client.query(
      `INSERT INTO app_telegram_connections(account_id,id,bot_id,bot_username,sender_hash,encrypted_peer)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        actor.id,
        id,
        bot.id,
        bot.username,
        senderHash,
        seal(config.encryptionKey, `telegram-peer:${actor.id}:${id}`, { botId: bot.id, sender }),
      ],
    );
    await client.query(
      "UPDATE app_telegram_connection_attempts SET consumed_at=clock_timestamp(),consumed_update_id=$2,connection_id=$3 WHERE account_id=$1",
      [actor.id, update.updateId, id],
    );
    return { connected: true as const, eventId: attempt.event_id as string | null };
  });
}
export async function ownTelegramConnection(pool: pg.Pool, sessionHash: string) {
  return transaction(pool, async (client) => {
    const actor = await requirePrivacyActor(client, sessionHash);
    const row = (
      await client.query(
        "SELECT bot_username,consented_at FROM app_telegram_connections WHERE account_id=$1",
        [actor.id],
      )
    ).rows[0];
    return {
      connected: Boolean(row),
      botUsername: row?.bot_username ?? null,
      consentedAt: row?.consented_at.toISOString() ?? null,
    };
  });
}
export async function disconnectTelegram(
  pool: pg.Pool,
  config: AuthConfig,
  sessionHash: string,
  operationId: string,
) {
  return mutate(
    pool,
    config.encryptionKey,
    sessionHash,
    operationId,
    {},
    "telegram.disconnect",
    async (client, actor) => {
      await client.query("DELETE FROM app_telegram_connection_attempts WHERE account_id=$1", [
        actor.id,
      ]);
      await client.query("DELETE FROM app_telegram_connections WHERE account_id=$1", [actor.id]);
      return { connected: false as const };
    },
  );
}
