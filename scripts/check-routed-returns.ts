import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { contractAuthorization } from "../src/server/commitments/contract-authorization";
import { assessPayout } from "../src/server/commitments/consent";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import { decodeBase58 } from "../src/server/protocol/encoding";
import { quoteMessage, verifyQuoteSignature } from "../src/server/protocol/quote-signature";

const vectors = [];
for (const file of ["routed-return-public.json", "routed-return-recovery-public.json"]) {
  const bytes = await readFile(`contracts/.cache/${file}`);
  if (bytes.length > 262144) throw new Error("Oversized public return vectors");
  const parsed = JSON.parse(bytes.toString("utf8"));
  assert(Array.isArray(parsed));
  vectors.push(...parsed);
}
assert.equal(vectors.length, 11);
assert.deepEqual(
  [...new Set(vectors.map((v) => v.authorization.payout.network))],
  ["base", "ethereum", "solana"],
);
for (const vector of vectors) {
  const envelope = JSON.parse(vector.authorization.wallet_consent);
  const wire = contractAuthorization(
    "https://localhost:3443",
    envelope.consent,
    envelope.proof,
    envelope.acceptedAt,
    vector.profile,
  );
  assert.deepEqual(wire.authorization, vector.authorization);
  assert.equal(wire.fundingAllowed, false);
  assert(verifyQuoteSignature(vector.quote, vector.quoteKey));
  assert.equal(verifyQuoteSignature(vector.quote), false);
  const quoteHash = decodeBase58(quoteMessage(vector.quote).toString("utf8"), 32).toString("hex");
  const last = vector.ledger.attempts.at(-1);
  assert.equal(last.quote_hash, quoteHash);
  assert.deepEqual(last.destination, vector.authorization.payout);
  assert.equal(last.deposit, vector.quote.quote.depositAddress);
  assert.equal(vector.quote.quoteRequest.refundTo, vector.authorization.deployment);
  assert.equal(vector.quote.quoteRequest.recipient, last.destination.address);
  assert.equal(last.gross, vector.quote.quote.amountIn);
  assert.equal(last.minimum_net, vector.quote.quote.minAmountOut);
  const image = (attempt: typeof last) =>
    canonicalHash({
      format: "showup.routed-return.image.v1",
      ...Object.fromEntries(
        [
          "number",
          "liability",
          "quote_hash",
          "deposit",
          "destination",
          "gross",
          "quoted_net",
          "minimum_net",
          "refund_fee",
          "deadline_ms",
        ].map((key) => [key, attempt[key]]),
      ),
    });
  let fees = 0n;
  for (const attempt of vector.ledger.attempts) {
    if (!["delivered", "refunded"].includes(attempt.state)) continue;
    assert.equal(attempt.observation.image_hash, image(attempt));
    const fee = BigInt(attempt.gross) - BigInt(attempt.observation.amount);
    assert(fee >= 0n);
    fees += fee;
  }
  assert.equal(fees.toString(), vector.ledger.fees_used);
  assert(fees <= BigInt(vector.authorization.fee_cap));
  const accounting = vector.accounting;
  assert.equal(
    BigInt(vector.tokenBalance) + BigInt(accounting.routed_in_flight ?? "0"),
    BigInt(accounting.owed) + BigInt(accounting.unallocated),
  );
  assert.equal(
    BigInt(accounting.received),
    BigInt(accounting.delivered) + BigInt(accounting.owed) + BigInt(accounting.unallocated),
  );
  if (vector.stage === "delivered") {
    assert.equal(vector.principal.paid, "5000000");
    assert.equal(vector.principal.pending, null);
    const receipt = last.observation;
    assert.equal(receipt.image_hash, image(last));
    const publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(vector.observerKey, "base64").toString("base64url"),
      },
      format: "jwk",
    });
    assert(
      verify(
        null,
        Buffer.from(canonicalJson(receipt)),
        publicKey,
        Buffer.from(vector.proof, "base64"),
      ),
    );
    const fee = (BigInt(last.gross) - BigInt(receipt.amount)).toString();
    assert.equal(
      assessPayout(envelope.consent, last.gross, fee, last.minimum_net, vector.profile).state,
      "within_limits",
    );
  }
}
console.log(
  "PASS: independent Node matches routed return images, original consent, cumulative fees and actual sandbox cash/in-flight conservation; destination witnesses remain synthetic and unqualified",
);
