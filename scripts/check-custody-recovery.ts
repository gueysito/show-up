import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Transaction } from "ethers";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import {
  custodyChainId,
  custodyIntentHash,
  custodyPath,
  evmCustodyTransaction,
  solanaCustodyMessage,
  type CustodyIntent,
} from "../src/server/protocol/custody-transactions";
import { encodeBase58 } from "../src/server/protocol/encoding";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const vectors = [];
for (const name of [
  "custody-recovery-public.json",
  "custody-recovery-solana-expiry-public.json",
  "custody-recovery-solana-failure-public.json",
]) {
  const bytes = await readFile("contracts/.cache/" + name);
  if (bytes.length > 131072) throw new Error("Oversized public recovery fixtures");
  const values = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(values)) throw new Error("Missing public recovery vectors");
  vectors.push(...values);
}
assert.equal(vectors.length, 4);
for (const vector of vectors) {
  const intent = vector.intent as CustodyIntent,
    receipt = vector.receipt,
    history = vector.history;
  assert.equal(intent.environment, "engineering");
  assert.equal(receipt.format, "showup.custody.recovery.v1");
  assert.equal(receipt.deployment, intent.deployment);
  assert.equal(receipt.event, intent.event);
  assert.equal(receipt.rules_hash, intent.rulesHash);
  assert.equal(receipt.manifest, intent.manifest);
  assert.equal(receipt.chain_id, custodyChainId(intent));
  assert.equal(receipt.owner, intent.source);
  assert.equal(receipt.intent_hash, custodyIntentHash(intent));
  assert.equal(receipt.profile_hash, vector.policy.profile_hash);
  assert.deepEqual(receipt.sources, vector.policy.sources);
  assert.equal(receipt.new_envelope_hash, canonicalHash(vector.envelope));
  const key = Buffer.from(vector.policy.key, "base64");
  assert.equal(key.length, 32);
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") },
    format: "jwk",
  });
  const proof = Buffer.from(vector.proof, "base64");
  assert.equal(proof.length, 64);
  assert(verify(null, Buffer.from(canonicalJson(receipt)), publicKey, proof));
  assert.equal(
    verify(null, Buffer.from(canonicalJson({ ...receipt, owner: "different" })), publicKey, proof),
    false,
  );
  assert(history.length >= 2 && history.length <= 3);
  assert.equal(receipt.previous_image_hash, sha(Buffer.from(history.at(-2).unsigned, "base64")));
  const exposure = new Map<string, bigint>();
  for (const [index, image] of history.entries()) {
    assert.equal(image.generation, index + 1);
    assert.equal(image.intent_hash, custodyIntentHash(intent));
    assert.equal(image.path, custodyPath(intent));
    assert.equal(image.execution.fee_bound_qualified, intent.network === "ethereum");
    const wire = Buffer.from(image.unsigned, "base64");
    let expected;
    let group: string, maximum: bigint;
    if (intent.network === "solana") {
      const envelope = {
        blockhash: encodeBase58(wire.subarray(228, 260)),
        computeUnits: wire.readUInt32LE(265),
        estimatedFee: image.execution.fee_exposure,
      };
      expected = solanaCustodyMessage(intent, envelope);
      assert.equal(expected.message, image.unsigned);
      assert.equal(image.payload, image.unsigned);
      assert.equal(image.execution.solana_blockhash, envelope.blockhash);
      assert.equal(image.execution.evm_nonce, null);
      assert.equal(
        image.envelope_hash,
        canonicalHash({
          blockhash: envelope.blockhash,
          compute_units: envelope.computeUnits,
          estimated_fee: envelope.estimatedFee,
          last_valid_block_height: image.execution.last_valid_block_height,
        }),
      );
      group = envelope.blockhash;
      maximum = BigInt(envelope.estimatedFee);
      assert(maximum >= 5000n);
      assert.equal(exposure.has(group), false, "Old blockhash cannot be reauthorized");
    } else {
      const tx = Transaction.from("0x" + wire.toString("hex"));
      const envelope = {
        nonce: tx.nonce,
        gasLimit: tx.gasLimit.toString(),
        maxFeePerGas: tx.maxFeePerGas!.toString(),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas!.toString(),
      };
      expected = evmCustodyTransaction(intent, envelope);
      assert.equal(expected.unsigned, "0x" + wire.toString("hex"));
      assert.equal(Buffer.from(image.payload, "base64").toString("hex"), expected.payload.slice(2));
      assert.equal(image.execution.evm_nonce, String(tx.nonce));
      assert.equal(image.execution.evm_max_fee, envelope.maxFeePerGas);
      assert.equal(image.execution.evm_priority_fee, envelope.maxPriorityFeePerGas);
      assert.equal(
        image.envelope_hash,
        canonicalHash({
          nonce: tx.nonce,
          gas_limit: Number(tx.gasLimit),
          max_fee_per_gas: envelope.maxFeePerGas,
          max_priority_fee_per_gas: envelope.maxPriorityFeePerGas,
        }),
      );
      group = String(tx.nonce);
      maximum = tx.gasLimit * tx.maxFeePerGas!;
    }
    assert.equal(image.execution.fee_exposure, maximum.toString());
    exposure.set(group, maximum > (exposure.get(group) ?? 0n) ? maximum : exposure.get(group)!);
    const reserved = [...exposure.values()].reduce((sum, value) => sum + value, 0n);
    assert.equal(image.reserved_fee, reserved.toString());
    assert(reserved <= BigInt(intent.feeCap));
  }
  assert.deepEqual(vector.image, history.at(-1));
  assert.equal(vector.image.recovery_witness.nonce, receipt.nonce);
}
console.log(
  "PASS: native Node verifies four sandbox recovery witnesses, typed image histories and non-replenishing fee reservations",
);
