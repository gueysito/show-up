import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { attendanceFixtures } from "../fixtures/attendance";
import { hash } from "../../src/server/auth/crypto";
import {
  issueAttendanceQr,
  scanAttendanceQr,
  confirmAttendanceQr,
} from "../../src/server/attendance/qr";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test("QR HTTP admission remains closed and private while explicit backend fixture scans require separate presence confirmation", async ({
  page,
  context,
  browser,
}) => {
  const f = await attendanceFixtures("physical");
  try {
    await f.enter(context, 0);
    const headers = { origin: "https://localhost:3444" };
    const issue = {
      action: "issue",
      eventId: f.eventId,
      consentId: f.consent.id,
      operationId: randomUUID(),
    };
    const unavailable = await page.request.post("/api/attendance/qr", { headers, data: issue });
    expect(unavailable.status()).toBe(503);
    expect(unavailable.headers()["cache-control"]).toBe("no-store");
    expect(unavailable.headers()["access-control-allow-origin"]).toBeUndefined();
    for (const extra of [
      { funded: true },
      { engineering: true },
      { receivedMs: 0 },
      { environment: "sandbox" },
    ])
      expect(
        (
          await page.request.post("/api/attendance/qr", { headers, data: { ...issue, ...extra } })
        ).status(),
      ).toBe(400);
    expect(
      (
        await page.request.post("/api/attendance/qr", {
          headers: { origin: "https://other.invalid" },
          data: issue,
        })
      ).status(),
    ).toBe(403);
    expect((await page.request.get("/api/attendance/qr")).status()).toBe(405);
    const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      expect(
        (
          await anonymous.request.post("https://localhost:3444/api/attendance/qr", {
            headers,
            data: issue,
          })
        ).status(),
      ).toBe(401);
    } finally {
      await anonymous.close();
    }
    const qr = await issueAttendanceQr(
      f.pool,
      f.config,
      f.session,
      { eventId: f.eventId, consentId: f.consent.id, operationId: randomUUID() },
      f.engineering,
    );
    const staff = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await f.enter(staff, 2);
      const scanRequest = {
        action: "scan",
        eventId: f.eventId,
        operationId: randomUUID(),
        payload: qr.payload,
      };
      expect(
        (
          await staff.request.post("https://localhost:3444/api/attendance/qr", {
            headers,
            data: scanRequest,
          })
        ).status(),
      ).toBe(503);
      expect(
        (await page.request.post("/api/attendance/qr", { headers, data: scanRequest })).status(),
      ).toBe(403);
      const inspection = await scanAttendanceQr(
        f.pool,
        f.config,
        hash(f.accounts[2].value),
        { eventId: f.eventId, operationId: randomUUID(), payload: qr.payload },
        { ...f.engineering, testClock: f.received + 1 },
      );
      expect(inspection.attendanceConfirmed).toBe(false);
      const confirm = {
        action: "confirm",
        eventId: f.eventId,
        operationId: randomUUID(),
        scanId: inspection.scanId,
        confirmPresence: true,
      };
      expect(
        (
          await staff.request.post("https://localhost:3444/api/attendance/qr", {
            headers,
            data: confirm,
          })
        ).status(),
      ).toBe(503);
      expect(
        (
          await staff.request.post("https://localhost:3444/api/attendance/qr", {
            headers,
            data: { ...confirm, confirmPresence: false },
          })
        ).status(),
      ).toBe(400);
      const pending = await confirmAttendanceQr(
        f.pool,
        f.config,
        hash(f.accounts[2].value),
        {
          eventId: f.eventId,
          operationId: randomUUID(),
          scanId: inspection.scanId,
          confirmPresence: true,
        },
        { ...f.engineering, testClock: f.received + 2 },
      );
      expect(pending.status).toBe("pending_contract");
      expect(pending.attendanceConfirmed).toBe(false);
      const staffRecords = await (
        await staff.request.get("https://localhost:3444/api/commitments")
      ).json();
      expect(staffRecords.records).toHaveLength(0);
    } finally {
      await staff.close();
    }
    await page.goto("/account/commitments");
    const status = page.getByRole("region", { name: "Attendance evidence status" });
    await expect(status.getByRole("heading", { name: "Attendance not confirmed" })).toBeVisible();
    await expect(status).toContainText("Disposable sandbox evidence candidate only");
    const records = await (await page.request.get("/api/commitments")).json();
    expect(records.records[0].attendance.attendanceConfirmed).toBe(false);
    for (const key of ["validator", "credential", "nonce", "payload", "source"])
      expect(records.records[0].attendance[key]).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});
