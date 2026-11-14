import { decodeBase58 } from "./encoding";
import { engineeringManifest, networkIdentity, type Network } from "./manifest";
import { record } from "./quote-signature";
import { ReadOnlyRpc, unsigned } from "./rpc";

export type FinalizedHeader = {
  height: string;
  hash: string;
  timestampMs: number;
  blockHeight?: string;
};

export class FinalizedSourceConflict extends Error {}

function timestamp(value: unknown, divisor: bigint, now: number, maximumLag: number): number {
  const milliseconds = unsigned(value) / divisor;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid block time");
  const result = Number(milliseconds);
  if (result > now + 30_000 || result < now - maximumLag)
    throw new Error("Finalized source is stale or future-dated");
  return result;
}
function evmHeader(value: unknown, now: number): FinalizedHeader {
  const block = record(value);
  if (typeof block.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(block.hash))
    throw new Error("Missing finalized block hash");
  return {
    height: unsigned(block.number, 64).toString(),
    hash: block.hash,
    timestampMs: timestamp(unsigned(block.timestamp) * 1000n, 1n, now, 30 * 60_000),
  };
}
function nearHeader(value: unknown, now: number): FinalizedHeader {
  const header = record(record(value).header);
  if (typeof header.hash !== "string") throw new Error("Missing final block hash");
  decodeBase58(header.hash, 32);
  return {
    height: unsigned(header.height, 64).toString(),
    hash: header.hash,
    timestampMs: timestamp(header.timestamp_nanosec ?? header.timestamp, 1_000_000n, now, 120_000),
  };
}
function solanaHeader(value: unknown, slot: bigint, now: number): FinalizedHeader {
  const block = record(value);
  if (typeof block.blockhash !== "string") throw new Error("Missing finalized block hash");
  decodeBase58(block.blockhash, 32);
  return {
    height: slot.toString(),
    hash: block.blockhash,
    blockHeight: unsigned(block.blockHeight, 64).toString(),
    timestampMs: timestamp(unsigned(block.blockTime) * 1000n, 1n, now, 120_000),
  };
}

function chainId(network: Network, environment: "mainnet" | "engineering") {
  const entry =
    environment === "mainnet"
      ? networkIdentity(network)
      : engineeringManifest.networks.find((item) => item.id === network);
  if (!entry) throw new Error("Unsupported RPC chain profile");
  return entry.chainId;
}
async function head(
  client: ReadOnlyRpc,
  network: Network,
  signal: AbortSignal,
  now: number,
  environment: "mainnet" | "engineering",
) {
  const expected = chainId(network, environment);
  if (network === "base" || network === "ethereum") {
    if (unsigned(await client.read("eth_chainId", [], signal)).toString() !== expected)
      throw new Error("Wrong RPC chain");
    return evmHeader(await client.read("eth_getBlockByNumber", ["finalized", false], signal), now);
  }
  if (network === "near") {
    if (record(await client.read("status", [], signal)).chain_id !== expected)
      throw new Error("Wrong RPC network");
    return nearHeader(await client.read("block", { finality: "final" }, signal), now);
  }
  if ((await client.read("getGenesisHash", [], signal)) !== expected)
    throw new Error("Wrong RPC genesis");
  const slot = unsigned(await client.read("getSlot", [{ commitment: "finalized" }], signal), 64);
  return { height: slot.toString(), hash: "", timestampMs: now };
}

async function blockAt(
  client: ReadOnlyRpc,
  network: Network,
  height: bigint,
  signal: AbortSignal,
  now: number,
) {
  if (network === "base" || network === "ethereum")
    return evmHeader(
      await client.read("eth_getBlockByNumber", [`0x${height.toString(16)}`, false], signal),
      now,
    );
  if (height > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("RPC height cannot be represented safely");
  if (network === "near")
    return nearHeader(await client.read("block", { block_id: Number(height) }, signal), now);
  return solanaHeader(
    await client.read(
      "getBlock",
      [
        Number(height),
        {
          commitment: "finalized",
          transactionDetails: "none",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
      signal,
    ),
    height,
    now,
  );
}

// Metadata comparison only. Caller supplies clients by fixed registry ID; this
// does not qualify operator independence, actual assets or a funding route.
export async function compareFinalizedHeads(
  network: Network,
  first: ReadOnlyRpc,
  second: ReadOnlyRpc,
  now = Date.now(),
  signal?: AbortSignal,
  environment: "mainnet" | "engineering" = "mainnet",
) {
  return compareSources(network, first, second, now, undefined, signal, environment);
}

// The requested state slot/block must already be finalized by both sources.
// This is useful for Solana account responses, whose actual context slot may
// differ from the initial head despite a minContextSlot request.
export async function compareFinalizedBlock(
  network: Network,
  first: ReadOnlyRpc,
  second: ReadOnlyRpc,
  height: string,
  now = Date.now(),
  signal?: AbortSignal,
  environment: "mainnet" | "engineering" = "mainnet",
) {
  return compareSources(network, first, second, now, height, signal, environment);
}

async function compareSources(
  network: Network,
  first: ReadOnlyRpc,
  second: ReadOnlyRpc,
  now: number,
  requestedHeight?: string,
  outerSignal?: AbortSignal,
  environment: "mainnet" | "engineering" = "mainnet",
) {
  if (
    first.endpoint.network !== network ||
    second.endpoint.network !== network ||
    (first.endpoint.environment ?? "mainnet") !== environment ||
    (second.endpoint.environment ?? "mainnet") !== environment ||
    first.endpoint.id === second.endpoint.id ||
    first.endpoint.operator === second.endpoint.operator
  )
    throw new Error("Distinct same-network sources required");
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  const heads = await Promise.all([
    head(first, network, signal, now, environment),
    head(second, network, signal, now, environment),
  ]);
  const available =
    BigInt(heads[0].height) < BigInt(heads[1].height)
      ? BigInt(heads[0].height)
      : BigInt(heads[1].height);
  const height = requestedHeight === undefined ? available : unsigned(requestedHeight, 64);
  if (height > available) throw new Error("Requested state block is not finalized by both sources");
  if (height === 0n) throw new Error("Unusable finalized height");
  const [a, b] = await Promise.all([
    blockAt(first, network, height, signal, now),
    blockAt(second, network, height, signal, now),
  ]);
  if (
    a.height !== height.toString() ||
    b.height !== a.height ||
    a.hash !== b.hash ||
    a.timestampMs !== b.timestampMs ||
    a.blockHeight !== b.blockHeight
  )
    throw new FinalizedSourceConflict("Finalized sources disagree");
  return {
    network,
    chainId: chainId(network, environment),
    block: a,
    sourceIds: [first.endpoint.id, second.endpoint.id],
    operatorClaims: [first.endpoint.operator, second.endpoint.operator],
    matched: true as const,
    independenceVerified: false as const,
    assetEvidence: false as const,
    fundingAllowed: false as const,
  };
}
