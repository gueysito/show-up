import assert from "node:assert/strict";
import { test } from "node:test";
import { publicationChecks } from "../../src/server/events/publication";
import { validDraft } from "../fixtures/draft";

test("publication prerequisites distinguish validation from unverified funding and adapt to the actual saved prize plan", () => {
  const now = Date.now(),
    draft = validDraft();
  const states = (data = draft) =>
    Object.fromEntries(publicationChecks(data, now).map((check) => [check.id, check.state]));
  assert.deepEqual(states({ ...draft, sponsorBudget: "0", rewardPreset: "equal", nft: null }), {
    rules: "ready",
    routes: "blocked",
    escrow: "blocked",
    execution: "blocked",
    sponsor: "not_required",
    nft: "not_required",
    draw: "not_required",
    staff: "blocked",
  });
  assert.equal(states({ ...draft, rewardPreset: "hybrid", sponsorBudget: "100" }).draw, "blocked");
  const nft = {
    network: "near" as const,
    collection: "fictional.near",
    assetId: "fictional",
    contributorReturnAddress: "fictional.near",
  };
  assert.equal(
    states({ ...draft, nft, rewardPreset: "draw", sponsorBudget: "100" }).nft,
    "blocked",
  );
  assert.equal(states({ ...draft, startsAt: new Date(now - 1).toISOString() }).rules, "blocked");
  assert.match(
    publicationChecks({ ...draft, mode: "physical" }, now).find((check) => check.id === "staff")!
      .detail,
    /validators/,
  );
});
