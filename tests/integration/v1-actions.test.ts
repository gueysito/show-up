import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { v1EventFixture } from "../fixtures/v1-event";
import {
  requestV1CheckIn,
  requestV1Close,
  rotateV1Code,
  readV1OwnReceipt,
  readV1HostState,
  requestV1Withdrawal,
  enqueueV1Deadline,
} from "../../src/server/events/v1-actions";
import { runV1Action } from "../../src/worker/v1-actions";
import { runV1Registration } from "../../src/worker/v1-registration";
import { listOwnWallets, removeOwnWallet } from "../../src/server/wallets/service";

test("owned live-code check-in survives an unknown write; close waits, then receipts conserve the no-show split", async () => {
  const f = await v1EventFixture();
  try {
    const { pool, config, eventId, sessions, transport, key, gateway } = f;
    await assert.rejects(
      rotateV1Code(pool, config, sessions[2], randomUUID(), eventId, transport),
      /Private event/,
    );
    await assert.rejects(
      readV1HostState(pool, config, sessions[2], eventId, transport),
      /Private event/,
    );
    const code = await rotateV1Code(pool, config, sessions[0], randomUUID(), eventId, transport);
    await assert.rejects(
      requestV1CheckIn(pool, config, sessions[1], randomUUID(), eventId, "xxxxxx", transport),
      /six-digit/,
    );
    await assert.rejects(
      requestV1CheckIn(
        pool,
        config,
        sessions[1],
        randomUUID(),
        eventId,
        code.code === "000000" ? "000001" : "000000",
        transport,
      ),
      /incorrect or expired/,
    );
    const accepted = await requestV1CheckIn(
      pool,
      config,
      sessions[1],
      randomUUID(),
      eventId,
      code.code,
      transport,
    );
    const repeat = await requestV1CheckIn(
      pool,
      config,
      sessions[1],
      randomUUID(),
      eventId,
      code.code,
      transport,
    );
    assert.equal(repeat.actionId, accepted.actionId);
    await requestV1Close(pool, config, sessions[0], randomUUID(), eventId, "settle", transport);
    await assert.rejects(
      requestV1CheckIn(pool, config, sessions[2], randomUUID(), eventId, code.code, transport),
      /closing/,
    );
    f.loseNextAck();
    await assert.rejects(runV1Action(pool, key, gateway), /Unknown acknowledgement/);
    assert.equal(f.sends(), 1);
    assert.equal(
      (await pool.query("SELECT state FROM app_v1_event_actions WHERE id=$1", [accepted.actionId]))
        .rows[0].state,
      "submitted",
    );
    assert.equal(
      (
        await runV1Registration(pool, key, {
          prepare: async () => {
            throw new Error("Must not sign");
          },
          submit: async () => {},
          final: async () => {
            throw new Error("Must not query");
          },
          observe: async () => {
            throw new Error("Must not query");
          },
        })
      ).state,
      "busy",
    );
    assert.equal((await runV1Action(pool, key, gateway)).state, "verified");
    assert.equal(f.sends(), 1);
    assert.equal(
      (await readV1HostState(pool, config, sessions[0], eventId, transport)).roster[0].attended,
      true,
    );
    assert.equal((await runV1Action(pool, key, gateway)).state, "verified");
    const receipt = await readV1OwnReceipt(pool, config, sessions[1], eventId, transport);
    assert.equal(receipt!.principal, "1000000");
    assert.equal(receipt!.share, "1000000");
    assert.equal(receipt!.winner, true);
    const missed = await readV1OwnReceipt(pool, config, sessions[2], eventId, transport);
    assert.equal(missed!.principal, "0");
    assert.equal(missed!.claim.total, "0");
    assert.equal(missed!.payout, "attendee-2.near");
    const [paidWallet] = await listOwnWallets(pool, config, f.accounts[1].id);
    await removeOwnWallet(pool, config, sessions[1], {
      walletId: paidWallet.id,
      operationId: randomUUID(),
    });
    assert.deepEqual(await listOwnWallets(pool, config, f.accounts[1].id), []);
    await assert.rejects(
      requestV1Withdrawal(pool, config, sessions[2], randomUUID(), eventId, "deposit", transport),
      /No unpaid claim/,
    );
    const payout = await requestV1Withdrawal(
      pool,
      config,
      sessions[1],
      randomUUID(),
      eventId,
      "deposit",
      transport,
    );
    assert.equal(
      (await readV1OwnReceipt(pool, config, sessions[1], eventId, transport))!.withdrawalQueued,
      true,
    );
    f.failTransfer(true);
    assert.equal((await runV1Action(pool, key, gateway)).state, "failed");
    assert.equal(
      (await readV1OwnReceipt(pool, config, sessions[1], eventId, transport))!.claim.paid,
      "0",
    );
    await pool.query("UPDATE app_accounts SET state='deletion_requested' WHERE id=$1", [
      f.accounts[1].id,
    ]);
    const retry = await requestV1Withdrawal(
      pool,
      config,
      sessions[1],
      randomUUID(),
      eventId,
      "deposit",
      transport,
    );
    assert.notEqual(retry.actionId, payout.actionId);
    f.failTransfer(false);
    assert.equal((await runV1Action(pool, key, gateway)).state, "verified");
    const paid = (await readV1OwnReceipt(pool, config, sessions[1], eventId, transport))!;
    assert.equal(paid.claim.paid, "2000000");
    assert.equal(paid.payout, paidWallet.address);
    assert.equal(paid.withdrawalQueued, false);
    const row = (
      await pool.query("SELECT encrypted_image FROM app_v1_event_actions WHERE id=$1", [
        accepted.actionId,
      ])
    ).rows[0];
    assert.equal(row.encrypted_image.includes("attendee-1.near"), false);
    f.setHeight(99);
    await assert.rejects(
      readV1OwnReceipt(pool, config, sessions[1], eventId, transport),
      /regressed/,
    );
  } finally {
    await f.cleanup();
  }
});

test("deadline closing cancels after a failed accepted check-in; expired codes and brute force are rejected", async (t) => {
  const f = await v1EventFixture();
  try {
    const { pool, config, eventId, sessions, transport, key } = f;
    const code = await rotateV1Code(pool, config, sessions[0], randomUUID(), eventId, transport);
    await pool.query(
      "UPDATE app_v1_code_windows SET expires_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
      [eventId],
    );
    await assert.rejects(
      requestV1CheckIn(pool, config, sessions[1], randomUUID(), eventId, code.code, transport),
      /incorrect or expired/,
    );
    const current = await rotateV1Code(pool, config, sessions[0], randomUUID(), eventId, transport);
    await requestV1CheckIn(
      pool,
      config,
      sessions[1],
      randomUUID(),
      eventId,
      current.code,
      transport,
    );
    await pool.query("UPDATE app_v1_event_actions SET state='failed' WHERE event_id=$1", [eventId]);
    await assert.rejects(
      requestV1Close(pool, config, sessions[0], randomUUID(), eventId, "settle", transport),
      /Cancel/,
    );
    for (let n = 0; n < 3; n++)
      await assert.rejects(
        requestV1CheckIn(pool, config, sessions[2], randomUUID(), eventId, "0000000", transport),
        /six-digit/,
      );
    for (let n = 0; n < 2; n++)
      await assert.rejects(
        requestV1CheckIn(pool, config, sessions[2], randomUUID(), eventId, "0000000", transport),
        /six-digit/,
      );
    await assert.rejects(
      requestV1CheckIn(pool, config, sessions[2], randomUUID(), eventId, current.code, transport),
      /Too many/,
    );
    const deadline = f.end();
    t.mock.timers.enable({ apis: ["Date"], now: deadline });
    await enqueueV1Deadline(pool, key, transport);
    assert.equal(
      (
        await pool.query(
          "SELECT kind FROM app_v1_event_actions WHERE event_id=$1 AND state='requested'",
          [eventId],
        )
      ).rows[0].kind,
      "cancel",
    );
    assert.equal((await runV1Action(pool, key, f.gateway)).state, "verified");
    assert.equal(
      (await readV1OwnReceipt(pool, config, sessions[2], eventId, transport))!.principal,
      "1000000",
    );
    assert.equal(await enqueueV1Deadline(pool, key, transport), undefined);
  } finally {
    await f.cleanup();
  }
});
