import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";
import { v1NftFixture } from "../fixtures/v1-nft";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import { runV1Publication } from "../../src/worker/v1-publication";
import { canonicalHash } from "../../src/server/protocol/canonical";
import type { V1Snapshot } from "../../src/server/protocol/v1-escrow";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test("synthetic NFT wallet approval fixes the asset and custody; a reload cannot prompt a second transfer", async ({
  page,
  context,
}) => {
  const f = await accountFixtures([["host"]]),
    n = v1NftFixture(),
    id = randomUUID(),
    key = process.env.SHOWUP_E2E_ENCRYPTION_KEY!,
    session = hash(f.accounts[0].value),
    block = "11111111111111111111111111111111";
  try {
    await saveAccountDraft(
      f.pool,
      key,
      session,
      {
        id,
        revision: 0,
        operationId: randomUUID(),
        data: {
          ...validDraft(),
          title: "Local NFT custody controls",
          capacity: 2,
          commitment: "1",
          sponsorBudget: "0",
          nft: n.draft,
        },
      },
      "v1",
    );
    await prepareV1Publication(f.pool, key, session, randomUUID(), id, 1, undefined, n.transport);
    let snapshot!: V1Snapshot;
    await runV1Publication(f.pool, key, {
      async prepare(image, phase) {
        snapshot = {
          block: { height: "100", hash: block, timestampMs: Date.now() },
          event: { ...image.terms, nft: n.live, status: "draft", prize_received: true },
        };
        return {
          hash: block,
          signedBase64: "synthetic-not-broadcast",
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
    });
    const view = {
        collection: n.nft.collection,
        tokenId: n.nft.token_id,
        contributor: n.contributor,
        custody: n.custody,
        owner: n.contributor,
        held: false,
        status: "draft",
        signatureState: null,
        delivery: null,
        transactionUrl: null,
        payments: [],
        progress: { confirmations: 0, gasConfirmations: 0, gasShortfall: "1000000000000" },
      },
      data = `0x42842e0e${n.contributor.slice(2).padStart(64, "0")}${n.custody.slice(2).padStart(64, "0")}${BigInt(n.nft.token_id).toString(16).padStart(64, "0")}`;
    let approvals = 0;
    await page.route("**/api/events/nft**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") return route.fulfill({ json: view });
      const body = request.postDataJSON();
      expect(body.eventId).toBe(id);
      if (body.operation === "prepare_nft") {
        approvals++;
        return route.fulfill({
          json: {
            transaction: {
              from: n.contributor,
              to: n.nft.collection,
              value: "0x0",
              chainId: "0x1",
              nonce: "0x0",
              gas: "0x186a0",
              maxFeePerGas: "0x989680",
              maxPriorityFeePerGas: "0xf4240",
              type: "0x2",
              data,
            },
            maximumGasWei: "1000000000000",
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        });
      }
      expect(body.operation).toBe("source_nft");
      expect(body.sourceHash).toBe("0x" + "17".repeat(32));
      return route.fulfill({ json: { recorded: true } });
    });
    await page.addInitScript(
      ({ contributor }) => {
        const state = window as Window & {
          ethereum?: unknown;
          showupSyntheticNftCalls?: unknown[];
        };
        state.showupSyntheticNftCalls = [];
        state.ethereum = {
          async request(input: { method: string; params?: unknown[] }) {
            if (input.method === "eth_chainId") return "0x1";
            if (input.method === "eth_requestAccounts") return [contributor];
            if (input.method === "wallet_switchEthereumChain") return null;
            if (input.method === "eth_sendTransaction") {
              state.showupSyntheticNftCalls!.push(input.params![0]);
              return "0x" + "17".repeat(32);
            }
            throw new Error("Unexpected synthetic wallet method");
          },
        };
      },
      { contributor: n.contributor },
    );
    await f.enter(context, 0);
    await page.goto(`/host?event=${id}`);
    const panel = page.getByRole("region", { name: "Ethereum NFT prize" });
    await panel.getByRole("button", { name: "Check NFT custody and delivery" }).click();
    await expect(panel).toContainText("Token #2829");
    await expect(
      panel.getByRole("button", { name: "Transfer this NFT into custody" }),
    ).toBeDisabled();
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Transfer this NFT into custody" }).click();
    await expect(panel.getByText(/Original transaction saved/)).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as Window & { showupSyntheticNftCalls?: unknown[] }).showupSyntheticNftCalls,
      ),
    ).toEqual([
      expect.objectContaining({ from: n.contributor, to: n.nft.collection, value: "0x0", data }),
    ]);
    await page.reload();
    await page.getByRole("button", { name: /Local NFT custody controls Publishing/ }).click();
    await panel.getByRole("button", { name: "Check NFT custody and delivery" }).click();
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Transfer this NFT into custody" }).click();
    await expect(panel.getByText(/wallet request already exists/)).toBeVisible();
    expect(approvals).toBe(1);
    view.progress = { confirmations: 1, gasConfirmations: 0, gasShortfall: "1000000000000" };
    await panel.getByRole("button", { name: "Check NFT custody and delivery" }).click();
    await expect(panel.getByText("NFT arrived in custody")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Fund the custody gas allowance" }),
    ).toBeVisible();
    view.progress = { confirmations: 2, gasConfirmations: 2, gasShortfall: "0" };
    await panel.getByRole("button", { name: "Check NFT custody and delivery" }).click();
    await expect(panel.getByText("Ready to confirm and publish")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Fund the custody gas allowance" })).toHaveCount(
      0,
    );
    await expect(panel.getByRole("checkbox")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await panel.screenshot({ path: "/private/tmp/showup-v1-nft-mobile.png" });
  } finally {
    await f.cleanup();
  }
});
