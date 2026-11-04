import { engineeringManifest, networkIdentity, type Network } from "./manifest";
import { decodeBase58 } from "./encoding";
import { walletAddress } from "../wallets/proof";
import { unsigned } from "./rpc";
import type { FinalizedHeader } from "./finalized-heads";

export type TransferContext = {
  environment: "mainnet" | "engineering";
  network: Network;
  asset: string;
  transaction: string;
  recipient: string;
  source?: string;
  eventIndex?: number;
};
export type TokenMove = { source: string; recipient: string; amount: string; eventIndex: number };
export function transferHash(network: Network, value: unknown, transaction = false): string {
  if (typeof value !== "string") throw new Error("Missing transfer hash");
  if (network === "base" || network === "ethereum") {
    if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error("Invalid EVM transfer hash");
  } else decodeBase58(value, network === "solana" && transaction ? 64 : 32);
  return value;
}
export function transferContext(input: TransferContext) {
  const identity =
    input.environment === "mainnet"
      ? networkIdentity(input.network)
      : input.environment === "engineering"
        ? engineeringManifest.networks.find((n) => n.id === input.network)
        : undefined;
  if (!identity) throw new Error("Unknown token-transfer profile");
  const contract =
    "usdc" in identity ? identity.usdc : identity.assets.find((a) => a.id === "usdc")!.contract;
  const asset = walletAddress(input.network, input.asset);
  const recipient = walletAddress(input.network, input.recipient);
  if (asset !== contract || /^0x0{40}$/.test(recipient))
    throw new Error("Wrong USDC transfer asset/recipient");
  transferHash(input.network, input.transaction, true);
  if (
    input.eventIndex !== undefined &&
    (!Number.isSafeInteger(input.eventIndex) ||
      input.eventIndex < 0 ||
      input.eventIndex > 0xffffffff)
  )
    throw new Error("Invalid transfer event index");
  return {
    ...input,
    asset,
    recipient,
    chainId: identity.chainId,
    source: input.source === undefined ? undefined : walletAddress(input.network, input.source),
  };
}
export function selectTransfer(context: TransferContext, moves: TokenMove[]) {
  const matches = moves.filter(
    (move) =>
      move.recipient === context.recipient &&
      (context.source === undefined || move.source === context.source) &&
      (context.eventIndex === undefined || move.eventIndex === context.eventIndex),
  );
  if (matches.length !== 1) throw new Error("Missing or ambiguous USDC transfer");
  const move = matches[0];
  // An incoming event followed by a debit is not an unambiguous delivery credit.
  if (
    moves.some(
      (other) =>
        other.source === context.recipient &&
        other.recipient !== context.recipient &&
        BigInt(other.amount) > 0n,
    )
  )
    throw new Error("Recipient also debited in the same transaction");
  return move;
}
export function transferFact(
  context: ReturnType<typeof transferContext>,
  move: TokenMove,
  inclusion: { height: string; hash: string; timestampMs: number },
  finalized: FinalizedHeader,
) {
  transferHash(context.network, inclusion.hash);
  transferHash(context.network, finalized.hash);
  if (
    unsigned(inclusion.height, 64) === 0n ||
    unsigned(inclusion.height, 64) > unsigned(finalized.height, 64) ||
    (inclusion.height === finalized.height && inclusion.hash !== finalized.hash) ||
    !Number.isSafeInteger(inclusion.timestampMs) ||
    inclusion.timestampMs <= 0 ||
    inclusion.timestampMs > finalized.timestampMs + 30_000
  )
    throw new Error("Transfer is outside compared finalized history");
  return {
    network: context.network,
    chainId: context.chainId,
    asset: context.asset,
    transaction: context.transaction,
    ...move,
    creditedAmount: move.source === move.recipient ? "0" : move.amount,
    blockHeight: inclusion.height,
    blockHash: inclusion.hash,
    timestampMs: inclusion.timestampMs,
    finalizedAtHeight: finalized.height,
    attributionQualified: false as const,
    fundingAllowed: false as const,
  };
}
