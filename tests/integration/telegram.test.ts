import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { authConfig, issuers } from "../../src/server/auth/config";
import { hash, identityIndex, seal } from "../../src/server/auth/crypto";
import { createDeletionConfirmation } from "../../src/server/privacy/confirmation";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { exportOwnData } from "../../src/server/privacy/export";
import {
  createTelegramConnectionAttempt,
  consumeTelegramConnection,
  disconnectTelegram,
  ownTelegramConnection,
} from "../../src/server/telegram/connection";
import { accountFixtures } from "../fixtures/accounts";

const bot = { id: "12345678", username: "showup_fixture_bot" };
async function fixture() {
  const f = await accountFixtures([[], []]);
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  })!;
  const identity = { issuer: issuers.telegram, subject: randomUUID(), telegramUserId: "987654321" },
    index = identityIndex(config.indexKey, identity.issuer, identity.subject);
  await f.pool.query(
    "INSERT INTO app_identities(identity_hash,account_id,provider,encrypted_identity) VALUES($1,$2,'telegram',$3)",
    [index, f.accounts[0].id, seal(config.encryptionKey, `identity:${index}`, identity)],
  );
  return { ...f, config, identity, session: hash(f.accounts[0].value) };
}
test("explicit bot opt-in binds the actual linked sender, deduplicates delivery, exports own consent and disconnects without changing login", async () => {
  const f = await fixture();
  try {
    const input = { operationId: randomUUID(), consentMessages: true };
    await assert.rejects(
      createTelegramConnectionAttempt(f.pool, f.config, bot, f.session, {
        ...input,
        consentMessages: false,
      }),
    );
    await assert.rejects(
      createTelegramConnectionAttempt(f.pool, f.config, bot, hash(f.accounts[1].value), input),
      /Link Telegram/,
    );
    const link = await createTelegramConnectionAttempt(f.pool, f.config, bot, f.session, input);
    assert.deepEqual(
      await createTelegramConnectionAttempt(f.pool, f.config, bot, f.session, input),
      link,
    );
    const value = new URL(link.deepLink).searchParams.get("start")!,
      update = { token: value, sender: f.identity.telegramUserId, updateId: 42 };
    await assert.rejects(
      consumeTelegramConnection(f.pool, f.config, bot, { ...update, sender: "987654322" }),
      /same Telegram identity/,
    );
    const results = await Promise.all([
      consumeTelegramConnection(f.pool, f.config, bot, update),
      consumeTelegramConnection(f.pool, f.config, bot, update),
    ]);
    assert(results.every((row) => row.connected));
    await assert.rejects(
      consumeTelegramConnection(f.pool, f.config, bot, { ...update, updateId: 43 }),
      /already used/,
    );
    assert.equal((await ownTelegramConnection(f.pool, f.session)).connected, true);
    assert.equal((await ownTelegramConnection(f.pool, hash(f.accounts[1].value))).connected, false);
    const stored = (
      await f.pool.query("SELECT * FROM app_telegram_connections WHERE account_id=$1", [
        f.accounts[0].id,
      ])
    ).rows[0];
    assert.equal(stored.encrypted_peer.includes(f.identity.telegramUserId), false);
    const exported = await exportOwnData(f.pool, f.config, f.session);
    assert.equal(exported.telegramConnections[0].botUsername, bot.username);
    assert.equal(JSON.stringify(exported).includes(value), false);
    assert.equal(JSON.stringify(exported).includes(stored.sender_hash), false);
    await disconnectTelegram(f.pool, f.config, f.session, randomUUID());
    assert.equal((await ownTelegramConnection(f.pool, f.session)).connected, false);
    await assert.rejects(consumeTelegramConnection(f.pool, f.config, bot, update), /unavailable/);
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_identities WHERE account_id=$1", [f.accounts[0].id]))
        .rowCount,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
test("connection expiry and session revocation prevent linking; account deletion removes messaging permission and pending links", async () => {
  const f = await fixture();
  try {
    const connect = () =>
      createTelegramConnectionAttempt(f.pool, f.config, bot, f.session, {
        operationId: randomUUID(),
        consentMessages: true,
      });
    const first = await connect(),
      value = new URL(first.deepLink).searchParams.get("start")!;
    await f.pool.query(
      "UPDATE app_telegram_connection_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
      [f.accounts[0].id],
    );
    await assert.rejects(
      consumeTelegramConnection(f.pool, f.config, bot, {
        token: value,
        sender: f.identity.telegramUserId,
        updateId: 45,
      }),
      /expired/,
    );
    const next = await connect(),
      nextValue = new URL(next.deepLink).searchParams.get("start")!;
    await f.pool.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [
      f.session,
    ]);
    await assert.rejects(
      consumeTelegramConnection(f.pool, f.config, bot, {
        token: nextValue,
        sender: f.identity.telegramUserId,
        updateId: 46,
      }),
      /session expired/,
    );
    await f.pool.query("UPDATE app_sessions SET revoked_at=NULL WHERE token_hash=$1", [f.session]);
    await consumeTelegramConnection(f.pool, f.config, bot, {
      token: nextValue,
      sender: f.identity.telegramUserId,
      updateId: 46,
    });
    const operationId = randomUUID(),
      intent = createDeletionConfirmation(f.config, f.accounts[0].id, f.session, operationId);
    await requestAccountDeletion(f.pool, f.config, f.session, {
      operationId,
      intent,
      confirmation: "DELETE",
      acknowledgeOnChain: true,
    });
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_telegram_connections WHERE account_id=$1", [
          f.accounts[0].id,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_telegram_connection_attempts WHERE account_id=$1", [
          f.accounts[0].id,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
