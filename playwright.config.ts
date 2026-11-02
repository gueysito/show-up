import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";

const containerHarness = process.env.SHOWUP_CONTAINER_E2E === "1";

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
        SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
        SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
        SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
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
