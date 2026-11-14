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
  readV1NftState,
  prepareV1NftWalletPayment,
  recordV1NftWalletPayment,
  requestV1NftAction,
} from "../../../../server/events/v1-nft";

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
    if (!session) throw new AppFailure(401, "Sign in again to review your NFT prize.");
    await limit(database.pool, `v1-nft:${session.accountId}`, request.method === "GET" ? 20 : 8);
    let result: unknown;
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some((k) => k !== "event") || query.getAll("event").length !== 1)
        throw new AppFailure(400, "Choose your event.");
      result = await readV1NftState(database.pool, config, session.tokenHash, query.get("event")!);
    } else {
      const body = await jsonBody(request, 2048),
        source = body.operation === "source_nft" || body.operation === "source_gas";
      if (
        Object.keys(body).some(
          (k) =>
            !["eventId", "operation", "operationId", ...(source ? ["sourceHash"] : [])].includes(k),
        ) ||
        typeof body.eventId !== "string" ||
        !isUuid(body.eventId) ||
        typeof body.operationId !== "string" ||
        !isUuid(body.operationId)
      )
        throw new AppFailure(400, "Invalid NFT operation.");
      if (body.operation === "prepare_nft" || body.operation === "prepare_gas")
        result = await prepareV1NftWalletPayment(
          database.pool,
          config,
          session.tokenHash,
          body.eventId,
          body.operation === "prepare_nft" ? "nft" : "gas",
        );
      else if (source && typeof body.sourceHash === "string")
        result = await recordV1NftWalletPayment(
          database.pool,
          config,
          session.tokenHash,
          body.eventId,
          body.operation === "source_nft" ? "nft" : "gas",
          body.sourceHash,
        );
      else if (
        body.operation === "nft_release" ||
        body.operation === "nft_retry" ||
        body.operation === "nft_derive"
      )
        result = await requestV1NftAction(
          database.pool,
          config,
          session.tokenHash,
          body.operationId,
          body.eventId,
          body.operation,
        );
      else throw new AppFailure(400, "Unknown NFT operation.");
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
