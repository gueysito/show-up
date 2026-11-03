import { lstat, readFile } from "node:fs/promises";
import { approvedTunnelOrigin, authConfig } from "../src/server/auth/config";
import { databaseConfig } from "../src/server/config";

const names = new Set([
  "SHOWUP_ENV",
  "DATABASE_URL",
  "SHOWUP_AUTH",
  "SHOWUP_AUTH_ORIGIN",
  "SHOWUP_IDENTITY_KEY",
  "SHOWUP_IDENTITY_INDEX_KEY",
  "SHOWUP_GOOGLE_CLIENT_ID",
  "SHOWUP_GOOGLE_CLIENT_SECRET",
  "SHOWUP_TELEGRAM_CLIENT_ID",
  "SHOWUP_TELEGRAM_CLIENT_SECRET",
  "SHOWUP_TELEGRAM_BOT_ENABLED",
  "SHOWUP_TELEGRAM_BOT_ID",
  "SHOWUP_TELEGRAM_BOT_USERNAME",
  "SHOWUP_TELEGRAM_WEBHOOK_SECRET",
  "SHOWUP_TELEGRAM_MESSAGES_ENABLED",
  "SHOWUP_TELEGRAM_BOT_TOKEN",
]);

export function parseAuthEnvironment(text: string) {
  const result: Record<string, string> = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^(?:export )?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !names.has(match[1]) || Object.hasOwn(result, match[1]) || line.includes("\0"))
      throw new Error(`Invalid credential configuration at line ${index + 1}`);
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0])
        throw new Error(`Invalid credential configuration at line ${index + 1}`);
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

export async function loadAuthEnvironment(path = ".env.auth") {
  const info = await lstat(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.size > 16384)
    throw new Error("Credential file must be an owner-only regular file of at most 16 KiB");
  return parseAuthEnvironment(await readFile(path, "utf8"));
}

export function tunnelEnvironment(
  configured: Record<string, string | undefined>,
  inherited: Record<string, string | undefined> = process.env,
) {
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    ...configured,
    NODE_ENV: "production",
    SHOWUP_AUTH_ORIGIN: approvedTunnelOrigin,
    SHOWUP_HARNESS: "0",
    SHOWUP_ORIGIN: "",
    HOSTNAME: "127.0.0.1",
    PORT: "3445",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  if (databaseConfig(env).purpose !== "development")
    throw new Error("The approved tunnel requires the disposable development database");
  if (!authConfig(env)?.clients.telegram)
    throw new Error("Set SHOWUP_TELEGRAM_CLIENT_ID and SHOWUP_TELEGRAM_CLIENT_SECRET in .env.auth");
  return env;
}

export function privateWorkerEnvironment(
  configured: Record<string, string | undefined>,
  inherited: Record<string, string | undefined> = process.env,
) {
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    NODE_ENV: "production",
    SHOWUP_ENV: configured.SHOWUP_ENV,
    DATABASE_URL: configured.DATABASE_URL,
    SHOWUP_IDENTITY_KEY: configured.SHOWUP_IDENTITY_KEY,
    SHOWUP_AUTH: "0",
    SHOWUP_HARNESS: "0",
  };
  for (const name of [
    "SHOWUP_IDENTITY_INDEX_KEY",
    "SHOWUP_GOOGLE_CLIENT_ID",
    "SHOWUP_GOOGLE_CLIENT_SECRET",
    "SHOWUP_TELEGRAM_CLIENT_ID",
    "SHOWUP_TELEGRAM_CLIENT_SECRET",
    "SHOWUP_TELEGRAM_BOT_ENABLED",
    "SHOWUP_TELEGRAM_BOT_ID",
    "SHOWUP_TELEGRAM_BOT_USERNAME",
    "SHOWUP_TELEGRAM_WEBHOOK_SECRET",
    "SHOWUP_TELEGRAM_MESSAGES_ENABLED",
    "SHOWUP_TELEGRAM_BOT_TOKEN",
  ])
    delete env[name];
  if (
    databaseConfig(env).purpose !== "development" ||
    !["localhost", "127.0.0.1"].includes(new URL(env.DATABASE_URL!).hostname) ||
    !/^[0-9a-f]{64}$/.test(env.SHOWUP_IDENTITY_KEY ?? "")
  )
    throw new Error(
      "Private worker requires the local development database and existing encryption key",
    );
  return env;
}
