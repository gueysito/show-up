import { expect, test } from "@playwright/test";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("the owning host queues publication once and saved terms stay locked across reloads", async ({
  page,
  context,
}) => {
  const f = await accountFixtures([["host"]]);
  try {
    await f.enter(context, 0);
    const draft = validDraft();
    await page.goto("/host");
    const preview = page.getByRole("complementary", { name: "Event rules preview" });
    await expect(preview).toContainText("No-show deposits are split equally");
    await expect(preview).not.toContainText("Publication is unavailable");
    await expect(preview).not.toContainText("Attendee release before");
    await page.getByLabel("Event name", { exact: true }).fill("Queued V1 publication");
    await page.getByLabel("Session URL", { exact: true }).fill(draft.sessionReference);
    await page.getByLabel("Planned start (UTC)", { exact: true }).fill(draft.startsAt.slice(0, 16));
    await page.getByLabel("Planned end (UTC)", { exact: true }).fill(draft.endsAt.slice(0, 16));
    await page.getByRole("button", { name: "Validate & save draft" }).click();
    await expect(page.getByRole("status")).toContainText("Saved private draft");
    await page.getByRole("button", { name: "Close saved details" }).click();
    await page.getByRole("button", { name: "Check publication status" }).click();
    await expect(
      page.getByRole("region", { name: "Saved publication requirements" }),
    ).toContainText("Ready to publish on NEAR mainnet");
    await page.getByRole("button", { name: "Publish event on mainnet" }).click();
    await expect(page.getByRole("heading", { name: "Publication in progress" })).toBeVisible();
    await expect(page.getByLabel("Capacity", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Publish event on mainnet" })).toBeDisabled();
    const row = (
      await f.pool.query(
        "SELECT p.transaction_state,p.transaction_hash,e.id FROM app_publication_images p JOIN app_events e ON e.id=p.event_id WHERE e.owner_id=$1",
        [f.accounts[0].id],
      )
    ).rows[0];
    expect(row.transaction_state).toBe("requested");
    expect(row.transaction_hash).toBeNull();
    await page.reload();
    await page.getByRole("button", { name: /Queued V1 publication Publishing/ }).click();
    await expect(page.getByLabel("Event name", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Check publication status" }).click();
    await expect(
      page.getByRole("region", { name: "Saved publication requirements" }),
    ).toContainText("awaiting its original transaction");
    expect(
      (
        await f.pool.query("SELECT count(*) FROM app_publication_images WHERE event_id=$1", [
          row.id,
        ])
      ).rows[0].count,
    ).toBe("1");
  } finally {
    await f.cleanup();
  }
});
