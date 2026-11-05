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
import {
  prepareV1Registration,
  readV1RegistrationState,
  prepareV1Deposit,
  confirmV1Deposit,
} from "../../../../server/commitments/v1-registration";
import { isUuid } from "../../../../server/events/drafts";

export const dynamic = "force-dynamic";
async function handle(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, request.method !== "GET");
    database = createDatabase();
    const session = await requireSession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    await limit(
      database.pool,
      `v1-deposit:${session.accountId}`,
      request.method === "GET" ? 30 : 10,
    );
    let result: unknown;
    if (request.method === "GET") {
      const params = new URL(request.url).searchParams;
      if ([...params.keys()].some((key) => key !== "event") || params.getAll("event").length !== 1)
        throw new AppFailure(400, "Choose your event.");
      result = await readV1RegistrationState(
        database.pool,
        config,
        session.tokenHash,
        params.get("event")!,
      );
    } else {
      const body = await jsonBody(request);
      if (
        typeof body.operation !== "string" ||
        typeof body.eventId !== "string" ||
        typeof body.operationId !== "string" ||
        !isUuid(body.operationId)
      )
        throw new AppFailure(400, "Invalid deposit operation.");
      const fields =
        body.operation === "register"
          ? ["operation", "operationId", "eventId", "rulesHash", "walletId"]
          : ["operation", "operationId", "eventId"];
      if (Object.keys(body).some((key) => !fields.includes(key)))
        throw new AppFailure(400, "Unexpected deposit fields.");
      if (body.operation === "register") {
        if (typeof body.rulesHash !== "string" || typeof body.walletId !== "string")
          throw new AppFailure(400, "Review the event and your own wallet.");
        result = await prepareV1Registration(
          database.pool,
          config,
          session.tokenHash,
          body.operationId,
          body.eventId,
          body.rulesHash,
          body.walletId,
        );
      } else if (body.operation === "pay")
        result = await prepareV1Deposit(database.pool, config, session.tokenHash, body.eventId);
      else if (body.operation === "confirm")
        result = await confirmV1Deposit(database.pool, config, session.tokenHash, body.eventId);
      else throw new AppFailure(400, "Unknown deposit operation.");
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
