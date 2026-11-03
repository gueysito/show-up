import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { financialFixtures } from "../fixtures/financial-records";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("private JSON download contains only owned data, excludes security tokens and rejects cross-site and revoked access", async ({
  page,
  context,
  browser,
}) => {
  const f = await financialFixtures(),
    subject = randomUUID();
  try {
    await f.linkFictionalIdentity(subject);
    await f.enter(context, 0);
    await page.goto("/account");
    await page.getByRole("link", { name: "Your data and export" }).click();
    await expect(page.getByRole("heading", { name: "Your data", exact: true })).toBeVisible();
    const pending = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download your data as JSON" }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe("showup-account-export.json");
    const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
    expect(exported.account.id).toBe(f.accounts[0].id);
    expect(exported.linkedIdentities[0].subject).toBe(subject);
    expect(exported.financialAuthorizations[0].consent.id).toBe(f.consent.id);
    expect(exported.financialAuthorizations[0].escrowConfirmed).toBe(false);
    expect(exported.hostedEvents).toEqual([]);
    const json = JSON.stringify(exported);
    for (const privateValue of [f.accounts[0].value, f.accounts[1].id, f.accounts[2].id])
      expect(json.includes(privateValue)).toBe(false);
    for (const field of [
      "token_hash",
      "identity_hash",
      "encrypted_identity",
      "wallet_index",
      "encrypted_proof",
    ])
      expect(json.includes(field)).toBe(false);
    const response = await page.request.get("/api/account/export");
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["content-disposition"]).toContain("attachment");
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(
      (await page.request.get(`/api/account/export?accountId=${f.accounts[1].id}`)).status(),
    ).toBe(400);
    expect(
      (
        await page.request.get("/api/account/export", {
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post("/api/account/export", { data: { accountId: f.accounts[1].id } })
      ).status(),
    ).toBe(405);
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await f.enter(other, 2);
      const otherExport = await (
        await other.request.get("https://localhost:3444/api/account/export")
      ).json();
      expect(otherExport.account.id).toBe(f.accounts[2].id);
      expect(otherExport.wallets).toEqual([]);
      expect(otherExport.financialAuthorizations).toEqual([]);
      expect(JSON.stringify(otherExport).includes(subject)).toBe(false);
    } finally {
      await other.close();
    }
    expect((await page.request.get("/api/account/export")).status()).toBe(200);
    expect((await page.request.get("/api/account/export")).status()).toBe(429);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("link", { name: "Download your data as JSON" }).focus();
    await expect(page.getByRole("link", { name: "Download your data as JSON" })).toBeFocused();
    await page.screenshot({ path: "test-results/privacy-export-mobile.png", fullPage: true });
    await page.getByRole("link", { name: "Back to your account" }).click();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    expect((await page.request.get("/api/account/export")).status()).toBe(401);
    await page.goto("/account/privacy");
    await expect(page.getByRole("link", { name: "Sign in to access your data" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download your data as JSON" })).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});
