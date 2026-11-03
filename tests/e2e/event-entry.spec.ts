import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { authConfig } from "../../src/server/auth/config";
import { hash, seal } from "../../src/server/auth/crypto";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { requiredNetworks } from "../../src/server/protocol/manifest";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { issueInvitation } from "../../src/server/invitations/service";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";

test.use({
  baseURL: "https://localhost:3444",
  ignoreHTTPSErrors: true,
  timezoneId: "Pacific/Auckland",
});
test("event entry: public sign-in context, private invitation-to-event handoff and closed deposits in both modes", async ({
  page,
  context,
  browser,
}, testInfo) => {
  const f = await accountFixtures([["host"], [], []]),
    publicId = randomUUID(),
    privateId = randomUUID();
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: process.env.SHOWUP_E2E_ENCRYPTION_KEY,
    SHOWUP_IDENTITY_INDEX_KEY: process.env.SHOWUP_E2E_INDEX_KEY,
  })!;
  const host = hash(f.accounts[0].value),
    open = {
      ...validDraft(),
      title: "Fictional online event entry",
      timeZone: "America/Denver",
      access: "open" as const,
    },
    privateEvent = {
      ...validDraft(),
      title: "Fictional invited studio",
      timeZone: "America/Denver",
      mode: "physical" as const,
      venue: "Fictional studio",
      access: "invitation" as const,
    };
  try {
    for (const [id, data] of [
      [publicId, open],
      [privateId, privateEvent],
    ] as const) {
      await saveAccountDraft(f.pool, config.encryptionKey, host, {
        id,
        data,
        revision: 0,
        operationId: randomUUID(),
      });
      // Published-state engineering fixture, never live route/funding evidence.
      await f.pool.query(
        "UPDATE app_events SET state='published',rules_hash=$2,published_at=clock_timestamp() WHERE id=$1",
        [id, "b".repeat(64)],
      );
    }
    await page.goto(`/events/${publicId}`);
    await expect(page.getByRole("heading", { name: open.title })).toBeVisible();
    for (const [label, instant] of [
      ["Starts", open.startsAt],
      ["Ends", open.endsAt],
    ]) {
      const row = page.getByText(label, { exact: true }).locator("+ dd");
      for (const zone of [open.timeZone, "Pacific/Auckland"])
        await expect(row.locator(`time[data-time-zone="${zone}"]`)).toHaveAttribute(
          "datetime",
          instant,
        );
    }
    await expect(page.getByRole("button", { name: "Deposits closed", exact: true })).toBeDisabled();
    const google = page.getByRole("button", {
      name: "Sign in with Google and return to this event",
    });
    await expect(google).toBeDisabled();
    expect(await google.locator("..").getAttribute("action")).toContain(
      encodeURIComponent(`/events/${publicId}`),
    );
    expect(
      (
        await page.request.post("/api/auth/start/google?returnTo=https%3A%2F%2Fforeign.invalid", {
          headers: { origin: config.origin },
        })
      ).status(),
    ).toBe(400);
    expect(await page.content()).not.toContain(f.accounts[0].id);
    expect((await page.goto(`/events/${privateId}`))?.status()).toBe(404);
    const invitation = await issueInvitation(f.pool, config, host, randomUUID(), {
      kind: "event",
      eventId: privateId,
    });
    await f.enter(context, 1);
    await page.goto(invitation.url);
    await page.getByRole("checkbox", { name: /I accept this access grant/ }).check();
    await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await page.getByRole("link", { name: "Open your invited event" }).click();
    await expect(page.getByRole("heading", { name: privateEvent.title })).toBeVisible();
    await expect(page.getByText("Venue: Fictional studio", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Deposits closed", exact: true })).toBeDisabled();
    const verifiedWallets = [];
    for (const network of requiredNetworks) {
      // Already-verified engineering records; actual wallet control has its own UI checks.
      const wallet = {
        id: randomUUID(),
        network,
        address:
          network === "near"
            ? "fictional.near"
            : network === "solana"
              ? encodeBase58(Buffer.alloc(32, 3))
              : `0x${"12".repeat(20)}`,
        verifiedAt: new Date().toISOString(),
      };
      await f.pool.query(
        "INSERT INTO app_wallets(id,account_id,wallet_index,network,encrypted_wallet,verified_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          wallet.id,
          f.accounts[1].id,
          wallet.id,
          network,
          seal(config.encryptionKey, `wallet:${f.accounts[1].id}:${wallet.id}`, wallet),
          wallet.verifiedAt,
        ],
      );
      verifiedWallets.push(wallet);
    }
    await page.getByRole("link", { name: "Review wallets and commitment destinations" }).click();
    await page.getByLabel("Source wallet", { exact: true }).selectOption(verifiedWallets[1].id);
    await page
      .getByLabel("Source-refund wallet", { exact: true })
      .selectOption(verifiedWallets[1].id);
    await page
      .getByLabel("Principal payout wallet", { exact: true })
      .selectOption(verifiedWallets[3].id);
    await page.getByRole("link", { name: "Verify another wallet for this event" }).click();
    await expect(page.getByRole("heading", { name: "Your wallets", exact: true })).toBeVisible();
    // A real wallet redirect replaces the document. Reload this isolated wallet
    // page to prove choices survive that boundary rather than router memory.
    await page.reload();
    await page.getByRole("link", { name: "Return to this event's commitment review" }).click();
    await expect(page.getByLabel("Source wallet", { exact: true })).toHaveValue(
      verifiedWallets[1].id,
    );
    await expect(page.getByLabel("Source-refund wallet", { exact: true })).toHaveValue(
      verifiedWallets[1].id,
    );
    await expect(page.getByLabel("Principal payout wallet", { exact: true })).toHaveValue(
      verifiedWallets[3].id,
    );
    await expect(page.getByRole("status")).toContainText(
      "Your previous wallet choices were restored",
    );
    const cached = await page.evaluate(() =>
      Object.entries(sessionStorage)
        .filter(([key]) => key.startsWith("showup.commitment-choices.v1:"))
        .map(([, value]) => JSON.parse(value)),
    );
    expect(cached).toHaveLength(1);
    expect(Object.keys(cached[0]).sort()).toEqual(["expiresAt", "payout", "refund", "source"]);
    expect(cached[0]).toMatchObject({
      source: verifiedWallets[1].id,
      refund: verifiedWallets[1].id,
      payout: verifiedWallets[3].id,
    });
    expect((await page.content()).includes(config.indexKey)).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("commitment-restored-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Review destinations and fee availability" }).click();
    const review = page.getByRole("region", { name: "Reviewed commitment destinations" });
    await expect(review).toContainText("No qualified quote");
    const closes = review.getByText("Registration closes", { exact: true }).locator("+ dd");
    for (const zone of [privateEvent.timeZone, "Pacific/Auckland"])
      await expect(closes.locator(`time[data-time-zone="${zone}"]`)).toHaveAttribute(
        "datetime",
        privateEvent.startsAt,
      );
    await expect(review).toContainText(verifiedWallets[3].address);
    await expect(
      review.getByRole("button", { name: "Approve financial terms · verified quote required" }),
    ).toBeDisabled();
    expect(
      await page.evaluate(
        () =>
          Object.keys(sessionStorage).filter((key) =>
            key.startsWith("showup.commitment-choices.v1:"),
          ).length,
      ),
    ).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath("commitment-review-mobile.png"),
      fullPage: true,
    });
    await page
      .getByLabel("Principal payout wallet", { exact: true })
      .selectOption(verifiedWallets[0].id);
    await expect(review).toHaveCount(0);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM app_commitment_consents WHERE event_id=$1",
          [privateId],
        )
      ).rows[0].n,
    ).toBe(0);
    await page.getByRole("link", { name: "Back to event", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath("event-entry-mobile.png"), fullPage: true });
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await f.enter(other, 2);
      const foreign = await other.newPage();
      expect((await foreign.goto(`https://localhost:3444/events/${privateId}`))?.status()).toBe(
        404,
      );
      expect(await foreign.content()).not.toContain(privateEvent.title);
    } finally {
      await other.close();
    }
    await f.pool.query("UPDATE app_events SET state='closed' WHERE id=$1", [publicId]);
    await page.goto(`/events/${publicId}`);
    await expect(page.getByRole("heading", { name: "Registration closed" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Review this event's authorizations and recovery" }),
    ).toHaveAttribute("href", `/account/commitments?event=${publicId}`);
  } finally {
    await f.cleanup();
  }
});
