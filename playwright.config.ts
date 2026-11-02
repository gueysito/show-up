import { defineConfig } from "@playwright/test";

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
  webServer: {
    command: "node .next/standalone/server.js",
    url: "http://127.0.0.1:3102",
    reuseExistingServer: false,
    env: {
      SHOWUP_ENV: "test",
      DATABASE_URL: "postgresql://showup@127.0.0.1:55433/showup_test",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: "3102",
      HOSTNAME: "127.0.0.1",
    },
  },
});
