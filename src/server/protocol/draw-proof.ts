import { createHash, createPublicKey, verify } from "node:crypto";

export type DrawContext = {
  domain: string;
  deployment: string;
  manifest: string;
  event: string;
  rules_hash: string;
  snapshot_hash: string;
  round: number;
  exclusion_hash: string;
  provider: string;
  project: string;
  version_hash: string;
  sender: string;
  key: string;
};

export function drawSeed(context: DrawContext): string {
  for (const key of [
    "event",
    "rules_hash",
    "snapshot_hash",
    "exclusion_hash",
    "version_hash",
  ] as const)
    if (!/^[0-9a-f]{64}$/.test(context[key])) throw new Error("Invalid frozen draw hash");
  if (context.round !== 0)
    throw new Error("Later selection rounds belong to the rewards milestone");
  const entries = Object.entries(context);
  if (entries.some(([, value]) => typeof value === "string" && (!value || value.length > 128)))
    throw new Error("Invalid draw context");
  const serialized = JSON.stringify(
    Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
  return createHash("sha256").update(serialized).digest("hex");
}

// This verifies a proof against an already frozen binding. It cannot allocate,
// request another execution, extend the deadline or authenticate its provenance.
export function verifyDrawProof(input: {
  context: DrawContext;
  requestId: string;
  alpha: string;
  signature: string;
  output: string;
}): boolean {
  try {
    if (
      !/^[a-zA-Z0-9-]{1,64}$/.test(input.requestId) ||
      !/^[0-9a-f]{128}$/.test(input.signature) ||
      !/^[0-9a-f]{64}$/.test(input.output) ||
      !/^[a-z0-9._-]{2,64}$/.test(input.context.sender)
    )
      return false;
    const alpha = `vrf:${input.requestId}:${input.context.sender}:${drawSeed(input.context)}`;
    if (input.alpha !== alpha) return false;
    const raw = Buffer.from(input.context.key, "base64");
    if (raw.length !== 32 || raw.toString("base64") !== input.context.key) return false;
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    const signature = Buffer.from(input.signature, "hex");
    return (
      verify(null, Buffer.from(alpha), key, signature) &&
      createHash("sha256").update(signature).digest("hex") === input.output
    );
  } catch {
    return false;
  }
}
