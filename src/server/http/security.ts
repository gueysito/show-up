import type pg from "pg";
import { hash } from "../auth/crypto";

export class AppFailure extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function guardRequest(request: Request, origin: string, mutation = true) {
  if (
    request.headers.get("host") !== new URL(origin).host ||
    (mutation && request.headers.get("origin") !== origin) ||
    (mutation && request.headers.get("sec-fetch-site") === "cross-site")
  )
    throw new AppFailure(403, "Open Showup directly and retry this action.");
}

export async function limit(pool: pg.Pool, scope: string, maximum: number, seconds = 60) {
  const result = await pool.query(
    `
    INSERT INTO app_rate_limits (key_hash, window_start, attempts)
    VALUES ($1, clock_timestamp(), 1)
    ON CONFLICT (key_hash) DO UPDATE SET
      attempts = CASE WHEN app_rate_limits.window_start <= clock_timestamp() - $2 * interval '1 second'
        THEN 1 ELSE app_rate_limits.attempts + 1 END,
      window_start = CASE WHEN app_rate_limits.window_start <= clock_timestamp() - $2 * interval '1 second'
        THEN clock_timestamp() ELSE app_rate_limits.window_start END
    RETURNING attempts`,
    [hash(scope), seconds],
  );
  if (result.rows[0].attempts > maximum)
    throw new AppFailure(429, "Too many attempts. Wait and retry.");
}

export async function jsonBody(
  request: Request,
  maximum = 32768,
): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new AppFailure(415, "Use JSON for this operation.");
  const reader = request.body?.getReader();
  if (!reader) throw new AppFailure(400, "Missing request.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new AppFailure(413, "Request is too large.");
    }
    chunks.push(value);
  }
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new AppFailure(400, "Invalid JSON request.");
  }
}

export function failureResponse(error: unknown) {
  return Response.json(
    { error: error instanceof AppFailure ? error.message : "Service unavailable. Retry later." },
    {
      status: error instanceof AppFailure ? error.status : 503,
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    },
  );
}
