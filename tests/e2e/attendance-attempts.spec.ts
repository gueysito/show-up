import { expect, test } from "@playwright/test";
import { attendanceFixtures } from "../fixtures/attendance";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("sandbox-context fixture candidates remain explicitly pending; HTTP cannot inject funding, source or receipt-time authority", async ({
  page,
  context,
  browser,
}) => {
  const f = await attendanceFixtures();
  try {
    await f.enter(context, 0);
    await page.goto("/account/commitments");
    const headers = { origin: "https://localhost:3444" };
    const closed = await page.request.post("/api/attendance/check-in", {
      headers,
      data: f.input(),
    });
    expect(closed.status()).toBe(503);
    expect(closed.headers()["cache-control"]).toBe("no-store");
    expect(closed.headers()["access-control-allow-origin"]).toBeUndefined();
    for (const extra of [
      { funded: true },
      { engineering: true },
      { receivedMs: 0 },
      { environment: "sandbox" },
    ])
      expect(
        (
          await page.request.post("/api/attendance/check-in", {
            headers,
            data: { ...f.input(), ...extra },
          })
        ).status(),
      ).toBe(400);
    expect(
      (
        await page.request.post("/api/attendance/check-in", {
          headers: { origin: "https://other.invalid" },
          data: f.input(),
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await f.pool.query("SELECT 1 FROM app_attendance_code_attempts WHERE account_id=$1", [
          f.accounts[0].id,
        ])
      ).rowCount,
    ).toBe(0);
    // Positive model input is explicit backend-only test data, never HTTP/live eligibility.
    const candidate = await f.attempt();
    expect(candidate.status).toBe("pending_contract");
    await page.reload();
    const evidence = page.getByRole("region", { name: "Attendance evidence status" });
    await expect(evidence.getByRole("heading", { name: "Attendance not confirmed" })).toBeVisible();
    await expect(evidence).toContainText("Disposable sandbox evidence candidate only");
    await expect(
      page.getByText("Escrow not confirmed. No funded seat is shown for this authorization.", {
        exact: true,
      }),
    ).toBeVisible();
    const own = await (await page.request.get("/api/commitments")).json();
    expect(own.records[0].attendance.attendanceConfirmed).toBe(false);
    expect(own.records[0].attendance.liveSubmissionAllowed).toBe(false);
    for (const key of ["nonce", "receipt", "source", "accountId", "proof"])
      expect(own.records[0].attendance[key]).toBeUndefined();
    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await f.enter(other, 2);
      expect(
        (
          await other.request.post("https://localhost:3444/api/attendance/check-in", {
            headers,
            data: f.input(),
          })
        ).status(),
      ).toBe(404);
      const rows = await (await other.request.get("https://localhost:3444/api/commitments")).json();
      expect(rows.records).toHaveLength(0);
    } finally {
      await other.close();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await evidence.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await evidence.screenshot({ path: "test-results/attendance-pending-mobile.png" });
  } finally {
    await f.cleanup();
  }
});
