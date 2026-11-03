import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { requireSession, sessionCookie } from "../../../../server/auth/sessions";
import { attemptAttendanceCode } from "../../../../server/attendance/attempts";
import { createDatabase } from "../../../../server/db/client";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../../server/http/security";

export async function POST(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin);
    if (new URL(request.url).searchParams.size)
      throw new AppFailure(400, "Use the check-in action without query fields.");
    const body = await jsonBody(request, 2048);
    // Arrival means the complete bounded request reached the server, before any
    // database/qualification wait. No browser field supplies this timestamp.
    const receivedAt = Date.now();
    if (
      Object.keys(body).sort().join() !== "consentId,eventId,operationId,phrase" ||
      typeof body.eventId !== "string" ||
      typeof body.consentId !== "string" ||
      typeof body.operationId !== "string"
    )
      throw new AppFailure(400, "Choose the original event authorization and code.");
    database = createDatabase();
    const session = await requireSession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    // Transport headroom covers five attempts plus retries through rapid host
    // rotations; the per-window journal remains the actual five-guess boundary.
    await limit(database.pool, `attendance-attempt:${session.accountId}`, 60);
    await limit(database.pool, "attendance-attempt:global", 12000);
    // No HTTP input, provider flag or environment variable injects an engineering
    // observation. Default live admission fails closed while routes are unqualified.
    const result = await attemptAttendanceCode(
      database.pool,
      config,
      session.tokenHash,
      {
        eventId: body.eventId,
        consentId: body.consentId,
        operationId: body.operationId,
        phrase: body.phrase,
      },
      undefined,
      receivedAt,
    );
    return Response.json(result, {
      status:
        result.status === "pending_contract"
          ? 202
          : result.status === "incorrect_code"
            ? 422
            : result.status === "attempt_limit"
              ? 429
              : 409,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
