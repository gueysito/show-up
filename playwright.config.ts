import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

const containerHarness = process.env.SHOWUP_CONTAINER_E2E === "1";
// Disposable per-run keys, inherited by browser-test workers for fixture records.
// Application configuration never reads these names; no operator credential file is used.
const fixtureKey = (name: string) => (process.env[name] ??= randomBytes(32).toString("hex"));
const fixtureEncryptionKey = fixtureKey("SHOWUP_E2E_ENCRYPTION_KEY");
const fixtureIndexKey = fixtureKey("SHOWUP_E2E_INDEX_KEY");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3102",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node .next/standalone/server.js",
      url: "http://127.0.0.1:3102",
      reuseExistingServer: false,
      env: {
        SHOWUP_ENV: "test",
        DATABASE_URL: "postgresql://showup@127.0.0.1:55433/showup_test",
        NEXT_TELEMETRY_DISABLED: "1",
        PORT: "3102",
        HOSTNAME: "127.0.0.1",
        SHOWUP_HARNESS: "1",
        SHOWUP_ORIGIN: "http://127.0.0.1:3101",
        SHOWUP_AUTH: "1",
        SHOWUP_TELEGRAM_BOT_ENABLED: "0",
        SHOWUP_TELEGRAM_MESSAGES_ENABLED: "0",
        SHOWUP_TELEGRAM_BOT_TOKEN: "",
        SHOWUP_TELEGRAM_WEBHOOK_SECRET: "",
        SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
        SHOWUP_IDENTITY_KEY: fixtureEncryptionKey,
        SHOWUP_IDENTITY_INDEX_KEY: fixtureIndexKey,
      },
    },
    {
      command: "node --import tsx scripts/local-https.ts 3444 3102",
      url: "https://localhost:3444/account",
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
    },
    ...(containerHarness
      ? []
      : [
          {
            command: "node_modules/.bin/next dev --hostname 127.0.0.1 --port 3103",
            url: "http://127.0.0.1:3103/workbench",
            reuseExistingServer: false,
            env: {
              NODE_ENV: "development",
              SHOWUP_ENV: "test",
              DATABASE_URL: "postgresql://showup@127.0.0.1:55433/showup_test",
              NEXT_TELEMETRY_DISABLED: "1",
              SHOWUP_HARNESS: "1",
              SHOWUP_ORIGIN: "http://127.0.0.1:3103",
            },
          },
        ]),
  ],
});
