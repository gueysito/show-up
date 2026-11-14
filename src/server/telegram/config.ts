import { timingSafeEqual } from "node:crypto";
import { telegramUserId } from "../auth/provider-identity";
import { AppFailure } from "../http/security";

export function telegramBotConfig(env: Record<string, string | undefined> = process.env) {
  if (env.SHOWUP_TELEGRAM_BOT_ENABLED !== "1") return null;
  const id = telegramUserId(env.SHOWUP_TELEGRAM_BOT_ID),
    username = env.SHOWUP_TELEGRAM_BOT_USERNAME ?? "",
    webhookSecret = env.SHOWUP_TELEGRAM_WEBHOOK_SECRET ?? "";
  if (
    !/^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/.test(username) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)
  )
    throw new Error("Optional Telegram bot configuration is incomplete");
  return { id, username, webhookSecret };
}
export type TelegramBotConfig = NonNullable<ReturnType<typeof telegramBotConfig>>;
export function requireTelegramWebhook(request: Request, secret: string) {
  const supplied = Buffer.from(request.headers.get("x-telegram-bot-api-secret-token") ?? ""),
    expected = Buffer.from(secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new AppFailure(401, "Unverified bot update.");
}
