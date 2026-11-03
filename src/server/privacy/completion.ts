import type { AuthConfig } from "../auth/config";
import { seal, unseal } from "../auth/crypto";
import { isUuid } from "../events/drafts";
import type { DeletionReceipt } from "./deletion";

export const deletionCompletionCookie = "__Host-showup-deletion-complete";
export function completedDeletionReceipt(
  config: AuthConfig,
  receipt: DeletionReceipt,
  now = Date.now(),
) {
  if (receipt.state !== "completed" || !receipt.completedAt || !isUuid(receipt.id))
    throw new Error("Completed deletion required");
  return seal(config.encryptionKey, "privacy.completed.v1", {
    id: receipt.id,
    completedAt: receipt.completedAt,
    expiresAt: now + 900_000,
  });
}
export function readCompletedDeletion(
  config: AuthConfig,
  value?: string,
  now = Date.now(),
): { id: string; completedAt: string } | null {
  if (!value || value.length > 2048) return null;
  try {
    const result = unseal(config.encryptionKey, "privacy.completed.v1", value) as {
      id: string;
      completedAt: string;
      expiresAt: number;
    };
    if (
      !isUuid(result.id) ||
      typeof result.completedAt !== "string" ||
      !Number.isFinite(Date.parse(result.completedAt)) ||
      !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= now ||
      result.expiresAt > now + 900_000
    )
      return null;
    return { id: result.id, completedAt: result.completedAt };
  } catch {
    return null;
  }
}
