import { expect, test } from "@playwright/test";

test("production shell and database health are observable", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A commitment worth keeping." })).toBeVisible();
  await expect(
    page.getByText("Authentication, publication and funding are unavailable."),
  ).toBeVisible();
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: "ready", scope: "local-foundation" });
});
