import { decodeBase58 } from "./encoding";
import type { FinalizedHeader } from "./finalized-heads";
import { integerAmount } from "./one-click";
import { record } from "./quote-signature";
import { unsigned } from "./rpc";
import {
  transferContext,
  transferFact,
  selectTransfer,
  type TransferContext,
  type TokenMove,
} from "./token-transfer";

const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
// Transfer/TransferChecked ABI: solana-program/token f62a0b05415e64b0af0823864bbb2df2a49f5d49.
function keys(value: unknown) {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Solana account list bounds");
  return value.map((key) => {
    if (typeof key !== "string") throw new Error("Raw Solana account required");
    decodeBase58(key, 32);
    return key;
  });
}
function index(value: unknown, maximum: number) {
  const n = unsigned(value, 64);
  if (n >= BigInt(maximum)) throw new Error("Solana instruction/account index bounds");
  return Number(n);
}
type Balance = { mint: string; owner: string; amount: bigint };
function balances(value: unknown, accounts: string[], mint: string) {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Token balance bounds");
  const result = new Map<number, Balance>();
  for (const item of value) {
    const b = record(item),
      i = index(b.accountIndex, accounts.length),
      a = record(b.uiTokenAmount);
    if (b.mint !== mint) continue;
    if (result.has(i) || typeof b.mint !== "string" || typeof b.owner !== "string")
      throw new Error("Missing or duplicate token-account identity");
    decodeBase58(b.mint, 32);
    decodeBase58(b.owner, 32);
    if (b.programId !== undefined && b.programId !== tokenProgram)
      throw new Error("Token-2022 account remains unqualified");
    const amount = integerAmount(a.amount);
    if (amount >= 1n << 64n) throw new Error("SPL token balance exceeds u64");
    result.set(i, { mint: b.mint, owner: b.owner, amount });
    if (a.decimals !== 6) throw new Error("Invalid token precision");
  }
  return result;
}
function transferData(value: string): Buffer | undefined {
  for (const size of [9, 10]) {
    try {
      return decodeBase58(value, size);
    } catch {
      /* Other token instruction. */
    }
  }
  return undefined;
}
// Compiled (not RPC-parsed) top-level and CPI SPL transfer instructions, including
// resolved v0 account lists. Token-2022 and ambiguous netting remain unqualified.
export function normalizeSolanaTokenTransfer(input: {
  context: TransferContext;
  transaction: unknown;
  statuses: unknown;
  block: unknown;
  finalized: FinalizedHeader;
}) {
  const context = transferContext(input.context);
  if (context.network !== "solana") throw new Error("Wrong SPL network");
  const raw = record(input.transaction),
    meta = record(raw.meta),
    tx = record(raw.transaction),
    message = record(tx.message),
    block = record(input.block);
  const slot = unsigned(raw.slot, 64).toString();
  const statuses = record(input.statuses);
  if (!Array.isArray(statuses.value) || statuses.value.length !== 1)
    throw new Error("Missing finalized token signature");
  const status = record(statuses.value[0]);
  if (
    meta.err !== null ||
    (raw.version !== "legacy" && raw.version !== 0) ||
    !Array.isArray(tx.signatures) ||
    tx.signatures.length < 1 ||
    tx.signatures.length > 64 ||
    tx.signatures[0] !== context.transaction ||
    status.err !== null ||
    status.confirmationStatus !== "finalized" ||
    status.confirmations !== null ||
    unsigned(status.slot, 64).toString() !== slot ||
    unsigned(record(statuses.context).slot, 64) < BigInt(slot) ||
    !Array.isArray(block.signatures) ||
    block.signatures.length > 30000 ||
    block.signatures.filter((s) => s === context.transaction).length !== 1 ||
    unsigned(block.blockTime, 64) !== unsigned(raw.blockTime, 64)
  )
    throw new Error("SPL transaction is not successful in finalized history");
  for (const signature of tx.signatures) decodeBase58(signature, 64);
  const loaded =
    meta.loadedAddresses === undefined
      ? { writable: [], readonly: [] }
      : record(meta.loadedAddresses);
  const accounts = [
    ...keys(message.accountKeys),
    ...keys(loaded.writable),
    ...keys(loaded.readonly),
  ];
  if (accounts.length > 256 || new Set(accounts).size !== accounts.length)
    throw new Error("Invalid resolved Solana account list");
  if (raw.version === "legacy" && (keys(loaded.writable).length || keys(loaded.readonly).length))
    throw new Error("Legacy transaction has loaded addresses");
  const before = balances(meta.preTokenBalances, accounts, context.asset),
    after = balances(meta.postTokenBalances, accounts, context.asset);
  for (const [i, old] of before) {
    const next = after.get(i);
    if (next && (next.mint !== old.mint || next.owner !== old.owner))
      throw new Error("Token account identity changed during transfer");
  }
  if (
    !Array.isArray(message.instructions) ||
    message.instructions.length > 256 ||
    !Array.isArray(meta.innerInstructions) ||
    meta.innerInstructions.length > 256
  )
    throw new Error("SPL instruction bounds");
  const instructions = message.instructions.map((value, i) => ({ value, eventIndex: i * 65536 }));
  const parents = new Set<number>();
  for (const group of meta.innerInstructions) {
    const g = record(group),
      parent = index(g.index, message.instructions.length);
    if (parents.has(parent) || !Array.isArray(g.instructions) || g.instructions.length > 1024)
      throw new Error("Ambiguous CPI instruction list");
    parents.add(parent);
    for (const [inner, value] of g.instructions.entries())
      instructions.push({ value, eventIndex: parent * 65536 + inner + 1 });
  }
  const moves: TokenMove[] = [];
  const tokenInstructions = instructions.filter(
    ({ value }) => accounts[index(record(value).programIdIndex, accounts.length)] === tokenProgram,
  ).length;
  if (
    !Array.isArray(meta.logMessages) ||
    meta.logMessages.length > 4096 ||
    meta.logMessages.some(
      (log) =>
        typeof log !== "string" ||
        log.length > 16384 ||
        log.startsWith(`Program ${tokenProgram} failed:`),
    ) ||
    meta.logMessages.filter((log) => log.startsWith(`Program ${tokenProgram} invoke [`)).length !==
      meta.logMessages.filter((log) => log === `Program ${tokenProgram} success`).length ||
    meta.logMessages.filter((log) => log === `Program ${tokenProgram} success`).length !==
      tokenInstructions
  )
    throw new Error("Failed or incomplete SPL invocation evidence");
  for (const { value, eventIndex } of instructions) {
    const ix = record(value);
    if (accounts[index(ix.programIdIndex, accounts.length)] !== tokenProgram) continue;
    if (
      typeof ix.data !== "string" ||
      ix.data.length > 2048 ||
      !Array.isArray(ix.accounts) ||
      ix.accounts.length > 256
    )
      throw new Error("Invalid compiled SPL instruction");
    // Other Token instructions may have arbitrary lengths; only transfer opcodes
    // are decoded. Their account metadata and net credit are checked below.
    const data = transferData(ix.data);
    if (!data || (data[0] !== 3 && data[0] !== 12)) continue;
    const checked = data[0] === 12;
    if (data.length !== (checked ? 10 : 9) || ix.accounts.length < (checked ? 4 : 3))
      throw new Error("Malformed SPL transfer");
    const source = index(ix.accounts[0], accounts.length),
      destination = index(ix.accounts[checked ? 2 : 1], accounts.length);
    const from = before.get(source) ?? after.get(source),
      to = after.get(destination) ?? before.get(destination);
    if (
      !from &&
      !to &&
      (!checked || accounts[index(ix.accounts[1], accounts.length)] !== context.asset)
    )
      continue;
    if (!from || !to || from.mint !== to.mint)
      throw new Error("Missing SPL transfer mint/owner evidence");
    if (from.mint !== context.asset) continue;
    if (
      checked &&
      (accounts[index(ix.accounts[1], accounts.length)] !== context.asset || data[9] !== 6)
    )
      throw new Error("Wrong checked SPL mint/precision");
    const amount = data.readBigUInt64LE(1);
    moves.push({ source: from.owner, recipient: to.owner, amount: amount.toString(), eventIndex });
  }
  const selected = selectTransfer(context, moves);
  if (
    input.finalized.blockHeight === undefined ||
    unsigned(block.blockHeight, 64) > unsigned(input.finalized.blockHeight, 64)
  )
    throw new Error("SPL inclusion block is beyond the finalized height");
  const total = (values: Map<number, Balance>) =>
    [...values.values()]
      .filter((b) => b.mint === context.asset && b.owner === context.recipient)
      .reduce((sum, b) => sum + b.amount, 0n);
  const credit = total(after) - total(before);
  const incoming = moves
    .filter((m) => m.recipient === context.recipient && m.source !== context.recipient)
    .reduce((sum, m) => sum + BigInt(m.amount), 0n);
  if (credit !== incoming) throw new Error("SPL net credit differs from its transfer instructions");
  return transferFact(
    context,
    selected,
    {
      height: slot,
      hash: String(block.blockhash),
      timestampMs: Number(unsigned(raw.blockTime, 64) * 1000n),
    },
    input.finalized,
  );
}
