import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("production shell and database health are observable", async ({ page, request }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Make showing up mean something." }),
  ).toBeVisible();
  await expect(page.getByText("Publication and funding are unavailable.")).toBeVisible();
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
