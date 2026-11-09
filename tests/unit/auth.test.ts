import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { approvedTunnelOrigin, authConfig } from "../../src/server/auth/config";
import { hash, identityIndex, seal, unseal } from "../../src/server/auth/crypto";
import { cookieOptions } from "../../src/server/auth/sessions";
import { guardRequest } from "../../src/server/http/security";
import { parseAuthEnvironment, tunnelEnvironment } from "../../scripts/auth-environment";
import { harnessAvailable } from "../../src/server/harness/guard";
import { authFailureDetails } from "../../src/server/auth/diagnostics";
import { providerClientAuthentication } from "../../src/server/auth/oidc";

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

test("the production tunnel accepts only its frozen HTTPS origin and preserves request guards", () => {
  const configured = {
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: approvedTunnelOrigin,
    NODE_ENV: "production",
    SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  };
  assert.equal(authConfig(configured)?.origin, approvedTunnelOrigin);
  for (const origin of [
    "https://another.ngrok-free.dev",
    `${approvedTunnelOrigin}.evil.example`,
    `${approvedTunnelOrigin}:3443`,
    `${approvedTunnelOrigin}/account`,
    `${approvedTunnelOrigin}?next=elsewhere`,
    `${approvedTunnelOrigin}#fragment`,
    approvedTunnelOrigin.replace("https://", "http://"),
    approvedTunnelOrigin.replace("https://", "https://user@"),
  ])
    assert.throws(() => authConfig({ ...configured, SHOWUP_AUTH_ORIGIN: origin }));
  assert.throws(() => authConfig({ ...configured, NODE_ENV: "development" }));
  const host = new URL(approvedTunnelOrigin).host;
  const request = (origin: string, requestHost = host, site = "same-origin") =>
    new Request(`${approvedTunnelOrigin}/api/auth/start/telegram`, {
      method: "POST",
      headers: { origin, host: requestHost, "sec-fetch-site": site },
    });
  guardRequest(request(approvedTunnelOrigin), approvedTunnelOrigin);
  assert.throws(() => guardRequest(request("https://evil.example"), approvedTunnelOrigin));
  assert.throws(() =>
    guardRequest(request(approvedTunnelOrigin, "localhost:3445"), approvedTunnelOrigin),
  );
  assert.throws(() =>
    guardRequest(request(approvedTunnelOrigin, host, "cross-site"), approvedTunnelOrigin),
  );
});

test("hosted sign-in accepts only this deployment's Railway HTTPS origin", () => {
  const host = "web-production-example.up.railway.app";
  const configured = {
    SHOWUP_AUTH: "1",
    SHOWUP_ENV: "production",
    SHOWUP_AUTH_ORIGIN: `https://${host}`,
    NODE_ENV: "production",
    RAILWAY_PUBLIC_DOMAIN: host,
    SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  };
  assert.equal(authConfig(configured)?.origin, configured.SHOWUP_AUTH_ORIGIN);
  for (const origin of [
    approvedTunnelOrigin,
    "https://localhost:3443",
    "https://different.up.railway.app",
    `https://${host}:3100`,
    `https://${host}.example.org`,
    `http://${host}`,
  ])
    assert.throws(() => authConfig({ ...configured, SHOWUP_AUTH_ORIGIN: origin }));
  assert.throws(() => authConfig({ ...configured, RAILWAY_PUBLIC_DOMAIN: undefined }));
  assert.throws(() => authConfig({ ...configured, NODE_ENV: "development" }));
});

test("tunnel startup requires configured identity and development data and disables the harness", () => {
  const configured = {
    SHOWUP_ENV: "development",
    DATABASE_URL: "postgresql://showup@127.0.0.1:55432/showup_dev",
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3443",
    SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
    SHOWUP_TELEGRAM_CLIENT_ID: "fictional-client",
    SHOWUP_TELEGRAM_CLIENT_SECRET: "fictional-secret",
  };
  const env = tunnelEnvironment(configured, {
    NODE_ENV: "development",
    HOSTNAME: "0.0.0.0",
    PORT: "9999",
    SHOWUP_HARNESS: "1",
    SHOWUP_ORIGIN: "http://127.0.0.1:3101",
  });
  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.HOSTNAME, "127.0.0.1");
  assert.equal(env.PORT, "3445");
  assert.equal(env.SHOWUP_AUTH_ORIGIN, approvedTunnelOrigin);
  assert.equal(harnessAvailable(env), false);
  assert.equal(env.SHOWUP_IDENTITY_KEY, configured.SHOWUP_IDENTITY_KEY);
  assert.equal(env.SHOWUP_IDENTITY_INDEX_KEY, configured.SHOWUP_IDENTITY_INDEX_KEY);
  assert.throws(() => tunnelEnvironment({ ...configured, SHOWUP_AUTH: "0" }, {}));
  assert.throws(() => tunnelEnvironment({ ...configured, SHOWUP_TELEGRAM_CLIENT_SECRET: "" }, {}));
  assert.throws(() =>
    tunnelEnvironment(
      { ...configured, SHOWUP_ENV: "test", DATABASE_URL: "postgresql://localhost/showup_test" },
      {},
    ),
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

test("callback diagnostics expose only fixed categories, never error bodies or private claims", () => {
  const privateText = "fictional-private-token-must-not-appear";
  const error = Object.assign(new Error(privateText), {
    code: "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
    cause: { cause: { claim: "nonce", claims: { nonce: privateText, sub: privateText } } },
  });
  assert.deepEqual(authFailureDetails("exchange", error), {
    stage: "exchange",
    code: "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
    claim: "nonce",
    oauth: "none",
    field: "none",
  });
  const details = authFailureDetails("exchange", {
    code: privateText,
    error: privateText,
    error_description: privateText,
    cause: { claim: privateText, id_token: privateText },
  });
  assert.deepEqual(details, {
    stage: "exchange",
    code: "unclassified",
    claim: "none",
    oauth: "none",
    field: "none",
  });
  assert.equal(JSON.stringify(details).includes(privateText), false);
  assert.equal(authFailureDetails("attempt", null).code, "unclassified");
  assert.deepEqual(
    authFailureDetails("exchange", {
      code: "OAUTH_INVALID_RESPONSE",
      cause: {
        message: '"response" body "access_token" property must be a non-empty string',
        cause: { body: { error: "invalid_grant", id_token: privateText } },
      },
    }),
    {
      stage: "exchange",
      code: "OAUTH_INVALID_RESPONSE",
      oauth: "invalid_grant",
      claim: "none",
      field: "access_token",
    },
  );
  assert.equal(
    authFailureDetails("exchange", { code: "OAUTH_RESPONSE_BODY_ERROR", error: "invalid_client" })
      .oauth,
    "invalid_client",
  );
});

test("Google and Telegram token authentication preserve encoded characters in the HTTPS form body", async () => {
  const secret = "fixture-only_secret.with+encoded/characters=";
  for (const provider of ["google", "telegram"] as const) {
    const body = new URLSearchParams({ grant_type: "authorization_code" });
    const headers = new Headers();
    await providerClientAuthentication(provider, secret)(
      { issuer: "https://issuer.invalid" },
      { client_id: "fixture-client" },
      body,
      headers,
    );
    assert.equal(headers.has("authorization"), false);
    assert.deepEqual(new URLSearchParams(body.toString()).getAll("client_id"), ["fixture-client"]);
    assert.deepEqual(new URLSearchParams(body.toString()).getAll("client_secret"), [secret]);
    assert.equal(body.get("grant_type"), "authorization_code");
  }
});
