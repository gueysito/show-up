import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyAssetObservation } from "../src/server/protocol/asset-observation";

const bytes = await readFile("contracts/.cache/asset-observations-public.json");
if (bytes.length > 65536) throw new Error("Oversized public observation fixtures");
const vectors = JSON.parse(bytes.toString("utf8"));
if (!Array.isArray(vectors) || vectors.length !== 3)
  throw new Error("Missing external network fixtures");
for (const vector of vectors) {
  for (const kind of ["holding", "delivered"]) {
    const receipt = vector[kind];
    const proof = vector[`${kind}_proof`];
    const context = vector.context;
    assert(verifyAssetObservation(receipt, proof, context, receipt.observed_ms));
    for (const field of Object.keys(receipt)) {
      const changed = { ...receipt, [field]: field === "finalized" ? false : "changed" };
      assert.equal(
        verifyAssetObservation(changed, proof, context, receipt.observed_ms),
        false,
        field,
      );
    }
    assert.equal(
      verifyAssetObservation(
        receipt,
        proof,
        { ...context, event: "0".repeat(64) },
        receipt.observed_ms,
      ),
      false,
    );
    assert.equal(verifyAssetObservation(receipt, proof, context, receipt.expires_ms), false);
  }
}
console.log(
  "PASS: independent Node verification replays sandbox observer signatures and rejects changed fields/context/expiry",
);
