import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import publicDry from "../fixtures/one-click-dry-public.json";
import { decodeBase58, encodeBase58 } from "../../src/server/protocol/encoding";
import { quoteMessage, verifyQuoteSignature } from "../../src/server/protocol/quote-signature";
import {
  dryQuoteRequest,
  OneClickReadOnly,
  validateQuoteTerms,
  type QuoteRequest,
} from "../../src/server/protocol/one-click";

const observed = Date.parse(publicDry.timestamp) + 1000;
const expected: QuoteRequest = {
  dry: true,
  swapType: "EXACT_OUTPUT",
  slippageTolerance: 100,
  originAsset: publicDry.quoteRequest.originAsset,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: publicDry.quoteRequest.destinationAsset,
  amount: "5000000",
  refundTo: publicDry.quoteRequest.refundTo,
  refundType: "ORIGIN_CHAIN",
  recipient: "intents.near",
  recipientType: "DESTINATION_CHAIN",
  deadline: publicDry.quoteRequest.deadline,
  quoteWaitingTimeMs: 3000,
};

test("public dry response verifies against the pinned production key without authorizing funds", () => {
  assert.equal(verifyQuoteSignature(publicDry), true);
  const terms = validateQuoteTerms(publicDry, expected, observed);
  assert.equal(terms.principal, "5000000");
  assert.equal(terms.fundingAllowed, false);
  assert.equal(terms.hasUnsignedFeeDetails, true);
  assert.equal("depositAddress" in terms, false);
  for (const field of Object.keys(expected)) {
    const changed = structuredClone(publicDry);
    const old = (expected as unknown as Record<string, unknown>)[field];
    Object.assign(changed.quoteRequest, {
      [field]: typeof old === "boolean" ? !old : typeof old === "number" ? old + 1 : "substituted",
    });
    assert.equal(verifyQuoteSignature(changed), false, field);
    assert.throws(() => validateQuoteTerms(changed, expected, observed), /changed/);
  }
  for (const field of [
    "amountIn",
    "minAmountIn",
    "amountOut",
    "minAmountOut",
    "amountInFormatted",
    "amountOutFormatted",
    "amountInUsd",
    "amountOutUsd",
  ]) {
    const changed = structuredClone(publicDry);
    Object.assign(changed.quote, { [field]: "1" });
    assert.equal(verifyQuoteSignature(changed), false, field);
  }
  assert.equal(verifyQuoteSignature({ ...publicDry, signature: "ed25519:invalid" }), false);
  assert.equal(verifyQuoteSignature({ ...publicDry, timestamp: "2030-01-01T00:00:00Z" }), false);
  assert.throws(() => validateQuoteTerms(publicDry, expected, observed + 120_000), /time/);
  assert.throws(() => validateQuoteTerms(publicDry, expected, observed - 60_000), /time/);
});

test("unsigned provider fee/status fields cannot become consent or payment instructions", () => {
  const changed = structuredClone(publicDry);
  changed.quoteRequest.appFees[0] = { recipient: "attacker.near", fee: 9999 };
  changed.quote.refundFee = "9999999999";
  assert.equal(verifyQuoteSignature(changed), true, "the provider algorithm excludes these fields");
  assert.deepEqual(
    validateQuoteTerms(changed, expected, observed),
    validateQuoteTerms(publicDry, expected, observed),
  );
  assert.throws(() =>
    validateQuoteTerms(
      { ...changed, quote: { ...changed.quote, depositAddress: "attacker" } },
      expected,
      observed,
    ),
  );
  assert.throws(() =>
    validateQuoteTerms(
      { ...changed, quoteRequest: { ...changed.quoteRequest, insured: true } },
      expected,
      observed,
    ),
  );
  assert.throws(() =>
    validateQuoteTerms(
      { ...changed, quoteRequest: { ...changed.quoteRequest, customRecipientMsg: "call" } },
      expected,
      observed,
    ),
  );
});

test("wet signed quotes still require independent echoed-deadline and historical recovery checks", () => {
  // Fresh disposable fixture keys, never used by the application adapter.
  const keys = generateKeyPairSync("ed25519");
  const publicKey = `ed25519:${encodeBase58(Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url"))}`;
  const request = { ...expected, dry: false };
  const response = {
    ...structuredClone(publicDry),
    quoteRequest: { ...request },
    quote: {
      ...publicDry.quote,
      depositAddress: "0x1111111111111111111111111111111111111111",
      deadline: expected.deadline,
    },
    signature: "",
  };
  response.signature = `ed25519:${encodeBase58(sign(null, quoteMessage(response), keys.privateKey))}`;
  assert.equal(verifyQuoteSignature(response, publicKey), true);
  assert.equal(verifyQuoteSignature(response), false, "fixture key never accepted by production");
  assert.equal(validateQuoteTerms(response, request, observed).fundingAllowed, false);
  const changed = structuredClone(response);
  changed.quoteRequest.deadline = "2099-01-01T00:00:00Z";
  assert.equal(
    verifyQuoteSignature(changed, publicKey),
    true,
    "flattened quote deadline overwrites request deadline",
  );
  assert.throws(() => validateQuoteTerms(changed, request, observed), /changed/);
  for (const field of ["depositAddress", "depositMemo", "deadline", "refundFee", "withdrawFee"]) {
    const changed = structuredClone(response);
    Object.assign(changed.quote, { [field]: "substituted" });
    assert.equal(verifyQuoteSignature(changed, publicKey), false, field);
  }
  assert.throws(() => validateQuoteTerms(response, request, observed + 86_400_000));
  assert.equal(
    validateQuoteTerms(response, request, observed + 86_400_000, true).fundingAllowed,
    false,
  );
});

test("pricing accepts only manifest assets and bounded public addresses; funding makes no HTTP request", async () => {
  let calls = 0;
  const adapter = new OneClickReadOnly(async () => {
    calls++;
    throw new Error("offline");
  });
  const request = dryQuoteRequest({
    network: "base",
    amount: "5000000",
    refundTo: expected.refundTo,
    recipient: "intents.near",
  });
  assert.equal(request.dry, true);
  for (const network of ["near", "base", "ethereum", "solana"] as const)
    assert.throws(() => adapter.prepareFunding(network), /Funding disabled/);
  await assert.rejects(adapter.dryQuote({ ...request, dry: false }), /only/);
  await assert.rejects(adapter.dryQuote({ ...request, originAsset: "wrong" }), /Unapproved/);
  await assert.rejects(adapter.dryQuote({ ...request, slippageTolerance: 9999 }), /Invalid dry/);
  await assert.rejects(
    adapter.dryQuote({ ...request, deadline: "2099-01-01T00:00:00Z" }),
    /Invalid dry/,
  );
  assert.equal(calls, 0);
  assert.throws(() =>
    dryQuoteRequest({
      network: "base",
      amount: "0",
      refundTo: expected.refundTo,
      recipient: "intents.near",
    }),
  );
  assert.throws(() =>
    dryQuoteRequest({
      network: "base",
      amount: "1e9",
      refundTo: expected.refundTo,
      recipient: "intents.near",
    }),
  );
  assert.throws(() =>
    dryQuoteRequest({
      network: "solana",
      amount: "1",
      refundTo: "not an address",
      recipient: "intents.near",
    }),
  );
  for (const bytes of [Buffer.alloc(32), Buffer.alloc(32, 255), Buffer.from([0, 0, 1, 2, 3])])
    assert.deepEqual(decodeBase58(encodeBase58(bytes), bytes.length), bytes);
  assert.throws(() => decodeBase58("1".repeat(181), 32));
  assert.throws(
    () =>
      dryQuoteRequest({
        network: "base",
        amount: (1n << 128n).toString(),
        refundTo: expected.refundTo,
        recipient: "intents.near",
      }),
    /bounds/,
  );
});

test("read-only transport retries transient errors within limits and rejects oversized or unsigned data", async () => {
  const request = dryQuoteRequest({
    network: "base",
    amount: "5000000",
    refundTo: expected.refundTo,
    recipient: "intents.near",
  });
  let calls = 0;
  const adapter = new OneClickReadOnly(async (url, options) => {
    calls++;
    assert.equal(new URL(String(url)).origin, "https://1click.chaindefuser.com");
    assert.equal(options?.redirect, "error");
    assert.equal(JSON.parse(String(options?.body)).dry, true);
    if (calls === 1) throw new TypeError("temporary failure");
    return new Response(null, { status: calls === 2 ? 429 : 503 });
  });
  await assert.rejects(adapter.dryQuote(request), /unavailable/);
  assert.equal(calls, 3);
  await assert.rejects(
    new OneClickReadOnly(
      async () => new Response("{}", { headers: { "content-length": "9999999" } }),
    ).dryQuote(request),
    /size/,
  );
  await assert.rejects(
    new OneClickReadOnly(async () => new Response("x".repeat(262145))).dryQuote(request),
    /byte limit/,
  );
  await assert.rejects(
    new OneClickReadOnly(async () => Response.json({ quote: {}, signature: "fake" })).dryQuote(
      request,
    ),
    /signature/,
  );
  const status = new OneClickReadOnly(async () =>
    Response.json({ status: "SUCCESS", quoteResponse: publicDry }),
  );
  await assert.rejects(
    status.swapStatus("unverified-destination", { ...expected, dry: false }),
    /changed/,
  );
});
