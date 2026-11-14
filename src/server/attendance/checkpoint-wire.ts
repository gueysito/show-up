import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "../protocol/canonical";
import { unsigned } from "../protocol/rpc";

export type AttendanceCheckpoint = {
  domain: string;
  deployment: string;
  manifest: string;
  event: string;
  rules_hash: string;
  ledger_version: string;
  complete_through_ms: number;
  expires_ms: number;
};

// Rust's checkpoint schema uses a bare u64 JSON number. Keep its decimal digits
// exact internally; never round it through Number or serialize it as a string.
export function attendanceCheckpointWire(value: AttendanceCheckpoint) {
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join() !==
      "complete_through_ms,deployment,domain,event,expires_ms,ledger_version,manifest,rules_hash" ||
    typeof value.ledger_version !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(value.ledger_version) ||
    unsigned(value.ledger_version, 64).toString() !== value.ledger_version ||
    typeof value.domain !== "string" ||
    !value.domain ||
    typeof value.deployment !== "string" ||
    !value.deployment ||
    typeof value.manifest !== "string" ||
    !value.manifest ||
    !/^[0-9a-f]{64}$/.test(value.event) ||
    !/^[0-9a-f]{64}$/.test(value.rules_hash) ||
    !Number.isSafeInteger(value.complete_through_ms) ||
    value.complete_through_ms < 0 ||
    !Number.isSafeInteger(value.expires_ms) ||
    value.expires_ms < value.complete_through_ms
  )
    throw new Error("Invalid attendance checkpoint schema");
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${key === "ledger_version" ? value.ledger_version : canonicalJson(item)}`,
    )
    .join(",")}}`;
}

export function verifyAttendanceCheckpoint(
  value: AttendanceCheckpoint,
  signature: string,
  frozenEvidenceKey: string,
) {
  try {
    if (
      typeof signature !== "string" ||
      signature.length !== 88 ||
      typeof frozenEvidenceKey !== "string" ||
      frozenEvidenceKey.length !== 44
    )
      return false;
    const proof = Buffer.from(signature, "base64"),
      key = Buffer.from(frozenEvidenceKey, "base64");
    if (
      proof.length !== 64 ||
      proof.toString("base64") !== signature ||
      key.length !== 32 ||
      key.toString("base64") !== frozenEvidenceKey
    )
      return false;
    return verify(
      null,
      Buffer.from(attendanceCheckpointWire(value)),
      createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") },
        format: "jwk",
      }),
      proof,
    );
  } catch {
    return false;
  }
}
