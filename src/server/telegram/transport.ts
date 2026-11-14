import type { TelegramBotConfig } from "./config";
import type { TelegramPromptTransport } from "./attendance";

export function telegramPromptTransport(
  bot: TelegramBotConfig,
  env: Record<string, string | undefined> = process.env,
): TelegramPromptTransport | null {
  if (env.SHOWUP_TELEGRAM_MESSAGES_ENABLED !== "1") return null;
  const token = env.SHOWUP_TELEGRAM_BOT_TOKEN ?? "";
  if (!/^[0-9]{5,16}:[A-Za-z0-9_-]{30,128}$/.test(token) || token.split(":")[0] !== bot.id)
    throw new Error("Approved Telegram message configuration is incomplete");
  return {
    send: async ({ botId, chatId, text }) => {
      try {
        if (botId !== bot.id) throw new Error();
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(7500),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_notification: true,
            link_preview_options: { is_disabled: true },
            reply_markup: {
              force_reply: true,
              selective: true,
              input_field_placeholder: "Reply with the event phrase",
            },
          }),
        });
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 16384) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !response.ok ||
          body.ok !== true ||
          body.result?.chat?.type !== "private" ||
          String(body.result.chat.id) !== chatId ||
          String(body.result.from?.id) !== bot.id ||
          body.result.from?.is_bot !== true ||
          !Number.isSafeInteger(body.result.message_id) ||
          body.result.message_id <= 0
        )
          throw new Error();
        return { messageId: body.result.message_id as number };
      } catch {
        // Never propagate provider errors or a URL containing the bot token.
        throw new Error("Telegram message acknowledgement is unavailable");
      }
    },
  };
}
