import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { engineeringManifest } from "../../src/server/protocol/manifest";
import { normalizeEvmTokenTransfer } from "../../src/server/protocol/evm-token-transfer";
import { normalizeNearTokenTransfer } from "../../src/server/protocol/near-token-transfer";
import { normalizeSolanaTokenTransfer } from "../../src/server/protocol/solana-token-transfer";
import { compareTokenTransferSources } from "../../src/server/protocol/token-transfer-sources";
import { ReadOnlyRpc } from "../../src/server/protocol/rpc";

const captured = JSON.parse(
  readFileSync(new URL("../fixtures/usdc-transfers-public.json", import.meta.url), "utf8"),
);
const quantity = (n: number | bigint) => "0x" + BigInt(n).toString(16);

test("retained actual NEP-141 deposit/return events have stable IDs and failed/refunded logs cannot create credit", () => {
  for (const original of captured.near) {
    const fact = normalizeNearTokenTransfer(original);
    assert.equal(fact.amount, "5000000");
    assert.equal(fact.creditedAmount, "5000000");
    assert.equal(fact.fundingAllowed, false);
    const reordered = structuredClone(original);
    reordered.transaction.receipts_outcome.reverse();
    assert.deepEqual(normalizeNearTokenTransfer(reordered), fact);
    const failed = structuredClone(original);
    failed.transaction.receipts_outcome.find(
      (r: { id: string }) => r.id === fact.receiptId,
    ).outcome.status = { Failure: { error_message: "fixture failure" } };
    assert.throws(() => normalizeNearTokenTransfer(failed), /Missing or ambiguous/);
  }
  const refunded = structuredClone(captured.near[0]);
  const resolver = refunded.transaction.receipts_outcome.find(
    (r: { outcome: { executor_id: string; logs: string[] } }) =>
      r.outcome.executor_id === refunded.context.asset && !r.outcome.logs.length,
  );
  resolver.outcome.logs = [
    "EVENT_JSON:" +
      JSON.stringify({
        standard: "nep141",
        version: "1.0.0",
        event: "ft_transfer",
        data: [
          {
            old_owner_id: refunded.context.recipient,
            new_owner_id: "a-2750f947d3.showup-dev-14989f.testnet",
            amount: "5000000",
          },
        ],
      }),
  ];
  assert.throws(() => normalizeNearTokenTransfer(refunded), /also debited/);
});

test("ERC-20 decoding distinguishes actual Base self-transfer from credit on either EVM network", () => {
  const self = normalizeEvmTokenTransfer(captured.base);
  assert.equal(self.amount, "10000");
  assert.equal(self.creditedAmount, "0");
  for (const network of ["base", "ethereum"] as const) {
    const value = structuredClone(captured.base);
    const asset = engineeringManifest.networks.find((n) => n.id === network)!;
    value.context.network = network;
    value.context.asset = asset.usdc;
    value.context.recipient = "0x" + "22".repeat(20);
    value.transaction.chainId = quantity(BigInt(asset.chainId));
    value.transaction.to = asset.usdc;
    value.receipt.to = asset.usdc;
    value.receipt.logs[0].address = asset.usdc;
    value.receipt.logs[0].topics[2] = "0x" + "0".repeat(24) + value.context.recipient.slice(2);
    const fact = normalizeEvmTokenTransfer(value);
    assert.equal(fact.creditedAmount, "10000");
    assert.equal(fact.fundingAllowed, false);
    const nft = structuredClone(value);
    nft.receipt.logs[0].topics.push("0x" + "00".repeat(32));
    assert.throws(() => normalizeEvmTokenTransfer(nft), /ERC-20/);
    const fork = structuredClone(value);
    fork.receipt.blockHash = "0x" + "ff".repeat(32);
    assert.throws(() => normalizeEvmTokenTransfer(fork), /inclusion/);
  }
});

function solanaFixture(v0: boolean) {
  const key = (n: number) => encodeBase58(Buffer.alloc(32, n));
  const mint = engineeringManifest.networks.find((n) => n.id === "solana")!.usdc;
  const program = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const signature = encodeBase58(Buffer.alloc(64, 9));
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(5_000_000n, 1);
  data[9] = 6;
  const destination = v0 ? 4 : 2,
    programIndex = v0 ? 5 : 4;
  const instruction = {
    programIdIndex: programIndex,
    accounts: [1, 3, destination, 0],
    data: encodeBase58(data),
  };
  const balance = (i: number, owner: string, amount: string) => ({
    accountIndex: i,
    mint,
    owner,
    programId: program,
    uiTokenAmount: { amount, decimals: 6 },
  });
  const now = Math.floor(Date.now() / 1000);
  return {
    context: {
      environment: "engineering" as const,
      network: "solana" as const,
      asset: mint,
      transaction: signature,
      recipient: key(6),
    },
    transaction: {
      slot: 100,
      blockTime: now - 10,
      version: v0 ? 0 : "legacy",
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: v0
            ? [key(1), key(2), key(3), mint]
            : [key(1), key(2), key(4), mint, program],
          instructions: v0
            ? [{ programIdIndex: 2, accounts: [0, 1, 3, 4, 5], data: "1" }]
            : [instruction],
        },
      },
      meta: {
        err: null,
        loadedAddresses: { writable: v0 ? [key(4)] : [], readonly: v0 ? [program] : [] },
        preTokenBalances: [balance(1, key(1), "5000000")],
        postTokenBalances: [balance(1, key(1), "0"), balance(destination, key(6), "5000000")],
        innerInstructions: v0 ? [{ index: 0, instructions: [instruction] }] : [],
        logMessages: [`Program ${program} invoke [${v0 ? 2 : 1}]`, `Program ${program} success`],
      },
    },
    statuses: {
      context: { slot: 110 },
      value: [{ slot: 100, err: null, confirmations: null, confirmationStatus: "finalized" }],
    },
    block: { blockhash: key(10), blockHeight: 90, blockTime: now - 10, signatures: [signature] },
    finalized: { height: "110", hash: key(11), blockHeight: "100", timestampMs: now * 1000 },
  };
}
test("SPL checked transfers resolve legacy/v0 CPI accounts and require actual matching owner/mint credit", () => {
  for (const v0 of [false, true]) {
    const input = solanaFixture(v0),
      fact = normalizeSolanaTokenTransfer(input);
    assert.equal(fact.amount, "5000000");
    assert.equal(fact.creditedAmount, "5000000");
    assert.equal(fact.eventIndex, v0 ? 1 : 0);
    assert.equal(fact.fundingAllowed, false);
    const unchecked = structuredClone(input),
      bytes = Buffer.alloc(9);
    bytes[0] = 3;
    bytes.writeBigUInt64LE(5_000_000n, 1);
    const instruction = v0
      ? unchecked.transaction.meta.innerInstructions[0].instructions[0]
      : unchecked.transaction.transaction.message.instructions[0];
    instruction.accounts = [1, v0 ? 4 : 2, 0];
    instruction.data = encodeBase58(bytes);
    assert.equal(normalizeSolanaTokenTransfer(unchecked).creditedAmount, "5000000");
    const wrongOwner = structuredClone(input);
    wrongOwner.context.recipient = encodeBase58(Buffer.alloc(32, 4));
    assert.throws(() => normalizeSolanaTokenTransfer(wrongOwner), /Missing or ambiguous/);
    const wrongPrecision = structuredClone(input);
    wrongPrecision.transaction.meta.postTokenBalances[1].uiTokenAmount.decimals = 9;
    assert.throws(() => normalizeSolanaTokenTransfer(wrongPrecision), /precision/);
    const refunded = structuredClone(input);
    refunded.transaction.meta.postTokenBalances[1].uiTokenAmount.amount = "0";
    assert.throws(() => normalizeSolanaTokenTransfer(refunded), /net credit/);
    const failedCpi = structuredClone(input);
    failedCpi.transaction.meta.logMessages.push(
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: insufficient funds",
    );
    assert.throws(() => normalizeSolanaTokenTransfer(failedCpi), /Failed or incomplete/);
  }
});

test("two-source transfer comparison pins engineering chain identity and rejects conflicting amounts", async () => {
  const now = Math.floor(Date.now() / 1000),
    base = captured.base,
    height = BigInt(base.finalized.height) + 10n;
  const pair = (conflict: boolean) =>
    ["base-sepolia-public", "base-sepolia-publicnode"].map(
      (id, i) =>
        new ReadOnlyRpc(id, async (_url, options) => {
          const request = JSON.parse(String(options?.body));
          let result: unknown;
          if (request.method === "eth_chainId") result = quantity(84532);
          else if (request.method === "eth_getTransactionByHash") result = base.transaction;
          else if (request.method === "eth_getTransactionReceipt") {
            result = structuredClone(base.receipt);
            if (conflict && i === 1)
              (result as typeof base.receipt).logs[0].data = "0x" + "0".repeat(63) + "1";
          } else if (request.method === "eth_getBlockByNumber")
            result =
              request.params[0] === "finalized" || request.params[0] === quantity(height)
                ? {
                    number: quantity(height),
                    hash: "0x" + "ff".repeat(32),
                    timestamp: quantity(now),
                  }
                : base.block;
          else throw new Error("Unexpected transfer read");
          return Response.json({ jsonrpc: "2.0", id: request.id, result });
        }),
    );
  const [a, b] = pair(false),
    matched = await compareTokenTransferSources({ context: base.context }, a, b);
  assert.equal(matched.matched, true);
  assert.equal(matched.fundingAllowed, false);
  const [c, d] = pair(true);
  await assert.rejects(compareTokenTransferSources({ context: base.context }, c, d), /disagree/);
});
