import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Interface } from "ethers";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { quoteMessage } from "../../src/server/protocol/quote-signature";
import {
  v1RouteRequest,
  validateV1Route,
  v1RouteStatus,
} from "../../src/server/protocol/v1-routing";
import { prepareV1EvmPayment } from "../../src/server/protocol/v1-evm-payment";
import { v1Deployment } from "../../src/server/protocol/v1-escrow";
import { v1RouteAccount } from "../../src/server/protocol/v1-intents";
import { validateQuoteTerms } from "../../src/server/protocol/one-click";
import type { V1RouteRequest } from "../../src/server/protocol/v1-routing";

test("authentic live Intents quotes retain a short app approval window and a separately bounded provider deadline", () => {
  const response = JSON.parse(readFileSync("tests/fixtures/v1-intents-quote.json", "utf8")),
    request = response.quoteRequest as V1RouteRequest,
    now = Date.parse(response.timestamp),
    route = validateV1Route("base", request, response, now);
  assert.equal(route.principal, "1000000");
  assert.equal(route.expiresAt, request.deadline);
  assert.equal(Date.parse(response.quote.deadline) - Date.parse(request.deadline), 3 * 86400000);
  assert.throws(() => validateQuoteTerms(response, request, now), /deadline/);
  assert.throws(
    () => validateV1Route("base", request, response, Date.parse(request.deadline) + 1),
    /Expired|deadline/,
  );
});

test("status defaults preserve the original signed quote while altered recipients and money fields are rejected", async () => {
  const response = JSON.parse(readFileSync("tests/fixtures/v1-intents-quote.json", "utf8")),
    request = v1RouteRequest(
      "base",
      response.quoteRequest.refundTo,
      response.quoteRequest.customRecipientMsg.slice(8),
      response.quoteRequest.amount,
      Date.parse(response.quoteRequest.deadline) - 5 * 60000,
    ),
    route = validateV1Route("base", request, response, Date.parse(response.timestamp));
  const normalizedRequest: Record<string, unknown> = { ...response.quoteRequest };
  delete normalizedRequest.quoteWaitingTimeMs;
  let echo = {
    ...response,
    quoteRequest: {
      ...normalizedRequest,
      insured: false,
      appFees: [],
      referral: null,
    },
  };
  const transport: typeof fetch = async (url) => {
    assert(
      String(url).endsWith(
        new URLSearchParams({ depositAddress: route.depositAddress }).toString(),
      ),
    );
    return Response.json({ status: "SUCCESS", quoteResponse: echo });
  };
  assert.equal(await v1RouteStatus(route, transport), "SUCCESS");
  echo = { ...echo, quoteRequest: { ...echo.quoteRequest, recipient: "attacker.near" } };
  await assert.rejects(v1RouteStatus(route, transport), /signature|changed/);
  echo = {
    ...response,
    quoteRequest: {
      ...normalizedRequest,
      insured: false,
      appFees: [],
      referral: null,
    },
    quote: { ...response.quote, amountIn: "2000000" },
  };
  await assert.rejects(v1RouteStatus(route, transport), /money fields/);
  echo = {
    ...response,
    quoteRequest: normalizedRequest,
    quote: { ...response.quote, refundFee: "9952", timeEstimate: 999 },
  };
  assert.equal(await v1RouteStatus(route, transport), "SUCCESS");
  assert.notEqual(route.response.quote, echo.quote);
  assert.equal(
    (route.response.quote as Record<string, unknown>).refundFee,
    response.quote.refundFee,
  );
  echo = {
    ...echo,
    quote: { ...echo.quote, depositAddress: "0x3333333333333333333333333333333333333333" },
  };
  await assert.rejects(v1RouteStatus(route, transport), /money fields/);
  echo = { ...response, quoteRequest: normalizedRequest, signature: "ed25519:changed" };
  await assert.rejects(v1RouteStatus(route, transport), /differs/);
});

test("signed cross-chain quotes bind the native token, exact output, fixed message, source refund and expiry", () => {
  const keys = generateKeyPairSync("ed25519"),
    publicKey = `ed25519:${encodeBase58(Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url"))}`;
  const request = v1RouteRequest(
    "base",
    "0x1111111111111111111111111111111111111111",
    "5b6160bc-b2bd-4c14-8c3e-7175fcfe38a2",
    "1000000",
  );
  const unsigned = {
    timestamp: new Date().toISOString(),
    quoteRequest: request,
    quote: {
      amountIn: "1100000",
      minAmountIn: "1090000",
      amountOut: "1000000",
      minAmountOut: "1000000",
      depositAddress: "0x2222222222222222222222222222222222222222",
      deadline: request.deadline,
    },
  };
  function signed(value: typeof unsigned) {
    return {
      ...value,
      signature: `ed25519:${encodeBase58(sign(null, quoteMessage(value), keys.privateKey))}`,
    };
  }
  const quote = signed(unsigned);
  assert.throws(() => validateV1Route("base", request, quote), /signature/);
  const route = validateV1Route("base", request, quote, Date.now(), false, publicKey);
  assert.equal(route.input, "1100000");
  assert.equal(route.principal, "1000000");
  const extended = signed({
    ...unsigned,
    quote: {
      ...unsigned.quote,
      deadline: new Date(Date.parse(request.deadline) + 3 * 86400000).toISOString(),
    },
  });
  assert.equal(
    validateV1Route("base", request, extended, Date.now(), false, publicKey).expiresAt,
    request.deadline,
  );
  assert.throws(
    () => validateV1Route("ethereum", request, quote, Date.now(), false, publicKey),
    /policy/,
  );
  assert.throws(
    () =>
      validateV1Route(
        "base",
        { ...request, recipient: "attacker.near" },
        quote,
        Date.now(),
        false,
        publicKey,
      ),
    /policy/,
  );
  assert.equal(request.recipient, v1RouteAccount("5b6160bc-b2bd-4c14-8c3e-7175fcfe38a2"));
  assert.equal(request.recipientType, "INTENTS");
  assert.notEqual(request.recipient, v1Deployment.account);
  assert.equal(request.customRecipientMsg, "deposit:5b6160bc-b2bd-4c14-8c3e-7175fcfe38a2");
  for (const change of [
    { recipient: "attacker.near" },
    { refundTo: "0x3333333333333333333333333333333333333333" },
    { customRecipientMsg: "deposit:other" },
    { originAsset: "other" },
  ]) {
    const altered = { ...unsigned, quoteRequest: { ...request, ...change } };
    assert.throws(
      () => validateV1Route("base", request, signed(altered), Date.now(), false, publicKey),
      /changed/,
    );
  }
  for (const change of [
    { amountOut: "999999" },
    { minAmountOut: "999999" },
    { amountIn: "2000001" },
    { depositAddress: "0x0000000000000000000000000000000000000000" },
    { depositAddress: request.refundTo },
    { deadline: new Date(Date.parse(request.deadline) + 3 * 86400000 + 1).toISOString() },
    { timeWhenInactive: "invalid" },
  ]) {
    assert.throws(() =>
      validateV1Route(
        "base",
        request,
        signed({ ...unsigned, quote: { ...unsigned.quote, ...change } }),
        Date.now(),
        false,
        publicKey,
      ),
    );
  }
  assert.throws(
    () =>
      validateV1Route("base", request, quote, Date.parse(request.deadline) + 1, false, publicKey),
    /Expired|deadline/,
  );
});

test("EVM payment requests transfer only the quoted USDC and enforce independent chain, balance and gas limits", async () => {
  const request = v1RouteRequest(
    "base",
    "0x1111111111111111111111111111111111111111",
    "5b6160bc-b2bd-4c14-8c3e-7175fcfe38a2",
    "1000000",
  );
  const route = {
    network: "base" as const,
    request,
    response: {},
    input: "1100000",
    principal: "1000000",
    depositAddress: "0x2222222222222222222222222222222222222222",
    expiresAt: request.deadline,
  };
  let chain = "0x2105",
    balance = "0x124f80",
    price = "0xf4240",
    pending = "0x0",
    transferOk = true;
  const transport: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    const result =
      input.method === "eth_chainId"
        ? chain
        : input.method === "eth_getBalance"
          ? "0x5af3107a4000"
          : input.method === "eth_call"
            ? input.params[0].data.startsWith("0xa9059cbb")
              ? "0x" + "0".repeat(63) + (transferOk ? "1" : "0")
              : "0x" + balance.slice(2).padStart(64, "0")
            : input.method === "eth_getTransactionCount"
              ? input.params[1] === "pending"
                ? pending
                : "0x0"
              : price;
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  const payment = await prepareV1EvmPayment(route, request.refundTo, transport);
  assert.equal(payment.transaction.to, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(payment.transaction.value, "0x0");
  assert.equal(payment.transaction.gas, "0x186a0");
  assert.equal(payment.transaction.nonce, "0x0");
  const decoded = new Interface([
    "function transfer(address to,uint256 amount)",
  ]).decodeFunctionData("transfer", payment.transaction.data);
  assert.equal(decoded[0].toLowerCase(), route.depositAddress);
  assert.equal(decoded[1], 1100000n);
  chain = "0x1";
  const ethereum = await prepareV1EvmPayment(
    {
      ...route,
      network: "ethereum",
      request: v1RouteRequest(
        "ethereum",
        request.refundTo,
        "5b6160bc-b2bd-4c14-8c3e-7175fcfe38a2",
        "1000000",
      ),
    },
    request.refundTo,
    transport,
  );
  assert.equal(ethereum.transaction.chainId, "0x1");
  assert.equal(ethereum.transaction.to, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  chain = "0x2105";
  balance = "0xf4240";
  await assert.rejects(prepareV1EvmPayment(route, request.refundTo, transport), /USDC amount/);
  balance = "0x124f80";
  chain = "0x1";
  await assert.rejects(prepareV1EvmPayment(route, request.refundTo, transport), /chain changed/);
  chain = "0x2105";
  transferOk = false;
  await assert.rejects(
    prepareV1EvmPayment(route, request.refundTo, transport),
    /could not be checked/,
  );
  transferOk = true;
  pending = "0x1";
  await assert.rejects(
    prepareV1EvmPayment(route, request.refundTo, transport),
    /pending transaction/,
  );
  pending = "0x0";
  price = "0x3b9aca00";
  await assert.rejects(prepareV1EvmPayment(route, request.refundTo, transport), /gas/);
});
