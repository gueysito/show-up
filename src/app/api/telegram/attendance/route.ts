import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { requireSession, sessionCookie } from "../../../../server/auth/sessions";
import { createDatabase } from "../../../../server/db/client";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../../server/http/security";
import { telegramBotConfig } from "../../../../server/telegram/config";
import {
  prepareTelegramAttendancePrompt,
  deliverTelegramAttendancePrompt,
} from "../../../../server/telegram/attendance";
import { telegramPromptTransport } from "../../../../server/telegram/transport";

export async function POST(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig(),
      bot = telegramBotConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin);
    if (new URL(request.url).searchParams.size)
      throw new AppFailure(400, "Choose the original event check-in action.");
    const body = await jsonBody(request, 1024);
    if (
      Object.keys(body).sort().join() !== "consentId,eventId,operationId" ||
      typeof body.eventId !== "string" ||
      typeof body.consentId !== "string" ||
      typeof body.operationId !== "string"
    )
      throw new AppFailure(400, "Choose the original event authorization.");
    database = createDatabase();
    const session = await requireSession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    await limit(database.pool, `telegram-prompt:${session.accountId}`, 12);
    const transport = bot ? telegramPromptTransport(bot) : null;
    if (!bot || !transport)
      throw new AppFailure(
        503,
        "Telegram check-in prompts are currently unavailable. Use website check-in.",
      );
    // HTTP cannot inject engineering funding/source evidence. Unqualified
    // admission rejects before any prompt or outbound request is prepared.
    const prompt = await prepareTelegramAttendancePrompt(database.pool, config, session.tokenHash, {
      eventId: body.eventId,
      consentId: body.consentId,
      operationId: body.operationId,
    });
    return Response.json(
      await deliverTelegramAttendancePrompt(database.pool, config, prompt.id, transport),
      {
        headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      },
    );
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
