import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  verifyAssetObservation,
  type AssetObservation,
  type ObservationContext,
} from "../../src/server/protocol/asset-observation";
import { canonicalJson } from "../../src/server/protocol/canonical";
import {
  custodyIntentHash,
  evmCustodyTransaction,
  solanaCustodyMessage,
  type CustodyIntent,
} from "../../src/server/protocol/custody-transactions";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { engineeringManifest } from "../../src/server/protocol/manifest";

const now = 1_793_650_000_000;
const keys = generateKeyPairSync("ed25519"); // Disposable test key, never persisted.
const publicKey = Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url").toString(
  "base64",
);
function proof(receipt: unknown) {
  return sign(null, Buffer.from(canonicalJson(receipt)), keys.privateKey).toString("base64");
}
function fixture(network: "base" | "ethereum" | "solana") {
  const address = (n: number) =>
    network === "solana"
      ? encodeBase58(Buffer.alloc(32, n))
      : "0x" + n.toString(16).padStart(2, "0").repeat(20);
  const custody = {
    network,
    collection: address(1),
    asset: network === "solana" ? address(2) : "0x" + "01".repeat(32),
    source: address(3),
  };
  const context: ObservationContext = {
    domain: "showup.sandbox.authorization.v1",
    deployment: "escrow.local",
    event: "a".repeat(64),
    rules_hash: "b".repeat(64),
    custody,
    policy: { key: publicKey, profile_hash: "c".repeat(64), sources: ["one", "two"] },
  };
  const receipt: AssetObservation = {
    format: "showup.asset.observation.v1",
    domain: context.domain,
    deployment: context.deployment,
    manifest: engineeringManifest.revision,
    event: context.event,
    rules_hash: context.rules_hash,
    network,
    chain_id: engineeringManifest.networks.find((n) => n.id === network)!.chainId,
    profile_hash: context.policy.profile_hash,
    sources: context.policy.sources,
    collection: custody.collection,
    asset: custody.asset,
    custody: custody.source,
    owner: custody.source,
    operation: "holding",
    intent_hash: null,
    image_hash: null,
    transaction: null,
    block_height: "123",
    block_hash: network === "solana" ? address(8) : "0x" + "08".repeat(32),
    block_ms: now - 1000,
    observed_ms: now,
    expires_ms: now + 60_000,
    finalized: true,
    fee: "0",
  };
  return { context, receipt, address };
}

test("frozen observer signatures require exact event/asset/source/finality and bounded fresh evidence", () => {
  for (const network of ["base", "ethereum", "solana"] as const) {
    const { context, receipt } = fixture(network);
    assert(verifyAssetObservation(receipt, proof(receipt), context, now));
    for (const [field, value] of [
      ["domain", "wrong"],
      ["deployment", "other.local"],
      ["manifest", "wrong"],
      ["event", "d".repeat(64)],
      ["rules_hash", "e".repeat(64)],
      ["network", "near"],
      ["chain_id", "1"],
      ["profile_hash", "f".repeat(64)],
      ["sources", ["one", "one"]],
      ["collection", "wrong"],
      ["asset", "wrong"],
      ["custody", "wrong"],
      ["block_height", "0"],
      ["block_height", "0x7b"],
      ["block_height", 123],
      ["block_hash", "wrong"],
      ["block_ms", now + 1],
      ["observed_ms", now + 1],
      ["expires_ms", now],
      ["finalized", false],
      ["finalized", 1],
      ["fee", "1"],
      ["fee", "0x0"],
      ["extra", true],
    ] as const) {
      const changed = { ...receipt, [field]: value };
      assert.equal(verifyAssetObservation(changed, proof(changed), context, now), false, field);
    }
    assert.equal(verifyAssetObservation(receipt, proof(receipt), context, now + 60_000), false);
    assert.equal(
      verifyAssetObservation(receipt, proof({ ...receipt, owner: "wrong" }), context, now),
      false,
    );
  }
});
test("even a valid observer signature cannot replace a frozen payout recipient, operation, image or fee cap", () => {
  for (const network of ["base", "ethereum", "solana"] as const) {
    const { context, receipt, address } = fixture(network);
    const intent: CustodyIntent = {
      deployment: context.deployment,
      environment: "engineering",
      network,
      manifest: engineeringManifest.revision,
      event: context.event,
      rulesHash: context.rules_hash,
      payout: "d".repeat(64),
      operation: "return",
      collection: context.custody.collection,
      asset: context.custody.asset,
      source: context.custody.source,
      recipient: address(4),
      feeCap: "300000000000000",
    };
    const unsigned =
      network === "solana"
        ? solanaCustodyMessage(intent, {
            blockhash: address(5),
            computeUnits: 100000,
            estimatedFee: "5000",
          }).message
        : Buffer.from(
            evmCustodyTransaction(intent, {
              nonce: 0,
              gasLimit: "100000",
              maxFeePerGas: "2000000000",
              maxPriorityFeePerGas: "1000000000",
            }).unsigned.slice(2),
            "hex",
          ).toString("base64");
    context.intent = intent;
    context.image = { intent_hash: custodyIntentHash(intent), unsigned };
    const delivered = {
      ...receipt,
      operation: "return",
      owner: intent.recipient,
      intent_hash: context.image.intent_hash,
      image_hash: createHash("sha256").update(Buffer.from(unsigned, "base64")).digest("hex"),
      transaction:
        network === "solana" ? encodeBase58(Buffer.alloc(64, 9)) : "0x" + "09".repeat(32),
      fee: "5000",
    };
    assert(verifyAssetObservation(delivered, proof(delivered), context, now));
    for (const [field, value] of [
      ["operation", "delivery"],
      ["owner", address(6)],
      ["intent_hash", "e".repeat(64)],
      ["image_hash", "f".repeat(64)],
      ["transaction", "wrong"],
      ["fee", "300000000000001"],
    ]) {
      const changed = { ...delivered, [field]: value };
      assert.equal(verifyAssetObservation(changed, proof(changed), context, now), false, field);
    }
    assert.equal(
      verifyAssetObservation(
        delivered,
        proof(delivered),
        { ...context, intent: { ...intent, event: "f".repeat(64) } },
        now,
      ),
      false,
    );
  }
});
