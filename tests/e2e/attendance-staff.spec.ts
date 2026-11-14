import { expect, test, type Page } from "@playwright/test";
import qrcode from "qrcode-generator";
import { randomUUID } from "node:crypto";
import { attendanceFixtures } from "../fixtures/attendance";
import { syntheticQrCamera } from "../fixtures/camera";
import { hash } from "../../src/server/auth/crypto";
import { listStaffAttendanceEvents } from "../../src/server/attendance/staff";
import {
  issueAttendanceQr,
  scanAttendanceQr,
  confirmAttendanceQr,
} from "../../src/server/attendance/qr";

test.use({
  baseURL: "https://localhost:3444",
  ignoreHTTPSErrors: true,
  timezoneId: "Pacific/Auckland",
});
function image(payload: string) {
  const qr = qrcode(0, "M");
  qr.addData(payload, "Byte");
  qr.make();
  return qr.createDataURL(4, 16);
}
async function camera(page: Page) {
  return page.evaluate(() => {
    const probe = (
      window as typeof window & {
        cameraProbe: {
          requests: number;
          constraints: MediaStreamConstraints[];
          tracks: MediaStreamTrack[];
        };
      }
    ).cameraProbe;
    return {
      requests: probe.requests,
      audio: probe.constraints.map((value) => value.audio),
      live: probe.tracks.filter((track) => track.readyState === "live").length,
      ended: probe.tracks.filter((track) => track.readyState === "ended").length,
    };
  });
}
test("synthetic camera and explicit backend packets: scan and presence remain separate, unknown ACKs retry once, worker stays local", async ({
  page,
  context,
  browser,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    const qr = await issueAttendanceQr(
      f.pool,
      f.config,
      f.session,
      { eventId: f.eventId, consentId: f.consent.id, operationId: randomUUID() },
      { ...f.engineering, testClock: Date.now() },
    );
    // Feed the actual attendee canvas into synthetic video. Only the HTTP
    // acknowledgement uses a backend fixture; both UI codecs execute unchanged.
    const attendee = await browser.newContext({ ignoreHTTPSErrors: true });
    let encoded: string;
    try {
      await f.enter(attendee, 0);
      const display = await attendee.newPage();
      await display.route("**/api/attendance/qr", (route) =>
        route.fulfill({ status: 202, json: qr }),
      );
      await display.goto("https://localhost:3444/account/commitments");
      await display.getByRole("button", { name: "Request a personal QR" }).click();
      const canvas = display.getByRole("img", { name: "Private personal attendance QR" });
      await expect
        .poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width))
        .toBeGreaterThan(100);
      encoded = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
    } finally {
      await attendee.close();
    }
    await syntheticQrCamera(context, encoded);
    await f.enter(context, 2);
    const requests: Record<string, unknown>[] = [],
      workerUrls: string[] = [];
    page.on("worker", (worker) => workerUrls.push(worker.url()));
    let scanCalls = 0,
      confirmCalls = 0;
    await page.route("**/api/attendance/qr", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (body.action === "scan") {
        const result = await scanAttendanceQr(
          f.pool,
          f.config,
          hash(f.accounts[2].value),
          { eventId: body.eventId, operationId: body.operationId, payload: body.payload },
          { ...f.engineering, testClock: Date.now() },
        );
        if (++scanCalls === 1) await route.abort("failed");
        else await route.fulfill({ status: 202, json: result });
      } else {
        const result = await confirmAttendanceQr(
          f.pool,
          f.config,
          hash(f.accounts[2].value),
          {
            eventId: body.eventId,
            operationId: body.operationId,
            scanId: body.scanId,
            confirmPresence: body.confirmPresence,
          },
          { ...f.engineering, testClock: Date.now() },
        );
        if (++confirmCalls === 1) await route.abort("failed");
        else if (confirmCalls === 2)
          await route.fulfill({ status: 202, json: { ...result, scanId: randomUUID() } });
        else await route.fulfill({ status: 202, json: result });
      }
    });
    await page.goto(`/account/attendance?event=${f.eventId}`);
    const controls = page.getByRole("region", { name: "Staff QR scan controls" });
    const schedule = (
      await listStaffAttendanceEvents(f.pool, hash(f.accounts[2].value), { eventId: f.eventId })
    ).events[0];
    for (const [label, instant] of [
      ["Check-in opens", schedule.opensAt],
      ["Final cutoff", schedule.cutoff],
    ])
      for (const zone of [schedule.timeZone, "Pacific/Auckland"])
        await expect(
          controls
            .getByText(label, { exact: true })
            .locator("..")
            .locator(`time[data-time-zone="${zone}"]`),
        ).toHaveAttribute("datetime", instant);
    expect((await camera(page)).requests).toBe(0);
    await controls.getByRole("button", { name: "Start camera to scan QR" }).click();
    await expect(controls.getByRole("status")).toContainText("not acknowledged");
    await expect.poll(async () => (await camera(page)).live).toBe(0);
    expect((await camera(page)).audio.every((value) => value === false)).toBe(true);
    expect(workerUrls.length).toBeGreaterThan(0);
    expect(workerUrls.every((url) => url.startsWith("blob:https://localhost:3444/"))).toBe(true);
    await controls.getByRole("button", { name: "Retry the same QR action" }).click();
    const presence = controls.getByRole("region", { name: "Scanned attendee presence" });
    await expect(presence).toBeVisible();
    await expect(presence.getByRole("checkbox")).not.toBeChecked();
    await expect(presence.getByRole("button", { name: "Record presence request" })).toBeDisabled();
    expect(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
    ).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await controls.screenshot({
      path: "test-results/staff-presence-mobile.png",
      mask: [presence.getByText(/^Scanned alias:/)],
    });
    await presence.getByRole("checkbox").check();
    await presence.getByRole("button", { name: "Record presence request" }).click();
    await expect(controls.getByRole("status")).toContainText("not acknowledged");
    for (const text of ["could not be verified", "confirmation is still pending"]) {
      await controls.getByRole("button", { name: "Retry the same QR action" }).click();
      await expect(controls.getByRole("status")).toContainText(text);
    }
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[2]).toEqual(requests[3]);
    expect(requests[3]).toEqual(requests[4]);
    expect(Object.keys(requests[2]).sort()).toEqual([
      "action",
      "confirmPresence",
      "eventId",
      "operationId",
      "scanId",
    ]);
    expect(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
    ).toBe(1);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("camera stop fences a late permission response; page-hide stops streams and prevents automatic restart", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    await syntheticQrCamera(context, image("https://example.invalid/never-open"), true);
    await f.enter(context, 2);
    await page.goto(`/account/attendance?event=${f.eventId}`);
    const controls = page.getByRole("region", { name: "Staff QR scan controls" });
    await controls.getByRole("button", { name: "Start camera to scan QR" }).click();
    await expect.poll(async () => (await camera(page)).requests).toBe(1);
    await controls.getByRole("button", { name: "Stop camera" }).click();
    await page.evaluate(() =>
      (window as typeof window & { cameraProbe: { release: () => void } }).cameraProbe.release(),
    );
    await expect.poll(async () => (await camera(page)).ended).toBe(1);
    expect((await camera(page)).live).toBe(0);
    await controls.getByRole("button", { name: "Start camera to scan QR" }).click();
    await expect.poll(async () => (await camera(page)).requests).toBe(2);
    await page.evaluate(() =>
      (window as typeof window & { cameraProbe: { release: () => void } }).cameraProbe.release(),
    );
    // A foreign URL is decoded locally, never navigated or submitted.
    await expect(controls.getByRole("status")).toContainText(
      "Links and other QR codes are not opened",
    );
    expect(new URL(page.url()).pathname).toBe("/account/attendance");
    expect((await camera(page)).live).toBe(0);
    await controls.getByRole("button", { name: "Start camera to scan QR" }).click();
    await expect.poll(async () => (await camera(page)).requests).toBe(3);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    await page.evaluate(() =>
      (window as typeof window & { cameraProbe: { release: () => void } }).cameraProbe.release(),
    );
    await expect.poll(async () => (await camera(page)).ended).toBe(3);
    await expect(controls.getByRole("button", { name: "Start camera to scan QR" })).toBeVisible();
    expect((await camera(page)).requests).toBe(3);
  } finally {
    await f.cleanup();
  }
});

test("staff pages enforce active assignment, no-store and foreign event/cursor isolation", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    await f.enter(context, 0);
    const response = await page.goto(`/account/attendance?event=${f.eventId}`);
    expect(response?.headers()["cache-control"]).toContain("no-store");
    await expect(page.getByRole("region", { name: "Staff QR scan controls" })).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("unavailable");
    await page.goto(`/account/attendance?before=${f.eventId}`);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("unavailable");
    await f.enter(context, 1);
    await page.goto("/account/attendance");
    await page.getByRole("link", { name: "Open scan controls" }).click();
    await expect(page.getByRole("region", { name: "Staff QR scan controls" })).toBeVisible();
    await f.pool.query("UPDATE app_accounts SET state='deletion_requested' WHERE id=$1", [
      f.accounts[1].id,
    ]);
    await page.reload();
    await expect(page.getByRole("region", { name: "Staff QR scan controls" })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Sign in to review your staff assignments" }),
    ).toBeVisible();
  } finally {
    await f.cleanup();
  }
});

test("camera permission denial makes one request per explicit start and never retries automatically", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    await syntheticQrCamera(context, image("not an attendance QR"));
    await context.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: async () => {
          (window as typeof window & { cameraProbe: { requests: number } }).cameraProbe.requests++;
          throw new DOMException("Test denial", "NotAllowedError");
        },
        configurable: true,
      });
    });
    await f.enter(context, 2);
    await page.goto(`/account/attendance?event=${f.eventId}`);
    const controls = page.getByRole("region", { name: "Staff QR scan controls" });
    await controls.getByRole("button", { name: "Start camera to scan QR" }).click();
    await expect(controls.getByRole("status")).toContainText("Camera unavailable");
    expect((await camera(page)).requests).toBe(1);
    await expect(controls.getByRole("button", { name: "Start camera to scan QR" })).toBeVisible();
  } finally {
    await f.cleanup();
  }
});

test("an acquired synthetic camera stops on tab hiding and after its one-minute bound", async ({
  page,
  context,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    await syntheticQrCamera(
      context,
      "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="white"/></svg>',
        ),
    );
    await f.enter(context, 2);
    await page.clock.install();
    await page.goto(`/account/attendance?event=${f.eventId}`);
    const controls = page.getByRole("region", { name: "Staff QR scan controls" });
    await controls.getByRole("button", { name: "Start camera to scan QR" }).click();
    await expect.poll(async () => (await camera(page)).live).toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect((await camera(page)).live).toBe(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect((await camera(page)).requests).toBe(1);
    await controls.getByRole("button", { name: "Start camera to scan QR" }).click();
    await expect.poll(async () => (await camera(page)).live).toBe(1);
    await page.clock.fastForward(60_001);
    await expect(controls.getByRole("status")).toContainText("Camera stopped after one minute");
    expect((await camera(page)).live).toBe(0);
  } finally {
    await f.cleanup();
  }
});
