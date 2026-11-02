import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { requireSession, revokeSession, sessionCookie } from "../../../../server/auth/sessions";
import { createDatabase } from "../../../../server/db/client";
import { failureResponse, guardRequest } from "../../../../server/http/security";

export async function POST(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin);
    database = createDatabase();
    const jar = await cookies();
    const session = await requireSession(database.pool, jar.get(sessionCookie)?.value);
    await revokeSession(
      database.pool,
      session,
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
