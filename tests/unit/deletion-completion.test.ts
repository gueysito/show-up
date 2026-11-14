import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { authConfig } from "../../src/server/auth/config";
import {
  completedDeletionReceipt,
  readCompletedDeletion,
} from "../../src/server/privacy/completion";

test("completion requires an authenticated short-lived receipt rather than a URL or supplied completion flag", () => {
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  })!;
  const now = Date.now(),
    receipt = {
      id: randomUUID(),
      requestedAt: new Date(now).toISOString(),
      completedAt: new Date(now).toISOString(),
      state: "completed" as const,
      holdReasons: [],
    };
  const value = completedDeletionReceipt(config, receipt, now);
  assert.deepEqual(readCompletedDeletion(config, value, now), {
    id: receipt.id,
    completedAt: receipt.completedAt,
  });
  assert.equal(readCompletedDeletion(config, "completed", now), null);
  assert.equal(
    readCompletedDeletion(config, (value[0] === "A" ? "B" : "A") + value.slice(1), now),
    null,
  );
  assert.equal(readCompletedDeletion(config, value, now + 900_000), null);
  assert.equal(
    readCompletedDeletion(
      { ...config, encryptionKey: randomBytes(32).toString("hex") },
      value,
      now,
    ),
    null,
  );
  assert.throws(() =>
    completedDeletionReceipt(
      config,
      { ...receipt, state: "pending_reconciliation", completedAt: null },
      now,
    ),
  );
});
