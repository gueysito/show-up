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
import { eventLoginReturn } from "../../../../../server/auth/return-path";

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
    const query = new URL(request.url).searchParams;
    if (
      [...query.keys()].some((key) => !["flow", "returnTo"].includes(key)) ||
      query.getAll("returnTo").length > 1 ||
      query.getAll("flow").length > 1
    )
      throw new AppFailure(400, "Choose a sign-in action from Showup.");
    const linking = query.get("flow") === "link",
      returnTo = eventLoginReturn(query.get("returnTo"));
    if (linking && !session) throw new AppFailure(401, "Sign in before linking another identity.");
    const browser = token();
    const url = await beginLogin(
      database.pool,
      config,
      provider,
      browser,
      linking ? session! : undefined,
      returnTo ?? undefined,
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
