import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { hash, token } from "../../src/server/auth/crypto";
import { sessionCookie } from "../../src/server/auth/sessions";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });

test("unconfigured providers stay disabled; cross-site sign-in is rejected", async ({ page }) => {
  await page.goto("/account");
  await expect(page.getByRole("button", { name: "Sign in with Telegram" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeDisabled();
  await expect(
    page.getByText("Telegram sign-in requires no email.", { exact: false }),
  ).toBeVisible();
  const response = await page.request.post("/api/auth/start/google", {
    headers: { origin: "https://evil.example" },
  });
  expect(response.status()).toBe(403);
  expect((await page.request.get("/api/auth/start/google")).status()).toBe(405);
  expect(
    (
      await page.request.post("/api/auth/start/google?flow=link", {
        headers: { origin: "https://localhost:3444" },
      })
    ).status(),
  ).toBe(401);
});

test("preauthenticated fixture restores and logs out via real HTTPS UI; this does not prove live login", async ({
  page,
  context,
}) => {
  // Only database seeding in the test runner. No fixture identity/login endpoint exists in the app.
  process.env.SHOWUP_ENV = "test";
  process.env.DATABASE_URL = "postgresql://showup@127.0.0.1:55433/showup_test";
  const { pool } = createDatabase();
  const id = randomUUID();
  const value = token();
  try {
    await migrate(pool);
    await pool.query("INSERT INTO app_accounts (id) VALUES ($1)", [id]);
    await pool.query(
      "INSERT INTO app_sessions (token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
      [hash(value), id],
    );
    await context.addCookies([
      {
        name: sessionCookie,
        value,
        domain: "localhost",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/account");
    await expect(page.getByRole("region", { name: "Account access" })).toContainText(id);
    await page.screenshot({ path: "test-results/account-fixture.png" });
    await page.reload();
    await expect(page.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
    const cookie = (await context.cookies()).find((item) => item.name === sessionCookie)!;
    expect(cookie.secure && cookie.httpOnly).toBe(true);
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeDisabled();
    expect(
      (await pool.query("SELECT revoked_at FROM app_sessions WHERE token_hash=$1", [hash(value)]))
        .rows[0].revoked_at,
    ).not.toBeNull();
  } finally {
    await pool.query("DELETE FROM app_audit WHERE actor_id=$1", [id]);
    await pool.query("DELETE FROM app_sessions WHERE account_id=$1", [id]);
    await pool.query("DELETE FROM app_accounts WHERE id=$1", [id]);
    await pool.end();
  }
});
