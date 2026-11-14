import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sandboxAttendancePacket, verifyAttendancePacket } from "../src/server/attendance/evidence";
import { validateSettlementState } from "../src/server/protocol/settlement-state";

const bytes = await readFile("contracts/.cache/attendance-evidence-public.json");
if (bytes.length > 262144) throw new Error("Oversized public attendance vectors");
const vectors = JSON.parse(bytes.toString("utf8"));
if (!Array.isArray(vectors) || vectors.length !== 4)
  throw new Error("Missing actual sandbox attendance evidence");
const exercised = new Set<string>();
for (const vector of vectors) {
  const { before, receipt, returned } = vector;
  const packet = sandboxAttendancePacket(
    before.context,
    before.views,
    before.block,
    receipt.proof_class,
    receipt.received_ms,
    receipt.nonce,
  );
  assert.deepEqual(packet.receipt, receipt);
  assert.equal(packet.classification, vector.result);
  assert.equal(
    verifyAttendancePacket(packet, receipt, vector.proof, vector.evidencePublicKey),
    true,
  );
  assert.equal(packet.status, "pending_contract");
  assert.equal(packet.liveSubmissionAllowed, false);
  const settled = validateSettlementState(returned.context, returned.views, returned.block);
  assert.equal(settled.registration?.attendance, packet.classification);
  assert.equal(settled.registration?.state, "refund_owed");
  assert.equal(settled.principal?.gross, "5000000");
  assert.equal(settled.principal?.remaining, "0");
  assert.equal(settled.sourceQualified, false);
  assert.throws(() =>
    sandboxAttendancePacket(
      returned.context,
      returned.views,
      returned.block,
      receipt.proof_class,
      receipt.received_ms,
      receipt.nonce,
    ),
  );
  exercised.add(`${receipt.proof_class}:${vector.result}`);
}
assert.deepEqual([...exercised].sort(), [
  "live_code:late",
  "live_code:on_time",
  "staff_qr:late",
  "staff_qr:on_time",
]);
console.log(
  "PASS: independent Node attendance wire/signatures and four actual sandbox on-time/late principal returns across both proof classes",
);
