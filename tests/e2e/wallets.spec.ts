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

test("Solana verification uses Wallet Standard and rejects an altered message", async ({
  page,
  context,
}) => {
  const fixtures = await accountFixtures([[]]);
  const key = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url");
  const address = encodeBase58(publicKey);
  let signatures = 0;
  await page.exposeFunction("signSolanaChallenge", (message: number[]) => {
    const signedMessage = Buffer.from(message);
    if (++signatures === 1) signedMessage[0] ^= 1;
    return {
      signedMessage: [...signedMessage],
      signature: [...sign(null, signedMessage, key.privateKey)],
    };
  });
  await page.addInitScript(
    ({ address, publicKey }) => {
      const target = window as typeof window & {
        phantom?: unknown;
        signSolanaChallenge(
          message: number[],
        ): Promise<{ signedMessage: number[]; signature: number[] }>;
      };
      target.phantom = {
        solana: {
          connect: async () => ({ publicKey: { toString: () => address } }),
          signMessage: async () => {
            throw new Error("Legacy wallet did not return the approved signature");
          },
        },
      };
      const account = {
        address,
        publicKey: Uint8Array.from(publicKey),
        chains: ["solana:mainnet"],
        features: ["solana:signMessage"],
      };
      window.addEventListener("wallet-standard:app-ready", (event) => {
        const { register } = (event as CustomEvent<{ register(wallet: unknown): void }>).detail;
        register({
          name: "Fixture Solana Wallet",
          version: "1.0.0",
          chains: ["solana:mainnet"],
          accounts: [],
          features: {
            "standard:connect": { connect: async () => ({ accounts: [account] }) },
            "solana:signMessage": {
              signMessage: async (input: { account: typeof account; message: Uint8Array }) => {
                if (input.account !== account) throw new Error("Wrong wallet account");
                const result = await target.signSolanaChallenge([...input.message]);
                return [
                  {
                    signedMessage: Uint8Array.from(result.signedMessage),
                    signature: Uint8Array.from(result.signature),
                  },
                ];
              },
            },
          },
        });
      });
    },
    { address, publicKey: [...publicKey] },
  );

  try {
    await fixtures.enter(context, 0);
    await page.goto("/account/wallets");
    await page.getByLabel("Wallet network").selectOption("solana");
    const verify = page.getByRole("button", { name: "Connect and verify wallet" });
    await verify.click();
    await expect(
      page.getByRole("region", { name: "Wallet control" }).getByRole("alert"),
    ).toContainText("did not return a usable signature");
    await expect(
      page.getByText("No wallet control has been verified for this account."),
    ).toBeVisible();
    await verify.click();
    await expect(page.getByRole("status")).toContainText("Wallet control verified and saved");
    expect(signatures).toBe(2);
    await page.reload();
    await expect(page.getByRole("list").getByText(address, { exact: true })).toBeVisible();
  } finally {
    await fixtures.cleanup();
  }
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
    ).toContainText("Showup could not confirm that your proof was saved");
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

test("NEAR Mobile handoff sends a message only and rejects a response for another account", async ({
  page,
  context,
}) => {
  const fixtures = await accountFixtures([[]]);
  try {
    await fixtures.enter(context, 0);
    const id = randomUUID(),
      eventId = randomUUID(),
      relayId = randomUUID(),
      relay = "https://near-mobile-production.aws.peersyst.tech";
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
    const relayRequest = {
      id: relayId,
      method: "signMessage",
      network: "mainnet",
      origin: "https://localhost:3444",
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    };
    await page.route(`${relay}/connector/request`, async (route) => {
      const { method, network, origin, payload } = route.request().postDataJSON();
      expect({ method, network, origin }).toEqual({
        method: "signMessage",
        network: "mainnet",
        origin: "https://localhost:3444",
      });
      expect(Object.keys(payload).sort()).toEqual(["message", "nonce", "recipient", "signerId"]);
      expect(payload.recipient).toBe("localhost:3444");
      expect(payload.nonce).toHaveLength(32);
      expect(payload.signerId).toBe("fictional-wallet.near");
      expect(payload.message).toContain("No transfer or spending approval is authorized.");
      await route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: { ...relayRequest, payload, status: "pending" },
      });
    });
    await page.route(`${relay}/connector/request/${relayId}`, (route) =>
      route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: { ...relayRequest, status: "approved", response: { accountId: "different.near" } },
      }),
    );
    await page.getByRole("button", { name: "Prepare NEAR Mobile verification" }).click();
    const launch = page.getByRole("link", { name: "Open NEAR Mobile" });
    await expect(launch).toBeVisible();
    const url = new URL((await launch.getAttribute("href"))!);
    expect(url.origin).toBe(relay);
    expect(url.pathname).toBe("/api/deep-link");
    expect(url.searchParams.get("path")).toBe("connector-request");
    expect(url.searchParams.get("params")).toBe(`id=${relayId}`);
    await page.getByRole("button", { name: "Check NEAR Mobile approval" }).click();
    await expect(
      page.getByRole("region", { name: "Wallet control" }).getByRole("alert"),
    ).toContainText("Could not read the NEAR Mobile approval");
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

test("Meteor uses the pinned wallet executor for a message without requesting a key", async ({
  page,
  context,
}) => {
  const fixtures = await accountFixtures([[]]);
  const executor =
    "https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/ef1be35fc3712f2de60a7563aed543d78e73f763/storage/meteor-near-connect-latest.js";
  try {
    await fixtures.enter(context, 0);
    await page.route(`${executor}*`, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        headers: { "access-control-allow-origin": "*" },
        body: `window.selector.ready({ async signInAndSignMessage(input) {
        if (input.network !== "mainnet" || input.addFunctionCallKey !== undefined ||
            input.messageParams.nonce.length !== 32 ||
            input.messageParams.recipient !== "localhost:3444" ||
            !input.messageParams.message.includes("No transfer or spending approval is authorized."))
          throw new Error("Invalid fixture request");
        window.selector.ui.showIframe();
        const opened = await window.selector.open("meteorwallet://fixture/approval").windowIdPromise;
        if (opened !== null) throw new Error("Unexpected browser window");
        window.parent.postMessage({ type: "fixture-meteor-message-reviewed" }, "*");
        return [{ accountId: "other.near" }];
      } });`,
      }),
    );
    await page.addInitScript(() =>
      window.addEventListener("message", (event) => {
        if (event.data?.type === "fixture-meteor-message-reviewed")
          document.documentElement.dataset.meteorReviewed = "true";
      }),
    );
    await page.goto("/account/wallets");
    await page.getByLabel("Wallet network").selectOption("near");
    await page.getByLabel("NEAR wallet app").selectOption("meteor");
    await page.getByLabel("NEAR account").fill("fictional-wallet.near");
    await page.getByRole("button", { name: "Verify with Meteor Wallet" }).click();
    const open = page.getByRole("link", { name: "Open Meteor Wallet" });
    await expect(open).toHaveAttribute("href", "meteorwallet://fixture/approval");
    expect(await open.getAttribute("target")).toBeNull();
    await open.evaluate((link) =>
      link.addEventListener("click", (event) => event.preventDefault()),
    );
    await open.click();
    expect(context.pages()).toHaveLength(1);
    await expect(page.locator("html")).toHaveAttribute("data-meteor-reviewed", "true");
    await expect(
      page.getByRole("region", { name: "Wallet control" }).getByRole("alert"),
    ).toContainText("Meteor did not return a signature for this NEAR account");
    await expect(
      page.getByText("No wallet control has been verified for this account."),
    ).toBeVisible();
  } finally {
    await fixtures.cleanup();
  }
});
