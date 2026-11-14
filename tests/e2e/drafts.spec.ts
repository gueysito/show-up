import { expect, test, type Page } from "@playwright/test";
import { validDraft } from "../fixtures/draft";

const harnessOrigin =
  process.env.SHOWUP_CONTAINER_E2E === "1" ? "http://127.0.0.1:3101" : "http://127.0.0.1:3103";
test.use({ baseURL: harnessOrigin });

async function fillDraft(page: Page, name = "Friday community room") {
  const draft = validDraft();
  await page.getByLabel("Event name", { exact: true }).fill(name);
  await page.getByLabel("Session URL", { exact: true }).fill(draft.sessionReference);
  await page.getByLabel("Planned start", { exact: true }).fill(draft.startsAt.slice(0, 16));
  await page.getByLabel("Planned end", { exact: true }).fill(draft.endsAt.slice(0, 16));
  await page.getByLabel("Planned sponsor budget (USDC)", { exact: true }).fill("100");
  return draft;
}

test("invalid rules have linked errors, keyboard focus and preserved input", async ({ page }) => {
  await page.goto("/workbench");
  const save = page.getByRole("button", { name: "Validate & save draft" });
  await expect(save).toBeEnabled();
  await page.getByLabel("Event name", { exact: true }).fill("Keep my entries");
  await page.getByLabel("Capacity", { exact: true }).fill("101");
  await page.getByLabel("Refundable commitment (USDC)", { exact: true }).fill("2.49");
  await save.click();
  const errors = page.getByRole("alert", { name: "Draft validation errors" });
  await expect(errors).toBeFocused();
  await expect(errors).toContainText("Choose a whole number from 1 to 100");
  await expect(page.getByLabel("Event name", { exact: true })).toHaveValue("Keep my entries");
  await errors.getByRole("link", { name: /Capacity:/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Capacity", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Review validation errors" }).click();
  await errors.getByRole("link", { name: /commitment:/ }).click();
  await expect(page.getByLabel("Refundable commitment (USDC)", { exact: true })).toBeFocused();
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
  await expect(page.getByRole("region", { name: "Saved draft confirmation" })).toHaveCount(0);
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

test("timezone search updates preview and durable save details without moving UTC instants", async ({
  page,
}) => {
  await page.goto("/workbench");
  await expect(page.getByRole("button", { name: "Validate & save draft" })).toBeEnabled();
  const draft = await fillDraft(page, "Timezone proof");
  const zone = page.getByLabel("Event display timezone", { exact: true });
  await expect(zone).toHaveAttribute("list", "event-timezones");
  await expect(page.locator('#event-timezones option[value="America/Denver"]')).toHaveCount(1);
  await zone.fill("America/Denver");
  await expect(page.getByLabel("Planned start", { exact: true })).toHaveValue(
    draft.startsAt.slice(0, 16),
  );
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  const card = page.getByRole("region", { name: "Saved draft confirmation" });
  await expect(card).toBeInViewport();
  await expect(card).toContainText("Commitment: 5 USDC");
  await expect(card).toContainText("Sponsor budget: 100 USDC");
  await expect(card).toContainText("America/Denver");
  await expect(card).toContainText("Unpublished and unfunded");
  await page.reload();
  await page.getByRole("button", { name: /Timezone proof Revision 1/ }).click();
  await expect(zone).toHaveValue("America/Denver");
  await expect(page.getByLabel("Planned start", { exact: true })).toHaveValue(
    draft.startsAt.slice(0, 16),
  );
});

test("choice editor saves two through six choices, repairs selection and names invalid choices", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/workbench");
  await expect(page.getByRole("button", { name: "Validate & save draft" })).toBeEnabled();
  await fillDraft(page, "Choice proof");
  await page.getByRole("button", { name: /Add optional question/ }).click();
  await page.getByLabel("Question", { exact: true }).fill("Pick the word");
  await page.getByLabel("Choice 1", { exact: true }).fill("First");
  await page.getByLabel("Choice 2", { exact: true }).fill("Second");
  for (const count of [2, 3, 4, 5, 6]) {
    if (count > 2) {
      await page.getByRole("button", { name: /Add answer choice/ }).click();
      await page.getByLabel(`Choice ${count}`, { exact: true }).fill(`Option ${count}`);
    }
    await page.getByLabel("Correct option", { exact: true }).selectOption(String(count - 1));
    await page.getByRole("button", { name: "Validate & save draft" }).click();
    await expect(page.getByRole("region", { name: "Saved draft confirmation" })).toBeInViewport();
    await page.getByRole("button", { name: "Close saved details" }).click();
  }
  await expect(page.getByRole("button", { name: /Add answer choice/ })).toBeDisabled();
  await page.getByRole("button", { name: "Remove choice 6", exact: true }).click();
  await expect(page.getByLabel("Correct option", { exact: true })).toHaveValue("0");
  await page.getByLabel("Choice 2", { exact: true }).fill(" first ");
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  const errors = page.getByRole("alert", { name: "Draft validation errors" });
  await expect(errors).toBeInViewport();
  await expect(errors).toContainText("remove duplicates");
  await page.getByRole("button", { name: "Return to editing; keep inline errors" }).click();
  await page.getByLabel("Choice 2", { exact: true }).fill("");
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(errors).toContainText("Enter choice 2 or remove");
  await errors.getByRole("link", { name: /Choice 2:/ }).click();
  await expect(page.getByLabel("Choice 2", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Denver host enters local time and sees the same time in the event preview", async ({
  browser,
}) => {
  const context = await browser.newContext({ timezoneId: "America/Denver" });
  try {
    const page = await context.newPage();
    await page.goto(`${harnessOrigin}/workbench`);
    const start = new Date(Date.now() + 86_400_000);
    const [month, day, year] = start
      .toLocaleDateString("en-US", { timeZone: "America/Denver" })
      .split("/");
    const input = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    await page.getByLabel("Planned start", { exact: true }).fill(`${input}T18:30`);
    await page.getByLabel("Planned end", { exact: true }).fill(`${input}T19:30`);
    await page.getByLabel("Event display timezone", { exact: true }).fill("America/Denver");
    await expect(page.getByLabel("Event rules preview")).toContainText(/6:30\s*PM\s*(MDT|MST)/);
  } finally {
    await context.close();
  }
});

test("conflict reload requires explicit discard and preserves the newer save", async ({
  page,
  context,
}) => {
  await page.goto("/workbench");
  await expect(page.getByRole("button", { name: "Validate & save draft" })).toBeEnabled();
  await fillDraft(page, "Conflict proof");
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(page.getByRole("status")).toContainText("revision 1");
  await page.getByRole("button", { name: "Close saved details" }).click();
  const stale = await context.newPage();
  await stale.goto("/workbench");
  await stale.getByRole("button", { name: /Conflict proof Revision 1/ }).click();
  await stale.getByLabel("Event name", { exact: true }).fill("Unsaved reference");
  await page.getByLabel("Event name", { exact: true }).fill("Newer durable version");
  await page.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(page.getByRole("status")).toContainText("revision 2");
  await stale.getByRole("button", { name: "Validate & save draft" }).click();
  await expect(stale.getByRole("alert", { name: "Newer saved draft" })).toBeInViewport();
  const dismissed = stale.waitForEvent("dialog").then((dialog) => dialog.dismiss());
  await stale.getByRole("button", { name: "Load newer saved version" }).click();
  await dismissed;
  await expect(stale.getByRole("button", { name: "Load newer saved version" })).toBeEnabled();
  await expect(stale.getByLabel("Event name", { exact: true })).toHaveValue("Unsaved reference");
  const accepted = stale.waitForEvent("dialog").then((dialog) => dialog.accept());
  await stale.getByRole("button", { name: "Load newer saved version" }).click();
  await accepted;
  await expect(stale.getByLabel("Event name", { exact: true })).toHaveValue(
    "Newer durable version",
  );
  await expect(stale.getByRole("alert", { name: "Newer saved draft" })).toHaveCount(0);
});
