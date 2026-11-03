import assert from "node:assert/strict";
import { test } from "node:test";
import {
  identityFromVerifiedClaims,
  telegramUserId,
} from "../../src/server/auth/provider-identity";
import { issuers } from "../../src/server/auth/config";

test("Telegram profile ID remains distinct from OIDC subject and requires an exact bounded integer", () => {
  const claims = { iss: issuers.telegram, sub: "1234123412341234123", id: 987654321 };
  assert.deepEqual(identityFromVerifiedClaims(claims), {
    issuer: issuers.telegram,
    subject: claims.sub,
    telegramUserId: "987654321",
  });
  assert.deepEqual(identityFromVerifiedClaims({ ...claims, id: undefined }), {
    issuer: issuers.telegram,
    subject: claims.sub,
  });
  assert.deepEqual(identityFromVerifiedClaims({ ...claims, iss: issuers.google }), {
    issuer: issuers.google,
    subject: claims.sub,
  });
  assert.equal(telegramUserId(2 ** 52 - 1), String(2 ** 52 - 1));
  for (const id of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    2 ** 52,
    "01",
    "+1",
    "1e3",
    "1.0",
    " 1",
    null,
    {},
    true,
  ])
    assert.throws(() => identityFromVerifiedClaims({ ...claims, id }));
  for (const sub of [undefined, "", 123, "x".repeat(513)])
    assert.throws(() => identityFromVerifiedClaims({ ...claims, sub }));
});
