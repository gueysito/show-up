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
  }
}
console.log(
  "PASS: independent Node construction matches sandbox EVM/Solana signing images and frozen paths",
);
