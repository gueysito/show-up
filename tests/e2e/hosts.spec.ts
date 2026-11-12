import { expect, test, type BrowserContext } from "@playwright/test";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("preauthenticated fixtures: admin invitation, host redemption and isolated private draft management", async ({
  page,
  context,
  browser,
}) => {
  const fixtures = await accountFixtures([["admin"], [], ["host"], []]);
  const extra: BrowserContext[] = [];
  try {
    await fixtures.enter(context, 0);
    await page.goto("/account");
    const invitations = page.getByRole("region", { name: "Invitation controls" });
    await invitations.getByRole("button", { name: "Issue host invitation" }).click();
    await expect(invitations.getByRole("status")).toContainText("Invitation issued");
    const privateLink = await invitations.getByLabel("Private invitation link").inputValue();
    // Capability remains inside this isolated test; never print it in receipts.
    const hostContext = await browser.newContext({ ignoreHTTPSErrors: true });
    extra.push(hostContext);
    await fixtures.enter(hostContext, 1);
    const host = await hostContext.newPage();
    await host.goto(privateLink);
    await expect(host.getByRole("status")).toContainText("Review the access grant");
    await expect(host.getByRole("button", { name: "Accept invitation" })).toBeDisabled();
    await host.getByLabel(/I accept this access grant/).check();
    await host.getByRole("button", { name: "Accept invitation" }).click();
    await expect(host.getByRole("status")).toContainText("Host access confirmed");
    await host.getByRole("link", { name: "Go to your events" }).click();
    const save = host.getByRole("button", { name: "Validate & save draft" });
    await expect(save).toBeEnabled();
    const draft = validDraft();
    await host.getByLabel("Event name", { exact: true }).fill("Invited host draft");
    await host.getByLabel("Session URL", { exact: true }).fill(draft.sessionReference);
    await host.getByLabel("Planned start (UTC)", { exact: true }).fill(draft.startsAt.slice(0, 16));
    await host.getByLabel("Planned end (UTC)", { exact: true }).fill(draft.endsAt.slice(0, 16));
    await host.getByLabel("Planned sponsor budget (USDC)", { exact: true }).fill("100");
    await expect(host.getByRole("button", { name: /Add optional question/ })).toHaveCount(0);
    await save.click();
    await expect(host.getByRole("status")).toContainText("Saved private draft · revision 1");
    await host.getByRole("button", { name: "Close saved details" }).click();
    await host.reload();
    await host.getByRole("button", { name: /Invited host draft Draft/ }).click();
    await expect(host.getByLabel("Planned sponsor budget (USDC)", { exact: true })).toHaveValue(
      "100",
    );
    host.once("dialog", (dialog) => dialog.dismiss());
    await host.getByRole("button", { name: "Duplicate Invited host draft", exact: true }).click();
    await expect(host.getByLabel("Event name", { exact: true })).toHaveValue("Invited host draft");
    host.once("dialog", (dialog) => dialog.accept());
    await host.getByRole("button", { name: "Duplicate Invited host draft", exact: true }).click();
    await expect(host.getByLabel("Event name", { exact: true })).toHaveValue(
      "Copy of Invited host draft",
    );
    await expect(host.getByRole("status")).toContainText("Independent unfunded draft");
    const review = host.getByRole("button", { name: "Check publication status" });
    await review.click();
    const requirements = host.getByRole("region", { name: "Saved publication requirements" });
    await expect(requirements).toContainText("Choose your verified NEAR wallet");
    await expect(host.getByRole("button", { name: /Create prize event escrow/ })).toBeDisabled();
    const ownEvents = await (await host.request.get("/api/events")).json();
    const copy = ownEvents.drafts.find(
      (event: { data: { title: string } }) => event.data.title === "Copy of Invited host draft",
    );
    expect(
      (
        await host.request.get(`/api/events?publication=${copy.id}&revision=1&fundingVerified=true`)
      ).status(),
    ).toBe(400);
    expect((await host.request.get(`/api/events?publication=${copy.id}&revision=2`)).status()).toBe(
      409,
    );
    expect(
      (
        await host.request.post("/api/events", {
          headers: { origin: "https://localhost:3444" },
          data: {
            operation: "publish",
            operationId: crypto.randomUUID(),
            id: copy.id,
            fundingVerified: true,
          },
        })
      ).status(),
    ).toBe(400);
    await host.getByLabel("Event name", { exact: true }).fill("Unsaved private edit");
    await expect(review).toBeDisabled();
    await expect(requirements).toHaveCount(0);
    await host.getByLabel("Event name", { exact: true }).fill("Copy of Invited host draft");
    await expect(review).toBeEnabled();
    await host.setViewportSize({ width: 390, height: 844 });
    expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await host.screenshot({
      path: "contracts/.cache/v1-browser/invited-host-draft.png",
      fullPage: true,
    });
    await host
      .getByRole("region", { name: "Event publication and access" })
      .scrollIntoViewIfNeeded();
    await host.screenshot({ path: "contracts/.cache/v1-browser/host-actions-mobile.png" });

    const otherContext = await browser.newContext({ ignoreHTTPSErrors: true });
    extra.push(otherContext);
    await fixtures.enter(otherContext, 2);
    const other = await otherContext.newPage();
    await other.goto("https://localhost:3444/host");
    await expect(other.getByRole("button", { name: "Validate & save draft" })).toBeEnabled();
    await expect(other.getByRole("button", { name: /Invited host draft/ })).toHaveCount(0);
    const response = await other.request.get("https://localhost:3444/api/events");
    expect((await response.json()).drafts).toEqual([]);
    expect(
      (
        await other.request.get(
          `https://localhost:3444/api/events?publication=${copy.id}&revision=1`,
        )
      ).status(),
    ).toBe(404);
    await other.goto("https://localhost:3444/account");
    await expect(other.getByRole("button", { name: "Issue host invitation" })).toHaveCount(0);
    const attendeeContext = await browser.newContext({ ignoreHTTPSErrors: true });
    extra.push(attendeeContext);
    await fixtures.enter(attendeeContext, 3);
    const attendee = await attendeeContext.newPage();
    await attendee.goto("https://localhost:3444/account");
    await expect(attendee.getByRole("link", { name: "Your events", exact: true })).toHaveCount(0);
    await expect(attendee.getByRole("link", { name: "Use a host invitation" })).toBeVisible();
    await attendee.goto("https://localhost:3444/host");
    await expect(attendee.getByRole("heading", { name: "Host access required" })).toBeVisible();
  } finally {
    await Promise.all(extra.map((surface) => surface.close()));
    await fixtures.cleanup();
  }
});

test("published engineering fixture locks material terms and permits only a description correction", async ({
  page,
  context,
}) => {
  const fixtures = await accountFixtures([["host"]]);
  try {
    const id = crypto.randomUUID();
    const draft = validDraft();
    // Explicit fixture, never an application publication or funding success.
    await fixtures.pool.query(
      `INSERT INTO app_events (id,owner_id,revision,data,state,rules_hash,published_at,registration_closes_at)
      VALUES ($1,$2,1,$3,'published','fixture-locked',clock_timestamp(),$4)`,
      [id, fixtures.accounts[0].id, draft, draft.startsAt],
    );
    await fixtures.enter(context, 0);
    await page.goto("/host");
    await page.getByRole("button", { name: new RegExp(`${draft.title} Published`) }).click();
    await expect(page.getByLabel("Capacity", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Planned start (UTC)", { exact: true })).toBeDisabled();
    await expect(page.getByText("Published terms", { exact: true })).toBeVisible();
    await page.getByLabel("Correct description only").fill("Harmless wording correction");
    await page.getByRole("button", { name: "Save description correction" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Description correction saved" }),
    ).toBeVisible();
    const row = (
      await fixtures.pool.query("SELECT rules_hash,data,revision FROM app_events WHERE id=$1", [id])
    ).rows[0];
    expect(row.rules_hash).toBe("fixture-locked");
    expect(row.data.description).toBe("Harmless wording correction");
    expect(row.data.capacity).toBe(draft.capacity);
    expect(row.revision).toBe(2);
  } finally {
    await fixtures.cleanup();
  }
});
