import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  createDeletionConfirmation,
  verifyDeletionConfirmation,
} from "../../src/server/privacy/confirmation";

test("deletion confirmation binds account, exact session, operation and five-minute window", () => {
  const keys = { encryptionKey: randomBytes(32).toString("hex") },
    accountId = randomUUID(),
    session = randomBytes(32).toString("hex"),
    operationId = randomUUID(),
    now = Date.now();
  const value = createDeletionConfirmation(keys, accountId, session, operationId, now);
  assert.equal(verifyDeletionConfirmation(keys, value, accountId, session, operationId, now), true);
  assert.equal(
    verifyDeletionConfirmation(keys, value, randomUUID(), session, operationId, now),
    false,
  );
  assert.equal(
    verifyDeletionConfirmation(
      keys,
      value,
      accountId,
      randomBytes(32).toString("hex"),
      operationId,
      now,
    ),
    false,
  );
  assert.equal(
    verifyDeletionConfirmation(keys, value, accountId, session, randomUUID(), now),
    false,
  );
  assert.equal(
    verifyDeletionConfirmation(keys, value, accountId, session, operationId, now + 300_000),
    false,
  );
  assert.equal(
    verifyDeletionConfirmation(keys, value, accountId, session, operationId, now - 1),
    false,
  );
  assert.equal(
    verifyDeletionConfirmation(
      keys,
      (value[0] === "A" ? "B" : "A") + value.slice(1),
      accountId,
      session,
      operationId,
      now,
    ),
    false,
  );
});
