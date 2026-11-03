import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { revokeSession, sessionCookie } from "../../../../server/auth/sessions";
import { findPrivacySession } from "../../../../server/privacy/access";
import { createDatabase } from "../../../../server/db/client";
import { AppFailure, failureResponse, guardRequest } from "../../../../server/http/security";

export async function POST(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin);
    database = createDatabase();
    const jar = await cookies();
    const session = await findPrivacySession(database.pool, jar.get(sessionCookie)?.value);
    if (!session) throw new AppFailure(401, "Sign in again to continue.");
    await revokeSession(
      database.pool,
      { ...session, roles: [] },
      new URL(request.url).searchParams.get("all") === "1",
    );
    jar.delete(sessionCookie);
    return new Response(null, {
      status: 303,
      headers: { Location: "/account", "Cache-Control": "no-store" },
    });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
