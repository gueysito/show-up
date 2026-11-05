import { expect, test } from "@playwright/test";
import { mkdir, writeFile, rename, chmod } from "node:fs/promises";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";
import { runV1Publication } from "../../src/worker/v1-publication";
import { v1PublicationGateway } from "../../scripts/v1-publication-worker";
import { readV1Snapshot } from "../../src/server/protocol/v1-escrow";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test.setTimeout(180_000);

test("preauthenticated test host publishes real mainnet terms through the app", async ({
  page,
  context,
}) => {
  if (process.env.SHOWUP_MAINNET_BROWSER !== "1")
    throw new Error("Explicit mainnet execution required");
  const directory = "contracts/.cache/v1-browser";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let journal: Record<string, unknown> = {
    phase: "started",
    authentication: "preauthenticated engineering fixture",
  };
  // Refuse a fresh financial test when an earlier attempt still needs review.
  await writeFile(`${directory}/publication.json`, JSON.stringify(journal) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  const f = await accountFixtures([["host"]]);
  async function saveJournal(update: Record<string, unknown>) {
    journal = { ...journal, ...update };
    await writeFile(`${directory}/publication.json.next`, JSON.stringify(journal) + "\n", {
      mode: 0o600,
    });
    await rename(`${directory}/publication.json.next`, `${directory}/publication.json`);
  }
  try {
    await f.enter(context, 0);
    const draft = validDraft();
    const title = `Mainnet app publication ${new Date().toISOString().slice(0, 16)}`;
    await page.goto("/host");
    await page.getByLabel("Event name", { exact: true }).fill(title);
    await page
      .getByLabel("Session URL", { exact: true })
      .fill("https://example.com/showup-local-verification");
    await page.getByLabel("Planned start (UTC)", { exact: true }).fill(draft.startsAt.slice(0, 16));
    await page.getByLabel("Planned end (UTC)", { exact: true }).fill(draft.endsAt.slice(0, 16));
    await page.getByLabel("Capacity", { exact: true }).fill("2");
    await page.getByLabel("Registration access", { exact: true }).selectOption("open");
    await page.getByRole("button", { name: "Validate & save draft" }).click();
    await expect(page.getByRole("status")).toContainText("Saved private draft");
    await page.getByRole("button", { name: "Close saved details" }).click();
    await page.getByRole("button", { name: "Publish event on mainnet" }).click();
    await expect(page.getByRole("heading", { name: "Publication in progress" })).toBeVisible();
    const pending = (
      await f.pool.query("SELECT id FROM app_events WHERE owner_id=$1", [f.accounts[0].id])
    ).rows[0];
    await saveJournal({ phase: "requested", eventId: pending.id, title });
    // The test browser never receives a private key. This isolated worker uses
    // the retained project signer only after mainnet code/key/balance preflight.
    const key = process.env.SHOWUP_E2E_ENCRYPTION_KEY!;
    const native = v1PublicationGateway();
    const gateway = {
      ...native,
      async submit(image: Parameters<typeof native.submit>[0]) {
        // Persist the public signed image before its only write, independently of
        // disposable fixture cleanup. No private signing key is stored here.
        await saveJournal({ phase: "submitted", ...image });
        await native.submit(image);
      },
    };
    let receipt: Awaited<ReturnType<typeof runV1Publication>> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        receipt = await runV1Publication(f.pool, key, gateway);
        break;
      } catch (error) {
        const row = (
          await f.pool.query(
            "SELECT transaction_state FROM app_publication_images WHERE event_id=$1",
            [pending.id],
          )
        ).rows[0];
        if (row.transaction_state !== "submitted" || attempt === 2) throw error;
        // Reconcile only the retained original hash; never create another image.
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    expect(receipt?.state).toBe("verified");
    await saveJournal({ phase: "worker_verified", ...receipt });
    await page.getByRole("button", { name: "Check publication status" }).click();
    await expect(page).toHaveURL(new RegExp(`/events/${pending.id}$`));
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByRole("region", { name: "Verified mainnet event" })).toBeVisible();
    await expect(page.getByRole("link", { name: "View publication transaction" })).toHaveAttribute(
      "href",
      `https://nearblocks.io/txns/${receipt!.hash}`,
    );
    await expect(page.getByText("1.00 USDC", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${directory}/publication-mobile.png`, fullPage: true });
    const snapshot = await readV1Snapshot(pending.id);
    await saveJournal({
      phase: "browser_verified",
      height: snapshot.block.height,
      event: snapshot.event,
      browserUrl: page.url(),
    });
  } finally {
    await f.cleanup();
  }
});
