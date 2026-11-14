import { createHash, createPublicKey, verify } from "node:crypto";
import { decodeBase58, encodeBase58 } from "./encoding";
import { networkManifest } from "./manifest";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid provider response");
  return value as Record<string, unknown>;
}

const requestFields = [
  "dry",
  "swapType",
  "slippageTolerance",
  "originAsset",
  "depositType",
  "destinationAsset",
  "amount",
  "refundTo",
  "refundType",
  "recipient",
  "recipientType",
  "deadline",
];
const optionalRequestFields = [
  "quoteWaitingTimeMs",
  "referral",
  "virtualChainRecipient",
  "virtualChainRefundRecipient",
  "customRecipientMsg",
];
const amountFields = [
  "amountIn",
  "amountInFormatted",
  "amountInUsd",
  "minAmountIn",
  "amountOut",
  "amountOutFormatted",
  "amountOutUsd",
  "minAmountOut",
];
const wetFields = [
  "depositAddress",
  "depositMemo",
  "deadline",
  "timeWhenInactive",
  "timeEstimate",
  "refundFee",
  "withdrawFee",
];

// Exact protocol field selection from the immutable SDK revision in the manifest.
// This does NOT authenticate other response fields or an enclosing status object.
export function quoteMessage(value: unknown): Buffer {
  const response = record(value);
  const request = record(response.quoteRequest);
  const quote = record(response.quote);
  if (typeof request.dry !== "boolean") throw new Error("Missing quote mode");
  const selected: Record<string, unknown> = {};
  for (const key of requestFields) selected[key] = request[key];
  for (const key of optionalRequestFields) if (request[key]) selected[key] = request[key];
  for (const key of amountFields) selected[key] = quote[key];
  if (!request.dry) for (const key of wetFields) if (quote[key]) selected[key] = quote[key];
  selected.timestamp = response.timestamp;
  for (const value of Object.values(selected)) {
    if (value === undefined) continue;
    if (!["string", "number", "boolean"].includes(typeof value) || String(value).length > 16384)
      throw new Error("Invalid signed quote field");
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Invalid signed number");
  }
  const json = JSON.stringify(
    Object.fromEntries(Object.entries(selected).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
  return Buffer.from(encodeBase58(createHash("sha256").update(json).digest()), "utf8");
}

export function verifyQuoteSignature(
  value: unknown,
  publicKey = networkManifest.providers.oneClick.quotePublicKey,
): boolean {
  try {
    const response = record(value);
    if (typeof response.signature !== "string" || !response.signature.startsWith("ed25519:"))
      return false;
    if (!publicKey.startsWith("ed25519:")) return false;
    const raw = decodeBase58(publicKey.slice(8), 32);
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    return verify(null, quoteMessage(value), key, decodeBase58(response.signature.slice(8), 64));
  } catch {
    return false;
  }
}
