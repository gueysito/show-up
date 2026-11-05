import { getAddress } from "ethers";
import { dryQuoteRequest, validateQuoteTerms, boundedJson, type QuoteRequest } from "./one-click";
import { networkManifest, networkIdentity } from "./manifest";
import { verifyQuoteSignature, record } from "./quote-signature";
import { walletAddress } from "../wallets/proof";
import { v1Deployment } from "./v1-escrow";

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
    request.recipient !== v1Deployment.account ||
    request.swapType !== "EXACT_OUTPUT" ||
    request.depositType !== "ORIGIN_CHAIN" ||
    request.refundType !== "ORIGIN_CHAIN" ||
    request.recipientType !== "DESTINATION_CHAIN" ||
    request.slippageTolerance !== 100 ||
    !/^deposit:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.customRecipientMsg)
  )
    throw new Error("V1 route policy mismatch");
  if (!verifyQuoteSignature(value, quoteKey)) throw new Error("Invalid route quote signature");
  const response = record(value),
    terms = validateQuoteTerms(response, request, now, historical),
    quote = record(response.quote);
  if (BigInt(terms.amountIn) > BigInt(request.amount) + 1000000n)
    throw new Error("Route cost exceeds one USDC above principal");
  const address = walletAddress(network, String(quote.depositAddress));
  if (/^0x0{40}$/i.test(address) || address === "11111111111111111111111111111111")
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
    expiresAt: String(quote.deadline),
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
    quote = validateV1Route(route.network, route.request, value.quoteResponse, Date.now(), true);
  if (quote.depositAddress !== route.depositAddress || quote.input !== route.input)
    throw new Error("Routing status differs from original quote");
  return typeof value.status === "string" ? value.status.slice(0, 64) : "UNKNOWN";
}
