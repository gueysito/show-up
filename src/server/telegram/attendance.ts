import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { identityIndex, seal, unseal } from "../auth/crypto";
import { mutate } from "../auth/mutations";
import { telegramReplyCredential } from "../auth/attendance-actor";
import { telegramUserId } from "../auth/provider-identity";
import { attendanceCodeIndex } from "../attendance/codes";
import { attemptAttendanceCode } from "../attendance/attempts";
import {
  loadAttendanceAdmission,
  receivedAttendanceTime,
  type AttendanceEngineeringInput,
} from "../attendance/admission";
import { attendanceSchedule } from "../attendance/evidence";
import { transaction } from "../db/client";
import { AppFailure } from "../http/security";
import { isUuid } from "../events/drafts";
import { eventHostAlias } from "../events/entry";
import { telegramSenderHash } from "./connection";
import type { TelegramBotConfig } from "./config";

const promptIndex = (config: AuthConfig, code: string) =>
  identityIndex(config.indexKey, "showup.telegram.prompt.v1", code);
type Prompt = {
  id: string;
  eventId: string;
  consentId: string;
  code: string;
  text: string;
  expiresAt: string;
};
export type TelegramPromptTransport = {
  send: (input: { botId: string; chatId: string; text: string }) => Promise<{ messageId: number }>;
};

export async function prepareTelegramAttendancePrompt(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: { operationId: string; eventId: string; consentId: string },
  engineering?: AttendanceEngineeringInput,
) {
  if (!isUuid(input.eventId) || !isUuid(input.consentId))
    throw new AppFailure(400, "Choose the original event authorization.");
  return mutate(
    pool,
    config.encryptionKey,
    session,
    input.operationId,
    input,
    "telegram.attendance-prompt",
    async (client, actor) => {
      const connection = (
        await client.query("SELECT * FROM app_telegram_connections WHERE account_id=$1 FOR SHARE", [
          actor.id,
        ])
      ).rows[0];
      if (!connection)
        throw new AppFailure(
          409,
          "Connect optional Telegram messages before requesting a check-in prompt.",
        );
      const now = receivedAttendanceTime(engineering);
      await loadAttendanceAdmission(
        client,
        config,
        actor.id,
        input.eventId,
        input.consentId,
        now,
        randomBytes(32).toString("hex"),
        "live_code",
        engineering,
      );
      const event = (
        await client.query("SELECT data,owner_id FROM app_events WHERE id=$1", [input.eventId])
      ).rows[0];
      if (event.data.mode !== "digital")
        throw new AppFailure(409, "Use your personal QR for this in-person event.");
      const prior = (
        await client.query(
          "SELECT id FROM app_telegram_attendance_prompts WHERE connection_id=$1 AND event_id=$2 AND consent_id=$3",
          [connection.id, input.eventId, input.consentId],
        )
      ).rows[0];
      if (prior) return { id: prior.id as string, eventId: input.eventId };
      const id = randomUUID(),
        code = randomBytes(5).toString("hex").toUpperCase(),
        expiresAt = new Date(
          attendanceSchedule(Date.parse(event.data.startsAt), Date.parse(event.data.endsAt)).cutoff,
        ).toISOString();
      const prompt: Prompt = {
        id,
        eventId: input.eventId,
        consentId: input.consentId,
        code,
        expiresAt,
        text: `${event.data.title}\n${eventHostAlias(config, input.eventId, event.owner_id)}\nCheck in with the host's current phrase. Reply to this message, or send ${code} followed by the phrase.\nAttendance is confirmed only after verification.\nWebsite: ${config.origin}/account/commitments?event=${input.eventId}`,
      };
      await client.query(
        `INSERT INTO app_telegram_attendance_prompts(id,connection_id,event_id,consent_id,code_hash,encrypted_prompt,expires_at,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          connection.id,
          input.eventId,
          input.consentId,
          promptIndex(config, code),
          seal(config.encryptionKey, `telegram-prompt:${id}`, prompt),
          expiresAt,
          new Date(now),
        ],
      );
      return { id, eventId: input.eventId };
    },
  );
}
// No transport exists by default. The runtime transport is enabled only by
// separately approved message credentials; tests supply an in-process peer.
export async function deliverTelegramAttendancePrompt(
  pool: pg.Pool,
  config: AuthConfig,
  promptId: string,
  transport: TelegramPromptTransport,
) {
  const packet = await transaction(pool, async (client) => {
    const ref = (
      await client.query(
        "SELECT c.account_id FROM app_telegram_attendance_prompts p JOIN app_telegram_connections c ON c.id=p.connection_id WHERE p.id=$1",
        [promptId],
      )
    ).rows[0];
    if (!ref) throw new AppFailure(404, "Private check-in prompt unavailable.");
    await client.query("SELECT id FROM app_accounts WHERE id=$1 AND state='active' FOR UPDATE", [
      ref.account_id,
    ]);
    const row = (
      await client.query(
        `SELECT p.*,c.account_id,c.bot_id,c.sender_hash,c.encrypted_peer,c.id AS connection_ref,a.state AS account_state,clock_timestamp() AS now
       FROM app_telegram_attendance_prompts p JOIN app_telegram_connections c ON c.id=p.connection_id
       JOIN app_accounts a ON a.id=c.account_id WHERE p.id=$1 FOR UPDATE OF p,c`,
        [promptId],
      )
    ).rows[0];
    if (!row || row.account_state !== "active" || row.expires_at < row.now)
      throw new AppFailure(409, "This check-in prompt is closed.");
    if (row.state !== "prepared") return null;
    const prompt = unseal(
        config.encryptionKey,
        `telegram-prompt:${promptId}`,
        row.encrypted_prompt,
      ) as Prompt,
      peer = unseal(
        config.encryptionKey,
        `telegram-peer:${row.account_id}:${row.connection_ref}`,
        row.encrypted_peer,
      ) as { botId: string; sender: string };
    if (
      prompt.id !== row.id ||
      prompt.eventId !== row.event_id ||
      prompt.consentId !== row.consent_id ||
      promptIndex(config, prompt.code) !== row.code_hash ||
      peer.botId !== row.bot_id ||
      telegramSenderHash(config, peer.botId, telegramUserId(peer.sender)) !== row.sender_hash
    )
      throw new Error("Telegram prompt integrity failure");
    await client.query("UPDATE app_telegram_attendance_prompts SET state='sending' WHERE id=$1", [
      promptId,
    ]);
    return { botId: peer.botId, chatId: peer.sender, text: prompt.text };
  });
  if (!packet) return { status: "review_existing_prompt" as const };
  try {
    const result = await transport.send(packet);
    if (!Number.isSafeInteger(result.messageId) || result.messageId <= 0)
      throw new Error("Invalid bot message receipt");
    await pool.query(
      "UPDATE app_telegram_attendance_prompts SET state='sent',message_id=$2 WHERE id=$1 AND state='sending'",
      [promptId, result.messageId],
    );
    return { status: "sent" as const };
  } catch {
    await pool.query(
      "UPDATE app_telegram_attendance_prompts SET state='unknown' WHERE id=$1 AND state='sending'",
      [promptId],
    );
    return { status: "delivery_unknown" as const };
  }
}
export type TelegramCodeReply = {
  updateId: number;
  sender: string;
  text: string;
  replyTo: number | null;
  replyBotId: string | null;
};
export function parseTelegramCodeReply(update: Record<string, unknown>): TelegramCodeReply | null {
  const message = update.message as Record<string, unknown> | undefined;
  if (
    !message ||
    typeof message !== "object" ||
    typeof message.text !== "string" ||
    message.text.startsWith("/")
  )
    return null;
  const sender = message.from as { id?: unknown; is_bot?: unknown } | undefined,
    chat = message.chat as { id?: unknown; type?: unknown } | undefined;
  if (
    !sender ||
    !chat ||
    sender.is_bot !== false ||
    chat.type !== "private" ||
    message.sender_chat ||
    message.forward_origin ||
    message.business_connection_id ||
    message.guest_query_id ||
    message.via_bot ||
    !Number.isSafeInteger(update.update_id) ||
    Number(update.update_id) < 0 ||
    message.text.length > 512
  )
    throw new AppFailure(400, "Reply in your own private event prompt.");
  const id = telegramUserId(sender.id);
  if (telegramUserId(chat.id) !== id)
    throw new AppFailure(400, "Reply in your own private event prompt.");
  const reply = message.reply_to_message as
    { message_id?: unknown; from?: { id?: unknown; is_bot?: unknown } } | undefined;
  if (
    reply &&
    (!Number.isSafeInteger(reply.message_id) ||
      Number(reply.message_id) <= 0 ||
      reply.from?.is_bot !== true)
  )
    throw new AppFailure(400, "Use the original check-in prompt or its short code.");
  return {
    updateId: Number(update.update_id),
    sender: id,
    text: message.text,
    replyTo: reply ? Number(reply.message_id) : null,
    replyBotId: reply ? telegramUserId(reply.from?.id) : null,
  };
}
export async function submitTelegramAttendanceCode(
  pool: pg.Pool,
  config: AuthConfig,
  bot: Pick<TelegramBotConfig, "id">,
  update: TelegramCodeReply,
  receivedMs: number,
  engineering?: AttendanceEngineeringInput,
) {
  if (update.replyTo !== null && update.replyBotId !== bot.id)
    throw new AppFailure(409, "Use this bot's original event prompt.");
  const senderHash = telegramSenderHash(config, bot.id, telegramUserId(update.sender)),
    explicit = /^([A-F0-9]{10})\s+(.+)$/s.exec(update.text);
  if (update.replyTo === null && !explicit)
    throw new AppFailure(
      409,
      "Reply to the exact event prompt or include its short code. Website check-in remains available.",
    );
  const reply = await transaction(pool, async (client) => {
    const owner = (
      await client.query(
        "SELECT account_id FROM app_telegram_connections WHERE bot_id=$1 AND sender_hash=$2",
        [bot.id, senderHash],
      )
    ).rows[0];
    if (!owner) throw new AppFailure(401, "Reconnect optional Telegram messages in Showup.");
    const account = await client.query(
      "SELECT id FROM app_accounts WHERE id=$1 AND state='active' FOR UPDATE",
      [owner.account_id],
    );
    if (!account.rowCount) throw new AppFailure(401, "This account cannot submit new attendance.");
    const prompt = (
      await client.query(
        `SELECT p.*,c.id AS connection_ref,e.data->>'title' AS event_title,e.owner_id FROM app_telegram_attendance_prompts p JOIN app_telegram_connections c ON c.id=p.connection_id
       JOIN app_events e ON e.id=p.event_id
       WHERE c.account_id=$1 AND c.bot_id=$2 AND c.sender_hash=$3
       AND (($4::bigint IS NOT NULL AND p.message_id=$4) OR
         (($4::bigint IS NULL OR p.message_id IS NULL) AND $5::text IS NOT NULL AND p.code_hash=$5)) FOR SHARE OF p,c`,
        [
          owner.account_id,
          bot.id,
          senderHash,
          update.replyTo,
          explicit ? promptIndex(config, explicit[1]) : null,
        ],
      )
    ).rows;
    if (prompt.length !== 1)
      throw new AppFailure(
        409,
        "The event prompt is missing or ambiguous. Open the exact event in Showup.",
      );
    const p = prompt[0];
    if (
      update.replyTo !== null &&
      p.message_id !== null &&
      String(p.message_id) !== String(update.replyTo)
    )
      throw new AppFailure(409, "The reply and prompt code identify different messages.");
    // A host phrase may itself begin with ten hex characters. In a bound reply,
    // strip a prefix only when it is this prompt's actual code.
    const phrase =
      explicit && p.code_hash === promptIndex(config, explicit[1]) ? explicit[2] : update.text;
    const codeIndex = attendanceCodeIndex(config, p.event_id, phrase),
      environment = engineering ? "sandbox" : "mainnet";
    const original = (
      await client.query(
        "SELECT * FROM app_telegram_attendance_replies WHERE bot_id=$1 AND update_id=$2",
        [bot.id, update.updateId],
      )
    ).rows[0];
    if (original) {
      if (
        original.prompt_id !== p.id ||
        original.code_index !== codeIndex ||
        original.environment !== environment
      )
        throw new AppFailure(409, "This bot update was already bound to another request.");
      const completed = (
        await client.query("SELECT 1 FROM app_mutations WHERE operation_id=$1", [
          original.operation_id,
        ])
      ).rowCount;
      return {
        ...original,
        event_id: p.event_id,
        consent_id: p.consent_id,
        event_title: `${p.event_title} · ${eventHostAlias(config, p.event_id, p.owner_id)}`,
        replayed: Boolean(completed),
        phrase,
      };
    }
    const received = receivedAttendanceTime(engineering, receivedMs);
    if (received > p.expires_at.getTime() || received < p.created_at.getTime())
      throw new AppFailure(
        409,
        "This event prompt is closed. Telegram delivery time cannot extend check-in.",
      );
    const id = randomUUID(),
      operationId = randomUUID();
    await client.query(
      `INSERT INTO app_telegram_attendance_replies(id,bot_id,update_id,prompt_id,operation_id,code_index,environment,received_ms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, bot.id, update.updateId, p.id, operationId, codeIndex, environment, received],
    );
    return {
      id,
      operation_id: operationId,
      event_id: p.event_id,
      consent_id: p.consent_id,
      received_ms: String(received),
      event_title: `${p.event_title} · ${eventHostAlias(config, p.event_id, p.owner_id)}`,
      replayed: false,
      phrase,
    };
  });
  // Both transports use the same attempt journal, five-guess window, original
  // consent, funded-state check and candidate uniqueness. Telegram date is unused.
  const originalReceived = Number(reply.received_ms);
  const result = await attemptAttendanceCode(
    pool,
    config,
    telegramReplyCredential(reply.id),
    {
      eventId: reply.event_id,
      consentId: reply.consent_id,
      operationId: reply.operation_id,
      phrase: reply.phrase,
    },
    engineering ? { ...engineering, testClock: originalReceived } : undefined,
    originalReceived,
  );
  return {
    result,
    eventId: reply.event_id as string,
    eventTitle: reply.event_title as string,
    replayed: reply.replayed as boolean,
  };
}
