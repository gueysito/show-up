import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { seal } from "../../src/server/auth/crypto";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { v1Deployment, v1PreviousCodeHashes } from "../../src/server/protocol/v1-escrow";
import {
  storedV1Publication,
  v1DraftTerms,
  type V1PublicationImage,
  type V1PublicationRow,
} from "../../src/server/events/v1-publication";
import { validDraft } from "../fixtures/draft";

test("reviewed upgrades preserve authentic frozen events and reject changed deployment identities", () => {
  const key = randomBytes(32).toString("hex"),
    eventId = randomUUID(),
    ownerId = randomUUID(),
    data = { ...validDraft(), commitment: "1", sponsorBudget: "0", capacity: 2 },
    salt = "profile-regression",
    { description: _copy, ...fixed } = data;
  void _copy;
  const image: V1PublicationImage = {
    format: "showup.v1.mainnet-publication.v1",
    deployment: {
      account: v1Deployment.account,
      owner: v1Deployment.owner,
      token: v1Deployment.token,
      codeHash: v1Deployment.codeHash,
    },
    eventId,
    ownerId,
    revision: 1,
    salt,
    materialHash: canonicalHash({ format: "showup.v1.app-material.v1", salt, fixed }),
    terms: v1DraftTerms(eventId, data),
  };
  const row = (candidate: V1PublicationImage): V1PublicationRow => ({
    event_id: eventId,
    owner_id: ownerId,
    data,
    revision: 1,
    draft_revision: 1,
    image_hash: canonicalHash(candidate),
    encrypted_image: seal(key, `publication-image:${ownerId}:${eventId}`, candidate),
    transaction_state: "awaiting_prize",
    transaction_hash: null,
    encrypted_transaction: null,
  });
  for (const codeHash of [v1Deployment.codeHash, ...v1PreviousCodeHashes]) {
    const historical = { ...image, deployment: { ...image.deployment, codeHash } };
    assert.deepEqual(storedV1Publication(key, row(historical)), historical);
  }
  for (const change of [
    { codeHash: "11111111111111111111111111111111" },
    { account: "other.near" },
    { owner: "other.near" },
    { token: "other.near" },
    { extra: "unreviewed" },
  ]) {
    const changed = { ...image, deployment: { ...image.deployment, ...change } };
    assert.throws(() => storedV1Publication(key, row(changed)), /integrity/);
  }
  const original = row(image);
  assert.throws(
    () => storedV1Publication(key, { ...original, image_hash: "0".repeat(64) }),
    /integrity/,
  );
  assert.throws(
    () => storedV1Publication(key, { ...original, data: { ...data, capacity: 3 } }),
    /integrity/,
  );
});
