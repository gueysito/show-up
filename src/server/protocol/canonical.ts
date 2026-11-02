import { createHash } from "node:crypto";

// Shared wire format for typed attestations: compact UTF-8 JSON, recursive key
// ordering, integers only. It is deliberately stricter than general JSON.
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 12) throw new Error("Attestation nesting limit");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 65536 || Buffer.from(value).toString("utf8") !== value)
      throw new Error("Invalid attestation text");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Attestation integers must be exact");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error("Attestation array limit");
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 64) throw new Error("Attestation field limit");
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`).join(",")}}`;
  }
  throw new Error("Unsupported attestation value");
}

export function canonicalHash(value: unknown): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json) > 32768) throw new Error("Attestation size limit");
  return createHash("sha256").update(json).digest("hex");
}
