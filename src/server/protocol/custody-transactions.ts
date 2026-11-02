import { createHash } from "node:crypto";
import { getAddress, Interface, Transaction } from "ethers";
import { decodeBase58 } from "./encoding";
import { engineeringManifest, networkManifest } from "./manifest";
import legacyMainnet from "../../../manifests/mainnet.v1.json";

export type CustodyIntent = {
  deployment: string;
  environment: "mainnet" | "engineering";
  network: "base" | "ethereum" | "solana";
  manifest: string;
  event: string;
  rulesHash: string;
  payout: string;
  operation: "delivery" | "return";
  collection: string;
  asset: string;
  source: string;
  recipient: string;
  feeCap: string;
};

export function custodyIntentHash(intent: CustodyIntent): string {
  if (
    !/^[0-9a-f]{64}$/.test(intent.event) ||
    !/^[0-9a-f]{64}$/.test(intent.rulesHash) ||
    !/^[0-9a-f]{64}$/.test(intent.payout) ||
    !/^[a-z0-9._-]{2,64}$/.test(intent.deployment) ||
    !["delivery", "return"].includes(intent.operation) ||
    !["mainnet", "engineering"].includes(intent.environment) ||
    !["base", "ethereum", "solana"].includes(intent.network)
  )
    throw new Error("Invalid frozen custody intent");
  frozenManifest(intent);
  units(intent.feeCap);
  const canonical =
    intent.network === "solana"
      ? intent
      : {
          ...intent,
          collection: getAddress(intent.collection).toLowerCase(),
          source: getAddress(intent.source).toLowerCase(),
          recipient: getAddress(intent.recipient).toLowerCase(),
        };
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(canonical).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      ),
    )
    .digest("hex");
}

export function custodyPath(intent: CustodyIntent): string {
  // No caller-supplied derivation path, signer account or opaque signing hash.
  custodyIntentHash(intent);
  const descriptor = {
    deployment: intent.deployment,
    environment: intent.environment,
    network: intent.network,
    event: intent.event,
    collection:
      intent.network === "solana" ? intent.collection : getAddress(intent.collection).toLowerCase(),
    asset: intent.asset,
  };
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(descriptor).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      ),
    )
    .digest("hex");
  return `showup.v1/${intent.environment}/${intent.network}/${hash}`;
}

function units(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(value))
    throw new Error("Invalid custody integer");
  const amount = BigInt(value);
  if (amount > (1n << 128n) - 1n) throw new Error("Custody integer overflow");
  return amount;
}

function frozenManifest(intent: CustodyIntent) {
  const manifest = [legacyMainnet, networkManifest, engineeringManifest].find(
    (manifest) =>
      manifest.environment === intent.environment && manifest.revision === intent.manifest,
  );
  if (!manifest) throw new Error("Unknown frozen custody manifest");
  return manifest;
}

const erc721 = new Interface([
  "function safeTransferFrom(address from,address to,uint256 tokenId)",
]);
export type EvmEnvelope = {
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

export function evmCustodyTransaction(intent: CustodyIntent, envelope: EvmEnvelope) {
  if (intent.network !== "base" && intent.network !== "ethereum")
    throw new Error("Wrong custody family");
  const manifest = frozenManifest(intent).networks.find(
    (network) => network.id === intent.network,
  )!;
  const gasLimit = units(envelope.gasLimit);
  const maxFee = units(envelope.maxFeePerGas);
  const priority = units(envelope.maxPriorityFeePerGas);
  if (
    !Number.isSafeInteger(envelope.nonce) ||
    envelope.nonce < 0 ||
    gasLimit < 21_000n ||
    gasLimit > 300_000n ||
    maxFee === 0n ||
    priority > maxFee ||
    gasLimit * maxFee > units(intent.feeCap)
  )
    throw new Error("Unapproved nonce or gas/fee bounds");
  if (!/^0x[0-9a-f]{64}$/.test(intent.asset))
    throw new Error("Expected exact ERC-721 token identifier");
  const source = getAddress(intent.source);
  const recipient = getAddress(intent.recipient);
  const collection = getAddress(intent.collection);
  if (
    [source, recipient, collection].some((address) => /^0x0{40}$/.test(address)) ||
    source === recipient
  )
    throw new Error("Invalid custody addresses");
  const transaction = Transaction.from({
    type: 2,
    chainId: BigInt(manifest.chainId),
    nonce: envelope.nonce,
    gasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: priority,
    to: collection,
    value: 0n,
    data: erc721.encodeFunctionData("safeTransferFrom", [source, recipient, BigInt(intent.asset)]),
    accessList: [],
  });
  return {
    intentHash: custodyIntentHash(intent),
    path: custodyPath(intent),
    scheme: "Ecdsa" as const,
    unsigned: transaction.unsignedSerialized,
    payload: transaction.unsignedHash,
  };
}

// Pin from the immutable Metaplex source cited in docs/verification.md.
export const coreProgram = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const computeProgram = "ComputeBudget111111111111111111111111111111";
const systemProgram = "11111111111111111111111111111111";
export type SolanaEnvelope = { blockhash: string; computeUnits: number; estimatedFee: string };

export function solanaCustodyMessage(intent: CustodyIntent, envelope: SolanaEnvelope) {
  if (
    intent.network !== "solana" ||
    intent.asset === intent.source ||
    intent.source === intent.recipient ||
    !Number.isInteger(envelope.computeUnits) ||
    envelope.computeUnits < 1 ||
    envelope.computeUnits > 200_000 ||
    units(envelope.estimatedFee) === 0n ||
    units(envelope.estimatedFee) > units(intent.feeCap)
  )
    throw new Error("Invalid Solana custody/fee context");
  const keys = [
    intent.source,
    intent.asset,
    intent.collection,
    intent.recipient,
    systemProgram,
    coreProgram,
    computeProgram,
  ];
  if (new Set(keys).size !== keys.length) throw new Error("Custody account roles must be distinct");
  const accounts = keys.map((key) => decodeBase58(key, 32));
  const budget = Buffer.alloc(5);
  budget[0] = 2;
  budget.writeUInt32LE(envelope.computeUnits, 1);
  const zeroPriority = Buffer.alloc(9);
  zeroPriority[0] = 3;
  // Legacy message: one writable signer; asset writable; all remaining accounts readonly.
  // Fixed instructions only: compute limit, explicit zero priority fee, uncompressed Core TransferV1.
  const message = Buffer.concat([
    Buffer.from([1, 0, 5, keys.length]),
    ...accounts,
    decodeBase58(envelope.blockhash, 32),
    Buffer.from([3]),
    Buffer.from([6, 0, budget.length]),
    budget,
    Buffer.from([6, 0, zeroPriority.length]),
    zeroPriority,
    Buffer.from([5, 7, 1, 2, 0, 0, 3, 4, 5, 2, 14, 0]),
  ]);
  return {
    intentHash: custodyIntentHash(intent),
    path: custodyPath(intent),
    scheme: "Eddsa" as const,
    message: message.toString("base64"),
    payload: [...message],
    chainId: frozenManifest(intent).networks.find((network) => network.id === "solana")!.chainId,
  };
}
