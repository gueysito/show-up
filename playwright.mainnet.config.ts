import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const replay = process.env.SHOWUP_MAINNET_REPLAY === "1";
const prize = process.env.SHOWUP_MAINNET_PRIZE === "1";
const deposit = process.env.SHOWUP_MAINNET_DEPOSIT === "1";
if (!replay && !prize && !deposit && process.env.SHOWUP_MAINNET_BROWSER !== "1")
  throw new Error(
    "This owner-operated check submits a real mainnet publication. Set SHOWUP_MAINNET_BROWSER=1 explicitly.",
  );

export default defineConfig({
  ...base,
  testDir: "./tests/mainnet",
  retries: 0,
  workers: 1,
  expect: { timeout: 30000 },
  testMatch: deposit
    ? "**/deposit.spec.ts"
    : replay
      ? "**/publication-replay.spec.ts"
      : prize
        ? "**/prize-publication.spec.ts"
        : "**/publication.spec.ts",
});
