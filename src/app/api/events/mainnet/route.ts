import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { sessionCookie } from "../../../../server/auth/sessions";
import { findPrivacySession } from "../../../../server/privacy/access";
import { createDatabase } from "../../../../server/db/client";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../../server/http/security";
import { isUuid } from "../../../../server/events/drafts";
import {
  readV1HostState,
  readV1OwnReceipt,
  requestV1CheckIn,
  requestV1Close,
  requestV1Withdrawal,
  rotateV1Code,
} from "../../../../server/events/v1-actions";

export const dynamic = "force-dynamic";
async function handle(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, request.method !== "GET");
    database = createDatabase();
    const session = await findPrivacySession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    if (!session) throw new AppFailure(401, "Sign in again to review this event.");
    await limit(database.pool, `v1-event:${session.accountId}`, request.method === "GET" ? 30 : 8);
    let result: unknown;
    if (request.method === "GET") {
      const params = new URL(request.url).searchParams;
      if (
        [...params.keys()].some((k) => !["event", "view"].includes(k)) ||
        params.getAll("event").length !== 1 ||
        params.getAll("view").length !== 1 ||
        !["host", "receipt"].includes(params.get("view")!)
      )
        throw new AppFailure(400, "Choose an event view.");
      result =
        params.get("view") === "host"
          ? await readV1HostState(database.pool, config, session.tokenHash, params.get("event")!)
          : await readV1OwnReceipt(database.pool, config, session.tokenHash, params.get("event")!);
    } else {
      const body = await jsonBody(request, 2048);
      const fields = [
        "eventId",
        "operation",
        "operationId",
        ...(body.operation === "check_in"
          ? ["code"]
          : body.operation === "withdraw"
            ? ["claim"]
            : []),
      ];
      if (
        Object.keys(body).some((k) => !fields.includes(k)) ||
        typeof body.eventId !== "string" ||
        !isUuid(body.eventId) ||
        typeof body.operationId !== "string" ||
        !isUuid(body.operationId)
      )
        throw new AppFailure(400, "Invalid event operation.");
      if (session.state !== "active" && body.operation !== "withdraw")
        throw new AppFailure(403, "Restricted accounts can review and withdraw existing claims.");
      if (body.operation === "code")
        result = await rotateV1Code(
          database.pool,
          config,
          session.tokenHash,
          body.operationId,
          body.eventId,
        );
      else if (body.operation === "check_in" && typeof body.code === "string")
        result = await requestV1CheckIn(
          database.pool,
          config,
          session.tokenHash,
          body.operationId,
          body.eventId,
          body.code,
        );
      else if (body.operation === "settle" || body.operation === "cancel")
        result = await requestV1Close(
          database.pool,
          config,
          session.tokenHash,
          body.operationId,
          body.eventId,
          body.operation,
        );
      else if (
        body.operation === "withdraw" &&
        ["deposit", "recovery", "prize"].includes(String(body.claim))
      )
        result = await requestV1Withdrawal(
          database.pool,
          config,
          session.tokenHash,
          body.operationId,
          body.eventId,
          body.claim as "deposit" | "recovery" | "prize",
        );
      else throw new AppFailure(400, "Unknown event operation.");
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
