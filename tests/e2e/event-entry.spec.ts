import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { issueInvitation } from "../../src/server/invitations/service";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
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
    open = { ...validDraft(), title: "Fictional online event entry", access: "open" as const },
    privateEvent = {
      ...validDraft(),
      title: "Fictional invited studio",
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
