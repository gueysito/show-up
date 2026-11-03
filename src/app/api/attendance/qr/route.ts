import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { requireSession, sessionCookie } from "../../../../server/auth/sessions";
import {
  issueAttendanceQr,
  scanAttendanceQr,
  confirmAttendanceQr,
} from "../../../../server/attendance/qr";
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
      throw new AppFailure(400, "Use the private QR action without query fields.");
    const body = await jsonBody(request, 2048),
      received = Date.now();
    const fields =
      body.action === "issue"
        ? "action,consentId,eventId,operationId"
        : body.action === "scan"
          ? "action,eventId,operationId,payload"
          : body.action === "confirm"
            ? "action,confirmPresence,eventId,operationId,scanId"
            : null;
    if (
      !fields ||
      Object.keys(body).sort().join() !== fields ||
      typeof body.eventId !== "string" ||
      typeof body.operationId !== "string"
    )
      throw new AppFailure(400, "Choose a valid personal QR, scan or presence confirmation.");
    database = createDatabase();
    const session = await requireSession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    await limit(
      database.pool,
      `attendance-qr:${body.action}:${session.accountId}`,
      body.action === "issue" ? 12 : 60,
    );
    await limit(database.pool, "attendance-qr:global", 12000);
    // This route never constructs an engineering observation or signs/submits
    // attendance. Default evidence admission stays closed while unqualified.
    let result;
    if (body.action === "issue" && typeof body.consentId === "string")
      result = await issueAttendanceQr(
        database.pool,
        config,
        session.tokenHash,
        { eventId: body.eventId, consentId: body.consentId, operationId: body.operationId },
        undefined,
        received,
      );
    else if (body.action === "scan")
      result = await scanAttendanceQr(
        database.pool,
        config,
        session.tokenHash,
        { eventId: body.eventId, operationId: body.operationId, payload: body.payload },
        undefined,
        received,
      );
    else if (
      body.action === "confirm" &&
      typeof body.scanId === "string" &&
      typeof body.confirmPresence === "boolean"
    )
      result = await confirmAttendanceQr(
        database.pool,
        config,
        session.tokenHash,
        {
          eventId: body.eventId,
          operationId: body.operationId,
          scanId: body.scanId,
          confirmPresence: body.confirmPresence,
        },
        undefined,
        received,
      );
    else throw new AppFailure(400, "Choose a valid personal QR, scan or presence confirmation.");
    return Response.json(result, {
      status: 202,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
