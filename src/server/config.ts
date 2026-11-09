export type DatabasePurpose = "development" | "test" | "production";

export function databaseConfig(env: Record<string, string | undefined> = process.env) {
  const purpose = env.SHOWUP_ENV;
  if (purpose !== "development" && purpose !== "test" && purpose !== "production") {
    throw new Error("SHOWUP_ENV must identify a development, test or production environment");
  }
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw new Error("DATABASE_URL is required and must be a PostgreSQL URL");
  }
  if (purpose === "production") {
    const host = env.SHOWUP_DATABASE_HOST ?? "";
    if (
      env.NODE_ENV !== "production" ||
      !/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.railway\.internal$/.test(host) ||
      url.hostname !== host ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      (url.port && url.port !== "5432") ||
      url.pathname !== "/showup" ||
      !url.username ||
      !url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("DATABASE_URL must target the designated private Railway database");
    }
    return { connectionString: url.href, purpose };
  }
  const expected = purpose === "test" ? "/showup_test" : "/showup_dev";
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
  return { connectionString: url.href, purpose };
}
