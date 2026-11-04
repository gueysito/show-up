import type { FinalizedHeader } from "./finalized-heads";
import { integerAmount } from "./one-click";
import { record } from "./quote-signature";
import { unsigned } from "./rpc";
import { walletAddress } from "../wallets/proof";
import {
  transferContext,
  transferHash,
  selectTransfer,
  transferFact,
  type TransferContext,
} from "./token-transfer";

function success(value: unknown) {
  const status = record(value);
  return (
    Object.keys(status).length === 1 &&
    (typeof status.SuccessValue === "string" || typeof status.SuccessReceiptId === "string")
  );
}
// The ordinal is receipt-ID order (including the root), log position and data
// position, each in eight bits. It is independent of RPC receipt-array ordering.
export function nearTokenMoves(input: TransferContext, value: unknown) {
  const context = transferContext(input);
  if (context.network !== "near") throw new Error("Wrong NEP-141 network");
  const raw = record(value),
    tx = record(raw.transaction),
    root = record(raw.transaction_outcome);
  if (
    raw.final_execution_status !== "FINAL" ||
    tx.hash !== context.transaction ||
    root.id !== context.transaction ||
    record(root.outcome).executor_id !== tx.signer_id ||
    !Array.isArray(raw.receipts_outcome) ||
    raw.receipts_outcome.length > 255
  )
    throw new Error("NEAR transaction is not final or bound to its outcome");
  const outcomes = [root, ...raw.receipts_outcome.map(record)].sort((a, b) =>
    String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0,
  );
  const byId = new Map(outcomes.map((outcome) => [transferHash("near", outcome.id), outcome]));
  if (byId.size !== outcomes.length) throw new Error("Duplicate NEAR outcome ID");
  const reached = new Set<string>(),
    queue = [context.transaction];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (reached.has(id)) continue;
    reached.add(id);
    const item = byId.get(id);
    if (!item) throw new Error("Incomplete final NEAR receipt graph");
    const children = record(item.outcome).receipt_ids;
    if (!Array.isArray(children) || children.length > 256)
      throw new Error("NEAR receipt graph bounds");
    for (const child of children) queue.push(transferHash("near", child));
    if (queue.length > 65536) throw new Error("NEAR receipt graph work limit");
  }
  if (reached.size !== outcomes.length) throw new Error("Unrelated NEAR receipt injected");
  const moves = [];
  for (const [receiptIndex, receipt] of outcomes.entries()) {
    const outcome = record(receipt.outcome);
    transferHash("near", receipt.block_hash);
    if (outcome.executor_id !== context.asset || !success(outcome.status)) continue;
    if (!Array.isArray(outcome.logs) || outcome.logs.length > 256)
      throw new Error("NEP-141 log bounds");
    for (const [logIndex, log] of outcome.logs.entries()) {
      if (typeof log !== "string" || log.length > 65536) throw new Error("NEP-141 log size");
      if (!log.startsWith("EVENT_JSON:")) continue;
      const event = record(JSON.parse(log.slice(11)));
      if (event.standard !== "nep141" || event.event !== "ft_transfer") continue;
      if (event.version !== "1.0.0" || !Array.isArray(event.data) || event.data.length > 256)
        throw new Error("Unsupported NEP-141 transfer event");
      for (const [dataIndex, data] of event.data.entries()) {
        const move = record(data);
        if (typeof move.old_owner_id !== "string" || typeof move.new_owner_id !== "string")
          throw new Error("Invalid NEP-141 owners");
        moves.push({
          source: walletAddress("near", move.old_owner_id),
          recipient: walletAddress("near", move.new_owner_id),
          amount: integerAmount(move.amount).toString(),
          eventIndex: receiptIndex * 65536 + logIndex * 256 + dataIndex,
          receiptId: String(receipt.id),
          blockHash: String(receipt.block_hash),
        });
      }
    }
  }
  return { context, moves, transactionSucceeded: success(raw.status) };
}
export function normalizeNearTokenTransfer(input: {
  context: TransferContext;
  transaction: unknown;
  block: unknown;
  finalized: FinalizedHeader;
}) {
  const { context, moves, transactionSucceeded } = nearTokenMoves(input.context, input.transaction);
  const selected = selectTransfer(context, moves);
  const receipt = moves.find((move) => move.eventIndex === selected.eventIndex)!;
  const header = record(record(input.block).header);
  if (header.hash !== receipt.blockHash)
    throw new Error("NEP-141 receipt inclusion block mismatch");
  const timestamp = unsigned(header.timestamp_nanosec ?? header.timestamp) / 1_000_000n;
  return {
    ...transferFact(
      context,
      selected,
      {
        height: unsigned(header.height, 64).toString(),
        hash: receipt.blockHash,
        timestampMs: Number(timestamp),
      },
      input.finalized,
    ),
    receiptId: receipt.receiptId,
    transactionSucceeded,
  };
}
