import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft, correctPublishedDescription } from "../../src/server/events/accounts";
import {
  prepareSandboxPublication,
  observeSandboxPublication,
  type SandboxPublicationProfile,
} from "../../src/server/events/publication-image";
import { readEventValidators } from "../../src/server/events/validators";
import { readPublicationReadiness } from "../../src/server/events/publication";
import { exportOwnData } from "../../src/server/privacy/export";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { createDeletionConfirmation } from "../../src/server/privacy/confirmation";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";
import { settlementFixture } from "../fixtures/settlement";

async function fixture() {
  const f = await accountFixtures([["host"], []]),
    id = randomUUID(),
    source = settlementFixture();
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  })!;
  const session = hash(f.accounts[0].value),
    data = {
      ...validDraft(),
      commitment: "5",
      capacity: 1,
      sponsorBudget: "0",
      quizzes: [],
      nft: null,
    };
  await saveAccountDraft(f.pool, config.encryptionKey, session, {
    id,
    revision: 0,
    operationId: randomUUID(),
    data,
  });
  const profile: SandboxPublicationProfile = {
    environment: "sandbox",
    domain: "showup.sandbox.authorization.v1",
    deployment: source.context.deployment,
    token: source.context.token,
    manifest: source.context.manifest,
    escrowCodeHash: source.context.escrowCodeHash,
    tokenCodeHash: source.context.tokenCodeHash,
  };
  const input = {
    operationId: randomUUID(),
    eventId: id,
    revision: 1,
    profile,
    template: source.views.event as Record<string, unknown>,
  };
  input.template = (source.views.event as { terms: Record<string, unknown> }).terms;
  return { ...f, config, session, id, data, profile, input, source };
}
test("publication binds one saved material/roster image, rejects changed contract terms and preserves permitted description corrections", async () => {
  const f = await fixture();
  try {
    const prepared = await prepareSandboxPublication(f.pool, f.config, f.session, f.input);
    assert.equal(prepared.sourceQualified, false);
    assert.equal(prepared.liveSubmissionAllowed, false);
    assert.equal(Object.hasOwn(prepared, "salt"), false);
    assert.equal(prepared.terms.app_rules_hash, prepared.appRulesHash);
    assert.deepEqual((await readPublicationReadiness(f.pool, f.session, f.id, 1)).preparation, {
      imageHash: prepared.imageHash,
      revision: 1,
      state: "awaiting_observation",
      observedAt: null,
      sourceQualified: false,
    });
    assert.deepEqual(
      await prepareSandboxPublication(f.pool, f.config, f.session, {
        ...f.input,
        operationId: randomUUID(),
      }),
      prepared,
    );
    await assert.rejects(
      saveAccountDraft(f.pool, f.config.encryptionKey, f.session, {
        id: f.id,
        operationId: randomUUID(),
        revision: 1,
        data: { ...f.data, timeZone: "America/Denver" },
      }),
      /frozen/,
    );
    assert.equal((await readEventValidators(f.pool, f.session, f.id)).frozen, true);
    const source = {
      profile: f.profile,
      block: { ...f.source.block, timestampMs: Date.now() },
      event: {
        ...(f.source.views.event as Record<string, unknown>),
        terms: prepared.terms,
        reserved: [],
        funded: [],
        sponsor_received: "0",
        attendance: 0,
        ledger_version: 0,
      },
    };
    await assert.rejects(
      observeSandboxPublication(f.pool, f.config, f.id, prepared.imageHash, {
        ...source,
        event: { ...source.event, terms: { ...prepared.terms, capacity: 2 } },
      }),
      /differs/,
    );
    await observeSandboxPublication(f.pool, f.config, f.id, prepared.imageHash, source);
    await correctPublishedDescription(
      f.pool,
      f.config.encryptionKey,
      f.session,
      randomUUID(),
      f.id,
      1,
      "Corrected harmless copy",
    );
    await observeSandboxPublication(f.pool, f.config, f.id, prepared.imageHash, source);
    const event = (
      await f.pool.query("SELECT state,rules_hash FROM app_events WHERE id=$1", [f.id])
    ).rows[0];
    assert.equal(event.state, "published");
    assert.equal(event.rules_hash, prepared.rulesHash);
    const exported = await exportOwnData(f.pool, f.config, f.session);
    assert.equal(exported.publicationImages.length, 1);
    assert.equal(Object.hasOwn(exported.publicationImages[0], "encrypted_image"), false);
  } finally {
    await f.cleanup();
  }
});
test("an unresolved publication survives account deletion and its original source can still reconcile", async () => {
  const f = await fixture();
  try {
    const prepared = await prepareSandboxPublication(f.pool, f.config, f.session, f.input),
      operationId = randomUUID();
    const original = (
      await f.pool.query("SELECT encrypted_image FROM app_publication_images WHERE event_id=$1", [
        f.id,
      ])
    ).rows[0].encrypted_image;
    const deletion = await requestAccountDeletion(f.pool, f.config, f.session, {
      operationId,
      confirmation: "DELETE",
      acknowledgeOnChain: true,
      intent: createDeletionConfirmation(f.config, f.accounts[0].id, f.session, operationId),
    });
    assert.equal(deletion.state, "pending_reconciliation");
    assert(deletion.holdReasons.includes("publication_reconciliation"));
    await observeSandboxPublication(f.pool, f.config, f.id, prepared.imageHash, {
      profile: f.profile,
      block: { ...f.source.block, timestampMs: Date.now() },
      event: {
        ...(f.source.views.event as Record<string, unknown>),
        terms: prepared.terms,
        reserved: [],
        funded: [],
        sponsor_received: "0",
        attendance: 0,
        ledger_version: 0,
      },
    });
    assert.equal(
      (
        await f.pool.query("SELECT encrypted_image FROM app_publication_images WHERE event_id=$1", [
          f.id,
        ])
      ).rows[0].encrypted_image,
      original,
    );
  } finally {
    await f.cleanup();
  }
});
