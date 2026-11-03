import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { financialFixtures } from "../fixtures/financial-records";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("explicit deletion erases only a cleared fictional account and authenticated completion survives refresh", async ({
  page,
  context,
}) => {
  const f = await accountFixtures([["host"], []]);
  try {
    await page.goto("/account/privacy?deletion=completed");
    await expect(page.getByText(/Deletion completed at/)).toHaveCount(0);
    await f.enter(context, 0);
    await page.goto("/host");
    const data = validDraft();
    await page.getByLabel("Event name", { exact: true }).fill("Fictional deletion draft");
    await page.getByLabel("Session URL", { exact: true }).fill(data.sessionReference);
    await page.getByLabel("Planned start (UTC)", { exact: true }).fill(data.startsAt.slice(0, 16));
    await page.getByLabel("Planned end (UTC)", { exact: true }).fill(data.endsAt.slice(0, 16));
    await page.getByLabel("Planned sponsor budget (USDC)", { exact: true }).fill("100");
    await page.getByRole("button", { name: "Validate & save draft" }).click();
    await page.getByRole("button", { name: "Close saved details" }).click();
    await page.getByRole("link", { name: "Account and host access" }).click();
    await page.getByRole("link", { name: "Your data and export" }).click();
    const button = page.getByRole("button", { name: "Request account deletion", exact: true });
    await expect(button).toBeDisabled();
    await page.getByLabel("Type DELETE to request deletion").fill("DELETE");
    await expect(button).toBeDisabled();
    await page.getByRole("checkbox", { name: /I understand that on-chain/ }).check();
    await button.click();
    await expect(page.getByRole("status")).toContainText("Deletion completed at");
    await page.reload();
    await expect(page.getByRole("status")).toContainText("Off-chain identity was removed");
    expect((await page.request.get("/api/account/export")).status()).toBe(401);
    expect(
      (await f.pool.query("SELECT count(*) FROM app_events WHERE owner_id=$1", [f.accounts[0].id]))
        .rows[0].count,
    ).toBe("0");
    await page.goBack();
    await expect(page).toHaveURL(/\/account$/);
    await expect(
      page.getByText(`Account reference: ${f.accounts[0].id}`, { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Sign in" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Host access required" })).toBeVisible();
    await expect(page.getByText("Fictional deletion draft")).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});

test("deletion with an approved record rotates sessions, preserves recovery data and denies new activity", async ({
  page,
  context,
  browser,
}) => {
  const f = await financialFixtures(),
    subject = randomUUID();
  const oldContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await f.linkFictionalIdentity(subject);
    await f.enter(context, 0);
    await f.enter(oldContext, 0);
    await page.goto("/account/privacy");
    expect(
      (
        await page.request.post("/api/account/deletion", {
          headers: { origin: "https://evil.example" },
          data: {},
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post("/api/account/deletion", {
          headers: { origin: "https://localhost:3444" },
          data: {
            operationId: randomUUID(),
            confirmation: "DELETE",
            acknowledgeOnChain: true,
            accountId: f.accounts[1].id,
            paid: true,
          },
        })
      ).status(),
    ).toBe(400);
    await page.getByLabel("Type DELETE to request deletion").fill("DELETE");
    await page.getByRole("checkbox", { name: /I understand that on-chain/ }).check();
    await page.getByRole("button", { name: "Request account deletion", exact: true }).click();
    await expect(page.getByRole("region", { name: "Deletion request status" })).toContainText(
      "New account activity is disabled",
    );
    await expect(page.getByRole("list", { name: "Unresolved deletion obligations" })).toContainText(
      "Original financial approvals still require qualified settlement and return evidence",
    );
    expect((await oldContext.request.get("https://localhost:3444/api/commitments")).status()).toBe(
      401,
    );
    const record = (await (await page.request.get("/api/commitments")).json()).records[0];
    expect(record.terms.source.address).toBe(f.consent.terms.source.address);
    expect(record.escrowState).toBe("not_confirmed");
    const exported = await (await page.request.get("/api/account/export")).json();
    expect(exported.account.state).toBe("deletion_requested");
    expect(exported.wallets).toEqual([]);
    expect(exported.financialAuthorizations[0].consent.id).toBe(f.consent.id);
    for (const path of ["/api/events", "/api/wallets"])
      expect((await page.request.get(path)).status()).toBe(401);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "test-results/deletion-pending-mobile.png", fullPage: true });
    await page.getByRole("link", { name: "Review your financial authorizations" }).click();
    await expect(page.getByRole("heading", { name: f.title })).toBeVisible();
    await page.getByRole("link", { name: "Back to your account" }).click();
    await expect(page.getByRole("heading", { name: "Restricted recovery access" })).toBeVisible();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    expect((await page.request.get("/api/commitments")).status()).toBe(401);
    const restored = await f.restoreFictionalIdentity(subject);
    expect(restored).toEqual({ accountId: f.accounts[0].id, recoveryOnly: true });
    await f.enter(context, 0);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Restricted recovery access" })).toBeVisible();
    expect((await page.request.get("/api/events")).status()).toBe(401);
    await page.getByRole("link", { name: "Review your financial authorizations" }).click();
    await expect(page.getByRole("heading", { name: f.title })).toBeVisible();
  } finally {
    await oldContext.close();
    await f.cleanup();
  }
});

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
