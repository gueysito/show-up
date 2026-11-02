import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  coreProgram,
  custodyChainId,
  solanaCustodyMessage,
  type CustodyIntent,
} from "../../src/server/protocol/custody-transactions";
import { decodeBase58, encodeBase58 } from "../../src/server/protocol/encoding";
import { engineeringManifest, networkManifest } from "../../src/server/protocol/manifest";
import {
  compareCustodyDeliverySources,
  compareCustodyHoldingSources,
} from "../../src/server/protocol/asset-source-comparison";
import { ReadOnlyRpc } from "../../src/server/protocol/rpc";
import {
  decodeSimpleCoreAsset,
  normalizeCoreHolding,
  normalizeSolanaAssetEvidence,
} from "../../src/server/protocol/solana-asset-evidence";

const address = (n: number) => encodeBase58(Buffer.alloc(32, n));
// Supported by pinned Node; TypeScript's JSON interface omits this proposal API.
const rawJson = Reflect.get(JSON, "rawJSON") as (value: string) => unknown;
function coreData(owner: string, collection: string) {
  const text = (value: string) => {
    const bytes = Buffer.from(value),
      length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  return Buffer.concat([
    Buffer.from([1]),
    decodeBase58(owner, 32),
    Buffer.from([2]),
    decodeBase58(collection, 32),
    text("Fictional fixture"),
    text("https://example.test/fixture"),
    Buffer.from([0]),
  ]);
}
function fixture(environment: "engineering" | "mainnet" = "engineering", tamperImage = false) {
  // Fresh offline key, never persisted/funded or used against a public network.
  const keys = generateKeyPairSync("ed25519"),
    source = encodeBase58(Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url"));
  const intent: CustodyIntent = {
    deployment: "escrow.local",
    environment,
    network: "solana",
    manifest:
      environment === "engineering" ? engineeringManifest.revision : networkManifest.revision,
    event: "a".repeat(64),
    rulesHash: "b".repeat(64),
    payout: "c".repeat(64),
    operation: "return",
    collection: address(1),
    asset: address(2),
    source,
    recipient: address(4),
    feeCap: "10000",
  };
  const prepared = solanaCustodyMessage(intent, {
    blockhash: address(5),
    computeUnits: 100000,
    estimatedFee: "5000",
  });
  const message = Buffer.from(prepared.message, "base64");
  if (tamperImage) message[message.length - 1] = 1;
  const signature = sign(null, message, keys.privateKey),
    txId = encodeBase58(signature);
  const wire = Buffer.concat([Buffer.from([1]), signature, message]);
  const data = coreData(intent.recipient, intent.collection);
  const transaction = {
    slot: 100,
    blockTime: 1793650000,
    version: "legacy",
    transaction: [wire.toString("base64"), "base64"],
    meta: {
      err: null as unknown,
      fee: 5000,
      preBalances: [9007199254740993n, 1n, 2n, 3n, 4n, 5n, 6n],
      postBalances: [9007199254735493n, 1n, 2n, 3n, 4n, 5n, 6n],
      loadedAddresses: { readonly: [] as string[], writable: [] as string[] },
    },
  };
  const status = {
    context: { slot: 106 },
    value: [
      { slot: 100, confirmationStatus: "finalized", confirmations: null, err: null as unknown },
    ],
  };
  return {
    intent,
    chainId: custodyChainId(intent),
    storedUnsigned: message.toString("base64"),
    requestedSignature: txId,
    transaction,
    signatureStatuses: status,
    inclusionSlot: "100",
    inclusionBlock: {
      blockhash: address(8),
      blockHeight: 90,
      blockTime: 1793650000,
      signatures: [txId],
    },
    finalized: { height: "105", hash: address(9), timestampMs: 1793650000000, blockHeight: "95" },
    queriedAsset: intent.asset,
    accountAtFinalized: {
      context: { slot: 105 },
      value: {
        owner: coreProgram,
        executable: false,
        lamports: 1000000,
        space: data.length,
        data: [data.toString("base64"), "base64"],
      },
    },
  };
}
test("raw Solana evidence binds cluster, actual wire signature, fixed transfer, final history and exact Core state slot", () => {
  const input = fixture();
  const result = normalizeSolanaAssetEvidence(input);
  assert.equal(result.outcome, "delivered");
  assert.equal(result.recipient, input.intent.recipient);
  assert.equal(result.observedOwner, input.intent.recipient);
  assert.equal(result.transactionFee, "5000");
  assert.equal(result.totalFee, "5500");
  assert.equal(result.fundingAllowed, false);
  assert.equal(result.authorityQualified, false);
  const failed = structuredClone(input);
  failed.transaction.meta.err = { InstructionError: [2, "Custom"] };
  failed.signatureStatuses.value[0].err = failed.transaction.meta.err;
  const raw = coreData(input.intent.source, input.intent.collection);
  failed.accountAtFinalized.value.data[0] = raw.toString("base64");
  failed.accountAtFinalized.value.space = raw.length;
  assert.equal(normalizeSolanaAssetEvidence(failed).outcome, "failed");
  assert.equal(
    normalizeCoreHolding({
      intent: failed.intent,
      chainId: failed.chainId,
      queriedAsset: failed.queriedAsset,
      account: failed.accountAtFinalized,
      finalized: failed.finalized,
    }).owner,
    input.intent.source,
  );
  const moved = structuredClone(input),
    other = coreData(address(10), input.intent.collection);
  moved.accountAtFinalized.value.data[0] = other.toString("base64");
  moved.accountAtFinalized.value.space = other.length;
  assert.equal(
    normalizeSolanaAssetEvidence(moved).outcome,
    "delivered",
    "Later forwarding cannot undo delivery",
  );
  assert.equal(
    normalizeSolanaAssetEvidence({ ...input, accountAtFinalized: null }).outcome,
    "delivered",
  );
  const excess = structuredClone(input);
  excess.transaction.meta.postBalances[0] = excess.transaction.meta.preBalances[0] - 10001n;
  assert.equal(normalizeSolanaAssetEvidence(excess).feeCapExceeded, true);
  const unknown = structuredClone(input);
  unknown.transaction.meta.postBalances[0] = unknown.transaction.meta.preBalances[0] + 1n;
  assert.equal(normalizeSolanaAssetEvidence(unknown).totalFeeQualified, false);
});
test("unsupported Core layout/plugins, forged wire/status, wrong cluster, slot mismatch and missing inclusion fail closed", () => {
  const input = fixture(),
    encoded = Buffer.from(input.accountAtFinalized.value.data[0], "base64");
  const sequenced = Buffer.concat([encoded.subarray(0, -1), Buffer.from([1]), Buffer.alloc(8)]);
  assert.equal(
    decodeSimpleCoreAsset(sequenced, input.intent.collection).owner,
    input.intent.recipient,
  );
  assert.throws(
    () => normalizeSolanaAssetEvidence(fixture("engineering", true)),
    /fixed authorized transfer/,
  );
  const forged = structuredClone(input),
    wire = Buffer.from(forged.transaction.transaction[0], "base64");
  wire[1] ^= 1;
  forged.transaction.transaction[0] = wire.toString("base64");
  forged.requestedSignature = encodeBase58(wire.subarray(1, 65));
  forged.inclusionBlock.signatures = [forged.requestedSignature];
  assert.throws(() => normalizeSolanaAssetEvidence(forged), /Invalid custody signer/);
  for (const variant of [
    Buffer.concat([encoded, Buffer.from([3])]),
    encoded.subarray(0, -1),
    Buffer.from(encoded),
  ]) {
    if (variant.length === encoded.length) variant[0] = 2;
    assert.throws(() => decodeSimpleCoreAsset(variant, input.intent.collection));
  }
  assert.throws(() => decodeSimpleCoreAsset(encoded, address(11)), /collection/);
  for (const mutate of [
    (v: typeof input) => {
      v.chainId = address(12);
    },
    (v: typeof input) => {
      v.queriedAsset = address(13);
    },
    (v: typeof input) => {
      v.transaction.version = "0";
    },
    (v: typeof input) => {
      v.transaction.slot = 106;
    },
    (v: typeof input) => {
      v.transaction.meta.loadedAddresses.writable.push("extra");
    },
    (v: typeof input) => {
      v.signatureStatuses.value[0].confirmationStatus = "confirmed";
    },
    (v: typeof input) => {
      v.signatureStatuses.value[0].slot = 99;
    },
    (v: typeof input) => {
      v.signatureStatuses.value[0].err = { InstructionError: [0, "wrong"] };
    },
    (v: typeof input) => {
      v.signatureStatuses.value = [];
    },
    (v: typeof input) => {
      v.inclusionBlock.signatures = [];
    },
    (v: typeof input) => {
      v.inclusionBlock.blockTime++;
    },
    (v: typeof input) => {
      v.accountAtFinalized.context.slot = 106;
    },
    (v: typeof input) => {
      v.accountAtFinalized.value.owner = address(14);
    },
    (v: typeof input) => {
      v.accountAtFinalized.value.executable = true;
    },
    (v: typeof input) => {
      v.transaction.meta.preBalances = [];
    },
    (v: typeof input) => {
      const wire = Buffer.from(v.transaction.transaction[0], "base64");
      wire[1] ^= 1;
      v.transaction.transaction[0] = wire.toString("base64");
    },
    (v: typeof input) => {
      const wire = Buffer.from(v.transaction.transaction[0], "base64");
      wire[wire.length - 1] ^= 1;
      v.transaction.transaction[0] = wire.toString("base64");
    },
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    assert.throws(() => normalizeSolanaAssetEvidence(changed));
  }
});

test("Solana sources must agree on the actual account bank; bounded skew recovery and historical delivery keep routes disabled", async () => {
  const input = fixture("mainnet");
  const seconds = Math.floor(Date.now() / 1000) - 12;
  const pair = (mode = "valid") => {
    let head = 105;
    const accountReads = [0, 0];
    const clients = ["solana-public", "solana-publicnode"].map(
      (id, index) =>
        new ReadOnlyRpc(id, async (_url, options) => {
          const { id: requestId, method, params } = JSON.parse(String(options?.body));
          let result: unknown;
          if (method === "getGenesisHash")
            result = mode === "wrong-cluster" && index === 1 ? address(20) : input.chainId;
          else if (method === "getSlot") result = head;
          else if (method === "getBlock") {
            if (params[1].transactionDetails === "signatures") {
              assert.equal(params[0], 100);
              result = input.inclusionBlock;
            } else
              result = {
                blockhash:
                  mode === "bank-fork" && params[0] === 106 && index === 1
                    ? address(21)
                    : address(params[0] === 106 ? 10 : 9),
                blockHeight: params[0] === 106 ? 96 : 95,
                blockTime: seconds,
              };
          } else if (method === "getAccountInfo") {
            accountReads[index]++;
            assert.equal(params[0], input.intent.asset);
            assert.equal(params[1].commitment, "finalized");
            assert.equal(params[1].encoding, "base64");
            assert.equal(params[1].minContextSlot, 105);
            let slot = 105;
            if (["skew", "skew-then-agree", "bank-fork"].includes(mode)) {
              head = 106;
              slot =
                mode === "bank-fork" ||
                index === 0 ||
                (mode === "skew-then-agree" && accountReads[index] > 1)
                  ? 106
                  : 105;
            }
            if (mode === "behind") slot = 104;
            const data = coreData(
              index === 1 && mode === "owner-conflict" ? address(22) : input.intent.source,
              input.intent.collection,
            );
            if (index === 1 && mode === "data-conflict") data[data.length - 2] ^= 1;
            result = {
              context: { slot },
              value: {
                ...input.accountAtFinalized.value,
                space: data.length,
                data: [data.toString("base64"), "base64"],
              },
            };
          } else if (method === "getTransaction") {
            assert.equal(params[0], input.requestedSignature);
            assert.equal(params[1].encoding, "base64");
            assert.equal(params[1].commitment, "finalized");
            result =
              mode === "pending" || (mode === "one-pending" && index === 1)
                ? null
                : input.transaction;
          } else if (method === "getSignatureStatuses") {
            assert.deepEqual(params, [
              [input.requestedSignature],
              { searchTransactionHistory: true },
            ]);
            result = input.signatureStatuses;
          } else throw new Error("Unexpected source method");
          // Actual JSON numeric literals exercise exact-u64 preservation in transport.
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: requestId, result }, (_key, value) =>
              typeof value === "bigint" ? rawJson(value.toString()) : value,
            ),
          );
        }),
    );
    return { clients, accountReads };
  };
  let { clients, accountReads } = pair();
  const held = await compareCustodyHoldingSources(input.intent, clients[0], clients[1]);
  assert.equal(held.fact.held, true);
  assert.equal(held.assetQualified, false);
  assert.equal(held.independenceVerified, false);
  const request = {
    intent: input.intent,
    storedImageBase64: input.storedUnsigned,
    transaction: input.requestedSignature,
  };
  const previousReads = [...accountReads];
  const delivered = await compareCustodyDeliverySources(request, clients[0], clients[1]);
  assert.equal(delivered.fact.outcome, "delivered");
  assert.equal(delivered.fundingAllowed, false);
  assert.deepEqual(
    accountReads,
    previousReads,
    "A historical delivery does not require the recipient to retain the NFT",
  );
  if ("totalFee" in delivered.fact) assert.equal(delivered.fact.totalFee, "5500");
  ({ clients, accountReads } = pair("skew-then-agree"));
  const matched = await compareCustodyHoldingSources(input.intent, clients[0], clients[1]);
  assert("slot" in matched.fact);
  assert.equal(matched.fact.slot, "106");
  assert.deepEqual(accountReads, [2, 2]);
  for (const mode of [
    "skew",
    "bank-fork",
    "owner-conflict",
    "data-conflict",
    "behind",
    "wrong-cluster",
  ]) {
    ({ clients, accountReads } = pair(mode));
    await assert.rejects(compareCustodyHoldingSources(input.intent, clients[0], clients[1]));
    assert(accountReads.every((count) => count <= 3));
  }
  ({ clients } = pair("pending"));
  assert.equal(
    (await compareCustodyDeliverySources(request, clients[0], clients[1])).fact.outcome,
    "uncertain",
  );
  ({ clients } = pair("one-pending"));
  await assert.rejects(compareCustodyDeliverySources(request, clients[0], clients[1]), /disagree/);
});
