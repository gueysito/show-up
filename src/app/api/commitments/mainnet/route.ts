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
  prepareV1ReceivingAccount,
} from "../../../../server/commitments/v1-registration";
import { isUuid } from "../../../../server/events/drafts";
import { findPrivacySession } from "../../../../server/privacy/access";
import {
  prepareV1Route,
  prepareV1RoutePayment,
  readV1RouteState,
  recordV1SourceTransaction,
} from "../../../../server/commitments/v1-route";

export const dynamic = "force-dynamic";
async function handle(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, request.method !== "GET");
    database = createDatabase();
    const cookie = (await cookies()).get(sessionCookie)?.value;
    const session =
      request.method === "GET"
        ? await findPrivacySession(database.pool, cookie)
        : await requireSession(database.pool, cookie);
    if (!session) throw new AppFailure(401, "Sign in again to review your deposit.");
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
      const state = await readV1RegistrationState(
        database.pool,
        config,
        session.tokenHash,
        params.get("event")!,
      );
      result = {
        ...state,
        ...("sourceNetwork" in state &&
          state.sourceNetwork !== "near" && {
            route: await readV1RouteState(
              database.pool,
              config,
              session.tokenHash,
              params.get("event")!,
            ),
          }),
      };
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
          ? [
              "operation",
              "operationId",
              "eventId",
              "rulesHash",
              "walletId",
              "sourceWalletId",
              "ethereumWalletId",
            ]
          : body.operation === "storage"
            ? ["operation", "operationId", "eventId", "walletId"]
            : body.operation === "source"
              ? ["operation", "operationId", "eventId", "sourceHash"]
              : ["operation", "operationId", "eventId"];
      if (Object.keys(body).some((key) => !fields.includes(key)))
        throw new AppFailure(400, "Unexpected deposit fields.");
      if (body.operation === "register") {
        if (
          body.ethereumWalletId !== undefined &&
          (typeof body.ethereumWalletId !== "string" || !isUuid(body.ethereumWalletId))
        )
          throw new AppFailure(400, "Choose your verified Ethereum recipient wallet.");
        if (
          body.sourceWalletId !== undefined &&
          (typeof body.sourceWalletId !== "string" || !isUuid(body.sourceWalletId))
        )
          throw new AppFailure(400, "Choose your source wallet.");
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
          undefined,
          body.sourceWalletId as string | undefined,
          body.ethereumWalletId as string | undefined,
        );
      } else if (body.operation === "storage") {
        if (typeof body.walletId !== "string" || !isUuid(body.walletId))
          throw new AppFailure(400, "Choose your verified NEAR payout wallet.");
        result = await prepareV1ReceivingAccount(
          database.pool,
          config,
          session.tokenHash,
          body.eventId,
          body.walletId,
        );
      } else if (body.operation === "quote")
        result = await prepareV1Route(database.pool, config, session.tokenHash, body.eventId);
      else if (body.operation === "route-pay")
        result = await prepareV1RoutePayment(
          database.pool,
          config,
          session.tokenHash,
          body.eventId,
        );
      else if (body.operation === "source") {
        if (typeof body.sourceHash !== "string")
          throw new AppFailure(400, "Use the original source transaction hash.");
        result = await recordV1SourceTransaction(
          database.pool,
          config,
          session.tokenHash,
          body.operationId,
          body.eventId,
          body.sourceHash,
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
