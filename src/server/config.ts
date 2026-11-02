export type DatabasePurpose = "development" | "test";

export function databaseConfig(env: Record<string, string | undefined> = process.env) {
  if (env.SHOWUP_ENV !== "development" && env.SHOWUP_ENV !== "test") {
    throw new Error("SHOWUP_ENV must identify a disposable development or test environment");
  }
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw new Error("DATABASE_URL is required and must be a PostgreSQL URL");
  }
  const expected = env.SHOWUP_ENV === "test" ? "/showup_test" : "/showup_dev";
  const allowedHosts = ["127.0.0.1", "localhost", "db", "test-db"];
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !allowedHosts.includes(url.hostname) ||
    url.pathname !== expected ||
    url.search ||
    url.hash
  ) {
    throw new Error("DATABASE_URL must target the designated local Showup database");
  }
  return { connectionString: url.href, purpose: env.SHOWUP_ENV as DatabasePurpose };
}
