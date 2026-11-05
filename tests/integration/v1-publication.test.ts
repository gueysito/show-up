import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import {
  prepareV1Publication,
  readV1PublicationState,
} from "../../src/server/events/v1-publication";
import { runV1Publication, type V1PublicationGateway } from "../../src/worker/v1-publication";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";
import type { V1Snapshot } from "../../src/server/protocol/v1-escrow";

async function fixture() {
  const f = await accountFixtures([["host"], ["host"], []]);
  const key = randomBytes(32).toString("hex"),
    id = randomUUID(),
    session = hash(f.accounts[0].value);
  const data = { ...validDraft(), capacity: 2, commitment: "1", sponsorBudget: "0" };
  await saveAccountDraft(
    f.pool,
    key,
    session,
    { id, revision: 0, operationId: randomUUID(), data },
    "v1",
  );
  return { ...f, key, id, data, session };
}

test("V1 requests require the owning host/current revision, lock terms and preserve one queued image", async () => {
  const f = await fixture();
  try {
    for (const index of [1, 2])
      await assert.rejects(
        prepareV1Publication(f.pool, f.key, hash(f.accounts[index].value), randomUUID(), f.id, 1),
      );
    await assert.rejects(
      prepareV1Publication(f.pool, f.key, f.session, randomUUID(), f.id, 2),
      /Reload/,
    );
    assert.equal((await readV1PublicationState(f.pool, f.session, f.id, 1)).canPublish, true);
    const operation = randomUUID();
    const first = await prepareV1Publication(f.pool, f.key, f.session, operation, f.id, 1);
    assert.deepEqual(
      await prepareV1Publication(f.pool, f.key, f.session, operation, f.id, 1),
      first,
    );
    assert.equal((await readV1PublicationState(f.pool, f.session, f.id, 1)).canPublish, false);
    assert.equal(
      (await f.pool.query("SELECT count(*) FROM app_publication_images WHERE event_id=$1", [f.id]))
        .rows[0].count,
      "1",
    );
    await assert.rejects(
      saveAccountDraft(
        f.pool,
        f.key,
        f.session,
        { id: f.id, revision: 1, operationId: randomUUID(), data: { ...f.data, title: "Changed" } },
        "v1",
      ),
      /frozen/,
    );
    await assert.rejects(
      readV1PublicationState(f.pool, hash(f.accounts[1].value), f.id, 1),
      /unavailable/,
    );
  } finally {
    await f.cleanup();
  }
});

test("V1 accepted-but-disconnected publication recovers the original hash without another signature or send", async () => {
  const f = await fixture();
  try {
    await prepareV1Publication(f.pool, f.key, f.session, randomUUID(), f.id, 1);
    let prepares = 0,
      sends = 0,
      reads = 0;
    let snapshot!: V1Snapshot;
    const transactionHash = "11111111111111111111111111111111";
    const gateway: V1PublicationGateway = {
      async prepare(image) {
        prepares++;
        snapshot = {
          block: { height: "100", hash: transactionHash, timestampMs: Date.now() },
          event: {
            ...image.terms,
            status: "published",
            funded: [],
            winner: null,
            prize_received: true,
          },
        };
        return {
          hash: transactionHash,
          signedBase64: "opaque-original-image",
          semantic: canonicalHash(image.terms),
          validUntilMs: Date.now() + 120000,
        };
      },
      async submit() {
        sends++;
        throw new Error("Accepted; response lost");
      },
      async final(image) {
        reads++;
        assert.equal(image.hash, transactionHash);
        return { success: true, minimumHeight: "100", gasYoctoNear: "123" };
      },
      async snapshot() {
        return snapshot;
      },
    };
    await assert.rejects(runV1Publication(f.pool, f.key, gateway), /response lost/);
    assert.equal((await readV1PublicationState(f.pool, f.session, f.id, 1)).state, "submitted");
    assert.equal(
      (await f.pool.query("SELECT state FROM app_events WHERE id=$1", [f.id])).rows[0].state,
      "draft",
    );
    const original = (
      await f.pool.query(
        "SELECT encrypted_transaction FROM app_publication_images WHERE event_id=$1",
        [f.id],
      )
    ).rows[0].encrypted_transaction;
    const receipt = await runV1Publication(f.pool, f.key, gateway);
    assert.equal(receipt.state, "verified");
    assert.deepEqual([prepares, sends, reads], [1, 1, 1]);
    assert.equal(
      (
        await f.pool.query(
          "SELECT encrypted_transaction FROM app_publication_images WHERE event_id=$1",
          [f.id],
        )
      ).rows[0].encrypted_transaction,
      original,
    );
    assert.equal(
      (await f.pool.query("SELECT state FROM app_events WHERE id=$1", [f.id])).rows[0].state,
      "published",
    );
    assert.equal((await runV1Publication(f.pool, f.key, gateway)).state, "idle");
  } finally {
    await f.cleanup();
  }
});

test("V1 publication cannot confirm altered terms or a state block before its original receipts", async () => {
  const f = await fixture();
  try {
    await prepareV1Publication(f.pool, f.key, f.session, randomUUID(), f.id, 1);
    let snapshot!: V1Snapshot;
    const gateway: V1PublicationGateway = {
      async prepare(image) {
        snapshot = {
          block: {
            height: "99",
            hash: "11111111111111111111111111111111",
            timestampMs: Date.now(),
          },
          event: { ...image.terms, status: "published" },
        };
        return {
          hash: "11111111111111111111111111111111",
          signedBase64: "original",
          semantic: canonicalHash(image.terms),
          validUntilMs: Date.now() + 120000,
        };
      },
      async submit() {},
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "123" };
      },
      async snapshot() {
        return snapshot;
      },
    };
    await assert.rejects(runV1Publication(f.pool, f.key, gateway), /receipt block/);
    snapshot.block.height = "100";
    snapshot.event!.deposit = "99999999";
    await assert.rejects(runV1Publication(f.pool, f.key, gateway), /differs/);
    assert.equal((await readV1PublicationState(f.pool, f.session, f.id, 1)).state, "submitted");
    assert.equal(
      (await f.pool.query("SELECT state FROM app_events WHERE id=$1", [f.id])).rows[0].state,
      "draft",
    );
  } finally {
    await f.cleanup();
  }
});

test("two V1 workers cannot sign or submit concurrently for the shared controller", async () => {
  const f = await fixture();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await prepareV1Publication(f.pool, f.key, f.session, randomUUID(), f.id, 1);
    let prepares = 0;
    const gateway: V1PublicationGateway = {
      async prepare(image) {
        prepares++;
        entered();
        await hold;
        return {
          hash: "11111111111111111111111111111111",
          signedBase64: "original",
          semantic: canonicalHash(image.terms),
          validUntilMs: Date.now() + 120000,
        };
      },
      async submit() {},
      async final() {
        return { success: false, minimumHeight: "100", gasYoctoNear: "123" };
      },
      async snapshot() {
        throw new Error("A failed transaction cannot confirm event publication");
      },
    };
    const first = runV1Publication(f.pool, f.key, gateway);
    await ready;
    assert.equal((await runV1Publication(f.pool, f.key, gateway)).state, "busy");
    release();
    assert.equal((await first).state, "failed");
    assert.equal(prepares, 1);
    assert.equal((await readV1PublicationState(f.pool, f.session, f.id, 1)).state, "failed");
    assert.equal(
      (await f.pool.query("SELECT state FROM app_events WHERE id=$1", [f.id])).rows[0].state,
      "draft",
    );
  } finally {
    release();
    await f.cleanup();
  }
});
