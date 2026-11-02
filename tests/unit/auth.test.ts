import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { authConfig } from "../../src/server/auth/config";
import { hash, identityIndex, seal, unseal } from "../../src/server/auth/crypto";
import { cookieOptions } from "../../src/server/auth/sessions";
import { guardRequest } from "../../src/server/http/security";
import { parseAuthEnvironment } from "../../scripts/auth-environment";

test("authentication requires secure explicit configuration and never enables fake providers", () => {
  assert.equal(authConfig({}), null);
  const config = {
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3443",
    SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  };
  assert.deepEqual(authConfig(config)?.clients, { google: null, telegram: null });
  for (const changes of [
    { SHOWUP_AUTH_ORIGIN: "http://localhost:3100" },
    { SHOWUP_AUTH_ORIGIN: "https://example.com" },
    { SHOWUP_IDENTITY_KEY: "missing" },
    { SHOWUP_IDENTITY_INDEX_KEY: config.SHOWUP_IDENTITY_KEY },
    { SHOWUP_GOOGLE_CLIENT_ID: "incomplete" },
  ])
    assert.throws(() => authConfig({ ...config, ...changes }));
  assert.equal(cookieOptions.secure, true);
  assert.equal(cookieOptions.httpOnly, true);
  const request = (origin: string, host = "localhost:3443") =>
    new Request(config.SHOWUP_AUTH_ORIGIN, {
      method: "POST",
      headers: { origin, host },
    });
  guardRequest(request(config.SHOWUP_AUTH_ORIGIN), config.SHOWUP_AUTH_ORIGIN);
  assert.throws(() => guardRequest(request("https://evil.example"), config.SHOWUP_AUTH_ORIGIN));
  assert.throws(() =>
    guardRequest(request(config.SHOWUP_AUTH_ORIGIN, "evil.example"), config.SHOWUP_AUTH_ORIGIN),
  );
  // Cross-site top-level provider redirects are permitted only on the read callback.
  guardRequest(
    new Request(config.SHOWUP_AUTH_ORIGIN, {
      headers: { host: "localhost:3443", "sec-fetch-site": "cross-site" },
    }),
    config.SHOWUP_AUTH_ORIGIN,
    false,
  );
});

test("private identities are encrypted and domain bound; indexes do not publish subject hashes", () => {
  const key = randomBytes(32).toString("hex");
  const value = { issuer: "https://issuer.invalid", subject: "fictional-user" };
  const encrypted = seal(key, "identity:one", value);
  assert.deepEqual(unseal(key, "identity:one", encrypted), value);
  assert.equal(encrypted.includes(value.subject), false);
  assert.throws(() => unseal(key, "identity:two", encrypted));
  assert.throws(() => unseal(randomBytes(32).toString("hex"), "identity:one", encrypted));
  assert.notEqual(encrypted, seal(key, "identity:one", value));
  assert.notEqual(identityIndex(key, value.issuer, value.subject), hash(value.subject));
  assert.notEqual(
    identityIndex(key, value.issuer, value.subject),
    identityIndex(key, "https://other.invalid", value.subject),
  );
});

test("credential setup parses allowlisted data without executing or expanding shell text", () => {
  assert.deepEqual(
    parseAuthEnvironment(
      "# fixture\nexport SHOWUP_GOOGLE_CLIENT_SECRET='literal $VALUE $(command)'\n",
    ),
    {
      SHOWUP_GOOGLE_CLIENT_SECRET: "literal $VALUE $(command)",
    },
  );
  for (const text of [
    "NODE_OPTIONS=--import=unknown",
    "SHOWUP_AUTH=1\nSHOWUP_AUTH=0",
    "export BAD=value",
    "malformed",
  ]) {
    assert.throws(
      () => parseAuthEnvironment(text),
      /^Error: Invalid credential configuration at line \d+$/,
    );
  }
});
