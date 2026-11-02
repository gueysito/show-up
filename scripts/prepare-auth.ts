import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

// Creates new local application keys; never reads existing credentials or wallet keys.
try {
  const lines = [
    "SHOWUP_ENV=development",
    "DATABASE_URL=postgresql://showup@127.0.0.1:55432/showup_dev",
    "SHOWUP_AUTH=1",
    "SHOWUP_AUTH_ORIGIN=https://localhost:3443",
    `SHOWUP_IDENTITY_KEY=${randomBytes(32).toString("hex")}`,
    `SHOWUP_IDENTITY_INDEX_KEY=${randomBytes(32).toString("hex")}`,
    "SHOWUP_GOOGLE_CLIENT_ID=",
    "SHOWUP_GOOGLE_CLIENT_SECRET=",
    "SHOWUP_TELEGRAM_CLIENT_ID=",
    "SHOWUP_TELEGRAM_CLIENT_SECRET=",
    "",
  ];
  await writeFile(".env.auth", lines.join("\n"), { flag: "wx", mode: 0o600 });
  console.log(
    "Prepared ignored .env.auth with new identity keys and empty provider fields. No existing file was read.",
  );
} catch {
  console.error(
    "Could not create .env.auth. Existing files are never overwritten; inspect setup instructions.",
  );
  process.exitCode = 1;
}
