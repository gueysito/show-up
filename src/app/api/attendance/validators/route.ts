import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { requireSession, sessionCookie } from "../../../../server/auth/sessions";
import { createDatabase } from "../../../../server/db/client";
import { readEventValidators, removeEventValidator } from "../../../../server/events/validators";
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
      throw new AppFailure(403, "Open Showup directly to manage validators.");
    database = createDatabase();
    const session = await requireSession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    await limit(
      database.pool,
      `event-validator:${request.method}:${session.accountId}`,
      request.method === "GET" ? 60 : 12,
    );
    const query = new URL(request.url).searchParams;
    let result: unknown;
    if (request.method === "GET") {
      if ([...query.keys()].some((key) => key !== "event") || query.getAll("event").length !== 1)
        throw new AppFailure(400, "Choose one saved event.");
      result = await readEventValidators(database.pool, session.tokenHash, query.get("event")!);
    } else {
      if (query.size) throw new AppFailure(400, "Use the validator action without query fields.");
      const body = await jsonBody(request, 2048);
      if (
        Object.keys(body).sort().join() !== "eventId,operationId,validatorId" ||
        typeof body.eventId !== "string" ||
        typeof body.operationId !== "string" ||
        typeof body.validatorId !== "string"
      )
        throw new AppFailure(400, "Choose a valid validator assignment.");
      result = await removeEventValidator(database.pool, config.encryptionKey, session.tokenHash, {
        eventId: body.eventId,
        operationId: body.operationId,
        validatorId: body.validatorId,
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
