import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { quoteMessage, verifyQuoteSignature } from "../src/server/protocol/quote-signature";
import { canonicalJson } from "../src/server/protocol/canonical";
import { createHash } from "node:crypto";
import { encodeBase58 } from "../src/server/protocol/encoding";

const bytes = await readFile("contracts/.cache/routing-quote-public.json");
if (bytes.length > 65_536) throw new Error("Oversized public routing quote vector");
const vector = JSON.parse(bytes.toString("utf8"));
assert(verifyQuoteSignature(vector.response));
assert.equal(vector.inspection.provider_message, quoteMessage(vector.response).toString("utf8"));
assert.equal(vector.inspection.selected.amountIn, vector.response.quote.amountIn);
assert.equal(vector.inspection.selected.minAmountOut, vector.response.quote.minAmountOut);
assert.equal(vector.inspection.request_deadline, vector.response.quoteRequest.deadline);
assert.equal(vector.inspection.request_deadline_authenticated, true);
for (const field of ["funding_allowed", "freshness_checked", "expected_request_checked"])
  assert.equal(vector.inspection[field], false);
for (const field of ["refundFee", "withdrawFee", "appFees"])
  assert.equal(field in vector.inspection.selected, false);
const wetBytes = await readFile("contracts/.cache/routing-quote-wet-fields-public.json");
if (wetBytes.length > 65_536) throw new Error("Oversized synthetic wet quote vector");
const wet = JSON.parse(wetBytes.toString("utf8"));
assert.equal(
  verifyQuoteSignature(wet.response),
  false,
  "Wet fields are synthetic, never an actual provider quote",
);
assert.equal(
  encodeBase58(createHash("sha256").update(canonicalJson(wet.selected)).digest()),
  quoteMessage(wet.response).toString("utf8"),
);
const overwritten = structuredClone(wet.response);
overwritten.quoteRequest.deadline = "2099-01-01T00:00:00Z";
assert.deepEqual(quoteMessage(overwritten), quoteMessage(wet.response));
console.log(
  "PASS: native Node independently reproduces the sandbox's actual provider quote authentication; funding remains disabled",
);
