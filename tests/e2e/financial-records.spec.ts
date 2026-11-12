import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { financialFixtures } from "../fixtures/financial-records";
import { v1EventFixture } from "../fixtures/v1-event";
import { readV1RegistrationState } from "../../src/server/commitments/v1-registration";
import {
  readV1PaidRefund,
  requestV1Close,
  requestV1Withdrawal,
} from "../../src/server/events/v1-actions";
import { runV1Action } from "../../src/worker/v1-actions";

test.use({
  baseURL: "https://localhost:3444",
  ignoreHTTPSErrors: true,
  timezoneId: "Pacific/Auckland",
});

test("an attendee can open a paid refund from their account without live chain data", async ({
  page,
  context,
}) => {
  const f = await v1EventFixture({
    encryption: process.env.SHOWUP_E2E_ENCRYPTION_KEY!,
    index: process.env.SHOWUP_E2E_INDEX_KEY!,
  });
  const { pool, config, sessions, eventId, transport, key, gateway } = f;
  try {
    expect(
      (await readV1RegistrationState(pool, config, sessions[1], eventId, transport)).funded,
    ).toBe(true);
    await requestV1Close(pool, config, sessions[0], randomUUID(), eventId, "cancel", transport);
    expect((await runV1Action(pool, key, gateway)).state).toBe("verified");
    await page.setViewportSize({ width: 320, height: 844 });
    await f.enter(context, 1);
    await page.goto("/account/commitments");
    await expect(page.getByRole("region", { name: "Deposits and refunds" })).toContainText(
      "Refund available",
    );
    await expect(page.getByRole("link", { name: /Withdraw refund for/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const withdrawal = await requestV1Withdrawal(
      pool,
      config,
      sessions[1],
      randomUUID(),
      eventId,
      "deposit",
      transport,
    );
    await page.reload();
    await expect(page.getByRole("region", { name: "Deposits and refunds" })).toContainText(
      "Refund pending",
    );
    expect(await readV1PaidRefund(pool, config, sessions[1], eventId)).toBeNull();
    expect((await runV1Action(pool, key, gateway)).state).toBe("verified");
    const { transaction_hash: hash } = (
      await pool.query("SELECT transaction_hash FROM app_v1_event_actions WHERE id=$1", [
        withdrawal.actionId,
      ])
    ).rows[0];
    await page.setViewportSize({ width: 390, height: 844 });
    await f.enter(context, 1);
    await page.goto("/account");
    await page.getByRole("link", { name: "Deposits and refunds" }).click();
    const refunds = page.getByRole("region", { name: "Deposits and refunds" });
    await expect(refunds).toContainText("Refund received");
    await refunds
      .getByRole("link", { name: `View receipt for ${String(f.event().title)}` })
      .click();
    await expect(page).toHaveURL(new RegExp(`/events/${eventId}/commit#refund$`));
    const receipt = page.getByRole("region", { name: "Refund receipt" });
    await expect(receipt).toContainText("1.00 USDC sent");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const confirmation = receipt.getByRole("status").locator("..");
    await expect(confirmation).toHaveCSS("animation-name", "none");
    await expect(confirmation).toHaveCSS("background-color", "rgb(235, 244, 232)");
    await expect(receipt).toContainText("sent to attendee-1.near on NEAR.");
    await expect(receipt.getByRole("link", { name: "View refund transaction" })).toHaveAttribute(
      "href",
      `https://nearblocks.io/txns/${hash}`,
    );
    await receipt.getByText("Transaction hash", { exact: true }).click();
    await expect(receipt.getByText(hash, { exact: true })).toBeVisible();
    await page.reload();
    await expect(receipt).toBeVisible();
    await f.enter(context, 2);
    expect(await readV1PaidRefund(pool, config, sessions[2], eventId)).toBeNull();
    await page.reload();
    await expect(receipt).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
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
    await expect(
      page
        .getByRole("region", { name: "Original financial limits" })
        .getByText("Maximum source gas cost", { exact: true })
        .locator(".."),
    ).toContainText("0.0000000000000000001 NEAR");
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
    await page.getByRole("link", { name: "Review event terms" }).click();
    await expect(page.getByRole("heading", { name: f.title })).toBeVisible();
    await expect(page.getByText("Financial terms approved", { exact: true })).toBeVisible();
    const release = page.getByRole("region", { name: "Release and recovery availability" });
    for (const zone of [f.consent.terms.timeZone, "Pacific/Auckland"])
      await expect(release.locator(`time[data-time-zone="${zone}"]`)).toHaveAttribute(
        "datetime",
        new Date(f.consent.terms.registrationClosesAt - 600_000).toISOString(),
      );
    const limits = page.getByRole("region", { name: "Original financial limits" });
    for (const [label, value] of [
      ["Maximum source input", "5.1 USDC"],
      ["Maximum source gas cost", "0.0000000000001 ETH"],
      ["Maximum routing fee", "0.10 USDC"],
      ["Maximum delivery fee", "0.05 USDC"],
      ["Platform fee", "0.00 USDC"],
    ])
      await expect(limits.getByText(label, { exact: true }).locator("..")).toContainText(value);
    for (const [label, expiry] of [
      ["Recorded quote expiry", f.consent.terms.quoteExpiresAt],
      ["Recorded reservation expiry limit", f.consent.terms.reservationExpiresAt],
      ["Funding authorization expiry", f.consent.terms.authorizationExpiresAt],
    ] as const) {
      const row = limits.getByText(label, { exact: true }).locator("..");
      const eventTime = row.locator('time[data-time-zone="America/Denver"]');
      const localTime = row.locator('time[data-time-zone="Pacific/Auckland"]');
      for (const time of [eventTime, localTime])
        await expect(time).toHaveAttribute("datetime", new Date(expiry).toISOString());
      await expect(eventTime).toContainText("(America/Denver)");
      await expect(localTime).toContainText("(Pacific/Auckland)");
    }
    // Recovery transport metadata fixture only, never a live transfer or payment receipt.
    await f.pool.query(
      "INSERT INTO app_principal_recoveries(consent_id,request_hash,encrypted_request,state,last_effect) VALUES($1,$2,$3,'broadcast_unknown','withdraw')",
      [f.consent.id, "e".repeat(64), "engineering-recovery-fixture"],
    );
    await f.pool.query(
      "INSERT INTO app_commitment_releases(operation_id,consent_id,account_id,image_hash,encrypted_image,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '2 minutes')",
      [
        crypto.randomUUID(),
        f.consent.id,
        f.accounts[0].id,
        "c".repeat(64),
        "engineering-release-fixture",
      ],
    );
    await page.reload();
    const recovery = page.getByRole("region", { name: "Principal recovery status" });
    await expect(recovery).toContainText("Submission acknowledgement is unknown");
    await expect(
      page.getByRole("region", { name: "Release and recovery availability" }),
    ).toContainText("Original release request saved. Release is not confirmed.");
    await expect(
      page.getByRole("button", { name: "Release commitment · qualified route required" }),
    ).toBeDisabled();
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
    expect(record.principalRecovery.paymentConfirmed).toBe(false);
    expect(record.principalRecovery.sourceQualified).toBe(false);
    expect(record.principalRecovery.encrypted_request).toBeUndefined();
    expect(record.releaseRequest.releaseConfirmed).toBe(false);
    expect(record.releaseRequest.encrypted_image).toBeUndefined();
    const releaseResponse = await page.request.post("/api/commitments/release", {
      headers: { origin: "https://localhost:3444" },
      data: { operationId: crypto.randomUUID(), consentId: f.consent.id, confirmRelease: true },
    });
    expect(releaseResponse.status()).toBe(503);
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
    const recordsHistoryLength = await page.evaluate(() => history.length);
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
    // Logout can add a second /account entry. Return to the original records
    // entry in one native traversal; Next may reload while restoring its tree.
    const offset = recordsHistoryLength - (await page.evaluate(() => history.length));
    expect(offset).toBeLessThan(0);
    await page.evaluate((delta) => history.go(delta), offset);
    await expect(page).toHaveURL(/\/account\/commitments#reviewed-terms$/);
    await expect(
      page.getByRole("link", { name: "Sign in to view your financial authorizations" }),
    ).toBeVisible();
    expect((await page.request.get("/api/commitments")).status()).toBe(401);
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
