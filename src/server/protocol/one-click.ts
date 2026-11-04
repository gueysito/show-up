import { setTimeout as delay } from "node:timers/promises";
import { decodeBase58 } from "./encoding";
import { networkIdentity, networkManifest, requireFundingRoute, type Network } from "./manifest";
import { record, verifyQuoteSignature } from "./quote-signature";

export type QuoteRequest = {
  dry: boolean;
  swapType: "EXACT_OUTPUT" | "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
  quoteWaitingTimeMs: number;
};

export function integerAmount(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(value))
    throw new Error("Invalid integer token amount");
  const amount = BigInt(value);
  if (amount > (1n << 128n) - 1n) throw new Error("Token amount exceeds escrow bounds");
  return amount;
}

function validAddress(network: Network, value: string) {
  if (typeof value !== "string") throw new Error("Invalid route destination");
  if (network === "base" || network === "ethereum") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value))
      throw new Error("Invalid EVM destination");
  } else if (network === "solana") decodeBase58(value, 32);
  else if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value) || value.length < 2 || value.length > 64)
    throw new Error("Invalid NEAR destination");
}

export function dryQuoteRequest(input: {
  network: Network;
  amount: string;
  refundTo: string;
  recipient: string;
  now?: number;
}): QuoteRequest {
  const source = networkIdentity(input.network).assets.find((asset) => asset.id === "usdc")!;
  if (integerAmount(input.amount) <= 0n) throw new Error("Principal must be positive");
  validAddress(input.network, input.refundTo);
  validAddress("near", input.recipient);
  return {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: source.routeAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: `nep141:${networkManifest.settlement.contract}`,
    amount: input.amount,
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date((input.now ?? Date.now()) + 5 * 60_000).toISOString(),
    quoteWaitingTimeMs: 3000,
  };
}

// Prices delivery of an existing NEAR USDC liability. This is not a payout
// instruction: neither dry response fields nor provider status authorize a send.
export function dryReturnQuoteRequest(input: {
  network: Network;
  amount: string;
  refundTo: string;
  recipient: string;
  now?: number;
}): QuoteRequest {
  if (input.network === "near") throw new Error("Native NEAR return needs no cross-chain quote");
  const destination = networkIdentity(input.network).assets.find((asset) => asset.id === "usdc")!;
  if (integerAmount(input.amount) <= 0n) throw new Error("Principal must be positive");
  validAddress("near", input.refundTo);
  validAddress(input.network, input.recipient);
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: `nep141:${networkManifest.settlement.contract}`,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: destination.routeAsset,
    amount: input.amount,
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date((input.now ?? Date.now()) + 5 * 60_000).toISOString(),
    quoteWaitingTimeMs: 3000,
  };
}

// Independent policy check: the signature's flattened deadline can hide a changed
// echoed request deadline. Compare the request itself, then bound both deadlines.
export function validateQuoteTerms(
  value: unknown,
  expected: QuoteRequest,
  now = Date.now(),
  historical = false,
) {
  const response = record(value);
  const request = record(response.quoteRequest);
  const quote = record(response.quote);
  for (const [key, value] of Object.entries(expected)) {
    if (request[key] !== value) throw new Error("Provider changed an authorized quote field");
  }
  for (const key of [
    "referral",
    "virtualChainRecipient",
    "virtualChainRefundRecipient",
    "customRecipientMsg",
  ])
    if (request[key]) throw new Error("Unexpected route modifier");
  if ((request.depositMode && request.depositMode !== "SIMPLE") || request.insured)
    throw new Error("Unsupported unsigned route option");
  const timestamp = Date.parse(String(response.timestamp));
  const deadline = Date.parse(expected.deadline);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now + 30_000 ||
    !Number.isFinite(deadline) ||
    deadline <= timestamp ||
    deadline > timestamp + 60 * 60_000 ||
    (!historical && (timestamp < now - 60_000 || deadline <= now))
  )
    throw new Error("Expired or invalid quote time");
  const amountIn = integerAmount(quote.amountIn);
  const minimumIn = integerAmount(quote.minAmountIn);
  const amountOut = integerAmount(quote.amountOut);
  const minimumOut = integerAmount(quote.minAmountOut);
  if (
    amountIn <= 0n ||
    minimumIn <= 0n ||
    minimumIn > amountIn ||
    minimumOut <= 0n ||
    minimumOut > amountOut ||
    (expected.swapType === "EXACT_OUTPUT"
      ? amountOut !== integerAmount(expected.amount) || minimumOut !== amountOut
      : expected.swapType !== "EXACT_INPUT" ||
        amountIn !== integerAmount(expected.amount) ||
        minimumIn !== amountIn)
  )
    throw new Error("Quote does not cover the full principal");
  if (expected.dry && (quote.depositAddress || quote.depositMemo))
    throw new Error("A dry quote must not supply a deposit destination");
  if (!expected.dry) {
    const quoteDeadline = Date.parse(String(quote.deadline));
    if (
      !Number.isFinite(quoteDeadline) ||
      quoteDeadline <= timestamp ||
      quoteDeadline > deadline ||
      (!historical && quoteDeadline <= now) ||
      typeof quote.depositAddress !== "string" ||
      !quote.depositAddress ||
      quote.depositAddress.length > 128
    )
      throw new Error("Invalid signed deposit destination or deadline");
  }
  return {
    amountIn: amountIn.toString(),
    principal: expected.amount,
    quotedOutput: amountOut.toString(),
    minimumOutput: minimumOut.toString(),
    expiresAt: expected.deadline,
    // Provider dry quotes do not sign fee details, estimates or appFees. Do not
    // copy those fields into consent or payment instructions.
    hasUnsignedFeeDetails: Boolean(request.appFees || quote.refundFee || quote.withdrawFee),
    fundingAllowed: false as const,
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length")) > 262144) {
    await response.body?.cancel();
    throw new Error("Invalid provider response size");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 262144) throw new Error("Provider response exceeded its byte limit");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } finally {
    await reader.cancel();
  }
}

export class OneClickReadOnly {
  constructor(private readonly transport: typeof fetch = fetch) {}

  private async request(path: string, body?: QuoteRequest): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.transport(`${networkManifest.providers.oneClick.origin}/v0/${path}`, {
          method: body ? "POST" : "GET",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        if (attempt === 2) throw new Error("Quote service unavailable");
        await delay(250 * (attempt + 1));
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await delay(250 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Quote service unavailable (${response.status})`);
      }
      return boundedJson(response);
    }
    throw new Error("Quote service unavailable");
  }

  async dryQuote(request: QuoteRequest) {
    if (request.dry !== true) throw new Error("This adapter only prepares dry pricing");
    const returning = request.swapType === "EXACT_INPUT";
    const network = networkManifest.networks.find((network) =>
      network.assets.some(
        (asset) =>
          asset.id === "usdc" &&
          asset.routeAsset === (returning ? request.destinationAsset : request.originAsset),
      ),
    );
    if (!network) throw new Error("Unapproved pricing asset");
    const input = {
      amount: request.amount,
      refundTo: request.refundTo,
      recipient: request.recipient,
    };
    const allowed = returning
      ? dryReturnQuoteRequest({ ...input, network: network.id as Network })
      : dryQuoteRequest({ ...input, network: network.id as Network });
    if (
      Object.keys(request).length !== Object.keys(allowed).length ||
      Object.entries(allowed).some(
        ([key, value]) => key !== "deadline" && record(request)[key] !== value,
      ) ||
      !Number.isFinite(Date.parse(request.deadline)) ||
      Date.parse(request.deadline) <= Date.now() ||
      Date.parse(request.deadline) > Date.now() + 5 * 60_000
    )
      throw new Error("Invalid dry pricing request");
    const response = await this.request("quote", request);
    if (!verifyQuoteSignature(response)) throw new Error("Invalid provider quote signature");
    return validateQuoteTerms(response, request);
  }

  async swapStatus(depositAddress: string, expected: QuoteRequest, depositMemo?: string) {
    if (
      expected.dry ||
      !depositAddress ||
      depositAddress.length > 128 ||
      (depositMemo?.length ?? 0) > 128
    )
      throw new Error("Invalid status context");
    const query = new URLSearchParams({ depositAddress });
    if (depositMemo) query.set("depositMemo", depositMemo);
    const response = record(await this.request(`status?${query}`));
    const nested = record(response.quoteResponse);
    if (!verifyQuoteSignature(nested)) throw new Error("Invalid status quote signature");
    const terms = validateQuoteTerms(nested, expected, Date.now(), true);
    const quote = record(nested.quote);
    if (quote.depositAddress !== depositAddress || (quote.depositMemo ?? undefined) !== depositMemo)
      throw new Error("Status belongs to another route");
    // The outer status is unsigned by the quote algorithm. No status can create
    // a seat, discharge a liability or authorize a new transfer.
    return {
      ...terms,
      hint: typeof response.status === "string" ? response.status.slice(0, 64) : "UNKNOWN",
    };
  }

  prepareFunding(network: Network): never {
    return requireFundingRoute(network);
  }
}
