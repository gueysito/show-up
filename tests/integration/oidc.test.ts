import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import * as oidc from "openid-client";
import { token } from "../../src/server/auth/crypto";
import { providerClientAuthentication, verifyAuthorization } from "../../src/server/auth/oidc";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "fixture",
  alg: "RS256",
  use: "sig",
};
const verifier = oidc.randomPKCECodeVerifier();
const challenge = createHash("sha256").update(verifier).digest("base64url");
const nonce = token();
const state = token();
let issuer = "";
let client: oidc.Configuration;
let server: Server;
const codes = new Set<string>();
const clientSecret = "fixture-only-secret_with.encoding+characters";

function jwt(variant: string) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: variant === "issuer" ? "https://wrong.invalid" : issuer,
    sub: "fictional-telegram-without-email",
    aud: variant === "audience" ? "wrong-client" : "fixture-client",
    iat: now,
    exp: variant === "expired" ? now - 600 : now + 300,
    nonce: variant === "nonce" ? "wrong-nonce" : nonce,
  };
  const encoded = [{ alg: "RS256", kid: "fixture", typ: "JWT" }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(encoded),
    variant === "signature" ? other.privateKey : keys.privateKey,
  );
  return `${encoded}.${signature.toString("base64url")}`;
}

before(async () => {
  server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (request.url !== "/token" || request.method !== "POST") {
      response.writeHead(404).end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    if (
      request.headers.authorization ||
      body.get("client_id") !== "fixture-client" ||
      body.get("client_secret") !== clientSecret
    ) {
      // Telegram can report token errors with HTTP 200, rather than a conforming 400.
      response.end(JSON.stringify({ error: "invalid_client" }));
      return;
    }
    const code = body.get("code") ?? "";
    const correctPkce =
      createHash("sha256")
        .update(body.get("code_verifier") ?? "")
        .digest("base64url") === challenge;
    if (!correctPkce || codes.has(code) || body.get("grant_type") !== "authorization_code") {
      response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    codes.add(code);
    if (code.startsWith("missing")) {
      response.end(JSON.stringify({ access_token: "fixture-only", token_type: "Bearer" }));
      return;
    }
    response.end(
      JSON.stringify({
        access_token: "fixture-only",
        token_type: "Bearer",
        id_token: jwt(code.split("-")[0]),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not start");
  issuer = `http://127.0.0.1:${address.port}`;
  client = new oidc.Configuration(
    {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ["RS256"],
    },
    "fixture-client",
    clientSecret,
    providerClientAuthentication("telegram", clientSecret),
  );
  // Only the test's in-process fixture permits HTTP. Application issuers are fixed HTTPS.
  oidc.allowInsecureRequests(client);
  oidc.enableNonRepudiationChecks(client);
});
after(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);

function callback(code: string, callbackState = state) {
  return new URL(
    `https://localhost:3443/api/auth/callback/telegram?code=${code}&state=${callbackState}`,
  );
}

test("real signed code exchange accepts an email-less ID token without UserInfo", async () => {
  assert.deepEqual(
    await verifyAuthorization(client, callback("valid-first"), { state, nonce, verifier }),
    {
      issuer,
      subject: "fictional-telegram-without-email",
    },
  );
  // The fixture has no UserInfo route; invoking it would fail this test.
  await assert.rejects(
    verifyAuthorization(client, callback("valid-first"), { state, nonce, verifier }),
  );
});

test("signed exchanges reject invalid signature, issuer, audience, expiry, nonce, state and PKCE", async () => {
  for (const variant of ["signature", "issuer", "audience", "expired", "nonce", "missing"]) {
    await assert.rejects(
      verifyAuthorization(client, callback(`${variant}-negative`), { state, nonce, verifier }),
      Error,
      `rejected ${variant}`,
    );
  }
  await assert.rejects(
    verifyAuthorization(client, callback("valid-state", "wrong-state"), { state, nonce, verifier }),
  );
  await assert.rejects(
    verifyAuthorization(client, callback("valid-pkce"), {
      state,
      nonce,
      verifier: "wrong-verifier",
    }),
  );
});
