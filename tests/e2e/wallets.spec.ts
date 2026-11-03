import { expect, test, type Page } from "@playwright/test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Wallet } from "ethers";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { accountFixtures } from "../fixtures/accounts";

test.use({
  baseURL: "https://localhost:3444",
  ignoreHTTPSErrors: true,
  timezoneId: "Pacific/Auckland",
});

async function disposableWallets(page: Page) {
  const ethereum = Wallet.createRandom(),
    solana = generateKeyPairSync("ed25519");
  const solanaAddress = encodeBase58(
    Buffer.from(solana.publicKey.export({ format: "jwk" }).x!, "base64url"),
  );
  let chain = "0x2105",
    signatures = 0;
  await page.exposeFunction(
    "showupFixtureEthereum",
    async (input: { method: string; params?: string[] }) => {
      if (input.method === "eth_requestAccounts") return [ethereum.address];
      if (input.method === "eth_chainId") return chain;
      if (input.method === "personal_sign") {
        signatures++;
        expect(input.params?.[1]).toBe(ethereum.address);
        return ethereum.signMessage(Buffer.from(input.params![0].slice(2), "hex"));
      }
      throw new Error("Fixture permits only account selection and personal message signing");
    },
  );
  await page.exposeFunction("showupFixtureSolana", async (message: number[]) => {
    signatures++;
    return Array.from(sign(null, Buffer.from(message), solana.privateKey));
  });
  await page.addInitScript(
    ({ solanaAddress }) => {
      const target = window as unknown as {
        ethereum: { request(input: { method: string; params?: string[] }): Promise<unknown> };
        phantom: {
          solana: {
            connect(): Promise<unknown>;
            signMessage(message: Uint8Array): Promise<unknown>;
          };
        };
        showupFixtureEthereum(input: { method: string; params?: string[] }): Promise<unknown>;
        showupFixtureSolana(message: number[]): Promise<number[]>;
      };
      target.ethereum = { request: (input) => target.showupFixtureEthereum(input) };
      target.phantom = {
        solana: {
          connect: async () => ({ publicKey: { toString: () => solanaAddress } }),
          signMessage: async (message) => ({
            signature: new Uint8Array(await target.showupFixtureSolana(Array.from(message))),
          }),
        },
      };
    },
    { solanaAddress },
  );
  return {
    ethereumAddress: ethereum.address.toLowerCase(),
    solanaAddress,
    setChain(value: string) {
      chain = value;
    },
    signatures: () => signatures,
  };
}

test("preauthenticated disposable wallets: control verification, refresh and mobile isolation through actual UI", async ({
  page,
  context,
  browser,
}) => {
  const fixtures = await accountFixtures([[], []]);
  const wallet = await disposableWallets(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await fixtures.enter(context, 0);
    await page.goto("/account");
    await page.getByRole("link", { name: "Verify and review your wallets" }).click();
    for (const network of ["base", "ethereum", "solana"]) {
      wallet.setChain(network === "ethereum" ? "0x1" : "0x2105");
      await page.getByLabel("Wallet network").selectOption(network);
      await page.getByRole("button", { name: "Connect and verify wallet" }).click();
      await expect(page.getByRole("status")).toContainText("Wallet control verified and saved");
    }
    expect(wallet.signatures()).toBe(3);
    await page.reload();
    await expect(
      page.getByRole("list").getByText(wallet.ethereumAddress, { exact: true }),
    ).toHaveCount(2);
    await expect(
      page.getByRole("list").getByText(wallet.solanaAddress, { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByLabel("Wallet network").selectOption("solana");
    await page.getByLabel("Wallet network").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Connect and verify wallet" })).toBeFocused();
    await page.screenshot({ path: "test-results/wallet-control-mobile.png", fullPage: true });
    const otherContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await fixtures.enter(otherContext, 1);
      const other = await otherContext.newPage();
      await other.goto("https://localhost:3444/account/wallets");
      await expect(
        other.getByText("No wallet control has been verified for this account."),
      ).toBeVisible();
      const response = await other.request.get(
        `https://localhost:3444/api/wallets?accountId=${fixtures.accounts[0].id}`,
      );
      expect((await response.json()).wallets).toEqual([]);
      expect(
        (
          await other.request.post("https://localhost:3444/api/wallets", {
            headers: { origin: "https://evil.example" },
            data: {},
          })
        ).status(),
      ).toBe(403);
    } finally {
      await otherContext.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await fixtures.cleanup();
  }
});

test("lost verification acknowledgement retries the original proof without requesting another signature", async ({
  page,
  context,
}) => {
  const fixtures = await accountFixtures([[]]);
  const wallet = await disposableWallets(page);
  let drop = true;
  await page.route("**/api/wallets", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.postDataJSON()?.operation === "verify" && drop) {
      drop = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  });
  try {
    await fixtures.enter(context, 0);
    await page.goto("/account/wallets");
    await page.getByRole("button", { name: "Connect and verify wallet" }).click();
    await expect(
      page.getByRole("region", { name: "Wallet control" }).getByRole("alert"),
    ).toContainText("Wallet verification was not completed");
    await page.getByRole("button", { name: "Retry saving this proof" }).click();
    await expect(page.getByRole("status")).toContainText("Wallet control verified and saved");
    expect(wallet.signatures()).toBe(1);
    expect(
      (
        await fixtures.pool.query(
          "SELECT count(*)::int AS n FROM app_wallets WHERE account_id=$1",
          [fixtures.accounts[0].id],
        )
      ).rows[0].n,
    ).toBe(1);
    await page.reload();
    await expect(
      page.getByRole("list").getByText(wallet.ethereumAddress, { exact: true }),
    ).toBeVisible();
  } finally {
    await fixtures.cleanup();
  }
});

test("NEAR return parameters are cleared and mismatched proofs cannot succeed; outbound wallet URL is inspected without contacting the wallet", async ({
  page,
  context,
}) => {
  const fixtures = await accountFixtures([[]]);
  try {
    await fixtures.enter(context, 0);
    const id = randomUUID(),
      eventId = randomUUID();
    await page.goto(
      `/account/wallets?challenge=${id}&event=${eventId}#state=wrong&accountId=fictional-wallet.near&publicKey=invalid&signature=invalid`,
    );
    await expect(page).toHaveURL(`https://localhost:3444/account/wallets?event=${eventId}`);
    await expect(
      page.getByRole("link", { name: "Return to this event's commitment review" }),
    ).toHaveAttribute("href", `/events/${eventId}/commit`);
    await page.getByRole("button", { name: "Finish NEAR wallet verification" }).click();
    await expect(
      page.getByRole("region", { name: "Wallet control" }).getByRole("alert"),
    ).toContainText("complete matching proof");
    await page.getByRole("button", { name: "Start a new wallet challenge" }).click();
    await page.getByLabel("NEAR account").fill("fictional-wallet.near");
    await page.route("https://app.mynearwallet.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<h1>Test intercept: external wallet was not contacted</h1>",
      }),
    );
    const target = page.waitForRequest((request) =>
      request.url().startsWith("https://app.mynearwallet.com/"),
    );
    await page.getByRole("button", { name: "Verify with MyNearWallet" }).click();
    const request = await target,
      url = new URL(request.url());
    expect(url.pathname).toBe("/sign-message");
    expect(url.searchParams.get("recipient")).toBe("localhost:3444");
    expect(Buffer.from(url.searchParams.get("nonce")!, "base64").length).toBe(32);
    expect(new URL(url.searchParams.get("callbackUrl")!).origin).toBe("https://localhost:3444");
    expect(new URL(url.searchParams.get("callbackUrl")!).searchParams.get("event")).toBe(eventId);
    expect(url.searchParams.get("message")).toContain(
      "No transfer or spending approval is authorized.",
    );
    expect(
      (
        await fixtures.pool.query(
          "SELECT count(*)::int AS n FROM app_wallets WHERE account_id=$1",
          [fixtures.accounts[0].id],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await fixtures.cleanup();
  }
});
