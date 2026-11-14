import type pg from "pg";
import type { AuthConfig } from "../server/auth/config";
import { seal, unseal } from "../server/auth/crypto";
import type { validateSettlementState } from "../server/protocol/settlement-state";

type Facts = ReturnType<typeof validateSettlementState>;
type Kind = "attendance" | "closing" | "principal";
const targets = {
  attendance: {
    table: "app_attendance_deliveries",
    key: "candidate_id",
    purpose: "attendance-delivery-observation",
  },
  closing: {
    table: "app_attendance_closings",
    key: "checkpoint_id",
    purpose: "attendance-closing-observation",
  },
  principal: {
    table: "app_principal_recoveries",
    key: "consent_id",
    purpose: "principal-recovery-observation",
  },
} as const;
function target(kind: Kind) {
  if (!Object.hasOwn(targets, kind)) throw new Error("Unknown source observation owner");
  return targets[kind];
}
export function workerSourceObservation(
  config: Pick<AuthConfig, "encryptionKey">,
  kind: Kind,
  id: string,
  row: Record<string, unknown>,
): Facts | null {
  const selected = target(kind);
  if (!row.encrypted_observation) return null;
  const facts = unseal(
    config.encryptionKey,
    `${selected.purpose}:${id}`,
    row.encrypted_observation as string,
  ) as Facts;
  if (facts.block.height !== row.observed_height || facts.block.hash !== row.observed_hash)
    throw new Error("Stored worker source observation integrity failure");
  return facts;
}
// Fixed internal table owners only. Persist each validated source watermark before
// another external operation; a lost claim cannot advance or overwrite its successor.
export async function recordWorkerSourceObservation(
  pool: pg.Pool,
  config: Pick<AuthConfig, "encryptionKey">,
  kind: Kind,
  id: string,
  claimToken: string,
  facts: Facts,
) {
  const selected = target(kind);
  const saved = await pool.query(
    `UPDATE ${selected.table} SET observed_height=$3,observed_hash=$4,encrypted_observation=$5,updated_at=clock_timestamp()
     WHERE ${selected.key}=$1 AND claim_token=$2`,
    [
      id,
      claimToken,
      facts.block.height,
      facts.block.hash,
      seal(config.encryptionKey, `${selected.purpose}:${id}`, facts),
    ],
  );
  if (!saved.rowCount) throw new Error("Worker source observation claim is no longer current");
}
