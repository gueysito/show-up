import { expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { accountFixtures } from "../fixtures/accounts";
import { verifyNearWallet } from "../fixtures/near-wallet";
import { validDraft } from "../fixtures/draft";
import { nativeKey } from "../../scripts/lib/native-engineering-transaction";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import { runV1Publication, type V1PublicationGateway } from "../../src/worker/v1-publication";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { v1Deployment, type V1Snapshot } from "../../src/server/protocol/v1-escrow";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test("local prize UI returns to its owned frozen event, ignores callback hashes and scopes confirmation status", async ({
  page,
  context,
}) => {
  const f = await accountFixtures([["host"]]);
  const key = process.env.SHOWUP_E2E_ENCRYPTION_KEY!,
    session = hash(f.accounts[0].value),
    id = randomUUID();
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: key,
    SHOWUP_IDENTITY_INDEX_KEY: process.env.SHOWUP_E2E_INDEX_KEY,
  })!;
  const signer = nativeKey(randomBytes(32)),
    block = encodeBase58(Buffer.alloc(32, 7));
  const blockTime = Date.now() - 1000;
  const transport: typeof fetch = async (_url, options) => {
    const input = JSON.parse(String(options?.body));
    const result =
      input.method === "status"
        ? { chain_id: "mainnet" }
        : input.method === "block"
          ? {
              header: {
                height: 100,
                hash: block,
                timestamp_nanosec: (BigInt(blockTime) * 1000000n).toString(),
              },
            }
          : {
              block_hash: block,
              block_height: 100,
              keys: [{ public_key: signer.publicKey, access_key: { permission: "FullAccess" } }],
            };
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  try {
    const wallet = await verifyNearWallet(
      f.pool,
      config,
      session,
      { address: "fictional-host.near", ...signer },
      transport,
    );
    const data = {
      ...validDraft(),
      title: "Local prize UI",
      capacity: 2,
      commitment: "1",
      sponsorBudget: "1",
    };
    await saveAccountDraft(
      f.pool,
      key,
      session,
      { id, revision: 0, operationId: randomUUID(), data },
      "v1",
    );
    await prepareV1Publication(f.pool, key, session, randomUUID(), id, 1, wallet.id);
    let snapshot!: V1Snapshot;
    const gateway: V1PublicationGateway = {
      async prepare(image, phase) {
        snapshot = {
          block: { height: "100", hash: block, timestampMs: Date.now() },
          event: { ...image.terms, status: "draft", prize_received: false },
        };
        return {
          hash: block,
          signedBase64: "local-only-never-broadcast",
          semantic: canonicalHash(image.terms),
          validUntilMs: Date.now() + 120000,
          phase,
        };
      },
      async submit() {},
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
      },
      async snapshot() {
        return snapshot;
      },
    };
    expect((await runV1Publication(f.pool, key, gateway)).state).toBe("awaiting_prize");
    await f.enter(context, 0);
    await page.goto(`/host?event=${id}&transactionHashes=forged`);
    await expect(page.getByLabel("Event name", { exact: true })).toHaveValue(data.title);
    await expect(page).toHaveURL("https://localhost:3444/host");
    await page.getByRole("button", { name: "Check publication status" }).click();
    const actions = page.getByRole("region", { name: "Event publication and access" });
    await expect(actions.getByText(/Funding wallet: fictional-host.near/)).toBeVisible();
    expect(
      (
        await f.pool.query(
          "SELECT transaction_state FROM app_publication_images WHERE event_id=$1",
          [id],
        )
      ).rows[0].transaction_state,
    ).toBe("awaiting_prize");
    let confirmed = false;
    let prepared = 0;
    let relayCreates = 0;
    let relayStatus = "pending";
    const relay = "https://near-mobile-production.aws.peersyst.tech/connector/request";
    const relayId = randomUUID();
    const walletTransaction = {
      signerId: "fictional-host.near",
      receiverId: v1Deployment.token,
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "ft_transfer_call",
            gas: "100000000000000",
            deposit: "1",
            args: { receiver_id: v1Deployment.account, amount: "1000000", msg: `prize:${id}` },
          },
        },
      ],
    };
    const relayRequest = {
      id: relayId,
      network: "mainnet",
      method: "signAndSendTransaction",
      origin: config.origin,
      payload: walletTransaction,
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    };
    await page.route(relay, async (route) => {
      relayCreates++;
      expect(route.request().postDataJSON()).toEqual({
        method: "signAndSendTransaction",
        network: "mainnet",
        origin: config.origin,
        payload: walletTransaction,
      });
      await route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: { ...relayRequest, status: relayStatus },
      });
    });
    await page.route(`${relay}/${relayId}`, (route) =>
      route.fulfill({
        headers: { "access-control-allow-origin": "*" },
        json: { ...relayRequest, status: relayStatus },
      }),
    );
    await page.route("**/api/events", async (route) => {
      if (
        route.request().method() === "POST" &&
        route.request().postDataJSON().operation === "fund-prize"
      ) {
        prepared++;
        return route.fulfill({
          json: {
            origin: config.origin,
            signer: walletTransaction.signerId,
            token: walletTransaction.receiverId,
            walletTransaction,
          },
        });
      }
      if (
        route.request().method() !== "POST" ||
        route.request().postDataJSON().operation !== "confirm-prize"
      )
        return route.fallback();
      confirmed = true;
      expect(route.request().postDataJSON()).toMatchObject({ id, revision: 1 });
      // UI contract only. Real funding authorization and RPC disagreement are
      // exercised separately through the actual service/database tests.
      await route.fulfill({ json: { eventId: id, state: "requested" } });
    });
    const pay = actions.getByRole("button", { name: "Approve prize funding in your NEAR wallet" });
    await pay.click();
    await expect(actions.getByRole("link", { name: "Open NEAR Mobile to approve" })).toBeVisible();
    expect(confirmed).toBe(false);
    await page.goto(`/host?event=${id}`);
    await page.getByRole("button", { name: "Check publication status" }).click();
    await pay.click();
    await expect(
      actions.getByText("The original wallet request is still waiting for approval."),
    ).toBeVisible();
    expect([prepared, relayCreates]).toEqual([1, 1]);
    expect(confirmed).toBe(false);
    relayStatus = "approved";
    await actions.getByRole("button", { name: "Check original wallet approval" }).click();
    await expect(actions.getByRole("status")).toContainText("Prize receipt confirmed");
    expect(confirmed).toBe(true);
    await expect(
      actions.getByRole("button", { name: "Approve prize funding in your NEAR wallet" }),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await f.cleanup();
  }
});
