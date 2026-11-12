import { expect, test, type BrowserContext } from "@playwright/test";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("preauthenticated staff: explicit event assignment, revision conflicts, removal and publication freeze without host or money authority", async ({
  page,
  context,
  browser,
}) => {
  const f = await accountFixtures([["host"], [], [], ["host"]]),
    extra: BrowserContext[] = [];
  try {
    await f.enter(context, 0);
    await page.goto("/host");
    const draft = validDraft(),
      title = `Fictional physical staff ${crypto.randomUUID()}`;
    await page.getByLabel("Event name", { exact: true }).fill(title);
    await page.getByLabel("Where we meet", { exact: true }).selectOption("physical");
    await page
      .getByLabel("Venue and proof instructions", { exact: true })
      .fill("Fictional venue; staff inspect a personal QR.");
    await page.getByLabel("Planned start (UTC)", { exact: true }).fill(draft.startsAt.slice(0, 16));
    await page.getByLabel("Planned end (UTC)", { exact: true }).fill(draft.endsAt.slice(0, 16));
    await page.getByLabel("Planned sponsor budget (USDC)", { exact: true }).fill("100");
    await page.getByRole("button", { name: "Validate & save draft" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved private draft · revision 1" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close saved details" }).click();
    const event = (await (await page.request.get("/api/events")).json()).drafts.find(
      (item: { data: { title: string } }) => item.data.title === title,
    );
    const panel = page.getByRole("region", { name: "Event validators", exact: true }),
      invites = panel.getByRole("region", { name: "Invitation controls", exact: true });
    await invites.getByRole("button", { name: "Invite event validator" }).click();
    await expect(invites.getByRole("status")).toContainText("Invitation issued");
    const link = await invites.getByLabel("Private invitation link").inputValue();
    // Capabilities remain inside the disposable browser contexts and are never printed.
    const staffContext = await browser.newContext({ ignoreHTTPSErrors: true });
    extra.push(staffContext);
    await f.enter(staffContext, 1);
    const staff = await staffContext.newPage();
    await staff.goto(link);
    await expect(
      staff.getByText(`Validator invitation for ${title}`, { exact: true }),
    ).toBeVisible();
    await expect(
      staff.getByText(/Grant: validate physical attendance for one event/),
    ).toBeVisible();
    await expect(staff.getByRole("button", { name: "Accept invitation" })).toBeDisabled();
    await staff.getByLabel(/I accept this access grant/).check();
    await staff.getByRole("button", { name: "Accept invitation" }).click();
    await expect(staff.getByRole("status")).toContainText("Validator assignment confirmed");
    await staff.goto("/host");
    await expect(staff.getByRole("heading", { name: "Host access required" })).toBeVisible();
    const ownExport = await (await staff.request.get("/api/account/export")).json();
    expect(ownExport.validatorAssignments).toHaveLength(1);
    expect(ownExport.hostedValidators).toHaveLength(0);
    await panel.getByRole("button", { name: "Refresh validator assignments" }).click();
    await expect(panel.getByText(/Validator [0-9a-f]{16} · Assigned/)).toBeVisible();
    const roster = await (
      await page.request.get(`/api/attendance/validators?event=${event.id}`)
    ).json();
    expect(roster.revision).toBe(2);
    expect(Object.keys(roster.validators[0]).sort()).toEqual([
      "alias",
      "assignedAt",
      "available",
      "id",
      "revokedAt",
    ]);
    expect(
      (await page.request.get(`/api/events?publication=${event.id}&revision=1`)).status(),
    ).toBe(409);
    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByRole("button", { name: "Remove validator before publication" }).click();
    await expect(panel.getByText(/Validator [0-9a-f]{16} · Removed/)).toBeVisible();
    expect(
      (
        await staff.request.post("/api/invitations", {
          headers: { origin: "https://localhost:3444" },
          data: { operation: "redeem", operationId: crypto.randomUUID(), consent: true },
        })
      ).status(),
    ).toBe(410);
    await invites.getByRole("button", { name: "Invite event validator" }).click();
    await expect(invites.getByLabel("Private invitation link")).not.toHaveValue(link);
    const fresh = await invites.getByLabel("Private invitation link").inputValue();
    await staff.goto(fresh);
    await staff.getByLabel(/I accept this access grant/).check();
    await staff.getByRole("button", { name: "Accept invitation" }).click();
    await expect(staff.getByRole("status")).toContainText("Validator assignment confirmed");
    await invites.getByRole("button", { name: "Invite event validator" }).click();
    await expect(invites.getByLabel("Private invitation link")).not.toHaveValue(fresh);
    const unused = await invites.getByLabel("Private invitation link").inputValue();
    // Explicit legacy fixture solely to exercise validator freezing without a mainnet submission.
    await f.pool.query(
      "UPDATE app_events SET state='published',rules_hash='engineering-staff-freeze',published_at=clock_timestamp() WHERE id=$1",
      [event.id],
    );
    await page.reload();
    await page.getByRole("button", { name: new RegExp(`${title} Published`) }).click();
    await panel.getByRole("button", { name: "Refresh validator assignments" }).click();
    await expect(
      panel.getByText("Published validator assignments are fixed.", { exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole("button", { name: "Invite event validator" })).toHaveCount(0);
    expect(
      (
        await page.request.post("/api/attendance/validators", {
          headers: { origin: "https://localhost:3444" },
          data: {
            eventId: event.id,
            validatorId: roster.validators[0].id,
            operationId: crypto.randomUUID(),
          },
        })
      ).status(),
    ).toBe(409);
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    extra.push(other);
    await f.enter(other, 2);
    const late = await other.newPage();
    await late.goto(unused);
    await late.getByLabel(/I accept this access grant/).check();
    await late.getByRole("button", { name: "Accept invitation" }).click();
    await expect(late.getByRole("status")).toContainText("fixed at publication");
    await f.enter(other, 3);
    expect(
      (
        await other.request.get(
          `https://localhost:3444/api/attendance/validators?event=${event.id}`,
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await page.request.get(`/api/attendance/validators?event=${event.id}`, {
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status(),
    ).toBe(403);
    const response = await page.request.get(`/api/attendance/validators?event=${event.id}`);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // Frozen panel contains no invitation capability or private identity/wallet mapping.
    await panel.screenshot({ path: "test-results/validator-roster-mobile.png" });
  } finally {
    await Promise.all(extra.map((item) => item.close()));
    await f.cleanup();
  }
});
