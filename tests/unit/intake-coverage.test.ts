import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  intakeCoverageProfile,
  intakeCoverageRequirements,
  verifyIntakeCoverage,
  type IntakeCoveragePacket,
  type IntakeAggregate,
} from "../../src/server/attendance/coverage";
import { canonicalHash, canonicalJson } from "../../src/server/protocol/canonical";
import { settlementFixture } from "../fixtures/settlement";
import { AppFailure } from "../../src/server/http/security";

function vector(mode: "online" | "physical" = "online") {
  const source = settlementFixture(),
    terms = (source.views.event as { terms: { start_ms: number } }).terms,
    profile = { ...intakeCoverageProfile(source, terms.start_ms - 600_000, terms.start_ms), mode },
    key = generateKeyPairSync("ed25519"),
    publicKey = Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url").toString(
      "base64",
    );
  const known: NonNullable<IntakeAggregate> = {
      revision: "4",
      received: mode === "online" ? "2" : "3",
      pending: "0",
      hadUnavailable: false,
      channels: {
        code_entry: mode === "online" ? "2" : "0",
        qr_issue: mode === "online" ? "0" : "1",
        qr_scan: mode === "online" ? "0" : "1",
        presence_confirmation: mode === "online" ? "0" : "1",
      },
    },
    now = profile.cutoffMs + 300_000;
  const packet: IntakeCoveragePacket = {
    format: "showup.intake.coverage.v1",
    profile,
    intakeHash: canonicalHash(known),
    observedAtMs: now,
    expiresMs: profile.expiresMs,
    intervals: intakeCoverageRequirements(profile).map((requirement) => {
      const count =
        requirement.channel in known.channels
          ? known.channels[requirement.channel as keyof typeof known.channels]
          : "1";
      return {
        ...requirement,
        received: count,
        resolved: count,
        unavailable: "0",
        traceHash: "a".repeat(64),
      };
    }),
  };
  const signed = (value: unknown = packet) => ({
    packet: value,
    signature: sign(null, Buffer.from(canonicalJson(value)), key.privateKey).toString("base64"),
  });
  return {
    profile,
    key,
    publicKey,
    known,
    now,
    packet,
    signed,
    verify: (value: unknown = signed(), at = now) =>
      verifyIntakeCoverage(profile, known, value, publicKey, at),
  };
}
const rejected = (error: unknown) => error instanceof AppFailure && error.status === 409;
test("event-bound signed coverage requires every mode-specific channel and returns detached evidence", () => {
  for (const mode of ["online", "physical"] as const) {
    const f = vector(mode),
      input = f.signed(),
      result = f.verify(input);
    assert.deepEqual(result, input);
    assert.notEqual(result.packet, input.packet);
    assert.equal(f.verify(undefined, f.profile.expiresMs).packet.expiresMs, f.profile.expiresMs);
    assert.throws(() => f.verify(undefined, f.profile.expiresMs + 1), rejected);
  }
});
test("even valid signatures cannot substitute event scope, profile, known intake, clock or expiry", () => {
  const f = vector();
  for (const change of [
    (p: IntakeCoveragePacket) => {
      p.profile.event = "b".repeat(64);
    },
    (p: IntakeCoveragePacket) => {
      p.profile.rulesHash = "b".repeat(64);
    },
    (p: IntakeCoveragePacket) => {
      p.profile.domain = "other";
    },
    (p: IntakeCoveragePacket) => {
      p.profile.deployment = "other.near";
    },
    (p: IntakeCoveragePacket) => {
      p.profile.manifest = "other";
    },
    (p: IntakeCoveragePacket) => {
      p.profile.mode = "physical";
    },
    (p: IntakeCoveragePacket) => {
      p.intakeHash = "b".repeat(64);
    },
    (p: IntakeCoveragePacket) => {
      p.observedAtMs = f.now + 1;
    },
    (p: IntakeCoveragePacket) => {
      p.observedAtMs = f.profile.cutoffMs - 1;
    },
    (p: IntakeCoveragePacket) => {
      p.expiresMs++;
    },
  ]) {
    const packet = structuredClone(f.packet);
    change(packet);
    assert.throws(() => f.verify(f.signed(packet)), rejected);
  }
  const wrong = generateKeyPairSync("ed25519");
  assert.throws(
    () =>
      f.verify({
        packet: f.packet,
        signature: sign(null, Buffer.from(canonicalJson(f.packet)), wrong.privateKey).toString(
          "base64",
        ),
      }),
    rejected,
  );
  assert.throws(() => f.verify({ ...f.signed(), signature: "bad" }), rejected);
});
test("missing, overlapping, gapped and regressing channel intervals cannot become complete coverage", () => {
  const f = vector(),
    index = f.packet.intervals.findIndex((value) => value.channel === "code_entry"),
    original = f.packet.intervals[index],
    mid = Math.floor((original.fromMs + original.throughMs) / 2);
  const sequences = [
    [],
    [original, original],
    [
      { ...original, throughMs: mid },
      { ...original, fromMs: mid + 1 },
    ],
    [
      { ...original, throughMs: mid },
      { ...original, fromMs: mid - 1 },
    ],
    [
      { ...original, throughMs: mid, received: "2", resolved: "1" },
      { ...original, fromMs: mid, received: "1", resolved: "1" },
    ],
    [{ ...original, unavailable: "1" }],
    [{ ...original, resolved: "1" }],
    [{ ...original, received: "1", resolved: "1" }],
    [{ ...original, received: "01" }],
    [{ ...original, received: "18446744073709551616" }],
    [{ ...original, traceHash: "bad" }],
  ];
  for (const sequence of sequences) {
    const packet = structuredClone(f.packet);
    packet.intervals.splice(index, 1, ...sequence);
    assert.throws(() => f.verify(f.signed(packet)), rejected);
  }
  const healthy = structuredClone(f.packet);
  healthy.intervals.splice(
    index,
    1,
    { ...original, throughMs: mid, resolved: "0" },
    { ...original, fromMs: mid },
  );
  assert.doesNotThrow(() => f.verify(f.signed(healthy)));
});
test("traffic from another channel cannot hide omitted known presence work", () => {
  const f = vector("physical"),
    packet = structuredClone(f.packet);
  for (const interval of packet.intervals) {
    if (interval.channel === "qr_issue") interval.received = interval.resolved = "3";
    if (interval.channel === "qr_scan" || interval.channel === "presence_confirmation")
      interval.received = interval.resolved = "0";
  }
  assert.throws(() => f.verify(f.signed(packet)), rejected);
  const unavailable = { ...f.known, hadUnavailable: true };
  assert.throws(
    () =>
      verifyIntakeCoverage(
        f.profile,
        unavailable,
        f.signed({ ...f.packet, intakeHash: canonicalHash(unavailable) }),
        f.publicKey,
        f.now,
      ),
    rejected,
  );
  const pending = { ...f.known, pending: "1" };
  assert.throws(
    () =>
      verifyIntakeCoverage(
        f.profile,
        pending,
        f.signed({ ...f.packet, intakeHash: canonicalHash(pending) }),
        f.publicKey,
        f.now,
      ),
    rejected,
  );
});
test("coverage decoding bounds shape, interval count, integer counters and published windows", () => {
  const f = vector();
  for (const value of [
    null,
    {},
    [],
    { ...f.signed(), liveSubmissionAllowed: true },
    f.signed({ ...f.packet, healthy: true }),
    f.signed({ ...f.packet, intervals: Array.from({ length: 129 }, () => f.packet.intervals[0]) }),
    { packet: f.packet, signature: f.signed().signature.slice(0, -1) },
  ])
    assert.throws(() => f.verify(value), rejected);
  const maximum = vector();
  maximum.known.revision =
    maximum.known.received =
    maximum.known.channels.code_entry =
      "18446744073709551615";
  maximum.packet.intakeHash = canonicalHash(maximum.known);
  const interval = maximum.packet.intervals.find((value) => value.channel === "code_entry")!;
  interval.received = interval.resolved = maximum.known.received;
  assert.doesNotThrow(() => maximum.verify());
  const source = settlementFixture(),
    terms = (source.views.event as { terms: { start_ms: number } }).terms;
  assert.throws(() => intakeCoverageProfile(source, terms.start_ms + 1, terms.start_ms), rejected);
  assert.throws(() => intakeCoverageProfile(source, 0, terms.start_ms + 1), rejected);
  assert.throws(
    () => intakeCoverageProfile(source, terms.start_ms - 600_000, terms.start_ms - 1),
    rejected,
  );
});
