import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { requireSession, sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import { AppFailure, failureResponse, guardRequest, jsonBody } from "../../../server/http/security";
import {
  acceptWalletProof,
  issueWalletChallenge,
  listOwnWallets,
  removeOwnWallet,
} from "../../../server/wallets/service";
import type { WalletSignature } from "../../../server/wallets/proof";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
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
    if (request.method === "GET")
      return Response.json(
        { wallets: await listOwnWallets(database.pool, config, session.accountId) },
        { headers },
      );
    const body = await jsonBody(request, 8192);
    const fields = Object.keys(body).sort().join();
    if (typeof body.operationId !== "string")
      throw new AppFailure(400, "Invalid wallet operation.");
    let result: unknown;
    if (
      body.operation === "challenge" &&
      [
        "address,network,operation,operationId",
        "address,network,operation,operationId,returnEventId",
        "address,nearTransport,network,operation,operationId",
        "address,nearTransport,network,operation,operationId,returnEventId",
      ].includes(fields) &&
      typeof body.network === "string" &&
      typeof body.address === "string" &&
      (body.nearTransport === undefined ||
        (body.network === "near" &&
          (body.nearTransport === "near-mobile" || body.nearTransport === "meteor"))) &&
      (body.returnEventId === undefined || typeof body.returnEventId === "string")
    )
      result = await issueWalletChallenge(database.pool, config, session.tokenHash, {
        operationId: body.operationId,
        network: body.network,
        address: body.address,
        ...(typeof body.returnEventId === "string" && { returnEventId: body.returnEventId }),
        ...(body.nearTransport && { nearTransport: body.nearTransport }),
      });
    else if (
      body.operation === "verify" &&
      fields === "challengeId,operation,operationId,proof" &&
      typeof body.challengeId === "string" &&
      body.proof &&
      typeof body.proof === "object" &&
      !Array.isArray(body.proof)
    )
      result = await acceptWalletProof(database.pool, config, session.tokenHash, {
        operationId: body.operationId,
        challengeId: body.challengeId,
        proof: body.proof as WalletSignature,
      });
    else if (
      body.operation === "remove" &&
      fields === "operation,operationId,walletId" &&
      typeof body.walletId === "string"
    )
      result = await removeOwnWallet(database.pool, config, session.tokenHash, {
        operationId: body.operationId,
        walletId: body.walletId,
      });
    else throw new AppFailure(400, "Invalid wallet action. Refresh and try again.");
    return Response.json(result, { headers });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
export const GET = handle;
export const POST = handle;
