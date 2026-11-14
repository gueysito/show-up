import assert from "node:assert/strict";
import { test } from "node:test";
import { token } from "../../src/server/auth/crypto";
import {
  parseTelegramStart,
  parseTelegramEventStart,
  telegramEventDeepLink,
} from "../../src/server/telegram/connection";
import { requireTelegramWebhook, telegramBotConfig } from "../../src/server/telegram/config";
import { telegramPromptTransport } from "../../src/server/telegram/transport";
import { parseTelegramCodeReply } from "../../src/server/telegram/attendance";

test("optional bot stays disabled by default; connection starts require authenticated ordinary private-chat context", () => {
  assert.equal(telegramBotConfig({}), null);
  const config = telegramBotConfig({
    SHOWUP_TELEGRAM_BOT_ENABLED: "1",
    SHOWUP_TELEGRAM_BOT_ID: "12345",
    SHOWUP_TELEGRAM_BOT_USERNAME: "showup_fixture_bot",
    SHOWUP_TELEGRAM_WEBHOOK_SECRET: token(),
  })!;
  const request = (value: string) =>
    new Request("https://localhost:3444/api/telegram/webhook", {
      headers: { "x-telegram-bot-api-secret-token": value },
    });
  assert.equal(telegramPromptTransport(config, {}), null);
  requireTelegramWebhook(request(config.webhookSecret), config.webhookSecret);
  assert.throws(() => requireTelegramWebhook(request(token()), config.webhookSecret));
  assert.throws(() => requireTelegramWebhook(request(""), config.webhookSecret));
  const start = token(),
    message = {
      message_id: 1,
      text: `/start ${start}`,
      from: { id: 987654321, is_bot: false },
      chat: { id: 987654321, type: "private" },
    };
  assert.deepEqual(parseTelegramStart({ update_id: 42, message }), {
    updateId: 42,
    sender: "987654321",
    token: start,
  });
  const eventId = "01234567-89ab-4cde-8fab-0123456789ab";
  assert.equal(
    telegramEventDeepLink(config.username, eventId),
    `https://t.me/${config.username}?start=e_${eventId}`,
  );
  assert.deepEqual(
    parseTelegramEventStart({
      update_id: 44,
      message: { ...message, text: `/start e_${eventId}` },
    }),
    { updateId: 44, sender: "987654321", eventId },
  );
  assert.deepEqual(
    parseTelegramCodeReply({
      update_id: 43,
      message: {
        ...message,
        text: "event phrase",
        reply_to_message: { message_id: 91, from: { id: 12345678, is_bot: true } },
      },
    }),
    {
      updateId: 43,
      sender: "987654321",
      text: "event phrase",
      replyTo: 91,
      replyBotId: "12345678",
    },
  );
  assert.throws(() =>
    parseTelegramCodeReply({
      update_id: 43,
      message: {
        ...message,
        text: "event phrase",
        reply_to_message: { message_id: 91, from: { id: 12345678, is_bot: false } },
      },
    }),
  );
  for (const changed of [
    { chat: { id: -1, type: "group" } },
    { from: { id: 1, is_bot: true } },
    { sender_chat: {} },
    { forward_origin: {} },
    { business_connection_id: "business" },
  ])
    assert.throws(() => parseTelegramStart({ update_id: 42, message: { ...message, ...changed } }));
  assert.equal(parseTelegramStart({ update_id: 42, edited_message: message }), null);
  assert.equal(
    parseTelegramStart({ update_id: 42, message: { ...message, text: "an unbound phrase" } }),
    null,
  );
});
