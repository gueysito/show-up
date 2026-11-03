import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { cookieOptions, sessionCookie, sessionSeconds } from "../../../../server/auth/sessions";
import { createDatabase } from "../../../../server/db/client";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../../server/http/security";
import { findPrivacySession } from "../../../../server/privacy/access";
import { requestAccountDeletion } from "../../../../server/privacy/deletion";
import {
  completedDeletionReceipt,
  deletionCompletionCookie,
} from "../../../../server/privacy/completion";

export async function POST(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin);
    if (new URL(request.url).search)
      throw new AppFailure(400, "Request deletion from your own account.");
    database = createDatabase();
    const jar = await cookies(),
      session = await findPrivacySession(database.pool, jar.get(sessionCookie)?.value);
    if (!session) throw new AppFailure(401, "Sign in again to request deletion.");
    await limit(database.pool, `privacy-deletion:${session.accountId}`, 3, 3600);
    const body = await jsonBody(request, 2048);
    if (Object.keys(body).sort().join() !== "acknowledgeOnChain,confirmation,intent,operationId")
      throw new AppFailure(400, "Review the deletion confirmation.");
    const { sessionValue, ...result } = await requestAccountDeletion(
      database.pool,
      config,
      session.tokenHash,
      body as {
        operationId: string;
        confirmation: string;
        acknowledgeOnChain: boolean;
        intent: string;
      },
    );
    if (sessionValue)
      jar.set(sessionCookie, sessionValue, { ...cookieOptions, maxAge: sessionSeconds });
    else if (result.state === "completed") {
      jar.delete(sessionCookie);
      jar.set(deletionCompletionCookie, completedDeletionReceipt(config, result), {
        ...cookieOptions,
        maxAge: 900,
      });
    }
    if (result.state !== "completed") jar.delete(deletionCompletionCookie);
    return Response.json(result, {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
