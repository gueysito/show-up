import { AppFailure } from "../http/security";
import { issuers } from "./config";

export type ProviderIdentity = {
  issuer: string;
  subject: string;
  telegramUserId?: string;
};

// Telegram's profile `id` is the Bot API identifier. OIDC `sub` is a separate
// account identifier and must never be substituted for it.
export function telegramUserId(value: unknown): string {
  const text = typeof value === "number" ? String(value) : value;
  if (
    typeof text !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(text) ||
    !Number.isSafeInteger(Number(text)) ||
    Number(text) >= 2 ** 52
  )
    throw new AppFailure(401, "Telegram identity could not be verified.");
  return text;
}

// Call only after the OIDC library verifies the ID token, issuer, audience,
// nonce and signature. This projects authenticated claims, not a token verifier.
export function identityFromVerifiedClaims(claims: Record<string, unknown>): ProviderIdentity {
  if (
    typeof claims.iss !== "string" ||
    !claims.iss ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.sub.length > 512
  )
    throw new AppFailure(401, "Provider identity could not be verified.");
  return {
    issuer: claims.iss,
    subject: claims.sub,
    ...(claims.iss === issuers.telegram && claims.id !== undefined
      ? { telegramUserId: telegramUserId(claims.id) }
      : {}),
  };
}
