import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { attendanceFixtures } from "../fixtures/attendance";
import { issueAttendanceQr } from "../../src/server/attendance/qr";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test("personal QR entry keeps an unknown operation while actual HTTP stays unqualified", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    await f.enter(context, 0);
    await page.goto("/account/commitments");
    const section = page.getByRole("region", { name: "Personal attendance QR" }),
      requests: Record<string, unknown>[] = [];
    await page.route("**/api/attendance/qr", async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) await route.abort("failed");
      else await route.continue();
    });
    await section.getByRole("button", { name: "Request a personal QR" }).click();
    await expect(section.getByRole("status")).toContainText("not acknowledged");
    await section.getByRole("button", { name: "Retry the same QR request" }).click();
    await expect(section.getByRole("status")).toContainText("could not be verified");
    expect(requests.length).toBe(2);
    expect(requests[0]).toEqual(requests[1]);
    await expect(section.getByRole("img")).toHaveCount(0);
    expect(
      (await f.pool.query("SELECT 1 FROM app_attendance_qr WHERE event_id=$1", [f.eventId]))
        .rowCount,
    ).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("explicit backend-fixture QR packets: wrong event and confirmed-looking replies are rejected; original QR expires and hides", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    await f.enter(context, 0);
    await page.clock.install();
    await page.goto("/account/commitments");
    const section = page.getByRole("region", { name: "Personal attendance QR" }),
      requests: Record<string, unknown>[] = [];
    let qr: Awaited<ReturnType<typeof issueAttendanceQr>> | undefined;
    await page.route("**/api/attendance/qr", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      qr = await issueAttendanceQr(
        f.pool,
        f.config,
        f.session,
        { eventId: body.eventId, consentId: body.consentId, operationId: body.operationId },
        { ...f.engineering, testClock: Date.now() },
      );
      if (requests.length === 1) await route.abort("failed");
      else if (requests.length === 2)
        await route.fulfill({ status: 202, json: { ...qr, attendanceConfirmed: true } });
      else if (requests.length === 3)
        await route.fulfill({
          status: 202,
          json: {
            ...qr,
            payload: JSON.stringify({ ...JSON.parse(qr.payload), eventId: randomUUID() }),
          },
        });
      else await route.fulfill({ status: 202, json: qr });
    });
    await section.getByRole("button", { name: "Request a personal QR" }).click();
    await expect(section.getByRole("status")).toContainText("not acknowledged");
    for (let index = 0; index < 2; index++) {
      await section.getByRole("button", { name: "Retry the same QR request" }).click();
      await expect(section.getByRole("status")).toContainText("could not be verified");
      await expect(section.getByRole("img")).toHaveCount(0);
    }
    await section.getByRole("button", { name: "Retry the same QR request" }).click();
    const image = section.getByRole("img", { name: "Private personal attendance QR" });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLCanvasElement).width))
      .toBeGreaterThan(100);
    expect(requests.every((value) => JSON.stringify(value) === JSON.stringify(requests[0]))).toBe(
      true,
    );
    expect(
      (await f.pool.query("SELECT 1 FROM app_attendance_qr WHERE event_id=$1", [f.eventId]))
        .rowCount,
    ).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await section.screenshot({ path: "test-results/personal-qr-mobile.png", mask: [image] });
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    await expect(image).toHaveCount(0);
    await expect(section.getByRole("status")).toHaveCount(0);
    await section.getByRole("button", { name: "Request a personal QR" }).click();
    await expect(image).toBeVisible();
    // Advance browser timers only. This is not a server-clock admission claim.
    await page.clock.fastForward(65_000);
    await expect(image).toHaveCount(0);
    await expect(section.getByRole("status")).toContainText("expired");
  } finally {
    await f.cleanup();
  }
});

test("personal QR actions disappear for restricted recovery and foreign accounts", async ({
  page,
  context,
  browser,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    await f.enter(context, 0);
    await f.pool.query("UPDATE app_accounts SET state='deletion_requested' WHERE id=$1", [
      f.accounts[0].id,
    ]);
    await page.goto("/account/commitments");
    await expect(page.getByRole("region", { name: "Personal attendance QR" })).toHaveCount(0);
    await expect(page.getByText("Financial terms approved", { exact: true })).toBeVisible();
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await f.enter(other, 2);
      const stranger = await other.newPage();
      await stranger.goto("https://localhost:3444/account/commitments");
      await expect(stranger.getByRole("region", { name: "Personal attendance QR" })).toHaveCount(0);
    } finally {
      await other.close();
    }
  } finally {
    await f.cleanup();
  }
});

test("an acknowledged expired QR ends its retry operation without displaying the capability", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    await f.enter(context, 0);
    await page.clock.install();
    await page.goto("/account/commitments");
    const section = page.getByRole("region", { name: "Personal attendance QR" });
    let reply: Awaited<ReturnType<typeof issueAttendanceQr>> | undefined;
    await page.route("**/api/attendance/qr", async (route) => {
      const body = route.request().postDataJSON();
      if (!reply) {
        reply = await issueAttendanceQr(
          f.pool,
          f.config,
          f.session,
          { eventId: body.eventId, consentId: body.consentId, operationId: body.operationId },
          { ...f.engineering, testClock: Date.now() },
        );
        await route.abort("failed");
      } else await route.fulfill({ status: 202, json: reply });
    });
    await section.getByRole("button", { name: "Request a personal QR" }).click();
    await expect(section.getByRole("status")).toContainText("not acknowledged");
    await page.clock.fastForward(65_000);
    await section.getByRole("button", { name: "Retry the same QR request" }).click();
    await expect(section.getByRole("status")).toContainText("expired");
    await expect(section.getByRole("button", { name: "Request a personal QR" })).toBeVisible();
    await expect(section.getByRole("img")).toHaveCount(0);
  } finally {
    await f.cleanup();
  }
});
