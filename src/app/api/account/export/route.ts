import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { sessionCookie } from "../../../../server/auth/sessions";
import { createDatabase } from "../../../../server/db/client";
import { AppFailure, failureResponse, guardRequest, limit } from "../../../../server/http/security";
import { findPrivacySession } from "../../../../server/privacy/access";
import { exportOwnData } from "../../../../server/privacy/export";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, false);
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw new AppFailure(403, "Open your Showup account to export your data.");
    if (new URL(request.url).search)
      throw new AppFailure(400, "Exports contain only the signed-in account's data.");
    database = createDatabase();
    const session = await findPrivacySession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    if (!session) throw new AppFailure(401, "Sign in again to export your data.");
    await limit(database.pool, `privacy-export:${session.accountId}`, 3, 3600);
    return Response.json(await exportOwnData(database.pool, config, session.tokenHash), {
      headers: {
        "Content-Disposition": 'attachment; filename="showup-account-export.json"',
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
