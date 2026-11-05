import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { validDraft } from "../fixtures/draft";
import { validateDraft } from "../../src/domain/event-draft";
import { v1DraftTerms } from "../../src/server/events/v1-publication";
import { matchesV1Terms, v1Deployment } from "../../src/server/protocol/v1-escrow";

test("V1 publication converts only bounded saved rules and never inherits V2 reward promises", () => {
  const id = randomUUID();
  const data = { ...validDraft(), capacity: 2, commitment: "1", sponsorBudget: "0" };
  const terms = v1DraftTerms(id, data);
  assert.equal(terms.deposit, "1000000");
  assert.equal(terms.sponsor, v1Deployment.account);
  assert.equal(terms.prize, "0");
  assert.equal(terms.nft, null);
  assert.equal(terms.id, id);
  for (const change of [
    { capacity: 65 },
    { commitment: "0.999999" },
    { commitment: "100.000001" },
    { sponsorBudget: "1" },
    { title: "😀".repeat(60) },
    { startsAt: new Date(0).toISOString() },
  ])
    assert.throws(() => v1DraftTerms(id, { ...data, ...change }));
  assert.equal(
    validateDraft({ ...data, commitment: "1" }).ok,
    false,
    "V2 validation must stay unchanged",
  );
  assert.equal(
    validateDraft({ ...data, capacity: 64, commitment: "100" }, Date.now(), "v1").ok,
    true,
  );
  const event = { ...terms, status: "published", funded: [], winner: null, prize_received: true };
  assert.equal(matchesV1Terms(event, terms), true);
  for (const change of [
    { capacity: 1 },
    { deposit: "2000000" },
    { sponsor: "attacker.near" },
    { end_ms: terms.end_ms + 1 },
  ])
    assert.equal(matchesV1Terms({ ...event, ...change }, terms), false);
});
