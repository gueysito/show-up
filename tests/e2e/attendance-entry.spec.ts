import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { attendanceFixtures } from "../fixtures/attendance";

test.use({
  baseURL: "https://localhost:3444",
  ignoreHTTPSErrors: true,
  timezoneId: "Pacific/Auckland",
});

test("code entry retries the same request after transport failure while actual HTTP qualification remains closed", async ({
  page,
  context,
  browser,
}) => {
  const f = await attendanceFixtures();
  try {
    await f.enter(context, 0);
    await page.goto(`/account/commitments?event=${f.eventId}`);
    const telegram = page.getByRole("region", { name: "Optional Telegram check-in" });
    await telegram
      .getByRole("button", { name: "Send this event's check-in prompt to Telegram" })
      .click();
    await expect(telegram.getByRole("status")).toContainText("currently unavailable");
    const entry = page.getByRole("region", { name: "Event code check-in" }),
      input = entry.getByLabel("Word or phrase from your host");
    await expect(entry).toContainText(f.consent.terms.timeZone);
    const window = (await (await page.request.get("/api/commitments")).json()).records[0]
      .attendanceWindow;
    const opens = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: f.consent.terms.timeZone,
    }).format(new Date(window.opensAt));
    await expect(entry).toContainText(`Check-in opens ${opens}`);
    const requests: Record<string, unknown>[] = [];
    await page.route("**/api/attendance/check-in", async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) await route.abort("failed");
      else await route.continue();
    });
    await input.fill("Fresh attendance phrase");
    await input.press("Enter");
    await expect(entry.getByRole("alert")).toContainText("not acknowledged");
    await expect(input).toBeDisabled();
    await entry.getByRole("button", { name: "Retry the same code submission" }).click();
    await expect(entry.getByRole("alert")).toContainText("temporarily unavailable");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(Object.keys(requests[0]).sort()).toEqual([
      "consentId",
      "eventId",
      "operationId",
      "phrase",
    ]);
    expect(requests[0].eventId).toBe(f.eventId);
    expect(requests[0].consentId).toBe(f.consent.id);
    expect(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
    ).toBe(0);
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await f.enter(other, 2);
      const stranger = await other.newPage();
      await stranger.goto("https://localhost:3444/account/commitments");
      await expect(stranger.getByRole("region", { name: "Event code check-in" })).toHaveCount(0);
      expect(
        (
          await stranger.request.post("https://localhost:3444/api/attendance/check-in", {
            headers: { origin: "https://localhost:3444" },
            data: { ...requests[0], operationId: randomUUID() },
          })
        ).status(),
      ).toBe(404);
    } finally {
      await other.close();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await entry.screenshot({ path: "test-results/attendance-entry-mobile.png", mask: [input] });
  } finally {
    await f.cleanup();
  }
});

test("explicit backend-fixture packets: unknown acknowledgements replay once and foreign or confirmed-looking replies never confirm attendance", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures();
  try {
    await f.enter(context, 0);
    await page.goto("/account/commitments");
    const entry = page.getByRole("region", { name: "Event code check-in" }),
      requests: Record<string, unknown>[] = [];
    let original: Awaited<ReturnType<typeof f.attempt>> | undefined;
    // Only the component transport is mocked. The fixture invokes the actual
    // backend sandbox admission/operation journal; live HTTP stays unqualified.
    await page.route("**/api/attendance/check-in", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      const result = await f.attempt(body.phrase, body.operationId);
      original ??= result;
      if (requests.length === 1) await route.abort("failed");
      else if (requests.length === 2)
        await route.fulfill({ status: 202, json: { ...result, attendanceConfirmed: true } });
      else if (requests.length === 3)
        await route.fulfill({ status: 202, json: { ...result, consentId: randomUUID() } });
      else await route.fulfill({ status: 202, json: result });
    });
    await entry.getByLabel("Word or phrase from your host").fill("Fresh attendance phrase");
    await entry.getByRole("button", { name: "Submit code for verification" }).click();
    await expect(entry.getByRole("alert")).toContainText("not acknowledged");
    for (let index = 0; index < 2; index++) {
      await entry.getByRole("button", { name: "Retry the same code submission" }).click();
      await expect(entry.getByRole("alert")).toContainText("could not be verified");
    }
    await entry.getByRole("button", { name: "Retry the same code submission" }).click();
    await expect(entry.getByRole("status")).toContainText("confirmation is still pending");
    expect(requests).toHaveLength(4);
    expect(requests.every((value) => JSON.stringify(value) === JSON.stringify(requests[0]))).toBe(
      true,
    );
    expect(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
    ).toBe(1);
    expect(original && "attendanceConfirmed" in original && original.attendanceConfirmed).toBe(
      false,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Attendance not confirmed", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Event code check-in" })).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});

test("page-hide clears an unacknowledged code and ignores a delayed reply; restored private records reload", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures();
  let release: () => void = () => {},
    started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
      started = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  try {
    await f.enter(context, 0);
    await page.goto("/account/commitments");
    const entry = page.getByRole("region", { name: "Event code check-in" }),
      input = entry.getByLabel("Word or phrase from your host");
    await page.route("**/api/attendance/check-in", async (route) => {
      const body = route.request().postDataJSON(),
        result = await f.attempt(body.phrase, body.operationId);
      started();
      await blocked;
      // The request may already have been aborted by the page-hide handler.
      await route.fulfill({ status: 202, json: result }).catch(() => {});
    });
    await input.fill("Fresh attendance phrase");
    await entry.getByRole("button", { name: "Submit code for verification" }).click();
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("No code request reached the fixture")), 5000),
      ),
    ]);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await expect(input).toHaveValue("");
    await expect(entry.getByRole("status")).toHaveCount(0);
    release();
    await expect(
      entry.getByRole("button", { name: "Submit code for verification" }),
    ).toBeDisabled();
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect(
      page.getByRole("heading", { name: "Attendance not confirmed", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Event code check-in" })).toHaveCount(0);
    // This exercises the handler in Chromium, not actual-device BFCache behavior.
  } finally {
    release();
    await f.cleanup();
  }
});

test("restricted financial recovery does not expose a new check-in form", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures();
  try {
    await f.pool.query("UPDATE app_accounts SET state='deletion_requested' WHERE id=$1", [
      f.accounts[0].id,
    ]);
    await f.enter(context, 0);
    await page.goto("/account/commitments");
    await expect(page.getByText("Financial terms approved", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Event code check-in" })).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});
