import { cookies } from "next/headers";
import { authConfig, isProvider } from "../../../../../server/auth/config";
import { hash } from "../../../../../server/auth/crypto";
import { finishLogin } from "../../../../../server/auth/oidc";
import {
  browserCookie,
  cookieOptions,
  sessionCookie,
  sessionSeconds,
} from "../../../../../server/auth/sessions";
import { createDatabase } from "../../../../../server/db/client";
import { guardRequest } from "../../../../../server/http/security";

export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  if (!isProvider(provider)) return new Response(null, { status: 404 });
  let database: ReturnType<typeof createDatabase> | undefined;
  let location = "/account?auth=failed";
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, false);
    database = createDatabase();
    const jar = await cookies();
    const previous = jar.get(sessionCookie)?.value;
    const result = await finishLogin(
      database.pool,
      config,
      provider,
      new URL(request.url).search,
      jar.get(browserCookie)?.value ?? "",
      previous ? hash(previous) : undefined,
    );
    jar.set(sessionCookie, result.value, { ...cookieOptions, maxAge: sessionSeconds });
    jar.delete(browserCookie);
    location = "/account?auth=complete";
  } catch {
    // Provider responses, code, ID token and private claims never enter logs or URLs.
  } finally {
    await database?.pool.end();
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
