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
  createTelegramConnectionAttempt,
  disconnectTelegram,
  ownTelegramConnection,
} from "../../../../server/telegram/connection";

export const dynamic = "force-dynamic";
async function handle(request: Request, mutation: boolean) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, mutation);
    if (new URL(request.url).searchParams.size)
      throw new AppFailure(400, "Use your own Telegram connection controls.");
    database = createDatabase();
    const session = await requireSession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    await limit(database.pool, `telegram-connection:${session.accountId}`, mutation ? 12 : 60);
    let result;
    if (!mutation)
      result = {
        ...(await ownTelegramConnection(database.pool, session.tokenHash)),
        available: Boolean(telegramBotConfig()),
      };
    else {
      const body = await jsonBody(request, 1024);
      if (typeof body.operationId !== "string")
        throw new AppFailure(400, "Choose a connection action.");
      if (body.action === "disconnect" && Object.keys(body).sort().join() === "action,operationId")
        result = await disconnectTelegram(
          database.pool,
          config,
          session.tokenHash,
          body.operationId,
        );
      else if (
        body.action === "connect" &&
        [
          "action,consentMessages,operationId",
          "action,consentMessages,eventId,operationId",
        ].includes(Object.keys(body).sort().join()) &&
        (body.eventId === undefined || typeof body.eventId === "string")
      ) {
        const bot = telegramBotConfig();
        if (!bot)
          throw new AppFailure(503, "Optional Telegram messages are currently unavailable.");
        result = await createTelegramConnectionAttempt(
          database.pool,
          config,
          bot,
          session.tokenHash,
          {
            operationId: body.operationId,
            consentMessages: body.consentMessages === true,
            ...(body.eventId ? { eventId: body.eventId as string } : {}),
          },
        );
      } else throw new AppFailure(400, "Choose a connection action and explicit message consent.");
    }
    return Response.json(result, {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
