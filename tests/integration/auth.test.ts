import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { authConfig, issuers } from "../../src/server/auth/config";
import { bootstrapAdmin } from "../../src/server/auth/bootstrap";
import { hash, seal, token, unseal } from "../../src/server/auth/crypto";
import { establishIdentity } from "../../src/server/auth/identities";
import { consumeAttempt } from "../../src/server/auth/oidc";
import { findSession, revokeSession } from "../../src/server/auth/sessions";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { limit } from "../../src/server/http/security";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Auth tests require the disposable test database");
const { pool } = createDatabase();
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3443",
  SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
  SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
})!;
const accounts = new Set<string>();
before(() => migrate(pool));
after(async () => {
  const ids = [...accounts];
  await pool.query(
    "DELETE FROM app_login_attempts WHERE linking_session_hash IN (SELECT token_hash FROM app_sessions WHERE account_id=ANY($1::uuid[]))",
    [ids],
  );
  for (const table of ["app_audit", "app_roles", "app_identities", "app_sessions"])
    await pool.query(
      `DELETE FROM ${table} WHERE ${table === "app_audit" ? "actor_id" : "account_id"}=ANY($1::uuid[])`,
      [ids],
    );
  await pool.query("DELETE FROM app_accounts WHERE id=ANY($1::uuid[])", [ids]);
  await pool.end();
});

async function login(
  provider: "google" | "telegram",
  subject = randomUUID(),
  prior?: string,
  linking?: string,
) {
  const result = await establishIdentity(
    pool,
    config,
    provider,
    { issuer: issuers[provider], subject },
    prior,
    linking,
  );
  accounts.add(result.accountId);
  return result;
}

test("email-less Telegram login, concurrent signup and returning login retain one encrypted identity", async () => {
  const subject = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => login("telegram", subject)));
  const account = results[0].accountId;
  assert.ok(results.every((result) => result.accountId === account));
  const identity = await pool.query("SELECT * FROM app_identities WHERE account_id=$1", [account]);
  assert.equal(identity.rowCount, 1);
  assert.equal(identity.rows[0].encrypted_identity.includes(subject), false);
  assert.deepEqual(
    unseal(
      config.encryptionKey,
      `identity:${identity.rows[0].identity_hash}`,
      identity.rows[0].encrypted_identity,
    ),
    { issuer: issuers.telegram, subject },
  );
  assert.deepEqual((await findSession(pool, results[0].value))?.roles, []);
  const returning = await login("telegram", subject, hash(results[0].value));
  assert.equal(returning.accountId, account);
  assert.equal(await findSession(pool, results[0].value), null);
  assert.equal((await findSession(pool, returning.value))?.accountId, account);
});

test("linking requires the initiating live session, rejects conflicting accounts and never merges", async () => {
  const google = await login("google");
  const telegramSubject = randomUUID();
  const telegram = await login("telegram", telegramSubject);
  await assert.rejects(
    login("telegram", telegramSubject, hash(google.value), hash(google.value)),
    /another account/,
  );
  assert.equal((await findSession(pool, telegram.value))?.accountId, telegram.accountId);
  await assert.rejects(
    login("telegram", randomUUID(), hash(telegram.value), hash(google.value)),
    /Restart linking/,
  );
  const linked = await login("telegram", randomUUID(), hash(google.value), hash(google.value));
  assert.equal(linked.accountId, google.accountId);
  assert.equal(await findSession(pool, google.value), null);
  assert.equal(
    (
      await pool.query("SELECT provider FROM app_identities WHERE account_id=$1", [
        google.accountId,
      ])
    ).rowCount,
    2,
  );
  await assert.rejects(
    login("google", randomUUID(), hash(linked.value), hash(linked.value)),
    /already linked/,
  );
  await assert.rejects(
    login("telegram", randomUUID(), hash(google.value), hash(google.value)),
    /session expired/,
  );
});

test("expiry, account disablement and all-session logout revoke restoration", async () => {
  const subject = randomUUID();
  const first = await login("google", subject);
  const second = await login("google", subject);
  const session = (await findSession(pool, first.value))!;
  await revokeSession(pool, session, true);
  assert.equal(await findSession(pool, first.value), null);
  assert.equal(await findSession(pool, second.value), null);
  const third = await login("google", subject);
  await pool.query(
    "UPDATE app_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
    [hash(third.value)],
  );
  assert.equal(await findSession(pool, third.value), null);
  const fourth = await login("google", subject);
  await pool.query("UPDATE app_accounts SET state='disabled' WHERE id=$1", [fourth.accountId]);
  assert.equal(await findSession(pool, fourth.value), null);
  await assert.rejects(login("google", subject), /access is unavailable/);
});

test("login state is browser/provider bound, expires and atomically rejects callback replay", async () => {
  const state = token();
  const browser = token();
  await pool.query(
    `INSERT INTO app_login_attempts (state_hash,browser_hash,provider,encrypted_checks,expires_at)
    VALUES ($1,$2,'telegram',$3,clock_timestamp()+interval '1 minute')`,
    [
      hash(state),
      hash(browser),
      seal(config.encryptionKey, `login:${hash(state)}`, { nonce: token(), verifier: token() }),
    ],
  );
  await assert.rejects(consumeAttempt(pool, "google", state, browser));
  await assert.rejects(consumeAttempt(pool, "telegram", state, token()));
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => consumeAttempt(pool, "telegram", state, browser)),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 4);
  await pool.query("DELETE FROM app_login_attempts WHERE state_hash=$1", [hash(state)]);
  await pool.query(
    `INSERT INTO app_login_attempts (state_hash,browser_hash,provider,encrypted_checks,expires_at)
    VALUES ($1,$2,'telegram','expired',clock_timestamp()-interval '1 second')`,
    [hash(state), hash(browser)],
  );
  await assert.rejects(consumeAttempt(pool, "telegram", state, browser));
  await pool.query("DELETE FROM app_login_attempts WHERE state_hash=$1", [hash(state)]);
});

test("login rate limit is shared and atomic across concurrent requests", async () => {
  const scope = randomUUID();
  const result = await Promise.allSettled(Array.from({ length: 12 }, () => limit(pool, scope, 5)));
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 5);
  await pool.query("DELETE FROM app_rate_limits WHERE key_hash=$1", [hash(scope)]);
});

test("initial admin bootstrap requires a verified account and closes atomically", async () => {
  await assert.rejects(bootstrapAdmin(pool, randomUUID()), /provider-verified/);
  const one = await login("google");
  const two = await login("telegram");
  const results = await Promise.allSettled([
    bootstrapAdmin(pool, one.accountId),
    bootstrapAdmin(pool, two.accountId),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await pool.query("SELECT 1 FROM app_roles WHERE role='admin'")).rowCount, 1);
  await assert.rejects(bootstrapAdmin(pool, one.accountId), /Bootstrap is closed/);
  await pool.query("DELETE FROM app_roles WHERE role='admin' AND account_id=ANY($1::uuid[])", [
    [one.accountId, two.accountId],
  ]);
});
