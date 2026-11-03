import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "../protocol/canonical";
import type { FinalizedHeader } from "../protocol/finalized-heads";
import { record } from "../protocol/quote-signature";
import {
  validateSettlementState,
  type SettlementContext,
  type SettlementViews,
} from "../protocol/settlement-state";

export type AttendanceClass = "on_time" | "late";
export type AttendanceProof = "live_code" | "staff_qr";
export type AttendanceReceipt = {
  domain: string;
  deployment: string;
  manifest: string;
  event: string;
  rules_hash: string;
  registration: string;
  participant: string;
  proof_class: AttendanceProof;
  received_ms: number;
  nonce: string;
  expires_ms: number;
};

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Invalid attendance time");
  return Number(value);
}

export function attendanceSchedule(startMs: number, endMs: number) {
  const start = timestamp(startMs),
    end = timestamp(endMs);
  if (
    start < 300_000 ||
    end - start < 1_800_000 ||
    end - start > 7_200_000 ||
    !Number.isSafeInteger(end + 2_100_000)
  )
    throw new Error("Invalid attendance schedule");
  return {
    opensAt: start - 300_000,
    onTimeThrough: start + 600_000,
    cutoff: end - 900_000,
    evidenceThrough: end - 600_000,
    failNeutralAt: end + 2_100_000,
  };
}

export function classifyAttendance(
  startMs: number,
  endMs: number,
  receivedMs: number,
): AttendanceClass {
  const schedule = attendanceSchedule(startMs, endMs),
    received = timestamp(receivedMs);
  if (received < schedule.opensAt || received > schedule.cutoff)
    throw new Error("Attendance window is closed");
  return received <= schedule.onTimeThrough ? "on_time" : "late";
}

// Pure engineering packet construction. Callers must first establish the actual
// code/assigned-staff proof and persist its server receipt time. This function
// cannot establish that proof, sign, book a seat or confirm attendance. No HTTP
// route or environment flag can use a sandbox observation as live eligibility.
export function sandboxAttendancePacket(
  context: SettlementContext,
  views: SettlementViews,
  block: FinalizedHeader,
  proofClass: AttendanceProof,
  receivedMs: number,
  nonce: string,
) {
  if (context.environment !== "sandbox" || context.domain !== "showup.sandbox.authorization.v1")
    throw new Error("Live attendance requires qualified funding and evidence integration");
  const facts = validateSettlementState(context, views, block),
    terms = record(record(views.event).terms),
    start = timestamp(terms.start_ms),
    end = timestamp(terms.end_ms),
    classification = classifyAttendance(start, end, receivedMs);
  if (
    facts.eventState !== "published" ||
    !facts.registration?.booked ||
    facts.registration.attendance !== null ||
    receivedMs < block.timestampMs ||
    !/^[0-9a-f]{64}$/.test(nonce) ||
    (facts.mode === "online" ? proofClass !== "live_code" : proofClass !== "staff_qr")
  )
    throw new Error("Attendance requires the bound funded registration and matching proof");
  const receipt: AttendanceReceipt = {
    domain: context.domain,
    deployment: context.deployment,
    manifest: context.manifest,
    event: context.event,
    rules_hash: context.rulesHash,
    registration: String(context.authorization.registration),
    participant: String(context.authorization.participant),
    proof_class: proofClass,
    received_ms: receivedMs,
    nonce,
    expires_ms: Math.min(receivedMs + 300_000, attendanceSchedule(start, end).evidenceThrough),
  };
  return {
    receipt,
    canonical: canonicalJson(receipt),
    classification,
    status: "pending_contract" as const,
    sourceQualified: false as const,
    liveSubmissionAllowed: false as const,
  };
}

// The key must come from the frozen evidence authority, never from the receipt.
// Wallet-control and funding-credential signatures use separate authority keys.
export function verifyAttendancePacket(
  expected: ReturnType<typeof sandboxAttendancePacket>,
  receipt: unknown,
  signature: string,
  evidencePublicKey: string,
): boolean {
  try {
    const bytes = Buffer.from(signature, "base64"),
      key = Buffer.from(evidencePublicKey, "base64"),
      canonical = canonicalJson(receipt);
    if (
      canonical !== expected.canonical ||
      bytes.length !== 64 ||
      key.length !== 32 ||
      bytes.toString("base64") !== signature ||
      key.toString("base64") !== evidencePublicKey
    )
      return false;
    return verify(
      null,
      Buffer.from(canonical),
      createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]),
        format: "der",
        type: "spki",
      }),
      bytes,
    );
  } catch {
    return false;
  }
}
