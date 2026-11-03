import { createPublicKey, verify } from "node:crypto";
import { AppFailure } from "../http/security";
import { canonicalHash, canonicalJson } from "../protocol/canonical";
import type { SandboxAttendanceObservation } from "./admission";
import { attendanceSchedule } from "./evidence";

export type IntakeAggregate = {
  revision: string;
  received: string;
  pending: string;
  hadUnavailable: boolean;
  channels: Record<"code_entry" | "qr_issue" | "qr_scan" | "presence_confirmation", string>;
} | null;
export type IntakeCoverageProfile = {
  format: "showup.intake.profile.v1";
  domain: string;
  deployment: string;
  manifest: string;
  event: string;
  rulesHash: string;
  mode: "online" | "physical";
  publishedAtMs: number;
  registrationClosesMs: number;
  opensAtMs: number;
  cutoffMs: number;
  expiresMs: number;
};
export type IntakeCoverageInterval = {
  channel: string;
  fromMs: number;
  throughMs: number;
  received: string;
  resolved: string;
  unavailable: string;
  traceHash: string;
};
export type IntakeCoveragePacket = {
  format: "showup.intake.coverage.v1";
  profile: IntakeCoverageProfile;
  intakeHash: string;
  intervals: IntakeCoverageInterval[];
  observedAtMs: number;
  expiresMs: number;
};
export type SignedIntakeCoverage = { packet: IntakeCoveragePacket; signature: string };
const u64 = (value: unknown): bigint => {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error("Invalid coverage counter");
  return BigInt(value);
};
function exact(value: unknown, keys: string): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === keys,
  );
}
export function intakeCoverageProfile(
  source: SandboxAttendanceObservation,
  publishedAtMs: number,
  registrationClosesMs: number,
): IntakeCoverageProfile {
  const event = source.views.event as {
      terms: { start_ms: number; end_ms: number; mode: "online" | "physical" };
    },
    terms = event.terms,
    schedule = attendanceSchedule(terms.start_ms, terms.end_ms);
  if (
    !Number.isSafeInteger(publishedAtMs) ||
    publishedAtMs < 0 ||
    !Number.isSafeInteger(registrationClosesMs) ||
    registrationClosesMs < publishedAtMs ||
    registrationClosesMs !== terms.start_ms ||
    !["online", "physical"].includes(terms.mode)
  )
    throw new AppFailure(409, "Published intake coverage bounds are unavailable.");
  return {
    format: "showup.intake.profile.v1",
    domain: source.context.domain,
    deployment: source.context.deployment,
    manifest: source.context.manifest,
    event: source.context.event,
    rulesHash: source.context.rulesHash,
    mode: terms.mode,
    publishedAtMs,
    registrationClosesMs,
    opensAtMs: Math.max(publishedAtMs, schedule.opensAt),
    cutoffMs: schedule.cutoff,
    expiresMs: schedule.failNeutralAt,
  };
}
export function intakeCoverageRequirements(profile: IntakeCoverageProfile) {
  return [
    {
      channel: "admission",
      fromMs: profile.publishedAtMs,
      throughMs: profile.registrationClosesMs,
    },
    ...(profile.mode === "online"
      ? ["host_code", "code_entry"]
      : ["qr_issue", "qr_scan", "presence_confirmation"]
    ).map((channel) => ({ channel, fromMs: profile.opensAtMs, throughMs: profile.cutoffMs })),
  ];
}
// The caller supplies the frozen authority and independently derived profile.
// A signature authenticates the collector's claim; it never qualifies a producer
// or proves continuous service by itself. No HTTP handler accepts this packet.
export function verifyIntakeCoverage(
  profile: IntakeCoverageProfile,
  known: IntakeAggregate,
  input: unknown,
  evidencePublicKey: string,
  now: number,
): SignedIntakeCoverage {
  try {
    if (
      !exact(input, "packet,signature") ||
      typeof input.signature !== "string" ||
      !exact(input.packet, "expiresMs,format,intakeHash,intervals,observedAtMs,profile")
    )
      throw new Error("Invalid coverage envelope");
    const packet = input.packet;
    if (known) {
      u64(known.revision);
      if (
        Object.keys(known.channels).sort().join() !==
          "code_entry,presence_confirmation,qr_issue,qr_scan" ||
        Object.values(known.channels).reduce((sum, count) => sum + u64(count), 0n) !==
          u64(known.received)
      )
        throw new Error("Invalid known channel counters");
    }
    if (
      packet.format !== "showup.intake.coverage.v1" ||
      canonicalJson(packet.profile) !== canonicalJson(profile) ||
      packet.intakeHash !== canonicalHash(known) ||
      !Number.isSafeInteger(packet.observedAtMs) ||
      Number(packet.observedAtMs) < Math.max(profile.registrationClosesMs, profile.cutoffMs) ||
      Number(packet.observedAtMs) > now ||
      !Number.isSafeInteger(now) ||
      now > profile.expiresMs ||
      packet.expiresMs !== profile.expiresMs ||
      !Array.isArray(packet.intervals) ||
      packet.intervals.length < 1 ||
      packet.intervals.length > 128 ||
      (known && (known.hadUnavailable || u64(known.pending) !== 0n))
    )
      throw new Error("Incomplete coverage");
    const wire = canonicalJson(packet),
      key = Buffer.from(evidencePublicKey, "base64"),
      signature = Buffer.from(input.signature, "base64");
    if (
      Buffer.byteLength(wire) > 32768 ||
      key.length !== 32 ||
      key.toString("base64") !== evidencePublicKey ||
      signature.length !== 64 ||
      signature.toString("base64") !== input.signature ||
      !verify(
        null,
        Buffer.from(wire),
        createPublicKey({
          key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]),
          format: "der",
          type: "spki",
        }),
        signature,
      )
    )
      throw new Error("Unverified coverage");
    const requirements = intakeCoverageRequirements(profile),
      channels = new Set(requirements.map((value) => value.channel));
    for (const interval of packet.intervals) {
      if (
        !exact(interval, "channel,fromMs,received,resolved,throughMs,traceHash,unavailable") ||
        typeof interval.channel !== "string" ||
        !channels.has(interval.channel) ||
        !Number.isSafeInteger(interval.fromMs) ||
        !Number.isSafeInteger(interval.throughMs) ||
        Number(interval.throughMs) < Number(interval.fromMs) ||
        typeof interval.traceHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(interval.traceHash) ||
        u64(interval.unavailable) !== 0n ||
        u64(interval.resolved) > u64(interval.received)
      )
        throw new Error("Invalid coverage interval");
    }
    let attendanceReceived = 0n;
    for (const requirement of requirements) {
      const intervals = (packet.intervals as IntakeCoverageInterval[]).filter(
        (value) => value.channel === requirement.channel,
      );
      if (
        !intervals.length ||
        (requirement.fromMs === requirement.throughMs && intervals.length !== 1)
      )
        throw new Error("Missing coverage channel");
      let through = requirement.fromMs,
        received = 0n,
        resolved = 0n;
      for (const interval of intervals) {
        if (
          interval.fromMs !== through ||
          interval.throughMs > requirement.throughMs ||
          (interval.throughMs === interval.fromMs &&
            requirement.fromMs !== requirement.throughMs) ||
          u64(interval.received) < received ||
          u64(interval.resolved) < resolved
        )
          throw new Error("Coverage gap or regression");
        through = interval.throughMs;
        received = u64(interval.received);
        resolved = u64(interval.resolved);
      }
      if (through !== requirement.throughMs || received !== resolved)
        throw new Error("Unresolved coverage");
      if (
        known &&
        requirement.channel in known.channels &&
        received < u64(known.channels[requirement.channel as keyof typeof known.channels])
      )
        throw new Error("Coverage omits a known channel");
      if (requirement.channel !== "admission") attendanceReceived += received;
    }
    if (known && attendanceReceived < u64(known.received))
      throw new Error("Coverage omits known intake");
    return structuredClone(input) as SignedIntakeCoverage;
  } catch {
    throw new AppFailure(
      409,
      "Complete event-bound admission and attendance coverage is required before normal closing.",
    );
  }
}
