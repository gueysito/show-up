import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateSettlementState } from "../src/server/protocol/settlement-state";

const bytes = await readFile("contracts/.cache/settlement-state-public.json");
if (bytes.length > 262144) throw new Error("Oversized settlement vectors");
const vectors = JSON.parse(bytes.toString("utf8"));
if (!Array.isArray(vectors) || vectors.length !== 9)
  throw new Error("Missing actual sandbox settlement states");
const states = new Map(
  vectors.map((vector) => [
    vector.stage,
    validateSettlementState(vector.context, vector.views, vector.block),
  ]),
);
assert.equal(states.get("absent")?.registration, null);
assert.equal(states.get("reserved")?.registration?.booked, false);
assert(states.get("reserved")?.registration?.reservedUntil);
assert.equal(states.get("short_return")?.returned?.remaining, "2000000");
assert.equal(states.get("short_return")?.registration?.booked, false);
assert.equal(states.get("funded_excess")?.registration?.booked, true);
assert.equal(states.get("funded_excess")?.returned?.remaining, "3000000");
assert.equal(states.get("duplicate_return")?.returned?.remaining, "8000000");
assert.equal(states.get("released")?.registration?.booked, false);
assert.equal(states.get("failed_principal")?.principal?.remaining, "5000000");
assert.equal(states.get("failed_principal")?.principal?.attempts, "1");
assert.equal(states.get("paid_principal")?.principal?.remaining, "0");
assert.equal(states.get("paid_return")?.returned?.remaining, "0");
assert.equal(states.get("paid_return")?.tokenBalance, "0");
for (const vector of vectors) {
  const state = validateSettlementState(vector.context, vector.views, vector.block);
  assert.equal(state.fundingAllowed, false);
  assert.equal(state.sourceQualified, false);
  const changed = structuredClone(vector);
  changed.views.tokenBalance = "0";
  if (state.tokenBalance !== "0")
    assert.throws(() => validateSettlementState(changed.context, changed.views, changed.block));
  if (vector.views.registration) {
    changed.views = structuredClone(vector.views);
    changed.views.registration.authorization.payout.address = "attacker.near";
    assert.throws(() => validateSettlementState(changed.context, changed.views, changed.block));
  }
}
console.log(
  "PASS: independent Node replay of nine actual sandbox settlement states, capacity, conservation and refund retry",
);
