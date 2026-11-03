import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractAuthorization } from "../src/server/commitments/contract-authorization";
import { verifyCommitmentConsent, type ConsentProfile } from "../src/server/commitments/consent";
import { validateSettlementState } from "../src/server/protocol/settlement-state";

const vectors = [];
for (const path of [
  "contracts/.cache/financial-consent-public.json",
  "contracts/.cache/engineering-financial-consent-public.json",
]) {
  const bytes = await readFile(path);
  if (bytes.length > 262144) throw new Error("Oversized public financial vectors");
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 4)
    throw new Error("Missing actual financial-consent vectors");
  vectors.push(...parsed);
}
for (const vector of vectors) {
  const auth = vector.context.authorization;
  const envelope = JSON.parse(auth.wallet_consent);
  assert(["sandbox", "engineering"].includes(vector.context.environment));
  const profile: ConsentProfile = {
    environment: vector.context.environment,
    manifest: vector.context.manifest,
    token: vector.context.token,
  };
  assert(
    verifyCommitmentConsent(
      envelope.consent,
      envelope.proof,
      "https://localhost:3443",
      envelope.acceptedAt,
      profile,
    ),
  );
  assert.equal(
    verifyCommitmentConsent(
      envelope.consent,
      envelope.proof,
      "https://localhost:3443",
      envelope.acceptedAt,
    ),
    false,
  );
  const wire = contractAuthorization(
    "https://localhost:3443",
    envelope.consent,
    envelope.proof,
    envelope.acceptedAt,
    profile,
  );
  assert.deepEqual(
    wire.authorization,
    auth,
    "Independent app wire differs from the authorization that funded actual sandbox escrow",
  );
  assert.equal(wire.fundingAllowed, false);
  const facts = validateSettlementState(vector.context, vector.views, vector.block);
  assert.equal(facts.sourceQualified, false);
  if (vector.stage === "reserved") assert.equal(facts.registration?.booked, false);
  if (vector.stage === "funded_after_reservation") {
    assert.equal(facts.registration?.booked, true);
    assert(vector.block.timestampMs > envelope.consent.terms.reservationExpiresAt);
    assert(vector.block.timestampMs < envelope.consent.terms.authorizationExpiresAt);
  }
  if (vector.stage === "released") assert.equal(facts.principal?.remaining, "5000000");
  if (vector.stage === "paid_principal") assert.equal(facts.principal?.remaining, "0");
  const changed = structuredClone(envelope.consent);
  changed.terms.payout.address = "attacker.near";
  assert.equal(
    verifyCommitmentConsent(
      changed,
      envelope.proof,
      "https://localhost:3443",
      envelope.acceptedAt,
      profile,
    ),
    false,
  );
}
console.log(
  "PASS: independent Node verifies sandbox and pinned engineering-domain financial signatures/wire across actual local reservation, funding, release and return states",
);
