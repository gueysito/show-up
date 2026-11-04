import { getAddress, id } from "ethers";
import type { FinalizedHeader } from "./finalized-heads";
import { record } from "./quote-signature";
import { unsigned } from "./rpc";
import {
  transferContext,
  transferHash,
  selectTransfer,
  transferFact,
  type TransferContext,
} from "./token-transfer";

const transferTopic = id("Transfer(address,address,uint256)");
function address(value: unknown) {
  if (typeof value !== "string") throw new Error("Missing ERC-20 address");
  return getAddress(value).toLowerCase();
}
function topicAddress(value: unknown) {
  if (typeof value !== "string" || !/^0x0{24}[0-9a-f]{40}$/.test(value))
    throw new Error("Invalid ERC-20 indexed address");
  return "0x" + value.slice(26);
}
export function normalizeEvmTokenTransfer(input: {
  context: TransferContext;
  transaction: unknown;
  receipt: unknown;
  block: unknown;
  finalized: FinalizedHeader;
}) {
  const context = transferContext(input.context);
  if (context.network !== "base" && context.network !== "ethereum")
    throw new Error("Wrong ERC-20 network");
  const tx = record(input.transaction),
    receipt = record(input.receipt),
    block = record(input.block);
  const hash = (v: unknown) => transferHash(context.network, v);
  const height = unsigned(receipt.blockNumber, 64).toString(),
    blockHash = hash(receipt.blockHash);
  const index = unsigned(receipt.transactionIndex, 64);
  if (
    hash(tx.hash) !== context.transaction ||
    hash(receipt.transactionHash) !== context.transaction ||
    (tx.chainId !== undefined && unsigned(tx.chainId).toString() !== context.chainId) ||
    unsigned(tx.blockNumber, 64).toString() !== height ||
    hash(tx.blockHash) !== blockHash ||
    hash(block.hash) !== blockHash ||
    unsigned(block.number, 64).toString() !== height ||
    unsigned(tx.transactionIndex, 64) !== index ||
    address(tx.from) !== address(receipt.from) ||
    address(tx.to) !== address(receipt.to) ||
    unsigned(receipt.status) !== 1n ||
    receipt.contractAddress !== null ||
    !Array.isArray(block.transactions) ||
    block.transactions.length > 30000 ||
    block.transactions[Number(index)] !== context.transaction ||
    !Array.isArray(receipt.logs) ||
    receipt.logs.length > 1024
  )
    throw new Error("ERC-20 transaction/receipt inclusion mismatch");
  const indices = new Set<string>();
  const moves = receipt.logs
    .map(record)
    .filter(
      (log) =>
        address(log.address) === context.asset &&
        Array.isArray(log.topics) &&
        log.topics[0] === transferTopic,
    )
    .map((log) => {
      const eventIndex = unsigned(log.logIndex, 64);
      if (
        eventIndex > 0xffffffffn ||
        indices.has(eventIndex.toString()) ||
        log.removed !== false ||
        hash(log.transactionHash) !== context.transaction ||
        hash(log.blockHash) !== blockHash ||
        unsigned(log.blockNumber, 64).toString() !== height ||
        unsigned(log.transactionIndex, 64) !== index ||
        !Array.isArray(log.topics) ||
        log.topics.length !== 3 ||
        typeof log.data !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(log.data)
      )
        throw new Error("Invalid canonical ERC-20 Transfer log");
      indices.add(eventIndex.toString());
      const amount = BigInt(log.data);
      if (amount >= 1n << 128n) throw new Error("USDC amount exceeds settlement bounds");
      return {
        source: topicAddress(log.topics[1]),
        recipient: topicAddress(log.topics[2]),
        amount: amount.toString(),
        eventIndex: Number(eventIndex),
      };
    });
  const fact = transferFact(
    context,
    selectTransfer(context, moves),
    { height, hash: blockHash, timestampMs: Number(unsigned(block.timestamp, 64) * 1000n) },
    input.finalized,
  );
  return fact;
}
