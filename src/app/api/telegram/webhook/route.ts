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
    const update = parseTelegramStart(await jsonBody(request, 16384));
    if (!update) return Response.json({ ok: true });
    database = createDatabase();
    await limit(database.pool, `telegram-start:${bot.id}:${update.sender}`, 30);
    await limit(database.pool, "telegram-start:global", 1200);
    await consumeTelegramConnection(database.pool, config, bot, update);
    // No Bot API request or message is sent by connection handling.
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
