import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  contractAuthorization,
  routedCommitmentReference,
} from "../src/server/commitments/contract-authorization";
import { verifyCommitmentConsent } from "../src/server/commitments/consent";
import { canonicalHash } from "../src/server/protocol/canonical";
import { decodeBase58 } from "../src/server/protocol/encoding";
import { quoteMessage, verifyQuoteSignature } from "../src/server/protocol/quote-signature";

const bytes = await readFile("contracts/.cache/routed-funding-public.json");
if (bytes.length > 262144) throw new Error("Oversized public routed funding vectors");
const vectors = JSON.parse(bytes.toString("utf8"));
assert(Array.isArray(vectors));
assert.deepEqual(
  vectors.map((vector) => vector.network),
  ["near", "base", "ethereum", "solana"],
);
for (const vector of vectors) {
  const auth = vector.authorization;
  const envelope = JSON.parse(auth.wallet_consent);
  assert(
    verifyCommitmentConsent(
      envelope.consent,
      envelope.proof,
      "https://localhost:3443",
      envelope.acceptedAt,
      vector.profile,
    ),
  );
  const wire = contractAuthorization(
    "https://localhost:3443",
    envelope.consent,
    envelope.proof,
    envelope.acceptedAt,
    vector.profile,
  );
  assert.deepEqual(wire.authorization, auth);
  assert.equal(wire.fundingAllowed, false);
  assert(verifyQuoteSignature(vector.quote, vector.quoteKey));
  assert.equal(verifyQuoteSignature(vector.quote), false, "Fixture key became a real provider key");
  const quoteHash = decodeBase58(quoteMessage(vector.quote).toString("utf8"), 32).toString("hex");
  assert.equal(quoteHash, envelope.consent.terms.quoteHash);
  assert.equal(vector.binding.quote_hash, quoteHash);
  assert.equal(vector.binding.authorization_hash, canonicalHash(auth));
  assert.equal(vector.binding.deposit_address, vector.quote.quote.depositAddress);
  assert.equal(
    vector.quote.quoteRequest.customRecipientMsg,
    routedCommitmentReference(envelope.consent.terms.registration),
  );
  assert.equal(vector.binding.quote_deadline_ms, Date.parse(vector.quote.quote.deadline));
  assert.equal(vector.principal.total, "5000000");
  assert.equal(vector.principal.paid, "5000000");
  assert.deepEqual(vector.principal.destination, auth.payout);
  assert.equal(vector.accounting.received, "5000000");
  assert.equal(vector.accounting.delivered, "5000000");
  assert.equal(vector.accounting.owed, "0");
  assert.equal(vector.accounting.unallocated, "0");
}
console.log(
  "PASS: independent app wire, four wallet signatures and provider quote hashes match actual local routed receipts and original principal returns; public funding remains disabled",
);
