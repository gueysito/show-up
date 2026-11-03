import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  attendanceSchedule,
  classifyAttendance,
  sandboxAttendancePacket,
  verifyAttendancePacket,
} from "../../src/server/attendance/evidence";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { settlementFixture } from "../fixtures/settlement";

const start = 1_800_000_000_000,
  end = start + 3_600_000;
const nonce = "a".repeat(64);

test("shared attendance windows preserve opening, grace, cutoff and hard recovery equality", () => {
  const times = attendanceSchedule(start, end);
  assert.equal(times.opensAt, start - 300_000);
  assert.equal(times.failNeutralAt, end + 2_100_000);
  assert.throws(() => classifyAttendance(start, end, times.opensAt - 1));
  for (const time of [times.opensAt, times.onTimeThrough])
    assert.equal(classifyAttendance(start, end, time), "on_time");
  for (const time of [times.onTimeThrough + 1, times.cutoff])
    assert.equal(classifyAttendance(start, end, time), "late");
  assert.throws(() => classifyAttendance(start, end, times.cutoff + 1));
  for (const bad of [NaN, Infinity, start + 0.1, -1, Number.MAX_SAFE_INTEGER])
    assert.throws(() => attendanceSchedule(bad, end));
  assert.throws(() => attendanceSchedule(start, start + 1_799_999));
  assert.throws(() => attendanceSchedule(start, start + 7_200_001));
});

function fixture(mode: "online" | "physical" = "online") {
  const f = settlementFixture(start - 900_000),
    event = f.views.event as Record<string, unknown>,
    terms = event.terms as Record<string, unknown>;
  terms.mode = mode;
  const material = { ...terms };
  delete material.rules_hash;
  f.context.rulesHash = canonicalHash({
    format: "showup.event.rules.v1",
    authorization_domain: f.context.domain,
    deployment: f.context.deployment,
    manifest: f.context.manifest,
    settlement_token: f.context.token,
    terms: material,
  });
  terms.rules_hash = f.context.rulesHash;
  f.context.authorization.rules_hash = f.context.rulesHash;
  (f.views.registration as Record<string, unknown>).authorization = structuredClone(
    f.context.authorization,
  );
  return f;
}

test("both proof classes bind validated escrow, original participant and receipt time without live authority", () => {
  for (const [mode, proof] of [
    ["online", "live_code"],
    ["physical", "staff_qr"],
  ] as const) {
    const f = fixture(mode),
      packet = sandboxAttendancePacket(f.context, f.views, f.block, proof, start, nonce);
    assert.equal(packet.classification, "on_time");
    assert.equal(packet.receipt.participant, f.context.authorization.participant);
    assert.equal(packet.receipt.registration, f.context.authorization.registration);
    assert.equal(packet.receipt.rules_hash, f.context.rulesHash);
    assert.equal(packet.receipt.received_ms, start);
    assert.equal(packet.receipt.expires_ms, start + 300_000);
    assert.equal(packet.status, "pending_contract");
    assert.equal(packet.sourceQualified, false);
    assert.equal(packet.liveSubmissionAllowed, false);
    assert.throws(() =>
      sandboxAttendancePacket(
        f.context,
        f.views,
        f.block,
        proof === "live_code" ? "staff_qr" : "live_code",
        start,
        nonce,
      ),
    );
    const terms = (f.views.event as Record<string, unknown>).terms as Record<string, number>;
    const cutoff = terms.end_ms - 900_000;
    assert.equal(
      sandboxAttendancePacket(f.context, f.views, f.block, proof, cutoff, nonce).receipt.expires_ms,
      cutoff + 300_000,
    );
  }
});

test("unfunded, released, changed, already-attended and live observations cannot produce sandbox evidence", () => {
  for (const state of ["reserved", "released", "return_only"]) {
    const f = fixture();
    (f.views.event as Record<string, unknown>).funded = [];
    (f.views.registration as Record<string, unknown>).state = state;
    assert.throws(() =>
      sandboxAttendancePacket(f.context, f.views, f.block, "live_code", start, nonce),
    );
  }
  const attended = fixture();
  (attended.views.registration as Record<string, unknown>).attendance = "on_time";
  (attended.views.event as Record<string, unknown>).attendance = 1;
  (attended.views.event as Record<string, unknown>).ledger_version = 2;
  assert.throws(() =>
    sandboxAttendancePacket(
      attended.context,
      attended.views,
      attended.block,
      "live_code",
      start,
      nonce,
    ),
  );
  const changed = fixture();
  changed.context.authorization.participant = "b".repeat(64);
  assert.throws(() =>
    sandboxAttendancePacket(
      changed.context,
      changed.views,
      changed.block,
      "live_code",
      start,
      nonce,
    ),
  );
  const live = settlementFixture(start - 900_000, "mainnet");
  assert.throws(() =>
    sandboxAttendancePacket(live.context, live.views, live.block, "live_code", start, nonce),
  );
  const f = fixture();
  for (const invalid of ["", "A".repeat(64), "a".repeat(63)])
    assert.throws(() =>
      sandboxAttendancePacket(f.context, f.views, f.block, "live_code", start, invalid),
    );
  assert.throws(() =>
    sandboxAttendancePacket(
      f.context,
      f.views,
      { ...f.block, timestampMs: start + 1 },
      "live_code",
      start,
      nonce,
    ),
  );
});

test("attendance signatures cover the exact schema and separate evidence key", () => {
  const f = fixture(),
    packet = sandboxAttendancePacket(f.context, f.views, f.block, "live_code", start, nonce),
    evidence = generateKeyPairSync("ed25519"),
    credential = generateKeyPairSync("ed25519");
  const publicKey = evidence.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
    signature = sign(null, Buffer.from(packet.canonical), evidence.privateKey).toString("base64");
  assert.equal(verifyAttendancePacket(packet, packet.receipt, signature, publicKey), true);
  assert.equal(
    verifyAttendancePacket(
      packet,
      packet.receipt,
      sign(null, Buffer.from(packet.canonical), credential.privateKey).toString("base64"),
      publicKey,
    ),
    false,
  );
  for (const field of Object.keys(packet.receipt)) {
    const changed = { ...packet.receipt, [field]: "changed" };
    assert.equal(verifyAttendancePacket(packet, changed, signature, publicKey), false);
  }
  assert.equal(
    verifyAttendancePacket(packet, { ...packet.receipt, funded: true }, signature, publicKey),
    false,
  );
  assert.equal(verifyAttendancePacket(packet, packet.receipt, signature + "=", publicKey), false);
});
