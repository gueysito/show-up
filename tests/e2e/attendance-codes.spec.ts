import { expect, test } from "@playwright/test";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("published engineering fixture: host rotates private code windows and retries an unacknowledged activation once", async ({
  page,
  context,
  browser,
}) => {
  const f = await accountFixtures([["host"], ["host"]]);
  try {
    const eventId = crypto.randomUUID(),
      now = Date.now(),
      draft = {
        ...validDraft(),
        startsAt: new Date(now + 60_000).toISOString(),
        endsAt: new Date(now + 3_660_000).toISOString(),
      };
    // Fixture publication only. This journey never funds or checks in an attendee.
    await f.pool.query(
      `INSERT INTO app_events(id,owner_id,revision,data,state,rules_hash,published_at,registration_closes_at)
      VALUES($1,$2,1,$3,'published','engineering-code-fixture',clock_timestamp(),$4)`,
      [eventId, f.accounts[0].id, draft, draft.startsAt],
    );
    await f.enter(context, 0);
    await page.goto("/host");
    await page.getByRole("button", { name: new RegExp(`${draft.title} Revision 1`) }).click();
    const codes = page.getByRole("region", { name: "Online attendance code", exact: true });
    await expect(
      codes.getByText(
        "Only attendees with confirmed deposits can check in. Opening a code does not check anyone in.",
      ),
    ).toBeVisible();
    const input = codes.getByLabel("Fresh word or phrase");
    // Reading status must not consume the separate activation budget.
    for (let i = 0; i < 7; i++)
      expect((await page.request.get(`/api/attendance/codes?event=${eventId}`)).status()).toBe(200);
    await input.fill("Fresh Word");
    await codes.getByRole("button", { name: "Open fresh code window" }).focus();
    const opened = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/attendance/codes") && response.request().method() === "POST",
    );
    await page.keyboard.press("Enter");
    expect((await opened).status()).toBe(200);
    await expect(codes.getByText("Phrase: Fresh Word", { exact: true })).toBeVisible();
    await input.fill("  FRESH  word ");
    await codes.getByRole("button", { name: "Open fresh code window" }).click();
    await expect(codes.getByRole("alert")).toContainText("already used that code");
    await expect(codes.getByText("Phrase: Fresh Word", { exact: true })).toBeVisible();

    const operations: string[] = [];
    await page.route("**/api/attendance/codes", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      operations.push(JSON.parse(route.request().postData()!).operationId);
      const response = await route.fetch();
      if (operations.length === 1) await route.abort("failed");
      else await route.fulfill({ response });
    });
    await input.fill("Second Fresh Phrase");
    await codes.getByRole("button", { name: "Open fresh code window" }).click();
    await expect(
      codes.getByRole("button", { name: "Retry the same code activation" }),
    ).toBeEnabled();
    await expect(input).toBeDisabled();
    await codes.getByRole("button", { name: "Retry the same code activation" }).click();
    await expect(codes.getByText("Phrase: Second Fresh Phrase", { exact: true })).toBeVisible();
    expect(operations).toHaveLength(2);
    expect(operations[0]).toBe(operations[1]);
    expect(
      (
        await f.pool.query("SELECT count(*) FROM app_attendance_code_windows WHERE event_id=$1", [
          eventId,
        ])
      ).rows[0].count,
    ).toBe("2");
    await page.reload();
    await page.getByRole("button", { name: new RegExp(`${draft.title} Revision 1`) }).click();
    await codes.getByRole("button", { name: "Show current code" }).click();
    await expect(codes.getByText("Phrase: Second Fresh Phrase", { exact: true })).toBeVisible();
    const own = await page.request.get(`/api/attendance/codes?event=${eventId}`);
    expect(own.headers()["cache-control"]).toBe("no-store");
    expect(own.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(
      (
        await page.request.get(`/api/attendance/codes?event=${eventId}`, {
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post("/api/attendance/codes", {
          headers: { origin: "https://localhost:3444" },
          data: { eventId, operationId: crypto.randomUUID(), phrase: "ignored", funded: true },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await page.request.post("/api/attendance/codes", {
          headers: { origin: "https://other.invalid" },
          data: {},
        })
      ).status(),
    ).toBe(403);
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      expect(
        (
          await other.request.get(`https://localhost:3444/api/attendance/codes?event=${eventId}`)
        ).status(),
      ).toBe(401);
      await f.enter(other, 1);
      expect(
        (
          await other.request.get(`https://localhost:3444/api/attendance/codes?event=${eventId}`)
        ).status(),
      ).toBe(404);
    } finally {
      await other.close();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await codes.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await codes.screenshot({ path: "test-results/host-code-window-mobile.png" });
  } finally {
    await f.cleanup();
  }
});
