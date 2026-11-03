import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { computeAddress, recoverAddress, Signature, Transaction } from "ethers";
import {
  custodyIntentHash,
  custodyPath,
  evmCustodyTransaction,
  solanaCustodyMessage,
  type CustodyIntent,
} from "../src/server/protocol/custody-transactions";
import { decodeBase58, encodeBase58 } from "../src/server/protocol/encoding";
import abi from "../manifests/signing-interface.v1.json";

const bytes = await readFile("contracts/.cache/custody-signatures-public.json");
assert(bytes.length < 65536);
const vectors = JSON.parse(bytes.toString("utf8"));
assert(Array.isArray(vectors) && vectors.length === 3);
assert.deepEqual(vectors.map((item) => item.network).sort(), ["base", "ethereum", "solana"]);
assert.equal(abi.fundingAllowed, false);
assert.equal(abi.liveProviderVerified, false);
assert.equal(abi.providerCallsPerImage, 1);
for (const vector of vectors) {
  const intent = vector.intent as CustodyIntent;
  const { image, binding, request, provider_trace: trace, response } = vector;
  const unsigned = Buffer.from(image.unsigned, "base64");
  const payload = Buffer.from(image.payload, "base64");
  const signature = Buffer.from(request.signature, "base64");
  assert.equal(intent.environment, "engineering");
  assert.equal(intent.network, vector.network);
  assert.equal(image.intent_hash, custodyIntentHash(intent));
  assert.equal(image.path, custodyPath(intent));
  assert.equal(binding.path, image.path);
  assert.equal(binding.state, "verified");
  assert.equal(request.state, "signed");
  assert.equal(request.provider, binding.provider);
  assert.equal(request.public_key, binding.public_key);
  assert.equal(request.path, binding.path);
  assert.equal(request.domain_id, binding.domain_id);
  assert.equal(request.payload, image.payload);
  assert.equal(request.event, intent.event);
  assert.equal(request.image_hash, createHash("sha256").update(unsigned).digest("hex"));
  assert.equal(trace.calls, abi.providerCallsPerImage);
  assert.equal(trace.last.caller, intent.deployment);
  assert.equal(trace.last.deposit, abi.signDepositYoctoNear);
  assert.deepEqual(trace.last.request, {
    domain_id: request.domain_id,
    path: custodyPath(intent),
    payload_v2: { [image.scheme]: payload.toString("hex") },
  });
  if (intent.network === "solana") {
    assert.equal(binding.domain_id, abi.eddsaDomain);
    assert.equal(signature.length, 64);
    assert.equal(binding.public_key, `ed25519:${intent.source}`);
    assert.deepEqual(payload, unsigned);
    assert.deepEqual(signature, Buffer.from(response.signature));
    assert.equal(response.scheme, "Ed25519");
    const expected = solanaCustodyMessage(intent, {
      blockhash: image.execution.solana_blockhash,
      computeUnits: unsigned.readUInt32LE(265),
      estimatedFee: image.execution.fee_exposure,
    });
    assert.equal(expected.message, image.unsigned);
    const publicKey = createPublicKey({
      format: "jwk",
      key: { kty: "OKP", crv: "Ed25519", x: decodeBase58(intent.source, 32).toString("base64url") },
    });
    assert(verify(null, unsigned, publicKey, signature));
    assert.equal(request.transaction, encodeBase58(signature));
    assert.deepEqual(
      Buffer.from(request.signed_transaction, "base64"),
      Buffer.concat([Buffer.from([1]), signature, unsigned]),
    );
    const changed = Buffer.from(unsigned);
    changed[changed.length - 1] ^= 1;
    assert(!verify(null, changed, publicKey, signature));
  } else {
    assert.equal(binding.domain_id, abi.ecdsaDomain);
    assert.equal(signature.length, 65);
    assert.equal(response.scheme, "Secp256k1");
    const key = decodeBase58(binding.public_key.slice("secp256k1:".length), 64);
    assert.equal(computeAddress(`0x04${key.toString("hex")}`).toLowerCase(), intent.source);
    const tx = Transaction.from("0x" + unsigned.toString("hex"));
    const expected = evmCustodyTransaction(intent, {
      nonce: tx.nonce,
      gasLimit: tx.gasLimit.toString(),
      maxFeePerGas: tx.maxFeePerGas!.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas!.toString(),
    });
    assert.equal(expected.unsigned, tx.unsignedSerialized);
    assert.equal(expected.payload, "0x" + payload.toString("hex"));
    const parity = signature[64];
    assert(parity === 0 || parity === 1);
    const parsed = Signature.from({
      r: "0x" + signature.subarray(0, 32).toString("hex"),
      s: "0x" + signature.subarray(32, 64).toString("hex"),
      yParity: parity,
    });
    assert.equal(
      response.big_r.affine_point,
      (2 + parsed.yParity).toString(16).padStart(2, "0") + parsed.r.slice(2),
    );
    assert.equal(response.s.scalar, parsed.s.slice(2));
    assert.equal(response.recovery_id, parsed.yParity);
    assert.equal(recoverAddress(expected.payload, parsed).toLowerCase(), intent.source);
    assert.notEqual(recoverAddress("0x" + "01".repeat(32), parsed).toLowerCase(), intent.source);
    tx.signature = parsed;
    assert.equal(tx.from!.toLowerCase(), intent.source);
    assert.equal(request.transaction, tx.hash);
    assert.equal(
      Buffer.from(request.signed_transaction, "base64").toString("hex"),
      tx.serialized.slice(2),
    );
  }
}
console.log(
  "PASS: independent Node verifies sandbox provider ABI traces, fixed paths, ECDSA/Ed25519 signatures and exact signed transactions",
);
