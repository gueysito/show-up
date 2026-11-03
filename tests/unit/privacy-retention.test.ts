import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { controlReceiptDeadline } from "../../src/server/privacy/retention";
import { createWalletChallenge } from "../../src/server/wallets/proof";
import { privateWorkerEnvironment } from "../../scripts/auth-environment";

test("control nonce retention starts seven days after actual expiry and never classifies a financial approval", () => {
  const challenge = createWalletChallenge("https://localhost:3444", "near", "fictional.near");
  assert.equal(controlReceiptDeadline(challenge)!.getTime(), challenge.expiresAt + 7 * 86400_000);
  assert.equal(
    controlReceiptDeadline({ ...challenge, format: "showup.commitment.consent.v1" }),
    null,
  );
  assert.equal(controlReceiptDeadline({ ...challenge, expiresAt: Number.MAX_SAFE_INTEGER }), null);
});

test("private worker preserves the existing local encryption key while excluding provider and index credentials", () => {
  const key = randomBytes(32).toString("hex"),
    configured = {
      SHOWUP_ENV: "development",
      DATABASE_URL: "postgresql://showup@127.0.0.1:55432/showup_dev",
      SHOWUP_IDENTITY_KEY: key,
    };
  const inherited = {
    SHOWUP_IDENTITY_INDEX_KEY: "fixture",
    SHOWUP_GOOGLE_CLIENT_ID: "fixture",
    SHOWUP_GOOGLE_CLIENT_SECRET: "fixture",
    SHOWUP_TELEGRAM_CLIENT_ID: "fixture",
    SHOWUP_TELEGRAM_CLIENT_SECRET: "fixture",
  };
  const env = privateWorkerEnvironment(configured, inherited);
  assert.equal(env.SHOWUP_IDENTITY_KEY === key, true);
  assert.equal(env.SHOWUP_AUTH, "0");
  assert.equal(env.SHOWUP_HARNESS, "0");
  for (const name of Object.keys(inherited)) assert.equal(Object.hasOwn(env, name), false);
  assert.throws(() =>
    privateWorkerEnvironment({
      ...configured,
      DATABASE_URL: "postgresql://showup@127.0.0.1:55433/showup_test",
    }),
  );
  assert.throws(() => privateWorkerEnvironment({ ...configured, SHOWUP_IDENTITY_KEY: undefined }));
  assert.throws(() =>
    privateWorkerEnvironment({ ...configured, DATABASE_URL: "postgresql://showup@db/showup_dev" }),
  );
});
