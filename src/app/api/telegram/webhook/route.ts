import { authConfig } from "../../../../server/auth/config";
import { createDatabase } from "../../../../server/db/client";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../../server/http/security";
import { requireTelegramWebhook, telegramBotConfig } from "../../../../server/telegram/config";
import {
  consumeTelegramConnection,
  parseTelegramStart,
} from "../../../../server/telegram/connection";
import {
  parseTelegramCodeReply,
  submitTelegramAttendanceCode,
} from "../../../../server/telegram/attendance";
import { telegramPromptTransport } from "../../../../server/telegram/transport";

export async function POST(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig(),
      bot = telegramBotConfig();
    if (!config || !bot) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, false);
    requireTelegramWebhook(request, bot.webhookSecret);
    if (new URL(request.url).searchParams.size)
      throw new AppFailure(400, "Unexpected webhook query.");
    const body = await jsonBody(request, 16384),
      receivedAt = Date.now(),
      update = parseTelegramStart(body),
      reply = update ? null : parseTelegramCodeReply(body);
    if (!update && !reply) return Response.json({ ok: true });
    database = createDatabase();
    await limit(database.pool, `telegram-update:${bot.id}:${(update ?? reply)!.sender}`, 60);
    await limit(database.pool, "telegram-update:global", 1200);
    if (update) {
      const connected = await consumeTelegramConnection(database.pool, config, bot, update);
      if (telegramPromptTransport(bot)) {
        const event = connected.eventId
          ? (
              await database.pool.query(
                "SELECT data->>'title' AS title FROM app_events WHERE id=$1",
                [connected.eventId],
              )
            ).rows[0]
          : null;
        return Response.json({
          method: "sendMessage",
          chat_id: update.sender,
          disable_notification: true,
          text: `${event ? `${event.title}\n` : ""}Optional Showup messages connected. Financial authorization remains on the website.`,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Open Showup on the web",
                  url: `${config.origin}/account${connected.eventId ? `/commitments?event=${connected.eventId}` : ""}`,
                },
              ],
            ],
          },
        });
      }
    } else if (reply) {
      const completed = await submitTelegramAttendanceCode(
          database.pool,
          config,
          bot,
          reply,
          receivedAt,
        ),
        result = completed.result;
      if (!completed.replayed && telegramPromptTransport(bot)) {
        const text =
          result.status === "pending_contract"
            ? "Code received for attendance verification. Attendance is not yet confirmed."
            : result.status === "incorrect_code"
              ? `That phrase did not match. ${result.remainingAttempts} attempts remain in this code window.`
              : result.status === "attempt_limit"
                ? "The attempt limit for this code window was reached. Website check-in shares this limit."
                : "This code window is closed. Review the event on the website.";
        // Informational webhook responses have no delivery acknowledgement.
        return Response.json({
          method: "sendMessage",
          chat_id: reply.sender,
          disable_notification: true,
          text: `${completed.eventTitle}\n${text}`,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Review this event in Showup",
                  url: `${config.origin}/account/commitments?event=${completed.eventId}`,
                },
              ],
            ],
          },
        });
      }
    }
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
