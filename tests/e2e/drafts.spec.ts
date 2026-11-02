import { expect, test, type Page } from "@playwright/test";
import { validDraft } from "../fixtures/draft";

const harnessOrigin =
  process.env.SHOWUP_CONTAINER_E2E === "1" ? "http://127.0.0.1:3101" : "http://127.0.0.1:3103";
test.use({ baseURL: harnessOrigin });

async function fillDraft(page: Page, name = "Friday community room") {
  const draft = validDraft();
  await page.getByLabel("Event name", { exact: true }).fill(name);
  await page.getByLabel("Session URL", { exact: true }).fill(draft.sessionReference);
  await page.getByLabel("Planned start (UTC)", { exact: true }).fill(draft.startsAt.slice(0, 16));
  await page.getByLabel("Planned end (UTC)", { exact: true }).fill(draft.endsAt.slice(0, 16));
  await page.getByLabel("Planned sponsor budget (USDC)", { exact: true }).fill("100");
  return draft;
}

test("invalid rules have linked errors, keyboard focus and preserved input", async ({ page }) => {
  await page.goto("/workbench");
  const save = page.getByRole("button", { name: "Validate & save draft" });
  await expect(save).toBeEnabled();
  await page.getByLabel("Event name", { exact: true }).fill("Keep my entries");
  await page.getByLabel("Capacity", { exact: true }).fill("101");
  await save.click();
  const errors = page.getByRole("alert", { name: "Draft validation errors" });
  await expect(errors).toBeFocused();
  await expect(errors).toContainText("Choose a whole number from 1 to 100");
  await expect(page.getByLabel("Event name", { exact: true })).toHaveValue("Keep my entries");
  await errors.getByRole("link", { name: /capacity:/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Capacity", { exact: true })).toBeFocused();
});

test("valid draft persists, reloads, protects a stale tab and clears only its workspace", async ({
  page,
  context,
  browser,
}) => {
  await page.goto("/workbench");
  await expect(page.getByRole("button", { name: "Validate & save draft" })).toBeEnabled();
  await fillDraft(page);
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(page.getByRole("status")).toContainText("Saved locally · revision 1");
  await page.reload();
  const saved = page.getByRole("button", { name: /Friday community room Revision 1/ });
  await saved.click();
  await expect(page.getByLabel("Event name", { exact: true })).toHaveValue("Friday community room");
  const otherTab = await context.newPage();
  await otherTab.goto("/workbench");
  await otherTab.getByRole("button", { name: /Friday community room Revision 1/ }).click();
  await page.getByLabel("Event name", { exact: true }).fill("Friday room updated");
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(page.getByRole("status")).toContainText("revision 2");
  await otherTab.getByLabel("Event name", { exact: true }).fill("Stale edit");
  await otherTab.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(otherTab.getByRole("status")).toContainText("changed in another tab");
  const privateContext = await browser.newContext();
  const privatePage = await privateContext.newPage();
  await privatePage.goto(`${harnessOrigin}/workbench`);
  await expect(privatePage.getByRole("button", { name: "Validate & save draft" })).toBeEnabled();
  await expect(privatePage.getByRole("button", { name: /Friday room updated/ })).toHaveCount(0);
  await privateContext.close();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear this local workspace" }).click();
  await expect(page.getByRole("status")).toContainText("Local workspace cleared");
  await expect(page.getByRole("button", { name: /Friday room updated/ })).toHaveCount(0);
});

test("question and NFT constraints work for a physical event", async ({ page }) => {
  await page.goto("/workbench");
  const draft = await fillDraft(page, "A physical gathering");
  await page.getByLabel("Where we meet", { exact: true }).selectOption("physical");
  await page
    .getByLabel("Venue and proof instructions", { exact: true })
    .fill("Room A, check in with assigned staff");
  await page.getByRole("button", { name: /Add optional question/ }).click();
  const question = page.getByRole("group", { name: "Question 1", exact: true });
  await question.getByLabel("Question", { exact: true }).fill("Which word matters?");
  await question.getByLabel("Answer format", { exact: true }).selectOption("short");
  await question.getByLabel("Accepted answers", { exact: true }).fill("Community\nTogether");
  await question
    .getByLabel("Planned question time (UTC)", { exact: true })
    .fill(draft.endsAt.slice(0, 16));
  await page.getByRole("button", { name: /Add optional question/ }).click();
  await expect(page.getByRole("button", { name: /Add optional question/ })).toBeDisabled();
  await page.getByRole("button", { name: "Remove question 2" }).click();
  await page.getByLabel("Include one planned NFT prize").check();
  await page.getByLabel("Reward recipe", { exact: true }).selectOption("equal");
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(page.getByRole("alert", { name: "Draft validation errors" })).toContainText(
    "Keep the full question window",
  );
  await expect(page.getByRole("alert", { name: "Draft validation errors" })).toContainText(
    "NFT supplements a monetary draw",
  );
  await question
    .getByLabel("Planned question time (UTC)", { exact: true })
    .fill(draft.startsAt.slice(0, 16));
  await page.getByLabel("Include one planned NFT prize").uncheck();
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(page.getByRole("status")).toContainText("Saved locally");
  await expect(page.getByRole("heading", { name: "Staff-validated QR" })).toBeVisible();
});

test("network failure preserves the form and a retry keeps the same operation", async ({
  page,
}) => {
  await page.goto("/workbench");
  await expect(page.getByRole("button", { name: "Validate & save draft" })).toBeEnabled();
  await fillDraft(page, "Retry this gathering");
  const operations: string[] = [];
  await page.route("**/api/dev/drafts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    operations.push(route.request().postDataJSON().operationId);
    await route.abort();
  });
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(page.getByRole("status")).toContainText(/fetch/i);
  await expect(page.getByLabel("Event name", { exact: true })).toHaveValue("Retry this gathering");
  await page.unroute("**/api/dev/drafts");
  page.on("request", (request) => {
    if (request.url().endsWith("/api/dev/drafts") && request.method() === "POST")
      operations.push(request.postDataJSON().operationId);
  });
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(page.getByRole("status")).toContainText("Saved locally · revision 1");
  expect(operations[0]).toBe(operations[1]);
});

test("API enforces origin, media, size and server-side validation", async ({ page }) => {
  await page.goto("/workbench");
  await expect(page.getByRole("button", { name: "Validate & save draft" })).toBeEnabled();
  const headers = { origin: harnessOrigin, "x-showup-harness": "1" };
  expect(
    (
      await page.request.post("/api/dev/drafts", {
        headers: { ...headers, origin: "https://evil.example" },
        data: {},
      })
    ).status(),
  ).toBe(404);
  expect((await page.request.post("/api/dev/drafts", { headers, data: "invalid" })).status()).toBe(
    415,
  );
  expect(
    (
      await page.request.post("/api/dev/drafts", {
        headers: { ...headers, "content-type": "application/json" },
        data: "[",
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.post("/api/dev/drafts", { headers, data: { payload: "x".repeat(33000) } })
    ).status(),
  ).toBe(413);
  const response = await page.request.post("/api/dev/drafts", {
    headers,
    data: {
      id: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      revision: 0,
      data: { ...validDraft(), capacity: 101 },
    },
  });
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({
    errors: { capacity: "Choose a whole number from 1 to 100." },
  });
});

test("phone widths preserve labels, controls and horizontal reflow", async ({ page }) => {
  for (const width of [320, 430, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/workbench");
    await expect(page.getByLabel("Event name", { exact: true })).toBeVisible();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits).toBe(true);
    const height = await page
      .getByRole("button", { name: "Validate & save draft" })
      .evaluate((node) => node.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
  }
});
