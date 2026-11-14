import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { requireSession, sessionCookie } from "../../../../server/auth/sessions";
import { activateHostCodeWindow, readHostCodeWindow } from "../../../../server/attendance/codes";
import { createDatabase } from "../../../../server/db/client";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../../server/http/security";

export const dynamic = "force-dynamic";
async function handle(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, request.method !== "GET");
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new AppFailure(403, "Open Showup directly to manage this event.");
    database = createDatabase();
    const session = await requireSession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    await limit(
      database.pool,
      `attendance-code:${request.method}:${session.accountId}`,
      request.method === "GET" ? 60 : 6,
    );
    const query = new URL(request.url).searchParams;
    let result: unknown;
    if (request.method === "GET") {
      if ([...query.keys()].some((key) => key !== "event") || query.getAll("event").length !== 1)
        throw new AppFailure(400, "Choose one saved event.");
      result = {
        window: await readHostCodeWindow(
          database.pool,
          config,
          session.tokenHash,
          query.get("event")!,
        ),
      };
    } else {
      if (query.size) throw new AppFailure(400, "Use the event action without query fields.");
      const body = await jsonBody(request, 2048);
      if (
        Object.keys(body).sort().join() !== "eventId,operationId,phrase" ||
        typeof body.eventId !== "string" ||
        typeof body.operationId !== "string"
      )
        throw new AppFailure(400, "Invalid code-window action.");
      result = await activateHostCodeWindow(database.pool, config, session.tokenHash, {
        eventId: body.eventId,
        operationId: body.operationId,
        phrase: body.phrase,
      });
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
export const GET = handle;
export const POST = handle;
