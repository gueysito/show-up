import type { AuthConfig } from "../auth/config";
import { seal, unseal } from "../auth/crypto";
import { isUuid } from "../events/drafts";

type Keys = Pick<AuthConfig, "encryptionKey">;
export function createDeletionConfirmation(
  keys: Keys,
  accountId: string,
  sessionHash: string,
  operationId: string,
  now = Date.now(),
) {
  if (!isUuid(accountId) || !isUuid(operationId) || !/^[0-9a-f]{64}$/.test(sessionHash))
    throw new Error("Invalid deletion confirmation context");
  return seal(keys.encryptionKey, "privacy.delete-confirmation.v1", {
    accountId,
    sessionHash,
    operationId,
    issuedAt: now,
    expiresAt: now + 300_000,
  });
}
export function verifyDeletionConfirmation(
  keys: Keys,
  value: unknown,
  accountId: string,
  sessionHash: string,
  operationId: string,
  now = Date.now(),
) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const data = unseal(keys.encryptionKey, "privacy.delete-confirmation.v1", value) as {
      accountId: string;
      sessionHash: string;
      operationId: string;
      issuedAt: number;
      expiresAt: number;
    };
    return (
      data.accountId === accountId &&
      data.sessionHash === sessionHash &&
      data.operationId === operationId &&
      Number.isSafeInteger(data.issuedAt) &&
      Number.isSafeInteger(data.expiresAt) &&
      data.issuedAt <= now &&
      data.expiresAt === data.issuedAt + 300_000 &&
      data.expiresAt > now
    );
  } catch {
    return false;
  }
}
