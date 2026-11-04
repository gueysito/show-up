import { canonicalHash } from "./canonical";
import { compareFinalizedHeads } from "./finalized-heads";
import { normalizeEvmTokenTransfer } from "./evm-token-transfer";
import { nearTokenMoves, normalizeNearTokenTransfer } from "./near-token-transfer";
import { normalizeSolanaTokenTransfer } from "./solana-token-transfer";
import { record } from "./quote-signature";
import { ReadOnlyRpc, unsigned } from "./rpc";
import { selectTransfer, transferContext, type TransferContext } from "./token-transfer";
import { walletAddress } from "../wallets/proof";

// Reads only registered sources. This verifies matching transfer facts, not
// provider-route causality, operator independence, recipient consent or payment.
export async function compareTokenTransferSources(
  input: { context: TransferContext; nearSigner?: string },
  first: ReadOnlyRpc,
  second: ReadOnlyRpc,
) {
  const context = transferContext(input.context),
    signal = AbortSignal.timeout(45_000);
  if (
    context.network === "near" &&
    (!input.nearSigner || walletAddress("near", input.nearSigner) !== input.nearSigner)
  )
    throw new Error("Original NEAR transaction signer required");
  const finality = await compareFinalizedHeads(
    context.network,
    first,
    second,
    Date.now(),
    signal,
    context.environment,
  );
  const read = async (client: ReadOnlyRpc) => {
    if (context.network === "near") {
      const transaction = await client.read(
        "tx",
        { tx_hash: context.transaction, sender_account_id: input.nearSigner, wait_until: "FINAL" },
        signal,
      );
      if (record(record(transaction).transaction).signer_id !== input.nearSigner)
        throw new Error("NEAR signer changed");
      const parsed = nearTokenMoves(context, transaction),
        move = selectTransfer(context, parsed.moves);
      const selected = parsed.moves.find((m) => m.eventIndex === move.eventIndex)!;
      const byHash = await client.read("block", { block_id: selected.blockHash }, signal);
      const height = unsigned(record(record(byHash).header).height, 64);
      if (height > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("NEAR inclusion height bounds");
      const block = await client.read("block", { block_id: Number(height) }, signal);
      return normalizeNearTokenTransfer({ context, transaction, block, finalized: finality.block });
    }
    if (context.network === "base" || context.network === "ethereum") {
      const [transaction, receipt] = await Promise.all([
        client.read("eth_getTransactionByHash", [context.transaction], signal),
        client.read("eth_getTransactionReceipt", [context.transaction], signal),
      ]);
      if (transaction === null || receipt === null) return { outcome: "uncertain" as const };
      const block = await client.read(
        "eth_getBlockByNumber",
        ["0x" + unsigned(record(receipt).blockNumber, 64).toString(16), false],
        signal,
      );
      return normalizeEvmTokenTransfer({
        context,
        transaction,
        receipt,
        block,
        finalized: finality.block,
      });
    }
    const [transaction, statuses] = await Promise.all([
      client.read(
        "getTransaction",
        [
          context.transaction,
          { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 },
        ],
        signal,
      ),
      client.read(
        "getSignatureStatuses",
        [[context.transaction], { searchTransactionHistory: true }],
        signal,
      ),
    ]);
    if (transaction === null) return { outcome: "uncertain" as const };
    const slot = unsigned(record(transaction).slot, 64);
    if (slot > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Solana inclusion slot bounds");
    const block = await client.read(
      "getBlock",
      [
        Number(slot),
        {
          commitment: "finalized",
          transactionDetails: "signatures",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
      signal,
    );
    return normalizeSolanaTokenTransfer({
      context,
      transaction,
      statuses,
      block,
      finalized: finality.block,
    });
  };
  const [a, b] = await Promise.all([read(first), read(second)]);
  if (canonicalHash(a) !== canonicalHash(b)) throw new Error("Token transfer sources disagree");
  return {
    fact: a,
    finality,
    matched: true as const,
    independenceVerified: false as const,
    attributionQualified: false as const,
    fundingAllowed: false as const,
  };
}
