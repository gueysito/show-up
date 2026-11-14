import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("production shell and database health are observable", async ({ page, request }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Make showing up mean something." }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Host an event" })).toHaveAttribute("href", "/host");
  await expect(page.getByText(/USDC deposits on NEAR are live/)).toBeVisible();
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ready", scope: "local-foundation" });
});

test("production refuses harness reads and writes even with its flag enabled", async ({
  request,
}) => {
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await request.fetch("/api/dev/drafts", {
      method,
      headers: {
        host: "127.0.0.1:3101",
        origin: "http://127.0.0.1:3101",
        "x-showup-harness": "1",
      },
    });
    expect(response.status()).toBe(404);
  }
  expect((await request.get("/workbench")).status()).toBe(404);
  expect(await readFile("AGENTS.md", "utf8")).not.toContain("BEGIN:nextjs-agent-");
});

test("the front door leads to real host access and a local V1 preview without funding actions", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "How Showup works" })).toContainText("Check in");
  await expect(
    page.getByRole("complementary", { name: "Illustrative attendee receipt" }),
  ).toContainText("Example receipt");
  await page.getByRole("link", { name: "Host an event", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Host access required" })).toBeVisible();
  await page.goto("/");
  await page.getByRole("link", { name: "Explore the event rules" }).click();
  await expect(page).toHaveURL(/\/preview$/);
  await expect(page.getByLabel("Refundable commitment (USDC)", { exact: true })).toHaveValue("1");
  await page.getByLabel("Where we meet", { exact: true }).selectOption("physical");
  await expect(page.getByRole("complementary", { name: "Event rules preview" })).toContainText(
    "Use the host's live code",
  );
  await expect(page.getByRole("button", { name: "Publish event on mainnet" })).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/preview");
    await expect(page.getByLabel("Refundable commitment (USDC)", { exact: true })).toHaveCSS(
      "font-size",
      "16px",
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.goto("/");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByRole("link", { name: "Your account" })).toBeVisible();
    if (width !== 320)
      await page.screenshot({
        path: testInfo.outputPath(`showup-home-${width}.png`),
        fullPage: true,
      });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    true,
  );
});
