import { Signature, Transaction, getAddress, id } from "ethers";
import { evmCustodyTransaction, type CustodyIntent } from "./custody-transactions";
import type { FinalizedHeader } from "./finalized-heads";
import { record } from "./quote-signature";
import { unsigned } from "./rpc";

const transferTopic = id("Transfer(address,address,uint256)");
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value))
    throw new Error("Invalid EVM evidence hash");
  return value;
}
function address(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing EVM evidence address");
  return getAddress(value).toLowerCase();
}
function safeNumber(value: unknown): number {
  const result = unsigned(value, 64);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe transaction index/nonce");
  return Number(result);
}

// Reconstruct the signed transaction, recover its signer and independently
// reproduce the contract's typed transfer. RPC 'from' and a submitted hash alone
// cannot establish source control or which signing image actually executed.
function signedImage(raw: Record<string, unknown>, intent: CustodyIntent, storedUnsigned: string) {
  if (
    unsigned(raw.type) !== 2n ||
    !Array.isArray(raw.accessList) ||
    raw.accessList.length !== 0 ||
    typeof raw.input !== "string" ||
    raw.input.length !== 202 ||
    !/^0x(?:[0-9a-f]{2}){1,512}$/.test(storedUnsigned)
  )
    throw new Error("Unsupported or malformed custody transaction");
  const parity = unsigned(raw.yParity ?? raw.v);
  if (
    parity > 1n ||
    (raw.yParity !== undefined && raw.v !== undefined && unsigned(raw.v) !== parity)
  )
    throw new Error("Invalid EIP-1559 signature parity");
  const tx = Transaction.from({
    type: 2,
    chainId: unsigned(raw.chainId),
    nonce: safeNumber(raw.nonce),
    gasLimit: unsigned(raw.gas),
    maxFeePerGas: unsigned(raw.maxFeePerGas),
    maxPriorityFeePerGas: unsigned(raw.maxPriorityFeePerGas),
    to: address(raw.to),
    value: unsigned(raw.value),
    data: raw.input,
    accessList: [],
    signature: Signature.from({ r: hash(raw.r), s: hash(raw.s), yParity: Number(parity) as 0 | 1 }),
  });
  const expected = evmCustodyTransaction(intent, {
    nonce: tx.nonce,
    gasLimit: tx.gasLimit.toString(),
    maxFeePerGas: tx.maxFeePerGas!.toString(),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas!.toString(),
  });
  if (
    tx.unsignedSerialized !== storedUnsigned ||
    storedUnsigned !== expected.unsigned ||
    tx.hash !== hash(raw.hash) ||
    tx.from?.toLowerCase() !== intent.source ||
    address(raw.from) !== intent.source
  )
    throw new Error("Executed transaction does not match the authorized image/signer");
  return tx;
}

export type EvmAssetEvidence = {
  network: "base" | "ethereum";
  transaction: string;
  image: string;
  outcome: "delivered" | "failed";
  recipient: string;
  observedOwner: string | null;
  blockHeight: string;
  blockHash: string;
  finalizedAtHeight: string;
  executionFee: string;
  reportedL1Fee: string | null;
  totalFee: string | null;
  totalFeeQualified: boolean;
  feeCapExceeded: boolean;
  fundingAllowed: false;
  codeQualified: false;
};

function owner(value: unknown): string | null {
  if (value === null) return null; // A later burn/absence does not erase delivery.
  if (typeof value !== "string" || !/^0x0{24}[0-9a-f]{40}$/.test(value) || /^0x0{64}$/.test(value))
    throw new Error("Invalid exact-asset owner response");
  return "0x" + value.slice(26);
}
export function normalizeEvmHolding(
  intent: CustodyIntent,
  ownerOfAtFinalized: unknown,
  finalized: FinalizedHeader,
) {
  if (!["base", "ethereum"].includes(intent.network) || unsigned(finalized.height, 64) === 0n)
    throw new Error("Wrong finalized EVM holding context");
  hash(finalized.hash);
  const observed = owner(ownerOfAtFinalized);
  return {
    network: intent.network,
    collection: intent.collection,
    asset: intent.asset,
    source: intent.source,
    owner: observed,
    held: observed === intent.source,
    blockHeight: finalized.height,
    blockHash: finalized.hash,
    codeQualified: false as const,
    fundingAllowed: false as const,
  };
}

// One source's raw facts. A caller must compare independently operated sources,
// pin ownerOf to the compared final block and qualify code/authority separately.
// This pure normalizer cannot qualify a source, sign a receipt or book a seat.
export function normalizeEvmAssetEvidence(input: {
  intent: CustodyIntent;
  storedUnsigned: string;
  requestedHash: string;
  transaction: unknown;
  receipt: unknown;
  inclusionBlock: unknown;
  finalized: FinalizedHeader;
  ownerOfAtFinalized: unknown;
}): EvmAssetEvidence {
  const { intent, finalized } = input;
  if (intent.network !== "base" && intent.network !== "ethereum")
    throw new Error("Wrong evidence family");
  const raw = record(input.transaction),
    receipt = record(input.receipt),
    block = record(input.inclusionBlock);
  const tx = signedImage(raw, intent, input.storedUnsigned);
  const txHash = hash(input.requestedHash);
  const height = unsigned(receipt.blockNumber, 64);
  const blockHash = hash(receipt.blockHash);
  hash(finalized.hash);
  if (
    tx.hash !== txHash ||
    hash(receipt.transactionHash) !== txHash ||
    height !== unsigned(raw.blockNumber, 64) ||
    height !== unsigned(block.number, 64) ||
    height > unsigned(finalized.height, 64) ||
    hash(raw.blockHash) !== blockHash ||
    hash(block.hash) !== blockHash ||
    (height === unsigned(finalized.height, 64) && blockHash !== finalized.hash) ||
    address(receipt.from) !== intent.source ||
    address(receipt.to) !== intent.collection ||
    receipt.contractAddress !== null ||
    unsigned(receipt.type) !== 2n ||
    safeNumber(receipt.transactionIndex) !== safeNumber(raw.transactionIndex)
  )
    throw new Error("Receipt is not in the compared canonical finalized history");
  if (
    !Array.isArray(block.transactions) ||
    block.transactions.length > 30_000 ||
    block.transactions[safeNumber(receipt.transactionIndex)] !== txHash
  )
    throw new Error("Transaction inclusion missing");
  const status = unsigned(receipt.status);
  if (status > 1n || !Array.isArray(receipt.logs) || receipt.logs.length > 256)
    throw new Error("Invalid receipt outcome/log bounds");
  const gas = unsigned(receipt.gasUsed, 128),
    price = unsigned(receipt.effectiveGasPrice, 128);
  if (
    gas === 0n ||
    gas > tx.gasLimit ||
    price > tx.maxFeePerGas! ||
    unsigned(receipt.cumulativeGasUsed) < gas
  )
    throw new Error("Invalid receipt fee evidence");
  const observedOwner = owner(input.ownerOfAtFinalized);
  const topics = [
    transferTopic,
    "0x" + "0".repeat(24) + intent.source.slice(2),
    "0x" + "0".repeat(24) + intent.recipient.slice(2),
    intent.asset,
  ];
  const relevant = receipt.logs
    .map(record)
    .filter(
      (log) =>
        address(log.address) === intent.collection &&
        Array.isArray(log.topics) &&
        log.topics[0] === transferTopic &&
        log.topics[3] === intent.asset,
    );
  if (status === 0n ? receipt.logs.length !== 0 : relevant.length !== 1)
    throw new Error("Missing or ambiguous exact ERC-721 transfer");
  if (status === 1n) {
    const log = relevant[0];
    if (
      log.removed !== false ||
      log.data !== "0x" ||
      JSON.stringify(log.topics) !== JSON.stringify(topics) ||
      hash(log.transactionHash) !== txHash ||
      hash(log.blockHash) !== blockHash ||
      unsigned(log.blockNumber, 64) !== height ||
      safeNumber(log.transactionIndex) !== safeNumber(receipt.transactionIndex)
    )
      throw new Error("ERC-721 transfer log is not bound to the authorized receipt");
  }
  const executionFee = gas * price;
  const reportedL1Fee =
    intent.network === "base" && receipt.l1Fee !== undefined ? unsigned(receipt.l1Fee, 128) : null;
  // Current Base specification also includes operator fees. An unsigned gas
  // envelope or optional l1Fee alone cannot qualify its complete fee total.
  const totalFee = intent.network === "ethereum" ? executionFee : null;
  return {
    network: intent.network,
    transaction: txHash,
    image: input.storedUnsigned,
    outcome: status === 1n ? "delivered" : "failed",
    recipient: intent.recipient,
    observedOwner,
    blockHeight: height.toString(),
    blockHash,
    finalizedAtHeight: finalized.height,
    executionFee: executionFee.toString(),
    reportedL1Fee: reportedL1Fee?.toString() ?? null,
    totalFee: totalFee?.toString() ?? null,
    totalFeeQualified: totalFee !== null,
    feeCapExceeded: executionFee + (reportedL1Fee ?? 0n) > unsigned(intent.feeCap, 128),
    fundingAllowed: false,
    codeQualified: false,
  };
}
