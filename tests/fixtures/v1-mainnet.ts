import { V1ReadOnlyRpc } from "../../src/server/protocol/v1-rpc";
import assert from "node:assert/strict";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { v1PublicationGateway, v1FinalTransaction } from "../../scripts/v1-publication-worker";
import { loadV1MainnetKey } from "../../scripts/lib/v1-mainnet-key";
import {
  v1DepositFundingTransaction,
  v1DemoAccounts,
  signV1MainnetTransaction,
  type NativeAction,
} from "../../scripts/lib/native-engineering-transaction";
import { readV1Snapshot, v1Deployment } from "../../src/server/protocol/v1-escrow";
import { unsigned } from "../../src/server/protocol/rpc";
import { record } from "../../src/server/protocol/quote-signature";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { canonicalJson } from "../../src/server/protocol/canonical";
import type { SignedV1Publication } from "../../src/worker/v1-publication";
import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

// Inspect the browser's structured wallet handoff without asking an external
// wallet to approve a second transaction. Mainnet fixtures sign the same intent.
export async function prepareBrowserNearPayment(
  page: Page,
  button: Locator,
  operation: "pay" | "fund-prize",
) {
  const endpoint = "https://near-mobile-production.aws.peersyst.tech/connector/request";
  const launch = "https://near-mobile-production.aws.peersyst.tech/api/deep-link?**";
  await page
    .context()
    .route(launch, (route) => route.fulfill({ body: "Wallet opening intercepted" }));
  const response = page.waitForResponse((result) => {
    const path = new URL(result.url()).pathname;
    return (
      (path === "/api/commitments/mainnet" || path === "/api/events") &&
      result.request().method() === "POST" &&
      result.request().postDataJSON().operation === operation
    );
  });
  let relayBody: unknown;
  await page.route(endpoint, async (route) => {
    const body = route.request().postDataJSON();
    relayBody = body;
    await route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      json: {
        ...body,
        id: randomUUID(),
        status: "pending",
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
      },
    });
  });
  try {
    await button.click();
    const payment = await (await response).json();
    await expect(page.getByRole("link", { name: /Open NEAR Mobile if/ })).toBeVisible();
    assert.deepEqual(relayBody, {
      method: "signAndSendTransaction",
      network: "mainnet",
      origin: payment.origin,
      payload: payment.walletTransaction,
    });
    assert.equal(typeof payment.unsignedBase64, "string");
    return payment.unsignedBase64 as string;
  } finally {
    await page.unroute(endpoint);
    await page.context().unroute(launch);
  }
}

// These owner-operated helpers are used only by explicitly selected mainnet
// browser tests. No fixture key, provider token or wallet secret is persisted.
export async function mainnetJournal(name: string, resumeSettlementReturn = false) {
  if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid financial journal");
  const directory = "contracts/.cache/v1-browser",
    path = `${directory}/${name}.json`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let value: Record<string, unknown> = {
    phase: "started",
    authentication: "preauthenticated engineering account; isolated owner-wallet signing",
  };
  if (resumeSettlementReturn) {
    if (name !== "attendee-settlement-verified")
      throw new Error("Only the confirmed settlement's USDC return can resume");
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (
      ![
        "needs_original_hash_reconciliation",
        "restore_0_submitted",
        "restore_0_final",
        "restored",
      ].includes(previous.phase) ||
      previous.finals?.withdraw?.success !== true
    )
      throw new Error("Reconcile the original settlement withdrawal first");
    value = previous;
  } else await writeFile(path, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  const images = (value.images ?? {}) as Record<string, SignedV1Publication>,
    finals = (value.finals ?? {}) as Record<string, unknown>;
  async function save(update: Record<string, unknown>) {
    value = { ...value, ...update, images, finals };
    await writeFile(`${path}.next`, JSON.stringify(value) + "\n", { mode: 0o600 });
    await rename(`${path}.next`, path);
  }
  const native = v1PublicationGateway();
  async function final(name: string, image: SignedV1Publication, sender?: string) {
    for (let attempt = 0; attempt < 3; attempt++)
      try {
        const result = sender ? await v1FinalTransaction(image, sender) : await native.final(image);
        assert.equal(result.success, true);
        finals[name] = result;
        await save({ phase: `${name}_final` });
        return result;
      } catch (error) {
        if (attempt === 2) throw error;
        const limited = error instanceof Error && /429|cooldown/i.test(error.message);
        await new Promise((resolve) => setTimeout(resolve, limited ? 31000 : 3000));
      }
    throw new Error("Original financial image needs reconciliation");
  }
  async function send(name: string, image: SignedV1Publication) {
    if (resumeSettlementReturn && !/^restore_[01]$/.test(name))
      throw new Error("Resume cannot repeat account setup, funding, settlement or withdrawal");
    if (images[name])
      throw new Error("Original image already retained; reconcile without another send");
    images[name] = image;
    await save({ phase: `${name}_submitted` });
    try {
      await native.submit(image);
    } catch {
      /* The write may have succeeded; only query the retained hash. */
    }
  }
  async function submit(name: string, image: SignedV1Publication, sender?: string) {
    await send(name, image);
    return final(name, image, sender);
  }
  return { directory, path, images, finals, save, send, submit, final };
}
export async function mainnetOwnerNonce(block: string, account: string = v1Deployment.owner) {
  if (
    !([v1Deployment.owner, v1Deployment.account, ...v1DemoAccounts] as readonly string[]).includes(
      account,
    )
  )
    throw new Error("Outside project mainnet signers");
  const nonces = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (id) => {
      const result = record(
        await new V1ReadOnlyRpc(id).read("query", {
          request_type: "view_access_key",
          account_id: account,
          public_key: v1Deployment.publicKey,
          block_id: block,
        }),
      );
      assert.equal(result.block_hash, block);
      assert.equal(result.permission, "FullAccess");
      return unsigned(result.nonce, 64).toString();
    }),
  );
  assert.equal(nonces[0], nonces[1]);
  return (BigInt(nonces[0]) + 1n).toString();
}
export async function mainnetUsdc(
  block: string,
  accounts: readonly string[] = [v1Deployment.owner, v1Deployment.account],
) {
  const values = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (endpoint) => {
      const rpc = new V1ReadOnlyRpc(endpoint);
      return Promise.all(
        accounts.map(async (account_id) => {
          const result = record(
            await rpc.read("query", {
              request_type: "call_function",
              account_id: v1Deployment.token,
              method_name: "ft_balance_of",
              args_base64: Buffer.from(canonicalJson({ account_id })).toString("base64"),
              block_id: block,
            }),
          );
          assert.equal(result.block_hash, block);
          const bytes = result.result;
          assert(
            Array.isArray(bytes) &&
              bytes.length < 128 &&
              bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
          );
          const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
          unsigned(value, 128);
          return value as string;
        }),
      );
    }),
  );
  assert.deepEqual(values[0], values[1]);
  return values[0];
}
export async function approveMainnetDeposit(
  unsignedBase64: string,
  eventId: string,
  registration: string,
  amount: string,
  account: string = v1Deployment.owner,
) {
  assert.equal(Buffer.from(unsignedBase64, "base64").toString("base64"), unsignedBase64);
  const requested = Buffer.from(unsignedBase64, "base64");
  assert(requested.length < 1024);
  if (!([v1Deployment.owner, ...v1DemoAccounts] as readonly string[]).includes(account))
    throw new Error("Outside project attendee wallets");
  const offset = 4 + Buffer.byteLength(account) + 33,
    blockOffset = offset + 8 + 4 + Buffer.byteLength(v1Deployment.token);
  const nonce = requested.readBigUInt64LE(offset).toString(),
    blockHash = encodeBase58(requested.subarray(blockOffset, blockOffset + 32));
  const current = await readV1Snapshot(eventId);
  assert.equal(await mainnetOwnerNonce(current.block.hash, account), nonce);
  const signer = await loadV1MainnetKey();
  const tx = v1DepositFundingTransaction({
    signer: account,
    publicKey: signer.publicKey,
    nonce,
    blockHash,
    eventId: registration,
    amount,
  });
  assert(tx.bytes.equals(requested), "Wallet request differs from the frozen native-USDC deposit");
  return {
    hash: tx.hash,
    signedBase64: Buffer.concat([tx.bytes, Buffer.from([0]), signer.sign(tx.digest)]).toString(
      "base64",
    ),
    semantic: `deposit:${registration}:${amount}`,
    validUntilMs: Date.now() + 120000,
  };
}
export async function ownerMainnetCalls(eventId: string, actions: NativeAction[]) {
  const snapshot = await readV1Snapshot(eventId),
    nonce = await mainnetOwnerNonce(snapshot.block.hash);
  return {
    ...signV1MainnetTransaction(
      {
        signer: v1Deployment.owner,
        receiver: v1Deployment.account,
        nonce,
        blockHash: snapshot.block.hash,
        actions,
      },
      await loadV1MainnetKey(),
    ),
    semantic: canonicalJson(
      actions.map((action) =>
        action.kind === "call"
          ? { method: action.method, args: action.args.toString("utf8") }
          : action.kind,
      ),
    ),
    validUntilMs: Date.now() + 120000,
  };
}
