import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { sessionCookie } from "../../../../server/auth/sessions";
import { createDatabase } from "../../../../server/db/client";
import { prepareCommitmentRelease } from "../../../../server/commitments/release";
import { findPrivacySession } from "../../../../server/privacy/access";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../../server/http/security";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, true);
    database = createDatabase();
    const session = await findPrivacySession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    if (!session) throw new AppFailure(401, "Sign in again to recover your original commitment.");
    await limit(database.pool, `commitment-release:${session.accountId}`, 12);
    const body = await jsonBody(request, 1024);
    if (
      Object.keys(body).sort().join() !== "confirmRelease,consentId,operationId" ||
      typeof body.operationId !== "string" ||
      typeof body.consentId !== "string" ||
      body.confirmRelease !== true
    )
      throw new AppFailure(
        400,
        "Confirm release of the original commitment without changing its destinations.",
      );
    // No browser data or flag can construct a qualified source or activate signing.
    const result = await prepareCommitmentRelease(database.pool, config, session.tokenHash, {
      operationId: body.operationId,
      consentId: body.consentId,
      confirmRelease: true,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
