import { randomUUID } from "node:crypto";
import type { AuthConfig } from "../../src/server/auth/config";
import { createDeletionConfirmation } from "../../src/server/privacy/confirmation";

export function confirmedDeletion(
  keys: Pick<AuthConfig, "encryptionKey">,
  accountId: string,
  sessionHash: string,
  operationId = randomUUID(),
) {
  return {
    operationId,
    confirmation: "DELETE",
    acknowledgeOnChain: true,
    intent: createDeletionConfirmation(keys, accountId, sessionHash, operationId),
  };
}
