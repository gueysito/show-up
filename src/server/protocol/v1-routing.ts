import { getAddress } from "ethers";
import { dryQuoteRequest, validateQuoteTerms, boundedJson, type QuoteRequest } from "./one-click";
import { networkManifest, networkIdentity } from "./manifest";
import { verifyQuoteSignature, record } from "./quote-signature";
import { walletAddress } from "../wallets/proof";
import { v1Deployment } from "./v1-escrow";
import { v1RouteAccount } from "./v1-intents";

export type V1RouteRequest = QuoteRequest & { customRecipientMsg: string };
export type V1Route = {
  network: "base" | "ethereum" | "solana";
  request: V1RouteRequest;
  response: Record<string, unknown>;
  input: string;
  principal: string;
  depositAddress: string;
  expiresAt: string;
};
export function v1RouteRequest(
  network: V1Route["network"],
  source: string,
  registration: string,
  amount: string,
  now = Date.now(),
): V1RouteRequest {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(registration))
    throw new Error("Invalid route registration");
  return {
    ...dryQuoteRequest({ network, amount, refundTo: source, recipient: v1Deployment.account, now }),
    dry: false,
    recipientType: "INTENTS",
    recipient: v1RouteAccount(registration),
    customRecipientMsg: `deposit:${registration}`,
  };
}
export function validateV1Route(
  network: V1Route["network"],
  request: V1RouteRequest,
  value: unknown,
  now = Date.now(),
  historical = false,
  quoteKey?: string,
): V1Route {
  const asset = networkIdentity(network).assets.find((asset) => asset.id === "usdc")!;
  if (
    request.dry !== false ||
    request.originAsset !== asset.routeAsset ||
    request.destinationAsset !== `nep141:${v1Deployment.token}` ||
    request.recipient !==
      (request.recipientType === "INTENTS"
        ? v1RouteAccount(request.customRecipientMsg.slice(8))
        : v1Deployment.account) ||
    request.swapType !== "EXACT_OUTPUT" ||
    request.depositType !== "ORIGIN_CHAIN" ||
    request.refundType !== "ORIGIN_CHAIN" ||
    !["DESTINATION_CHAIN", "INTENTS"].includes(request.recipientType) ||
    request.slippageTolerance !== 100 ||
    !/^deposit:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.customRecipientMsg)
  )
    throw new Error("V1 route policy mismatch");
  if (!verifyQuoteSignature(value, quoteKey)) throw new Error("Invalid route quote signature");
  const response = record(value),
    // Live Intents quotes currently sign a provider deadline three days beyond
    // the request. This never extends the application's source approval window.
    terms = validateQuoteTerms(response, request, now, historical, true),
    quote = record(response.quote);
  if (BigInt(terms.amountIn) > BigInt(request.amount) + 1000000n)
    throw new Error("Route cost exceeds one USDC above principal");
  const address = walletAddress(network, String(quote.depositAddress));
  if (
    /^0x0{40}$/i.test(address) ||
    address === "11111111111111111111111111111111" ||
    address === walletAddress(network, request.refundTo)
  )
    throw new Error("Invalid zero routing destination");
  if (quote.depositMemo) throw new Error("Memo routes are not supported in V1");
  if (network !== "solana") getAddress(address);
  return {
    network,
    request,
    response,
    input: terms.amountIn,
    principal: request.amount,
    depositAddress: address,
    expiresAt: new Date(
      Math.min(
        Date.parse(request.deadline),
        Date.parse(String(quote.deadline)),
        quote.timeWhenInactive ? Date.parse(String(quote.timeWhenInactive)) : Infinity,
      ),
    ).toISOString(),
  };
}
export async function requestV1Route(
  network: V1Route["network"],
  request: V1RouteRequest,
  transport: typeof fetch = fetch,
) {
  const response = await transport(`${networkManifest.providers.oneClick.origin}/v0/quote`, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Cross-chain quote service unavailable");
  }
  return validateV1Route(network, request, await boundedJson(response));
}
export async function v1RouteStatus(route: V1Route, transport: typeof fetch = fetch) {
  const response = await transport(
    `${networkManifest.providers.oneClick.origin}/v0/status?${new URLSearchParams({ depositAddress: route.depositAddress })}`,
    { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Routing status unavailable");
  }
  const value = record(await boundedJson(response)),
    echoed = record(value.quoteResponse),
    echoedRequest = record(echoed.quoteRequest),
    echoedQuote = record(echoed.quote),
    originalQuote = record(route.response.quote),
    original = validateV1Route(route.network, route.request, route.response, Date.now(), true);
  // Status omits latency settings and updates fees without re-signing. Verify the
  // stored quote, bind the hint to its immutable money/destination fields, and
  // discard all echoed fees/estimates. Only actual escrow receipts confirm seats.
  if (
    echoed.signature !== route.response.signature ||
    echoed.timestamp !== route.response.timestamp ||
    original.depositAddress !== route.depositAddress ||
    original.input !== route.input
  )
    throw new Error("Routing status differs from original quote");
  for (const [key, expected] of Object.entries(route.request))
    if (key !== "quoteWaitingTimeMs" && echoedRequest[key] !== expected)
      throw new Error("Routing status request changed");
  for (const key of [
    "amountIn",
    "minAmountIn",
    "amountOut",
    "minAmountOut",
    "depositAddress",
    "depositMemo",
    "deadline",
  ])
    if (echoedQuote[key] !== originalQuote[key])
      throw new Error("Routing status money fields changed");
  return [
    "KNOWN_DEPOSIT_TX",
    "PENDING_DEPOSIT",
    "INCOMPLETE_DEPOSIT",
    "PROCESSING",
    "SUCCESS",
    "REFUNDED",
    "FAILED",
  ].includes(String(value.status))
    ? String(value.status)
    : "UNKNOWN";
}
