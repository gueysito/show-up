import { expect, test } from "@playwright/test";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { attendanceFixtures } from "../fixtures/attendance";
import { startLoopbackCoverageProxy } from "../../scripts/loopback-coverage-proxy";
import { readLoopbackCoverage } from "../../src/server/attendance/coverage-recorder";
import { sessionCookie } from "../../src/server/auth/sessions";

// The collector sits on the private HTTP hop behind the separately tested TLS
// endpoint. These are generated engineering sessions, not owner/provider cookies.
function capturedPost(port: number, path: string, session: string, body: unknown) {
  return new Promise<number>((resolve, reject) => {
    const operation = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          host: "localhost:3444",
          origin: "https://localhost:3444",
          cookie: `${sessionCookie}=${session}`,
          "content-type": "application/json",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          response.complete
            ? resolve(response.statusCode ?? 0)
            : reject(new Error("Incomplete actual response")),
        );
        response.once("error", reject);
      },
    );
    operation.once("error", reject);
    operation.setTimeout(10000, () => operation.destroy(new Error("Capture test timed out")));
    operation.end(JSON.stringify(body));
  });
}
test("loopback capture measures actual host controls and closed attendance HTTP without retaining session or phrase values", async () => {
  const f = await attendanceFixtures(),
    epochs: string[] = [];
  let proxy: Awaited<ReturnType<typeof startLoopbackCoverageProxy>> | undefined;
  try {
    proxy = await startLoopbackCoverageProxy(f.pool, 3102, { expectedHost: "localhost:3444" });
    epochs.push(proxy.epochId);
    const phrase = `Measured fictional phrase ${randomUUID()}`;
    expect(
      await capturedPost(proxy.port, "/api/attendance/codes", f.accounts[1].value, {
        eventId: f.eventId,
        operationId: randomUUID(),
        phrase,
      }),
    ).toBe(200);
    expect(
      await capturedPost(proxy.port, "/api/attendance/check-in", f.accounts[0].value, {
        eventId: f.eventId,
        consentId: f.consent.id,
        operationId: randomUUID(),
        phrase,
      }),
    ).toBe(503);
    await proxy.stop();
    const trace = await readLoopbackCoverage(f.pool, proxy.epochId);
    expect(trace.counts?.find((row) => row.channel === "host_code")?.completed).toBe("1");
    expect(trace.counts?.find((row) => row.channel === "code_entry")?.unavailable).toBe("1");
    expect(trace.sourceQualified).toBe(false);
    expect(trace.liveSubmissionAllowed).toBe(false);
    const metadata = JSON.stringify(trace);
    for (const value of [
      phrase,
      f.accounts[0].value,
      f.accounts[1].value,
      f.accounts[0].id,
      f.consent.id,
    ])
      expect(metadata.includes(value)).toBe(false);
    expect(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
    ).toBe(0);
  } finally {
    await proxy?.stop();
    await f.pool.query("DELETE FROM service_coverage_epochs WHERE id=ANY($1::uuid[])", [epochs]);
    await f.cleanup();
  }
});
