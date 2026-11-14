import assert from "node:assert/strict";
import test from "node:test";
import { Interface, Transaction, Wallet } from "ethers";
import {
  evmCustodyTransaction,
  type CustodyIntent,
} from "../../src/server/protocol/custody-transactions";
import {
  normalizeEvmAssetEvidence,
  normalizeEvmHolding,
} from "../../src/server/protocol/evm-asset-evidence";
import { engineeringManifest, networkManifest } from "../../src/server/protocol/manifest";
import {
  compareCustodyDeliverySources,
  compareCustodyHoldingSources,
} from "../../src/server/protocol/asset-source-comparison";
import { ReadOnlyRpc } from "../../src/server/protocol/rpc";

const quantity = (value: bigint | number) => "0x" + BigInt(value).toString(16);
const erc721 = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
function fixture(
  network: "base" | "ethereum",
  wrongSigner = false,
  environment: "engineering" | "mainnet" = "engineering",
) {
  // Offline disposable, unfunded keys only. No wallet file, RPC or broadcast.
  const wallet = Wallet.createRandom();
  const intent: CustodyIntent = {
    deployment: "escrow.local",
    environment,
    network,
    manifest:
      environment === "engineering" ? engineeringManifest.revision : networkManifest.revision,
    event: "a".repeat(64),
    rulesHash: "b".repeat(64),
    payout: "c".repeat(64),
    operation: "return",
    collection: "0x" + "11".repeat(20),
    asset: "0x" + "00".repeat(31) + "01",
    source: wallet.address.toLowerCase(),
    recipient: "0x" + "33".repeat(20),
    feeCap: "300000000000000",
  };
  const prepared = evmCustodyTransaction(intent, {
    nonce: 4,
    gasLimit: "100000",
    maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "1000000000",
  });
  const tx = Transaction.from(prepared.unsigned);
  tx.signature = (wrongSigner ? Wallet.createRandom() : wallet).signingKey.sign(tx.unsignedHash);
  const blockHash = "0x" + "dd".repeat(32),
    txHash = tx.hash!;
  const transaction = {
    type: "0x2",
    chainId: quantity(tx.chainId),
    nonce: quantity(tx.nonce),
    gas: quantity(tx.gasLimit),
    maxFeePerGas: quantity(tx.maxFeePerGas!),
    maxPriorityFeePerGas: quantity(tx.maxPriorityFeePerGas!),
    to: intent.collection,
    from: intent.source,
    value: "0x0",
    input: tx.data,
    accessList: [],
    r: tx.signature.r,
    s: tx.signature.s,
    v: quantity(tx.signature.yParity),
    hash: txHash,
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
  };
  const event = erc721.encodeEventLog(erc721.getEvent("Transfer")!, [
    intent.source,
    intent.recipient,
    1n,
  ]);
  const log = {
    address: intent.collection,
    ...event,
    removed: false,
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
  };
  const receipt = {
    type: "0x2",
    transactionHash: txHash,
    blockHash,
    blockNumber: "0x64",
    transactionIndex: "0x0",
    from: intent.source,
    to: intent.collection,
    contractAddress: null,
    status: "0x1",
    gasUsed: "0xc350",
    effectiveGasPrice: "0x59682f00",
    cumulativeGasUsed: "0xc350",
    logs: [log],
    l1Fee: "0x3e8",
  };
  return {
    intent,
    storedUnsigned: prepared.unsigned,
    requestedHash: txHash,
    transaction,
    receipt,
    inclusionBlock: { number: "0x64", hash: blockHash, transactions: [txHash] },
    finalized: { height: "105", hash: "0x" + "ee".repeat(32), timestampMs: 1793650000000 },
    ownerOfAtFinalized: "0x" + "0".repeat(24) + intent.recipient.slice(2),
  };
}

test("raw EVM evidence reconstructs signer/image and requires exact finalized ERC-721 delivery", () => {
  for (const network of ["base", "ethereum"] as const) {
    const input = fixture(network);
    const result = normalizeEvmAssetEvidence(input);
    assert.equal(result.outcome, "delivered");
    assert.equal(result.recipient, input.intent.recipient);
    assert.equal(result.observedOwner, input.intent.recipient);
    assert.equal(result.executionFee, "75000000000000");
    assert.equal(result.fundingAllowed, false);
    assert.equal(result.totalFeeQualified, network === "ethereum");
    assert.equal(result.totalFee, network === "ethereum" ? "75000000000000" : null);
    assert.equal(result.reportedL1Fee, network === "base" ? "1000" : null);
    if (network === "base") {
      const excess = structuredClone(input);
      excess.receipt.l1Fee = quantity(BigInt(input.intent.feeCap));
      assert.equal(normalizeEvmAssetEvidence(excess).feeCapExceeded, true);
      assert.equal(normalizeEvmAssetEvidence(excess).totalFeeQualified, false);
    }
    const failed = structuredClone(input);
    failed.receipt.status = "0x0";
    failed.receipt.logs = [];
    failed.ownerOfAtFinalized = "0x" + "0".repeat(24) + input.intent.source.slice(2);
    assert.equal(normalizeEvmAssetEvidence(failed).outcome, "failed");
    assert.throws(() => normalizeEvmAssetEvidence(fixture(network, true)), /image\/signer/);
  }
});
test("RPC success/hash/from/log claims cannot hide a changed transaction or non-final block", () => {
  const input = fixture("ethereum");
  for (const [field, value] of [
    ["chainId", "0x1"],
    ["type", "0x0"],
    ["nonce", "0x5"],
    ["gas", "0x186a1"],
    ["maxFeePerGas", "0x77359401"],
    ["maxPriorityFeePerGas", "0x3b9aca01"],
    ["to", "0x" + "44".repeat(20)],
    ["from", "0x" + "55".repeat(20)],
    ["value", "0x1"],
    ["input", "0xdeadbeef"],
    ["accessList", [{}]],
    ["r", "0x" + "00".repeat(32)],
    ["s", "0x" + "ff".repeat(32)],
    ["v", "0x2"],
    ["hash", "0x" + "99".repeat(32)],
    ["blockHash", "0x" + "99".repeat(32)],
    ["blockNumber", "0x65"],
    ["transactionIndex", "0x1"],
  ] as const) {
    const changed = structuredClone(input);
    Object.assign(changed.transaction, { [field]: value });
    assert.throws(() => normalizeEvmAssetEvidence(changed), field);
  }
  for (const [field, value] of [
    ["status", "0x2"],
    ["transactionHash", "0x" + "77".repeat(32)],
    ["blockHash", "0x" + "77".repeat(32)],
    ["from", "0x" + "55".repeat(20)],
    ["to", "0x" + "44".repeat(20)],
    ["contractAddress", "0x" + "44".repeat(20)],
    ["gasUsed", "0x186a1"],
    ["effectiveGasPrice", "0x77359401"],
    ["cumulativeGasUsed", "0x0"],
    ["logs", []],
  ] as const) {
    const changed = structuredClone(input);
    Object.assign(changed.receipt, { [field]: value });
    assert.throws(() => normalizeEvmAssetEvidence(changed), field);
  }
  for (const [field, value] of [
    ["removed", true],
    ["data", "0x01"],
    ["address", "0x" + "44".repeat(20)],
    ["transactionHash", "0x" + "66".repeat(32)],
    ["blockHash", "0x" + "66".repeat(32)],
    ["transactionIndex", "0x1"],
  ] as const) {
    const changed = structuredClone(input);
    Object.assign(changed.receipt.logs[0], { [field]: value });
    assert.throws(() => normalizeEvmAssetEvidence(changed), field);
  }
  const duplicates = structuredClone(input);
  duplicates.receipt.logs.push(duplicates.receipt.logs[0]);
  assert.throws(() => normalizeEvmAssetEvidence(duplicates), /ambiguous/);
  assert.throws(() => normalizeEvmAssetEvidence({ ...input, ownerOfAtFinalized: "0x00" }), /owner/);
  assert.throws(
    () => normalizeEvmAssetEvidence({ ...input, finalized: { ...input.finalized, height: "99" } }),
    /finalized/,
  );
  assert.throws(
    () =>
      normalizeEvmAssetEvidence({
        ...input,
        inclusionBlock: { ...input.inclusionBlock, transactions: [] },
      }),
    /inclusion/,
  );
  assert.throws(
    () =>
      normalizeEvmAssetEvidence({
        ...input,
        intent: { ...input.intent, recipient: "0x" + "66".repeat(20) },
      }),
    /image/,
  );
});

test("a recipient's later transfer cannot undo a finalized exact-asset delivery", () => {
  const input = fixture("ethereum");
  input.ownerOfAtFinalized = "0x" + "0".repeat(24) + "77".repeat(20);
  assert.equal(normalizeEvmAssetEvidence(input).outcome, "delivered");
  assert.equal(
    normalizeEvmHolding(input.intent, input.ownerOfAtFinalized, input.finalized).held,
    false,
  );
  assert.equal(
    normalizeEvmAssetEvidence({ ...input, ownerOfAtFinalized: null }).outcome,
    "delivered",
  );
});

test("fixed EVM source comparison pins state by canonical hash and treats pending/conflicting facts as unqualified", async () => {
  for (const network of ["base", "ethereum"] as const) {
    const input = fixture(network, false, "mainnet");
    const timestamp = quantity(Math.floor(Date.now() / 1000) - 12);
    const ids =
      network === "base"
        ? ["base-public", "base-publicnode"]
        : ["ethereum-publicnode", "ethereum-drpc"];
    const pair = (mode = "valid") =>
      ids.map(
        (id, index) =>
          new ReadOnlyRpc(id, async (_url, options) => {
            const request = JSON.parse(String(options?.body)),
              params = request.params;
            const value = structuredClone(input);
            if (index === 1 && mode === "fork") {
              const hash = "0x" + "aa".repeat(32);
              value.transaction.blockHash = hash;
              value.receipt.blockHash = hash;
              value.receipt.logs[0].blockHash = hash;
              value.inclusionBlock.hash = hash;
            }
            let result: unknown;
            if (request.method === "eth_chainId") result = input.transaction.chainId;
            else if (request.method === "eth_getBlockByNumber")
              result =
                params[0] === "0x64"
                  ? value.inclusionBlock
                  : { number: "0x69", hash: input.finalized.hash, timestamp, transactions: [] };
            else if (request.method === "eth_call" || request.method === "eth_getCode") {
              assert.deepEqual(params[1], {
                blockHash: input.finalized.hash,
                requireCanonical: true,
              });
              if (request.method === "eth_call") {
                assert.equal(params[0].to, input.intent.collection);
                assert.equal(params[0].gas, "0x493e0");
                assert.equal(params[0].data, "0x6352211e" + input.intent.asset.slice(2));
                result =
                  "0x" +
                  "0".repeat(24) +
                  (index === 1 && mode === "owner-conflict"
                    ? "66".repeat(20)
                    : input.intent.source.slice(2));
              } else result = index === 1 && mode === "code-conflict" ? "0x6002" : "0x6001";
            } else if (request.method === "eth_getTransactionByHash") {
              assert.equal(params[0], input.requestedHash);
              result = value.transaction;
            } else if (request.method === "eth_getTransactionReceipt") {
              assert.equal(params[0], input.requestedHash);
              result =
                mode === "pending" || (index === 1 && mode === "one-pending")
                  ? null
                  : value.receipt;
            } else throw new Error("Unexpected source method");
            return Response.json({ jsonrpc: "2.0", id: request.id, result });
          }),
      );
    let [first, second] = pair();
    const holding = await compareCustodyHoldingSources(input.intent, first, second);
    assert.equal(holding.fact.held, true);
    assert.equal(holding.assetQualified, false);
    assert.equal(holding.fundingAllowed, false);
    const request = {
      intent: input.intent,
      storedImageBase64: Buffer.from(input.storedUnsigned.slice(2), "hex").toString("base64"),
      transaction: input.requestedHash,
    };
    const delivery = await compareCustodyDeliverySources(request, first, second);
    assert.equal(delivery.fact.outcome, "delivered");
    assert.equal(delivery.independenceVerified, false);
    [first, second] = pair("pending");
    assert.equal(
      (await compareCustodyDeliverySources(request, first, second)).fact.outcome,
      "uncertain",
    );
    for (const mode of ["owner-conflict", "code-conflict"]) {
      [first, second] = pair(mode);
      await assert.rejects(compareCustodyHoldingSources(input.intent, first, second), /disagree/);
    }
    for (const mode of ["fork", "one-pending"]) {
      [first, second] = pair(mode);
      await assert.rejects(compareCustodyDeliverySources(request, first, second), /disagree/);
    }
    await assert.rejects(
      compareCustodyHoldingSources(
        { ...input.intent, environment: "engineering", manifest: engineeringManifest.revision },
        first,
        second,
      ),
      /No fixed/,
    );
  }
});
