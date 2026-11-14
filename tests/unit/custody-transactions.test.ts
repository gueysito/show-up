import assert from "node:assert/strict";
import test from "node:test";
import { Interface, Transaction } from "ethers";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { engineeringManifest, networkManifest } from "../../src/server/protocol/manifest";
import {
  custodyIntentHash,
  custodyPath,
  evmCustodyTransaction,
  solanaCustodyMessage,
  type CustodyIntent,
} from "../../src/server/protocol/custody-transactions";

const evm: CustodyIntent = {
  deployment: "escrow.local",
  environment: "engineering",
  network: "base",
  manifest: engineeringManifest.revision,
  event: "a".repeat(64),
  rulesHash: "c".repeat(64),
  payout: "b".repeat(64),
  operation: "delivery",
  collection: "0x" + "11".repeat(20),
  asset: "0x" + "00".repeat(31) + "01",
  source: "0x" + "22".repeat(20),
  recipient: "0x" + "33".repeat(20),
  feeCap: "300000000000000",
};
const gas = {
  nonce: 7,
  gasLimit: "100000",
  maxFeePerGas: "2000000000",
  maxPriorityFeePerGas: "1000000000",
};

test("custody address path remains fixed while an irreversible decision has a distinct intent hash", () => {
  const returned = { ...evm, operation: "return" as const, recipient: "0x" + "44".repeat(20) };
  assert.equal(custodyPath(returned), custodyPath(evm));
  assert.notEqual(custodyIntentHash(returned), custodyIntentHash(evm));
  for (const field of [
    "deployment",
    "environment",
    "network",
    "event",
    "collection",
    "asset",
  ] as const) {
    const changed =
      field === "environment"
        ? "mainnet"
        : field === "network"
          ? "ethereum"
          : field === "deployment"
            ? "other.local"
            : field === "event"
              ? "c".repeat(64)
              : "0x" + "55".repeat(field === "asset" ? 32 : 20);
    assert.notEqual(
      custodyPath({
        ...evm,
        [field]: changed,
        manifest: field === "environment" ? networkManifest.revision : evm.manifest,
      }),
      custodyPath(evm),
      field,
    );
  }
  assert.throws(() => custodyPath({ ...evm, manifest: "unknown" }));
});

test("EVM signing image is an exact zero-value ERC-721 transfer with bounded EIP-1559 fees", () => {
  const prepared = evmCustodyTransaction(evm, gas);
  const tx = Transaction.from(prepared.unsigned);
  assert.equal(tx.chainId, 84532n);
  assert.equal(tx.type, 2);
  assert.equal(tx.nonce, 7);
  assert.equal(tx.to?.toLowerCase(), evm.collection);
  assert.equal(tx.value, 0n);
  assert.deepEqual(tx.accessList, []);
  assert.equal(tx.data.slice(0, 10), "0x42842e0e");
  const decoded = new Interface([
    "function safeTransferFrom(address,address,uint256)",
  ]).decodeFunctionData("safeTransferFrom", tx.data);
  assert.equal(decoded[0].toLowerCase(), evm.source);
  assert.equal(decoded[1].toLowerCase(), evm.recipient);
  assert.equal(decoded[2], 1n);
  assert.equal(prepared.payload, tx.unsignedHash);
  for (const override of [
    { gasLimit: "300001" },
    { gasLimit: "20999" },
    { maxFeePerGas: "999999999999999" },
    { maxPriorityFeePerGas: "3000000000" },
    { nonce: -1 },
    { nonce: 0.5 },
  ])
    assert.throws(() => evmCustodyTransaction(evm, { ...gas, ...override }));
  assert.equal(
    Transaction.from(evmCustodyTransaction({ ...evm, network: "ethereum" }, gas).unsigned).chainId,
    11155111n,
  );
  assert.throws(() => evmCustodyTransaction({ ...evm, asset: "1" }, gas));
  assert.throws(() => evmCustodyTransaction({ ...evm, recipient: evm.source }, gas));
});

test("Solana signing image fixes account roles, Core transfer and explicit zero priority fee", () => {
  const address = (value: number) => encodeBase58(Buffer.alloc(32, value));
  const intent: CustodyIntent = {
    ...evm,
    network: "solana",
    collection: address(1),
    asset: address(2),
    source: address(3),
    recipient: address(4),
    feeCap: "10000",
  };
  const envelope = { blockhash: address(5), computeUnits: 100000, estimatedFee: "5000" };
  const prepared = solanaCustodyMessage(intent, envelope);
  const bytes = Buffer.from(prepared.message, "base64");
  assert.deepEqual([...bytes.subarray(0, 4)], [1, 0, 5, 7]);
  assert.deepEqual(bytes.subarray(4, 36), Buffer.alloc(32, 3), "only custody signs and pays");
  assert.deepEqual(bytes.subarray(36, 68), Buffer.alloc(32, 2), "only asset is writable unsigned");
  const instructions = bytes.subarray(4 + 7 * 32 + 32);
  assert.equal(instructions[0], 3);
  assert.deepEqual([...instructions.subarray(1, 4)], [6, 0, 5]);
  assert.equal(instructions.readUInt32LE(5), 100000);
  assert.deepEqual([...instructions.subarray(9, 13)], [6, 0, 9, 3]);
  assert.equal(instructions.readBigUInt64LE(13), 0n);
  assert.deepEqual([...instructions.subarray(21)], [5, 7, 1, 2, 0, 0, 3, 4, 5, 2, 14, 0]);
  assert.deepEqual(prepared.payload, [...bytes]);
  for (const override of [
    { computeUnits: 200001 },
    { computeUnits: 0 },
    { estimatedFee: "10001" },
    { blockhash: "wrong" },
  ])
    assert.throws(() => solanaCustodyMessage(intent, { ...envelope, ...override }));
  assert.throws(() => solanaCustodyMessage({ ...intent, recipient: intent.source }, envelope));
});
