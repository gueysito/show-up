import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAnswer,
  rulePreview,
  usdcAtomic,
  validateDraft,
} from "../../src/domain/event-draft";
import { harnessAvailable, harnessRequestAllowed } from "../../src/server/harness/guard";
import { validDraft } from "../fixtures/draft";

test("30 and 120 minute plans satisfy the fixed timing order", () => {
  for (const minutes of [30, 120]) {
    const draft = validDraft();
    draft.endsAt = new Date(Date.parse(draft.startsAt) + minutes * 60000).toISOString();
    assert.equal(validateDraft(draft).ok, true);
    const p = rulePreview(draft);
    assert.ok(p.checkinOpen < p.onTimeThrough && p.onTimeThrough < p.checkinCutoff);
    assert.equal(p.registrationClose - p.releaseDeadline, 10 * 60000);
    assert.equal(p.hardClose - Date.parse(draft.endsAt), 30 * 60000);
  }
});

test("rejects invalid rules, malformed dates, URL schemes and unknown fields", () => {
  for (const changes of [
    { capacity: 101 },
    { capacity: 0 },
    { capacity: 2.5 },
    { commitment: "2.499999" },
    { commitment: "1e3" },
    { sponsorBudget: "-1" },
    { mode: "unknown" },
    { nft: {} },
    { startsAt: "2030-02-31T12:00:00Z" },
    { startsAt: "2030-01-01T12:00:00" },
    { startsAt: "2020-01-01T12:00:00Z" },
    { timeZone: "not-a-zone" },
    { sessionReference: "javascript:alert(1)" },
    { state: "OPEN" },
  ])
    assert.equal(validateDraft({ ...validDraft(), ...changes }).ok, false, JSON.stringify(changes));
  for (const minutes of [29, 121]) {
    const draft = validDraft();
    draft.endsAt = new Date(Date.parse(draft.startsAt) + minutes * 60000).toISOString();
    assert.equal(validateDraft(draft).ok, false);
  }
  assert.equal(
    validateDraft({ ...validDraft(), mode: "physical", sessionReference: "", venue: "Room A" }).ok,
    true,
  );
});

test("USDC preview conserves every atomic unit for all three presets", () => {
  assert.equal(usdcAtomic("2.500001"), 2500001n);
  assert.equal(usdcAtomic("2.0000001"), null);
  for (const rewardPreset of ["equal", "draw", "hybrid"] as const) {
    const p = rulePreview({ ...validDraft(), sponsorBudget: "100.000001", rewardPreset });
    assert.equal(usdcAtomic(p.equal)! + usdcAtomic(p.draw)!, 100000001n);
    if (rewardPreset === "hybrid") assert.equal(p.equal, "40.00");
  }
});

test("questions have private valid answers and a bounded pre-end window", () => {
  const draft = validDraft();
  const quiz = {
    question: "What did we discuss?",
    type: "short" as const,
    options: [],
    correctOption: 0,
    aliases: ["Community"],
    plannedAt: draft.startsAt,
    durationSeconds: 90,
  };
  draft.quizzes = [quiz];
  assert.equal(validateDraft(draft).ok, true);
  for (const changes of [
    { durationSeconds: 59 },
    { durationSeconds: 181 },
    { aliases: [] },
    { plannedAt: draft.endsAt },
  ]) {
    assert.equal(validateDraft({ ...draft, quizzes: [{ ...quiz, ...changes }] }).ok, false);
  }
  draft.quizzes = [{ ...quiz, type: "choice", options: ["A", " B "], correctOption: 1 }];
  assert.equal(validateDraft(draft).ok, true);
  draft.quizzes[0].options = ["A", " a "];
  assert.equal(validateDraft(draft).ok, false);
  assert.equal(validateDraft({ ...draft, quizzes: [quiz, quiz, quiz] }).ok, false);
  assert.equal(normalizeAnswer("  ＨＥＬＬＯ\n world  "), "hello world");
});

test("NFT is only a planned supplement to a monetary draw", () => {
  const draft = validDraft();
  draft.nft = {
    network: "near",
    collection: "example.testnet",
    assetId: "7",
    contributorReturnAddress: "return.testnet",
  };
  assert.equal(validateDraft(draft).ok, true);
  assert.equal(validateDraft({ ...draft, rewardPreset: "equal" }).ok, false);
  assert.equal(validateDraft({ ...draft, sponsorBudget: "0" }).ok, false);
});

test("harness cannot activate in production or on a remote/cross-site request", () => {
  const env = {
    NODE_ENV: "development",
    SHOWUP_ENV: "test",
    SHOWUP_HARNESS: "1",
    SHOWUP_ORIGIN: "http://127.0.0.1:3103",
  };
  assert.equal(harnessAvailable(env), true);
  assert.equal(harnessAvailable({ ...env, NODE_ENV: "production" }), false);
  assert.equal(harnessAvailable({ ...env, SHOWUP_ORIGIN: "https://example.com" }), false);
  const request = (host: string, origin: string) =>
    new Request(env.SHOWUP_ORIGIN, {
      method: "POST",
      headers: { host, origin, "x-showup-harness": "1" },
    });
  assert.equal(harnessRequestAllowed(request("127.0.0.1:3103", env.SHOWUP_ORIGIN), env), true);
  assert.equal(harnessRequestAllowed(request("evil.example", env.SHOWUP_ORIGIN), env), false);
  assert.equal(
    harnessRequestAllowed(request("127.0.0.1:3103", "https://evil.example"), env),
    false,
  );
});
