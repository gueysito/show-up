import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { accountFixtures } from "../fixtures/accounts";
import { verifyNearWallet } from "../fixtures/near-wallet";
import { validDraft } from "../fixtures/draft";
import { mainnetJournal, mainnetUsdc, ownerMainnetCalls } from "../fixtures/v1-mainnet";
import {
  sourceMainnetBalances,
  sourceMainnetApproval,
  type SourceNetwork,
} from "../fixtures/v1-source-mainnet";
import {
  loadV1EvmSource,
  loadV1SolanaSource,
  v1EvmSource,
  v1SolanaSource,
} from "../../scripts/lib/v1-source-keys";
import { loadV1MainnetKey } from "../../scripts/lib/v1-mainnet-key";
import { v1IntentsGateway } from "../../scripts/lib/v1-intents-gateway";
import {
  v1PublicationGateway,
  v1RegistrationGateway,
  v1FinalTransaction,
} from "../../scripts/v1-publication-worker";
import { runV1Publication } from "../../src/worker/v1-publication";
import { runV1Registration } from "../../src/worker/v1-registration";
import {
  runV1IntentsQueue,
  enqueueV1IntentsWithdrawal,
  type V1IntentsGateway,
  type V1IntentsWithdrawal,
} from "../../src/worker/v1-intents";
import { hash } from "../../src/server/auth/crypto";
import { authConfig } from "../../src/server/auth/config";
import { issueWalletChallenge, acceptWalletProof } from "../../src/server/wallets/service";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import type { V1RegistrationImage } from "../../src/server/commitments/v1-registration";
import { readV1Snapshot, readV1Record, v1Deployment } from "../../src/server/protocol/v1-escrow";
import { readV1IntentsBalance, v1RouteAccount } from "../../src/server/protocol/v1-intents";
import { canonicalJson } from "../../src/server/protocol/canonical";

test.use({ baseURL: "https://localhost:3444", ignoreHTTPSErrors: true });
test.setTimeout(30 * 60000);
test("a source wallet routes one real USDC through its isolated Intents account, confirms escrow in the app and receives its cancellation refund", async ({
  page,
  context,
}) => {
  const network = process.env.SHOWUP_MAINNET_SOURCE as SourceNetwork;
  if (
    process.env.SHOWUP_MAINNET_ROUTING !== "1" ||
    !["base", "solana", "ethereum"].includes(network)
  )
    throw new Error("Choose one explicitly approved mainnet routing source");
  const attempt = process.env.SHOWUP_MAINNET_ROUTE_ATTEMPT;
  if (attempt && !["second", "third"].includes(attempt))
    throw new Error("Invalid bounded routing attempt");
  const journal = await mainnetJournal(`routed-${network}${attempt ? `-${attempt}` : ""}`),
    f = await accountFixtures([["host"], []]),
    key = process.env.SHOWUP_E2E_ENCRYPTION_KEY!,
    config = authConfig({
      SHOWUP_AUTH: "1",
      SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
      SHOWUP_IDENTITY_KEY: key,
      SHOWUP_IDENTITY_INDEX_KEY: process.env.SHOWUP_E2E_INDEX_KEY,
    })!,
    session = hash(f.accounts[1].value),
    host = hash(f.accounts[0].value),
    eventId = randomUUID(),
    native = v1PublicationGateway();
  let registrationId: string | undefined,
    sourceHash: string | undefined,
    refunded = false,
    sourceAttempted = false;
  const initialSource = await sourceMainnetBalances(network),
    initialSnapshot = await readV1Snapshot(eventId),
    initialUsdc = await mainnetUsdc(initialSnapshot.block.hash);
  expect(initialUsdc[1]).toBe("0");
  await journal.save({ eventId, network, initialSource, initialUsdc });
  async function checkedStep(run: () => Promise<{ state: string }>, state: string) {
    for (let n = 0; n < 12; n++) {
      try {
        const result = await run();
        if (result.state === state) return;
        if (result.state === "failed") throw new Error("Known native transaction failure");
      } catch (error) {
        if (
          n === 11 ||
          !(
            error instanceof Error &&
            /429|cooldown|not final yet|RPC.*(?:timeout|unavailable)|fetch failed/i.test(
              error.message,
            )
          )
        )
          throw error;
      }
      await pause(5000);
    }
    throw new Error("Original native transaction still needs reconciliation");
  }
  function tracked(
    gateway: V1IntentsGateway<V1RegistrationImage | V1IntentsWithdrawal>,
    name: string,
  ): typeof gateway {
    return {
      ...gateway,
      submit: (image) => journal.send(name, image),
      async final(image, input) {
        const final = await gateway.final(image, input);
        journal.finals[name] = final;
        await journal.save({ phase: `${name}_final` });
        return final;
      },
      observe: async (image, min) => {
        const result = await gateway.observe(image, min);
        expect(result.confirmed).toBe(true);
        expect(BigInt(result.height) >= BigInt(min)).toBe(true);
        return result;
      },
    };
  }
  async function refund() {
    if (!registrationId) throw new Error("Original registration missing");
    if (!journal.images.refund)
      await journal.send(
        "refund",
        await ownerMainnetCalls(eventId, [
          {
            kind: "call",
            method: "cancel",
            args: Buffer.from(canonicalJson({ event: eventId })),
            gas: "30000000000000",
            deposit: "0",
          },
          {
            kind: "call",
            method: "withdraw",
            args: Buffer.from(canonicalJson({ claim: registrationId })),
            gas: "100000000000000",
            deposit: "0",
          },
        ]),
      );
    await journal.final("refund", journal.images.refund);
    const snapshot = await readV1Snapshot(eventId),
      claim = await readV1Record("get_claim", registrationId, snapshot.block),
      amounts = await mainnetUsdc(snapshot.block.hash);
    expect(claim?.paid).toBe("1000000");
    expect(claim?.recipient).toBe(v1Deployment.owner);
    expect(claim?.remaining).toBe("0");
    expect(amounts).toEqual([(BigInt(initialUsdc[0]) + 1000000n).toString(), "0"]);
    expect(await readV1IntentsBalance(registrationId, snapshot)).toBe("0");
    refunded = true;
    await journal.save({
      phase: "refunded",
      finalUsdc: amounts,
      finalHeight: snapshot.block.height,
      claim,
      sourceHash,
      finalSource: await sourceMainnetBalances(network),
    });
  }
  try {
    // No unrelated native queue may be processed with this disposable fixture key.
    const queued = (
      await f.pool.query(
        "SELECT (SELECT count(*) FROM app_publication_images WHERE transaction_state IN ('requested','prepared','submitted'))+(SELECT count(*) FROM app_v1_registrations WHERE state IN ('requested','prepared','submitted'))+(SELECT count(*) FROM app_v1_event_actions WHERE state IN ('requested','prepared','submitted'))+(SELECT count(*) FROM app_v1_route_accounts WHERE state IN ('requested','prepared','submitted'))+(SELECT count(*) FROM app_v1_route_withdrawals WHERE state IN ('requested','prepared','submitted')) AS count",
      )
    ).rows[0].count;
    expect(String(queued)).toBe("0");
    const near = await loadV1MainnetKey();
    await verifyNearWallet(f.pool, config, session, { address: v1Deployment.owner, ...near });
    const challenge = await issueWalletChallenge(f.pool, config, session, {
        operationId: randomUUID(),
        network,
        address: network === "solana" ? v1SolanaSource : v1EvmSource,
      }),
      signature =
        network === "solana"
          ? Buffer.from(
              await (await loadV1SolanaSource()).signBytes(Buffer.from(challenge.message)),
            ).toString("base64")
          : await (await loadV1EvmSource()).signMessage(challenge.message),
      source = await acceptWalletProof(f.pool, config, session, {
        operationId: randomUUID(),
        challengeId: challenge.id,
        proof: { signature },
      });
    await saveAccountDraft(
      f.pool,
      key,
      host,
      {
        id: eventId,
        revision: 0,
        operationId: randomUUID(),
        data: {
          ...validDraft(),
          title: `Community ${network} deposit check`,
          startsAt: new Date(Date.now() + 3 * 3600000).toISOString(),
          endsAt: new Date(Date.now() + 3.5 * 3600000).toISOString(),
          capacity: 2,
          commitment: "1",
          sponsorBudget: "0",
          access: "open",
        },
      },
      "v1",
    );
    await prepareV1Publication(f.pool, key, host, randomUUID(), eventId, 1);
    await checkedStep(
      () =>
        runV1Publication(f.pool, key, {
          ...native,
          submit: (image) => journal.send("publication", image),
          async final(image) {
            const result = await native.final(image);
            journal.finals.publication = result;
            await journal.save({ phase: "publication_final" });
            return result;
          },
        }),
      "verified",
    );
    await f.enter(context, 1);
    await page.goto(`/events/${eventId}/commit`);
    const panel = page.getByRole("region", { name: "NEAR USDC deposit" });
    await panel.getByLabel("Deposit Wallet").selectOption(source.id);
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Prepare my deposit" }).click();
    await expect(panel.getByRole("status")).toContainText("Registration queued");
    registrationId = (
      await f.pool.query(
        "SELECT id FROM app_v1_registrations WHERE event_id=$1 AND account_id=$2",
        [eventId, f.accounts[1].id],
      )
    ).rows[0].id;
    await journal.save({ registrationId, routeAccount: v1RouteAccount(registrationId!) });
    const account = v1IntentsGateway("route_account", {
      submit: native.submit,
      final: v1FinalTransaction,
    });
    await checkedStep(
      () => runV1IntentsQueue(f.pool, key, "route_account", tracked(account, "route_account")),
      "verified",
    );
    const registration = v1RegistrationGateway();
    await checkedStep(
      () =>
        runV1Registration(f.pool, key, {
          ...registration,
          submit: (image) => journal.send("registration", image),
          async final(image) {
            const result = await registration.final(image);
            journal.finals.registration = result;
            await journal.save({ phase: "registration_final" });
            return result;
          },
        }),
      "registered",
    );
    await panel.getByRole("button", { name: "Check deposit status" }).click();
    await panel.getByRole("button", { name: "Get routing quote" }).click();
    const review = panel.getByRole("region", { name: "Cross-chain quote review" });
    await expect(review.getByText("Deposit in NEAR escrow", { exact: true })).toBeVisible();
    await expect(review.getByText("Approve before", { exact: true })).toBeVisible();
    await expect(
      review.getByText("Provider deadline for unresolved routing", { exact: true }),
    ).toBeVisible();
    if (network === "solana") {
      await page.exposeFunction("showupIsolatedSolanaSend", async (wire: number[]) => {
        sourceAttempted = true;
        sourceHash = await sourceMainnetApproval({
          pool: f.pool,
          config,
          session,
          eventId,
          network,
          journal,
          wire,
        });
        const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        let value = 0n;
        for (const c of sourceHash) value = value * 58n + BigInt(alphabet.indexOf(c));
        const bytes: number[] = [];
        while (value) {
          bytes.unshift(Number(value & 255n));
          value >>= 8n;
        }
        while (bytes.length < 64) bytes.unshift(0);
        return bytes;
      });
      await page.evaluate(
        ({ address, publicKey }) => {
          const account = {
              address,
              publicKey: Uint8Array.from(publicKey),
              chains: ["solana:mainnet"],
              features: ["solana:signAndSendTransaction"],
            },
            wallet = {
              version: "1.0.0",
              name: "Project wallet (isolated Node)",
              icon: "data:image/svg+xml;base64,PHN2Zy8+",
              chains: ["solana:mainnet"],
              accounts: [account],
              features: {
                "standard:connect": {
                  version: "1.0.0",
                  connect: async () => ({ accounts: [account] }),
                },
                "solana:signAndSendTransaction": {
                  version: "1.0.0",
                  supportedTransactionVersions: ["legacy"],
                  signAndSendTransaction: async ({ transaction }: { transaction: Uint8Array }) => [
                    {
                      signature: Uint8Array.from(
                        await (
                          window as Window & {
                            showupIsolatedSolanaSend?: (wire: number[]) => Promise<number[]>;
                          }
                        ).showupIsolatedSolanaSend!(Array.from(transaction)),
                      ),
                    },
                  ],
                },
              },
            };
          const register = (api: { register: (wallet: unknown) => unknown }) =>
            api.register(wallet);
          window.addEventListener("wallet-standard:app-ready", (event) =>
            register((event as CustomEvent).detail),
          );
          window.dispatchEvent(
            new CustomEvent("wallet-standard:register-wallet", { detail: register }),
          );
        },
        {
          address: v1SolanaSource,
          publicKey: [...(await loadV1SolanaSource()).publicKey.toBytes()],
        },
      );
    } else {
      await page.exposeFunction("showupIsolatedEvmSend", async (wire: unknown) => {
        sourceAttempted = true;
        sourceHash = await sourceMainnetApproval({
          pool: f.pool,
          config,
          session,
          eventId,
          network,
          journal,
          wire,
        });
        return sourceHash;
      });
      await page.evaluate(
        ({ address, chain }) => {
          (window as Window & { ethereum?: unknown }).ethereum = {
            isRabby: true,
            async request(input: { method: string; params?: unknown[] }) {
              if (input.method === "wallet_switchEthereumChain") return null;
              if (input.method === "eth_chainId") return chain;
              if (input.method === "eth_requestAccounts") return [address];
              if (input.method === "eth_sendTransaction")
                return (
                  window as Window & { showupIsolatedEvmSend?: (wire: unknown) => Promise<string> }
                ).showupIsolatedEvmSend!(input.params![0]);
              throw new Error("Unexpected isolated wallet operation");
            },
          };
        },
        { address: v1EvmSource, chain: network === "base" ? "0x2105" : "0x1" },
      );
    }
    await review.getByRole("checkbox").check();
    await review
      .getByRole("button", {
        name: network === "solana" ? "Approve source USDC payment" : "Approve with Rabby",
      })
      .click();
    await expect.poll(() => sourceHash, { timeout: 45000 }).toBeTruthy();
    await journal.save({ phase: "routing", sourceHash });
    const forward = v1IntentsGateway("route_withdrawal", {
      submit: native.submit,
      final: v1FinalTransaction,
    });
    for (let attempt = 0; attempt < 60; attempt++) {
      await enqueueV1IntentsWithdrawal(f.pool, key);
      await runV1IntentsQueue(f.pool, key, "route_withdrawal", tracked(forward, "forward"));
      const snapshot = await readV1Snapshot(eventId),
        reg = await readV1Record("get_registration", registrationId!, snapshot.block);
      if (reg?.funded === true) {
        await journal.save({
          phase: "escrow_funded",
          registration: reg,
          height: snapshot.block.height,
        });
        break;
      }
      if (attempt === 59)
        throw new Error(
          "Original source route remains pending; retain its image and receiving account",
        );
      await pause(10000);
    }
    await page.goto(`/events/${eventId}/commit`);
    await expect(
      page.getByRole("heading", { name: "Deposit confirmed", exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `${journal.directory}/routed-${network}-mobile.png` });
    await journal.save({ phase: "browser_verified" });
    await refund();
  } finally {
    if (!refunded && registrationId) {
      try {
        const snapshot = await readV1Snapshot(eventId),
          reg = await readV1Record("get_registration", registrationId, snapshot.block);
        if (reg?.funded === true) await refund();
      } catch {
        await journal.save({ phase: "needs_original_hash_reconciliation" });
      }
    }
    if (
      !sourceAttempted &&
      journal.images.publication &&
      Object.keys(journal.images).every((name) => Object.hasOwn(journal.finals, name))
    ) {
      const snapshot = await readV1Snapshot(eventId);
      if (snapshot.event?.status === "published")
        await journal.submit(
          "cancel_unfunded",
          await ownerMainnetCalls(eventId, [
            {
              kind: "call",
              method: "cancel",
              args: Buffer.from(canonicalJson({ event: eventId })),
              gas: "30000000000000",
              deposit: "0",
            },
          ]),
        );
    }
    if (
      refunded ||
      (!sourceAttempted &&
        Object.keys(journal.images).every((name) => Object.hasOwn(journal.finals, name)))
    )
      await f.cleanup();
    else {
      await journal.save({ phase: "needs_original_hash_reconciliation" });
      await f.pool.end();
    }
  }
});
