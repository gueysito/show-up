import { sign, type KeyObject } from "node:crypto";
import type pg from "pg";
import type { SandboxAttendanceObservation } from "../../src/server/attendance/admission";
import {
  intakeCoverageProfile,
  intakeCoverageRequirements,
  type IntakeAggregate,
  type IntakeCoveragePacket,
} from "../../src/server/attendance/coverage";
import { canonicalHash, canonicalJson } from "../../src/server/protocol/canonical";
import { attendanceIntakeSnapshot } from "../../src/server/attendance/intake";

// Explicit, unmeasured evidence fixtures. Never a runtime health collector,
// source qualification, provider proof or claim that live ingress was available.
export async function fixtureIntakeCoveragePacket(
  pool: pg.Pool,
  eventId: string,
  source: SandboxAttendanceObservation,
): Promise<IntakeCoveragePacket> {
  const event = (
    await pool.query("SELECT published_at,registration_closes_at FROM app_events WHERE id=$1", [
      eventId,
    ])
  ).rows[0];
  const client = await pool.connect();
  let known: IntakeAggregate;
  try {
    known = await attendanceIntakeSnapshot(client, eventId);
  } finally {
    client.release();
  }
  const profile = intakeCoverageProfile(
    source,
    event.published_at.getTime(),
    event.registration_closes_at.getTime(),
  );
  const count = (channel: string) =>
    channel === "admission" || channel === "host_code"
      ? "1"
      : (known?.channels[channel as keyof NonNullable<IntakeAggregate>["channels"]] ?? "0");
  return {
    format: "showup.intake.coverage.v1",
    profile,
    intakeHash: canonicalHash(known),
    observedAtMs: source.block.timestampMs,
    expiresMs: profile.expiresMs,
    intervals: intakeCoverageRequirements(profile).map((requirement) => ({
      ...requirement,
      received: count(requirement.channel),
      resolved: count(requirement.channel),
      unavailable: known?.hadUnavailable ? "1" : "0",
      traceHash: canonicalHash({
        fixture: "unmeasured-intake-coverage",
        profile,
        channel: requirement.channel,
      }),
    })),
  };
}
export function signFixtureCoverage(packet: IntakeCoveragePacket, key: KeyObject) {
  return {
    packet,
    signature: sign(null, Buffer.from(canonicalJson(packet)), key).toString("base64"),
  };
}
