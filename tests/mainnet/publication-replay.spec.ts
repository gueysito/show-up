import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";
import { hash, seal } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication, observeV1Publication } from "../../src/server/events/v1-publication";
import { readV1Snapshot, v1EventTerms } from "../../src/server/protocol/v1-escrow";
import { canonicalHash } from "../../src/server/protocol/canonical";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test.setTimeout(90_000);

test("read-only replay of the original mainnet publication on desktop and mobile", async ({
  page,
  browser,
}) => {
  const directory = "contracts/.cache/v1-browser";
  const receipt = JSON.parse(await readFile(`${directory}/publication.json`, "utf8"));
  expect(receipt.phase).toBe("browser_verified");
  const source = await readV1Snapshot(receipt.eventId);
  expect(canonicalHash(v1EventTerms(source.event!))).toBe(receipt.semantic);
  const f = await accountFixtures([["host"]]);
  const key = process.env.SHOWUP_E2E_ENCRYPTION_KEY!,
    session = hash(f.accounts[0].value);
  try {
    const data = {
      ...validDraft(),
      title: source.event!.title as string,
      capacity: source.event!.capacity as number,
      commitment: "1",
      sponsorBudget: "0",
      access: "open" as const,
      startsAt: new Date(source.event!.start_ms as number).toISOString(),
      endsAt: new Date(source.event!.end_ms as number).toISOString(),
    };
    // Rehydrate disposable display records for the already-final publication.
    // This path never loads a wallet key, signs, or sends a transaction.
    await saveAccountDraft(
      f.pool,
      key,
      session,
      { id: receipt.eventId, operationId: randomUUID(), revision: 0, data },
      "v1",
    );
    await prepareV1Publication(f.pool, key, session, randomUUID(), receipt.eventId, 1);
    await f.pool.query(
      "UPDATE app_publication_images SET transaction_state='submitted',transaction_hash=$2,encrypted_transaction=$3 WHERE event_id=$1",
      [
        receipt.eventId,
        receipt.hash,
        seal(key, `v1-publication-transaction:${receipt.eventId}`, {
          hash: receipt.hash,
          signedBase64: receipt.signedBase64,
          semantic: receipt.semantic,
          validUntilMs: receipt.validUntilMs,
        }),
      ],
    );
    await observeV1Publication(f.pool, key, receipt.eventId, source);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const response = await page.goto(`/events/${receipt.eventId}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Verified mainnet event" })).toBeVisible();
    await page.screenshot({ path: `${directory}/publication-desktop.png` });
    const mobile = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const phone = await mobile.newPage();
      await phone.goto(`https://localhost:3444/events/${receipt.eventId}`);
      await expect(phone.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(phone.getByRole("region", { name: "Verified mainnet event" })).toBeVisible();
      expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await phone.screenshot({ path: `${directory}/publication-mobile-top.png` });
      await phone.getByText("1.00 USDC", { exact: true }).scrollIntoViewIfNeeded();
      await phone.screenshot({ path: `${directory}/publication-mobile-commitment.png` });
    } finally {
      await mobile.close();
    }
  } finally {
    await f.cleanup();
  }
});
