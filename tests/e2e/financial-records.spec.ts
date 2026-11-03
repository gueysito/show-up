import { expect, test } from "@playwright/test";
import { financialFixtures } from "../fixtures/financial-records";

test.use({
  baseURL: "https://localhost:3444",
  ignoreHTTPSErrors: true,
  timezoneId: "Pacific/Auckland",
});

test("own reconciliation reports waiting, unavailable and persistent conflict without claiming a funded seat", async ({
  page,
  context,
}) => {
  const f = await financialFixtures("near");
  try {
    await f.enter(context, 0);
    await f.watch("awaiting");
    await page.goto("/account/commitments");
    const status = page.getByRole("region", { name: "Reconciliation status" });
    await expect(status).toContainText("Waiting for finalized source records");
    await f.watch("unavailable");
    await page.reload();
    await expect(status).toContainText("temporarily unavailable");
    await f.watch("conflict");
    await page.reload();
    await expect(status).toContainText("Conflicting source records paused this check");
    await f.watch("unavailable");
    await page.reload();
    await expect(status).toContainText("Conflicting source records paused this check");
    await expect(
      page.getByText("Escrow not confirmed. No funded seat is shown for this authorization."),
    ).toBeVisible();
    const record = (await (await page.request.get("/api/commitments")).json()).records[0];
    expect(record.reconciliation.status).toBe("paused");
    expect(record.reconciliation.sourceQualified).toBe(false);
    expect(record.reconciliation.context).toBeUndefined();
    expect(record.reconciliation.funded).toBeUndefined();
    expect(record.fundingAllowed).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: "test-results/reconciliation-paused-mobile.png",
      fullPage: true,
    });
  } finally {
    await f.cleanup();
  }
});

test("own financial approvals persist without claiming escrow, and private history rejects ID swaps", async ({
  page,
  context,
  browser,
}) => {
  const f = await financialFixtures();
  try {
    await f.enter(context, 0);
    await page.goto("/account");
    await page.getByRole("link", { name: "Review your financial authorizations" }).click();
    await expect(page.getByRole("heading", { name: f.title })).toBeVisible();
    await expect(page.getByText("Financial terms approved", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Escrow not confirmed. No funded seat is shown for this authorization."),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: f.title })).toBeVisible();
    const response = await page.request.get("/api/commitments");
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    const record = (await response.json()).records[0];
    expect(record.fundingAllowed).toBe(false);
    for (const key of ["proof", "message", "nonce", "accountId"])
      expect(record[key]).toBeUndefined();
    for (const query of [
      "accountId=other",
      "before=bad",
      "before=" + f.consent.id + "&before=" + f.consent.id,
    ])
      expect((await page.request.get("/api/commitments?" + query)).status()).toBe(400);
    expect((await page.request.post("/api/commitments", { data: { funded: true } })).status()).toBe(
      405,
    );
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await f.enter(other, 2);
      const stranger = await other.newPage();
      await stranger.goto("https://localhost:3444/account/commitments");
      await expect(
        stranger.getByText("No financial authorizations are saved on this account."),
      ).toBeVisible();
      await expect(stranger.getByText(f.title)).toHaveCount(0);
      expect(
        (
          await stranger.request.get(
            `https://localhost:3444/api/commitments?before=${f.consent.id}`,
          )
        ).status(),
      ).toBe(404);
    } finally {
      await other.close();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const summary = page.getByText("Authorization details", { exact: true });
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(f.consent.terms.rulesHash, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "test-results/financial-records-mobile.png", fullPage: true });
    await page.getByRole("link", { name: "Back to your account" }).click();
    // Revocation can finish before the document redirect reaches the browser.
    await page.route("**/api/auth/logout", async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(page.getByRole("region", { name: "Sign in", exact: true })).toBeVisible();
    expect((await page.request.get("/api/commitments")).status()).toBe(401);
    await page.goBack();
    if (new URL(page.url()).pathname !== "/account/commitments") await page.goBack();
    await expect(page).toHaveURL(/\/account\/commitments$/);
    await expect(page.getByText(f.title)).toHaveCount(0);
    await page.goto("/account/commitments");
    await expect(
      page.getByRole("link", { name: "Sign in to view your financial authorizations" }),
    ).toBeVisible();
    await expect(page.getByText(f.title)).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});
