import { expect, test } from "@playwright/test";
import { v1EventFixture } from "../fixtures/v1-event";
import { readV1HostState } from "../../src/server/events/v1-actions";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("host countdown and closing controls follow server time with a fast or slow device clock", async ({
  page,
  context,
}) => {
  const f = await v1EventFixture({
    encryption: process.env.SHOWUP_E2E_ENCRYPTION_KEY!,
    index: process.env.SHOWUP_E2E_INDEX_KEY!,
  });
  try {
    const host = await readV1HostState(f.pool, f.config, f.sessions[0], f.eventId, f.transport);
    const serverNow = Date.now();
    await page.route("**/api/events/mainnet?**", (route) =>
      route.fulfill({
        json: {
          ...host,
          serverNow,
          code: "123456",
          codeExpiresAt: new Date(serverNow + 120000).toISOString(),
          startsAt: serverNow - 60000,
          endsAt: serverNow + 60000,
        },
      }),
    );
    await f.enter(context, 0);
    for (const skew of [-120000, 120000]) {
      await page.clock.setFixedTime(new Date(serverNow + skew));
      await page.goto(`/events/${f.eventId}/manage`);
      await expect(page.getByLabel("Live check-in code")).toHaveText("123456");
      await expect(page.getByRole("timer")).toContainText(/Closes in (2:00|1:59)/);
      await page.getByRole("checkbox").check();
      await expect(page.getByRole("button", { name: "Close and settle event" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Cancel and return deposits" })).toBeEnabled();
    }
  } finally {
    await f.cleanup();
  }
});
