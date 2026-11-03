import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { identityIndex, seal, unseal } from "../auth/crypto";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { canonicalHash, canonicalJson } from "../protocol/canonical";
import {
  compareSettlementState,
  settlementContextHash,
  SettlementSourceConflict,
  type SettlementContext,
  type validateSettlementState,
} from "../protocol/settlement-state";

type Facts = ReturnType<typeof validateSettlementState>;
type Compared = Awaited<ReturnType<typeof compareSettlementState>>;
type Keys = Pick<AuthConfig, "encryptionKey" | "indexKey">;
export type ReconciliationResult = {
  id: string;
  status: "observed" | "replayed" | "stale" | "conflict" | "unavailable";
  available: boolean;
  paused: boolean;
  facts: Compared | null;
};

function decodeContext(keys: Keys, row: Record<string, unknown>) {
  const context = unseal(
    keys.encryptionKey,
    `settlement-watch:${row.id}`,
    row.encrypted_context as string,
  ) as SettlementContext;
  if (settlementContextHash(context) !== row.context_hash)
    throw new Error("Settlement context integrity failure");
  return context;
}
function decodeState(keys: Keys, row: Record<string, unknown>): Compared | null {
  if (!row.encrypted_state) return null;
  const facts = unseal(
    keys.encryptionKey,
    `settlement-state:${row.id}`,
    row.encrypted_state as string,
  ) as Compared;
  if (
    canonicalHash(facts) !== row.observed_state_hash ||
    facts.block.height !== row.observed_height ||
    facts.block.hash !== row.observed_hash ||
    facts.ledgerVersion !== row.ledger_version ||
    String(facts.block.timestampMs) !== row.observed_time_ms
  )
    throw new Error("Settlement projection integrity failure");
  return facts;
}

// Restricted backend setup only. No user-facing endpoint or live funding
// activation is attached. Context/authorization remains immutable for this watch.
export async function createSettlementWatch(pool: pg.Pool, keys: Keys, context: SettlementContext) {
  const detached = structuredClone(context),
    contextHash = settlementContextHash(detached);
  const index = identityIndex(
    keys.indexKey,
    "showup.settlement.watch.v1",
    canonicalJson({
      environment: detached.environment,
      deployment: detached.deployment,
      event: detached.event,
      registration: detached.authorization.registration,
    }),
  );
  return transaction(pool, async (client) => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO app_settlement_watches (id,context_index,context_hash,encrypted_context)
      VALUES ($1,$2,$3,$4) ON CONFLICT (context_index) DO NOTHING`,
      [id, index, contextHash, seal(keys.encryptionKey, `settlement-watch:${id}`, detached)],
    );
    const row = (
      await client.query("SELECT * FROM app_settlement_watches WHERE context_index=$1 FOR UPDATE", [
        index,
      ])
    ).rows[0];
    if (row.context_hash !== contextHash)
      throw new AppFailure(409, "The frozen settlement watch cannot be replaced.");
    decodeContext(keys, row);
    return row.id as string;
  });
}

function monotonic(previous: Facts, next: Facts) {
  if (
    next.block.timestampMs < previous.block.timestampMs ||
    BigInt(next.ledgerVersion) < BigInt(previous.ledgerVersion) ||
    BigInt(next.accounting.received) < BigInt(previous.accounting.received) ||
    BigInt(next.accounting.delivered) < BigInt(previous.accounting.delivered) ||
    BigInt(next.sponsorReceived) < BigInt(previous.sponsorReceived)
  )
    return false;
  if (
    ["closed", "cancelled", "aborted"].includes(previous.eventState) &&
    next.eventState !== previous.eventState
  )
    return false;
  if (previous.eventState !== "draft" && next.eventState === "draft") return false;
  if (
    next.ledgerVersion === previous.ledgerVersion &&
    (canonicalJson(next.funded) !== canonicalJson(previous.funded) ||
      next.attendance !== previous.attendance)
  )
    return false;
  if (previous.registration) {
    const old = previous.registration,
      current = next.registration;
    if (
      !current ||
      old.authorizationHash !== current.authorizationHash ||
      (old.attendance && current.attendance !== old.attendance)
    )
      return false;
    const allowed: Record<string, string[]> = {
      reserved: ["reserved", "funded", "released", "refund_owed", "forfeiture_held"],
      return_only: ["return_only", "funded", "released", "refund_owed", "forfeiture_held"],
      funded: ["funded", "released", "refund_owed", "forfeiture_held"],
      released: ["released"],
      refund_owed: ["refund_owed"],
      forfeiture_held: ["forfeiture_held"],
    };
    if (!allowed[old.state]?.includes(current.state)) return false;
  }
  for (const kind of ["principal", "returned"] as const) {
    const old = previous[kind],
      current = next[kind];
    if (
      old &&
      (!current ||
        BigInt(current.gross) < BigInt(old.gross) ||
        BigInt(current.paid) < BigInt(old.paid) ||
        BigInt(current.attempts) < BigInt(old.attempts))
    )
      return false;
  }
  return true;
}

function result(
  keys: Keys,
  row: Record<string, unknown>,
  status: ReconciliationResult["status"],
): ReconciliationResult {
  return {
    id: row.id as string,
    status,
    available: Boolean(row.available),
    paused: Boolean(row.paused_at),
    facts: decodeState(keys, row),
  };
}

// Network reads happen before the transaction. Row locking and exact block/hash
// comparison serialize races without holding database locks during RPC waits.
export async function refreshSettlementWatch(
  pool: pg.Pool,
  keys: Keys,
  id: string,
  transport: typeof fetch = fetch,
  now = Date.now(),
): Promise<ReconciliationResult> {
  if (!isUuid(id)) throw new AppFailure(400, "Invalid settlement watch.");
  const original = (await pool.query("SELECT * FROM app_settlement_watches WHERE id=$1", [id]))
    .rows[0];
  if (!original) throw new AppFailure(404, "Settlement watch unavailable.");
  const expected = decodeContext(keys, original);
  let facts: Compared;
  try {
    facts = await compareSettlementState(expected, transport, now);
  } catch (error) {
    return transaction(pool, async (client) => {
      const row = (
        await client.query("SELECT * FROM app_settlement_watches WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!row || row.context_hash !== original.context_hash)
        throw new AppFailure(409, "Settlement watch changed.");
      const conflict = error instanceof SettlementSourceConflict;
      await client.query(
        `UPDATE app_settlement_watches SET available=false,last_attempt_at=clock_timestamp(),
        paused_at=CASE WHEN $2 THEN coalesce(paused_at,clock_timestamp()) ELSE paused_at END,
        pause_reason=CASE WHEN $2 THEN coalesce(pause_reason,'source_conflict') ELSE pause_reason END WHERE id=$1`,
        [id, conflict],
      );
      return result(
        keys,
        (await client.query("SELECT * FROM app_settlement_watches WHERE id=$1", [id])).rows[0],
        conflict || row.paused_at ? "conflict" : "unavailable",
      );
    });
  }
  return transaction(pool, async (client) => {
    let row = (
      await client.query("SELECT * FROM app_settlement_watches WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!row || row.context_hash !== original.context_hash)
      throw new AppFailure(409, "Settlement watch changed.");
    const previous = decodeState(keys, row),
      hash = canonicalHash(facts);
    const conflict =
      row.paused_at ||
      (previous &&
        ((BigInt(facts.block.height) === BigInt(previous.block.height) &&
          (facts.block.hash !== previous.block.hash || hash !== row.observed_state_hash)) ||
          (BigInt(facts.block.height) > BigInt(previous.block.height) &&
            !monotonic(previous, facts))));
    if (conflict) {
      await client.query(
        `UPDATE app_settlement_watches SET available=false,paused_at=coalesce(paused_at,clock_timestamp()),
        pause_reason=coalesce(pause_reason,'state_regression'),conflict_hash=$2,encrypted_conflict=$3,last_attempt_at=clock_timestamp() WHERE id=$1`,
        [id, hash, seal(keys.encryptionKey, `settlement-conflict:${id}:${hash}`, facts)],
      );
      row = (await client.query("SELECT * FROM app_settlement_watches WHERE id=$1", [id])).rows[0];
      return result(keys, row, "conflict");
    }
    if (previous && BigInt(facts.block.height) < BigInt(previous.block.height))
      return result(keys, row, "stale");
    if (previous && hash === row.observed_state_hash) {
      await client.query(
        "UPDATE app_settlement_watches SET available=true,last_attempt_at=clock_timestamp(),last_success_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      return { ...result(keys, row, "replayed"), available: true };
    }
    await client.query(
      `UPDATE app_settlement_watches SET observed_height=$2,observed_hash=$3,observed_time_ms=$4,
      observed_state_hash=$5,ledger_version=$6,encrypted_state=$7,available=true,last_attempt_at=clock_timestamp(),last_success_at=clock_timestamp() WHERE id=$1`,
      [
        id,
        facts.block.height,
        facts.block.hash,
        facts.block.timestampMs,
        hash,
        facts.ledgerVersion,
        seal(keys.encryptionKey, `settlement-state:${id}`, facts),
      ],
    );
    row = (await client.query("SELECT * FROM app_settlement_watches WHERE id=$1", [id])).rows[0];
    return result(keys, row, "observed");
  });
}
