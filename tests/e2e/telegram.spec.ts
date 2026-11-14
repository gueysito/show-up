import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { authConfig, issuers } from "../../src/server/auth/config";
import { hash, identityIndex, seal } from "../../src/server/auth/crypto";
import {
  consumeTelegramConnection,
  createTelegramConnectionAttempt,
  ownTelegramConnection,
} from "../../src/server/telegram/connection";
import { accountFixtures } from "../fixtures/accounts";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test("optional bot: disabled default, explicit backend-fixture opt-in/start, status refresh and actual disconnect", async ({
  page,
  context,
}, testInfo) => {
  const f = await accountFixtures([[]]),
    bot = { id: "12345678", username: "showup_fixture_bot" };
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: process.env.SHOWUP_E2E_ENCRYPTION_KEY,
    SHOWUP_IDENTITY_INDEX_KEY: process.env.SHOWUP_E2E_INDEX_KEY,
  })!;
  const identity = { issuer: issuers.telegram, subject: randomUUID(), telegramUserId: "987654321" },
    index = identityIndex(config.indexKey, identity.issuer, identity.subject),
    session = hash(f.accounts[0].value);
  try {
    await f.pool.query(
      "INSERT INTO app_identities(identity_hash,account_id,provider,encrypted_identity) VALUES($1,$2,'telegram',$3)",
      [index, f.accounts[0].id, seal(config.encryptionKey, `identity:${index}`, identity)],
    );
    await f.enter(context, 0);
    await page.goto("/account");
    await page.getByRole("link", { name: "Optional Telegram messages" }).click();
    await expect(
      page.getByText("Telegram messages are currently unavailable.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create Telegram connection link" }),
    ).toBeDisabled();
    expect((await page.request.post("/api/telegram/webhook", { data: {} })).status()).toBe(404);
    // Configure only this browser's explicit backend fixture; no Bot API/token or
    // Telegram request is used. Disconnect still goes to the actual HTTP route.
    await page.route("**/api/telegram/connection", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: { ...(await ownTelegramConnection(f.pool, session)), available: true },
        });
      } else {
        const body = route.request().postDataJSON();
        if (body.action !== "connect") return route.continue();
        await route.fulfill({
          json: await createTelegramConnectionAttempt(f.pool, config, bot, session, {
            operationId: body.operationId,
            consentMessages: body.consentMessages,
          }),
        });
      }
    });
    await page.getByRole("button", { name: "Refresh connection status" }).click();
    const consent = page.getByRole("checkbox", { name: /I want optional event reminders/ });
    await expect(consent).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Create Telegram connection link" }),
    ).toBeDisabled();
    await consent.check();
    await page.getByRole("button", { name: "Create Telegram connection link" }).click();
    const link = page.getByRole("link", { name: "Open your private Telegram connection" });
    await expect(link).toBeVisible();
    const href = new URL((await link.getAttribute("href"))!);
    expect(href.origin).toBe("https://t.me");
    expect(href.pathname).toBe(`/${bot.username}`);
    await consumeTelegramConnection(f.pool, config, bot, {
      token: href.searchParams.get("start")!,
      sender: identity.telegramUserId,
      updateId: 42,
    });
    await page.getByRole("button", { name: "Refresh connection status" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Connected to @showup_fixture_bot." }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Disconnect Telegram messages" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("telegram-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Disconnect Telegram messages" }).click();
    await expect(page.getByRole("status")).toContainText("Telegram messages disconnected.");
    expect((await ownTelegramConnection(f.pool, session)).connected).toBe(false);
    expect(
      (
        await page.request.post("/api/telegram/connection", {
          headers: { origin: "https://foreign.invalid" },
          data: { action: "disconnect", operationId: randomUUID() },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await f.cleanup();
  }
});
