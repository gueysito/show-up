import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

if (process.env.SHOWUP_MAINNET_BROWSER !== "1")
  throw new Error(
    "This owner-operated check submits a real mainnet publication. Set SHOWUP_MAINNET_BROWSER=1 explicitly.",
  );

export default defineConfig({ ...base, testDir: "./tests/mainnet", retries: 0, workers: 1 });
