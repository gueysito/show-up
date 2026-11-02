import { cookies } from "next/headers";
import { authConfig, isProvider } from "../../../../../server/auth/config";
import { token } from "../../../../../server/auth/crypto";
import { beginLogin } from "../../../../../server/auth/oidc";
import {
  browserCookie,
  cookieOptions,
  findSession,
  sessionCookie,
} from "../../../../../server/auth/sessions";
import { createDatabase } from "../../../../../server/db/client";
import { AppFailure, failureResponse, guardRequest } from "../../../../../server/http/security";

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isProvider(provider)) return new Response(null, { status: 404 });
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin);
    const jar = await cookies();
    database = createDatabase();
    const session = await findSession(database.pool, jar.get(sessionCookie)?.value);
    const linking = new URL(request.url).searchParams.get("flow") === "link";
    if (linking && !session) throw new AppFailure(401, "Sign in before linking another identity.");
    const browser = token();
    const url = await beginLogin(
      database.pool,
      config,
      provider,
      browser,
      linking ? session! : undefined,
    );
    jar.set(browserCookie, browser, { ...cookieOptions, maxAge: 600 });
    return new Response(null, {
      status: 303,
      headers: {
        Location: url.href,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
