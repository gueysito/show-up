import * as oidc from "openid-client";
import type pg from "pg";
import { AppFailure, limit } from "../http/security";
import { issuers, type AuthConfig, type Provider } from "./config";
import { hash, seal, token, unseal } from "./crypto";
import { establishIdentity } from "./identities";
import type { Session } from "./sessions";

async function providerClient(config: AuthConfig, provider: Provider) {
  const credentials = config.clients[provider];
  if (!credentials) throw new AppFailure(503, "This sign-in provider is not configured yet.");
  return oidc.discovery(
    new URL(issuers[provider]),
    credentials.id,
    credentials.secret,
    oidc.ClientSecretBasic(credentials.secret),
    {
      execute: [oidc.enableNonRepudiationChecks],
      timeout: 10,
    },
  );
}

export async function beginLogin(
  pool: pg.Pool,
  config: AuthConfig,
  provider: Provider,
  browser: string,
  linking?: Session,
) {
  await limit(pool, "login-start:global", 100);
  await limit(pool, `login-start:${hash(browser)}`, 10);
  const client = await providerClient(config, provider);
  const state = token();
  const nonce = token();
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  await pool.query(
    `INSERT INTO app_login_attempts
    (state_hash,browser_hash,provider,encrypted_checks,linking_session_hash,expires_at)
    VALUES ($1,$2,$3,$4,$5,clock_timestamp() + interval '10 minutes')`,
    [
      hash(state),
      hash(browser),
      provider,
      seal(config.encryptionKey, `login:${hash(state)}`, { nonce, verifier }),
      linking?.tokenHash ?? null,
    ],
  );
  return oidc.buildAuthorizationUrl(client, {
    redirect_uri: `${config.origin}/api/auth/callback/${provider}`,
    scope: "openid profile",
    response_type: "code",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(linking ? { prompt: "login" } : {}),
  });
}

export async function consumeAttempt(
  pool: pg.Pool,
  provider: Provider,
  state: string,
  browser: string,
) {
  if (!/^[\w-]{43}$/.test(state) || !/^[\w-]{43}$/.test(browser))
    throw new AppFailure(401, "Sign-in expired or invalid. Start again.");
  const result = await pool.query(
    `UPDATE app_login_attempts SET consumed_at=clock_timestamp()
    WHERE state_hash=$1 AND browser_hash=$2 AND provider=$3 AND consumed_at IS NULL
      AND expires_at > clock_timestamp()
    RETURNING encrypted_checks, linking_session_hash`,
    [hash(state), hash(browser), provider],
  );
  if (!result.rowCount) throw new AppFailure(401, "Sign-in expired or already used. Start again.");
  return result.rows[0] as { encrypted_checks: string; linking_session_hash: string | null };
}

// Kept as a protocol seam so tests can exercise actual signed OIDC exchanges
// against an isolated issuer without adding a test provider to the application.
export async function verifyAuthorization(
  client: oidc.Configuration,
  url: URL,
  checks: { state: string; nonce: string; verifier: string },
) {
  const tokens = await oidc.authorizationCodeGrant(client, url, {
    expectedState: checks.state,
    expectedNonce: checks.nonce,
    pkceCodeVerifier: checks.verifier,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims?.iss || !claims.sub)
    throw new AppFailure(401, "Provider identity could not be verified.");
  return { issuer: claims.iss, subject: claims.sub };
}

export async function finishLogin(
  pool: pg.Pool,
  config: AuthConfig,
  provider: Provider,
  search: string,
  browser: string,
  previousHash?: string,
) {
  if (search.length > 8192) throw new AppFailure(400, "Invalid sign-in response.");
  await limit(pool, "login-callback:global", 100);
  const url = new URL(`/api/auth/callback/${provider}${search}`, config.origin);
  const state = url.searchParams.get("state") ?? "";
  const attempt = await consumeAttempt(pool, provider, state, browser);
  const checks = unseal(config.encryptionKey, `login:${hash(state)}`, attempt.encrypted_checks) as {
    nonce: string;
    verifier: string;
  };
  const identity = await verifyAuthorization(await providerClient(config, provider), url, {
    ...checks,
    state,
  });
  return establishIdentity(
    pool,
    config,
    provider,
    identity,
    previousHash,
    attempt.linking_session_hash ?? undefined,
  );
}
