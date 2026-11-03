import assert from "node:assert/strict";
import { test } from "node:test";
import { token } from "../../src/server/auth/crypto";
import { parseTelegramStart } from "../../src/server/telegram/connection";
import { requireTelegramWebhook, telegramBotConfig } from "../../src/server/telegram/config";

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
