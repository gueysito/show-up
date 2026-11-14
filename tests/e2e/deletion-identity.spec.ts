import { expect, test } from "@playwright/test";
import { accountFixtures } from "../fixtures/accounts";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("switching accounts after opening deletion confirmation cannot erase the replacement account", async ({
  page,
  context,
}) => {
  const f = await accountFixtures([[], []]);
  try {
    await f.enter(context, 0);
    await page.goto("/account/privacy");
    await expect(
      page.getByText(`Account reference: ${f.accounts[0].id}`, { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Type DELETE to request deletion").fill("DELETE");
    await page.getByRole("checkbox", { name: /I understand that on-chain/ }).check();
    await f.enter(context, 1);
    expect((await (await page.request.get("/api/account/export")).json()).account.id).toBe(
      f.accounts[1].id,
    );
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/account/deletion") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Request account deletion", exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(403);
    const states = (
      await f.pool.query("SELECT state FROM app_accounts WHERE id=ANY($1::uuid[])", [
        f.accounts.map((account) => account.id),
      ])
    ).rows;
    expect(states.length).toBe(2);
    expect(states.every((row) => row.state === "active")).toBe(true);
    await page.getByRole("button", { name: "Reload deletion confirmation" }).click();
    await expect(
      page.getByText(`Account reference: ${f.accounts[1].id}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Type DELETE to request deletion")).toHaveValue("");
    await expect(
      page.getByRole("checkbox", { name: /I understand that on-chain/ }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Request account deletion", exact: true }),
    ).toBeDisabled();
  } finally {
    await f.cleanup();
  }
});
