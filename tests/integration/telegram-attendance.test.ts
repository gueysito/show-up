import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { issuers } from "../../src/server/auth/config";
import { identityIndex, seal } from "../../src/server/auth/crypto";
import { mutate } from "../../src/server/auth/mutations";
import { telegramReplyCredential } from "../../src/server/auth/attendance-actor";
import {
  createTelegramConnectionAttempt,
  consumeTelegramConnection,
  disconnectTelegram,
} from "../../src/server/telegram/connection";
import {
  prepareTelegramAttendancePrompt,
  deliverTelegramAttendancePrompt,
  submitTelegramAttendanceCode,
} from "../../src/server/telegram/attendance";
import { listOwnFinancialRecords } from "../../src/server/commitments/records";
import { exportOwnData } from "../../src/server/privacy/export";
import { attendanceFixtures } from "../fixtures/attendance";

test("bound Telegram replies share website attempt limits and one candidate without gaining website or wallet authority", async () => {
  const f = await attendanceFixtures(),
    bot = { id: "12345678", username: "showup_fixture_bot" };
  try {
    const identity = {
        issuer: issuers.telegram,
        subject: randomUUID(),
        telegramUserId: "987654321",
      },
      index = identityIndex(f.config.indexKey, identity.issuer, identity.subject);
    await f.pool.query(
      "INSERT INTO app_identities(identity_hash,account_id,provider,encrypted_identity) VALUES($1,$2,'telegram',$3)",
      [index, f.accounts[0].id, seal(f.config.encryptionKey, `identity:${index}`, identity)],
    );
    const link = await createTelegramConnectionAttempt(f.pool, f.config, bot, f.session, {
      operationId: randomUUID(),
      consentMessages: true,
      eventId: f.eventId,
    });
    await consumeTelegramConnection(f.pool, f.config, bot, {
      token: new URL(link.deepLink).searchParams.get("start")!,
      sender: identity.telegramUserId,
      updateId: 1,
    });
    const input = { operationId: randomUUID(), eventId: f.eventId, consentId: f.consent.id };
    await assert.rejects(
      prepareTelegramAttendancePrompt(f.pool, f.config, f.session, input),
      /qualified/,
    );
    const prompt = await prepareTelegramAttendancePrompt(
      f.pool,
      f.config,
      f.session,
      input,
      f.engineering,
    );
    let sent = 0,
      text = "";
    const transport = {
      send: async (packet: { botId: string; chatId: string; text: string }) => {
        sent++;
        text = packet.text;
        assert.equal(packet.botId, bot.id);
        assert.equal(packet.chatId, identity.telegramUserId);
        return { messageId: 91 };
      },
    };
    assert.equal(
      (await deliverTelegramAttendancePrompt(f.pool, f.config, prompt.id, transport)).status,
      "sent",
    );
    await deliverTelegramAttendancePrompt(f.pool, f.config, prompt.id, transport);
    assert.equal(sent, 1);
    assert(text.includes(`?event=${f.eventId}`));
    const reply = {
      updateId: 2,
      sender: identity.telegramUserId,
      text: "F00D123ABC wrong phrase",
      replyTo: 91,
      replyBotId: bot.id,
    };
    await assert.rejects(
      submitTelegramAttendanceCode(
        f.pool,
        f.config,
        bot,
        { ...reply, sender: "987654322" },
        f.received,
        f.engineering,
      ),
      /Reconnect/,
    );
    await assert.rejects(
      submitTelegramAttendanceCode(
        f.pool,
        f.config,
        bot,
        { ...reply, replyTo: null, replyBotId: null, text: "unbound phrase" },
        f.received,
        f.engineering,
      ),
      /exact event prompt/,
    );
    const first = await submitTelegramAttendanceCode(
      f.pool,
      f.config,
      bot,
      reply,
      f.received,
      f.engineering,
    );
    assert.deepEqual(first.result, { status: "incorrect_code", remainingAttempts: 4 });
    assert.deepEqual(await f.attempt("another wrong phrase"), {
      status: "incorrect_code",
      remainingAttempts: 3,
    });
    const shortCode = /send ([A-F0-9]{10}) followed/.exec(text)![1];
    assert.deepEqual(
      (
        await submitTelegramAttendanceCode(
          f.pool,
          f.config,
          bot,
          {
            ...reply,
            updateId: 5,
            replyTo: null,
            replyBotId: null,
            text: `${shortCode} wrong phrase`,
          },
          f.received,
          f.engineering,
        )
      ).result,
      { status: "incorrect_code", remainingAttempts: 2 },
    );
    await f.pool.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [
      f.session,
    ]);
    const correct = { ...reply, updateId: 3, text: "Fresh attendance phrase" },
      result = await submitTelegramAttendanceCode(
        f.pool,
        f.config,
        bot,
        correct,
        f.received,
        f.engineering,
      );
    assert.equal(result.result.status, "pending_contract");
    const replay = await submitTelegramAttendanceCode(
      f.pool,
      f.config,
      bot,
      correct,
      f.received,
      f.engineering,
    );
    assert.deepEqual(replay.result, result.result);
    assert.equal(replay.replayed, true);
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
      1,
    );
    const ref = (
      await f.pool.query(
        "SELECT id FROM app_telegram_attendance_replies WHERE bot_id=$1 AND update_id=3",
        [bot.id],
      )
    ).rows[0].id;
    await assert.rejects(
      mutate(
        f.pool,
        f.config.encryptionKey,
        telegramReplyCredential(ref),
        randomUUID(),
        {},
        "wallet.challenge",
        async () => ({ forbidden: true }),
      ),
      /only submit/,
    );
    await f.pool.query("UPDATE app_sessions SET revoked_at=NULL WHERE token_hash=$1", [f.session]);
    assert.equal(
      (await listOwnFinancialRecords(f.pool, f.config, f.session, undefined, f.eventId)).records
        .length,
      1,
    );
    assert.equal(
      (await listOwnFinancialRecords(f.pool, f.config, f.session, undefined, randomUUID())).records
        .length,
      0,
    );
    const exported = await exportOwnData(f.pool, f.config, f.session);
    assert.equal(exported.telegramAttendancePrompts.length, 1);
    assert.equal(JSON.stringify(exported.telegramAttendancePrompts).includes(text), false);
    await disconnectTelegram(f.pool, f.config, f.session, randomUUID());
    await assert.rejects(
      submitTelegramAttendanceCode(
        f.pool,
        f.config,
        bot,
        { ...correct, updateId: 4 },
        f.received,
        f.engineering,
      ),
      /Reconnect/,
    );
  } finally {
    await f.cleanup();
  }
});
