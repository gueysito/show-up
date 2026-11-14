export function harnessAvailable(env: Record<string, string | undefined> = process.env) {
  return (
    env.NODE_ENV === "development" &&
    (env.SHOWUP_ENV === "development" || env.SHOWUP_ENV === "test") &&
    env.SHOWUP_HARNESS === "1" &&
    ["http://127.0.0.1:3101", "http://127.0.0.1:3103"].includes(env.SHOWUP_ORIGIN ?? "")
  );
}

export function harnessRequestAllowed(
  request: Request,
  env: Record<string, string | undefined> = process.env,
) {
  if (!harnessAvailable(env)) return false;
  const origin = env.SHOWUP_ORIGIN!;
  return (
    request.headers.get("host") === new URL(origin).host &&
    request.headers.get("x-showup-harness") === "1" &&
    (request.method === "GET"
      ? !request.headers.get("origin") || request.headers.get("origin") === origin
      : request.headers.get("origin") === origin)
  );
}
