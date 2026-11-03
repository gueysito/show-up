import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  evmCustodyTransaction,
  solanaCustodyMessage,
  type CustodyIntent,
} from "../src/server/protocol/custody-transactions";

const bytes = await readFile("contracts/.cache/custody-images-public.json");
if (bytes.length > 65536) throw new Error("Oversized public custody fixtures");
const vectors = JSON.parse(bytes.toString("utf8"));
if (!Array.isArray(vectors) || vectors.length !== 3)
  throw new Error("Missing required network fixtures");
for (const vector of vectors) {
  const intent = vector.intent as CustodyIntent;
  if (intent.environment !== "engineering") throw new Error("Expected sandbox fixture");
  const raw = vector.envelope;
  const actual = vector.image;
  assert.equal(actual.generation, 1);
  assert.equal(actual.reserved_fee, actual.execution.fee_exposure);
  assert.equal(actual.execution.fee_bound_qualified, intent.network === "ethereum");
  if (intent.network === "solana") {
    const expected = solanaCustodyMessage(intent, {
      blockhash: raw.blockhash,
      computeUnits: raw.compute_units,
      estimatedFee: raw.estimated_fee,
    });
    assert.equal(actual.unsigned, expected.message);
    assert.equal(actual.payload, expected.message);
    assert.equal(actual.intent_hash, expected.intentHash);
    assert.equal(actual.path, expected.path);
    assert.equal(actual.scheme, expected.scheme);
    assert.equal(actual.reserved_fee, raw.estimated_fee);
    assert.equal(actual.execution.last_valid_block_height, raw.last_valid_block_height);
    assert.equal(actual.execution.solana_blockhash, raw.blockhash);
    assert.equal(actual.execution.evm_nonce, null);
  } else {
    const expected = evmCustodyTransaction(intent, {
      nonce: raw.nonce,
      gasLimit: String(raw.gas_limit),
      maxFeePerGas: raw.max_fee_per_gas,
      maxPriorityFeePerGas: raw.max_priority_fee_per_gas,
    });
    assert.equal(
      Buffer.from(actual.unsigned, "base64").toString("hex"),
      expected.unsigned.slice(2),
    );
    assert.equal(Buffer.from(actual.payload, "base64").toString("hex"), expected.payload.slice(2));
    assert.equal(actual.intent_hash, expected.intentHash);
    assert.equal(actual.path, expected.path);
    assert.equal(actual.scheme, expected.scheme);
    assert.equal(
      actual.reserved_fee,
      (BigInt(raw.gas_limit) * BigInt(raw.max_fee_per_gas)).toString(),
    );
    assert.equal(actual.execution.evm_nonce, String(raw.nonce));
    assert.equal(actual.execution.evm_max_fee, raw.max_fee_per_gas);
    assert.equal(actual.execution.evm_priority_fee, raw.max_priority_fee_per_gas);
    assert.equal(actual.execution.solana_blockhash, null);
  }
}
console.log(
  "PASS: independent Node construction matches sandbox EVM/Solana signing images and frozen paths",
);
