import { randomUUID } from "node:crypto";
import type pg from "pg";
import { newSession } from "../auth/sessions";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { requirePrivacyActor } from "./access";
import type { AuthConfig } from "../auth/config";
import { verifyDeletionConfirmation } from "./confirmation";

export type DeletionReceipt = {
  id: string;
  requestedAt: string;
  completedAt: string | null;
  state: "pending_reconciliation" | "completed";
  holdReasons: string[];
};
function receipt(row: Record<string, unknown>): DeletionReceipt {
  return {
    id: row.id as string,
    requestedAt: (row.requested_at as Date).toISOString(),
    completedAt: (row.completed_at as Date | null)?.toISOString() ?? null,
    state: row.completed_at ? "completed" : "pending_reconciliation",
    holdReasons: row.hold_reasons as string[],
  };
}

export async function ownDeletionRequest(
  pool: pg.Pool,
  sessionHash: string,
): Promise<DeletionReceipt | null> {
  return transaction(pool, async (client) => {
    const actor = await requirePrivacyActor(client, sessionHash);
    const row = (
      await client.query("SELECT * FROM app_deletion_requests WHERE account_id=$1", [actor.id])
    ).rows[0];
    return row ? receipt(row) : null;
  });
}

export async function requestAccountDeletion(
  pool: pg.Pool,
  keys: Pick<AuthConfig, "encryptionKey">,
  sessionHash: string,
  input: { operationId: string; confirmation: string; acknowledgeOnChain: boolean; intent: string },
) {
  if (
    !isUuid(input.operationId) ||
    input.confirmation !== "DELETE" ||
    input.acknowledgeOnChain !== true
  )
    throw new AppFailure(
      400,
      "Type DELETE and acknowledge that on-chain records cannot be erased.",
    );
  return transaction(pool, async (client) => {
    const actor = (
      await client.query(
        `SELECT a.id,a.state FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
      WHERE s.token_hash=$1 AND a.state IN ('active','deletion_requested') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR UPDATE OF a,s`,
        [sessionHash],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(401, "Sign in again to request deletion.");
    if (!verifyDeletionConfirmation(keys, input.intent, actor.id, sessionHash, input.operationId))
      throw new AppFailure(
        403,
        "Reload your data page and confirm deletion for the signed-in account. The previous confirmation may have expired.",
      );
    const existing = (
      await client.query("SELECT * FROM app_deletion_requests WHERE account_id=$1", [actor.id])
    ).rows[0];
    if (existing) return { ...receipt(existing), sessionValue: null as string | null };
    const used = await client.query("SELECT 1 FROM app_deletion_requests WHERE operation_id=$1", [
      input.operationId,
    ]);
    if (used.rowCount) throw new AppFailure(409, "This operation reference was already used.");
    // All related draft events precede their invitation/assignment rows. Sort the
    // union so simultaneous host/staff deletion cannot invert two event locks.
    await client.query(
      `SELECT e.id FROM app_events e WHERE e.state='draft' AND
      (e.owner_id=$1 OR EXISTS(SELECT 1 FROM app_event_validators v WHERE v.event_id=e.id AND v.account_id=$1))
      ORDER BY e.id FOR UPDATE`,
      [actor.id],
    );
    // Every currently available route is unqualified. An approved record cannot
    // be erased on the assumption that it was never funded, or on a browser's
    // paid flag. Keep the original proof/credential until qualified reconciliation.
    const financial = (
      await client.query(
        "SELECT 1 FROM app_commitment_consents WHERE account_id=$1 AND authorized_at IS NOT NULL LIMIT 1",
        [actor.id],
      )
    ).rowCount;
    const hosted = (
      await client.query("SELECT 1 FROM app_events WHERE owner_id=$1 AND state<>'draft' LIMIT 1", [
        actor.id,
      ])
    ).rowCount;
    const holdReasons = [
      ...(financial ? ["financial_reconciliation"] : []),
      ...(hosted ? ["published_event_obligations"] : []),
    ];
    const row = (
      await client.query(
        `INSERT INTO app_deletion_requests(account_id,id,operation_id,hold_reasons)
      VALUES ($1,$2,$3,$4) RETURNING *`,
        [actor.id, randomUUID(), input.operationId, holdReasons],
      )
    ).rows[0];
    await client.query("UPDATE app_accounts SET state='deletion_requested' WHERE id=$1", [
      actor.id,
    ]);
    await client.query(
      "UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE account_id=$1 AND revoked_at IS NULL",
      [actor.id],
    );
    await client.query(
      `DELETE FROM app_login_attempts WHERE linking_session_hash IN (SELECT token_hash FROM app_sessions WHERE account_id=$1)`,
      [actor.id],
    );
    await client.query("DELETE FROM app_wallet_challenges WHERE account_id=$1", [actor.id]);
    await client.query("DELETE FROM app_attendance_code_attempts WHERE account_id=$1", [actor.id]);
    await client.query("DELETE FROM app_attendance_qr_scans WHERE validator_id=$1", [actor.id]);
    await client.query("DELETE FROM app_attendance_qr WHERE account_id=$1", [actor.id]);
    await client.query("DELETE FROM app_mutations WHERE actor_id=$1", [actor.id]);
    await client.query("DELETE FROM app_wallets WHERE account_id=$1", [actor.id]);
    await client.query("DELETE FROM app_roles WHERE account_id=$1", [actor.id]);
    // Draft authority can be removed. Published exclusions stay fixed while the
    // disabled/restricted account immediately loses all validator authority.
    const draftAssignments = await client.query(
      `SELECT e.id FROM app_events e JOIN app_event_validators v ON v.event_id=e.id
      WHERE v.account_id=$1 AND e.state='draft' ORDER BY e.id FOR UPDATE OF e`,
      [actor.id],
    );
    const changedEvents = draftAssignments.rows.map((row) => row.id);
    await client.query(
      "DELETE FROM app_event_validators WHERE account_id=$1 AND event_id=ANY($2::uuid[])",
      [actor.id, changedEvents],
    );
    await client.query(
      "UPDATE app_events SET revision=revision+1,updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])",
      [changedEvents],
    );
    await client.query(
      "DELETE FROM app_commitment_consents WHERE account_id=$1 AND authorized_at IS NULL",
      [actor.id],
    );
    await client.query(
      `DELETE FROM app_event_credentials p WHERE p.account_id=$1 AND NOT EXISTS
      (SELECT 1 FROM app_commitment_consents c WHERE c.account_id=p.account_id AND c.event_id=p.event_id AND c.authorized_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM app_event_validators v JOIN app_events e ON e.id=v.event_id
      WHERE v.account_id=p.account_id AND v.event_id=p.event_id AND v.revoked_at IS NULL AND e.state<>'draft')`,
      [actor.id],
    );
    await client.query(
      "UPDATE app_invitations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE issuer_id=$1 AND redeemed_at IS NULL",
      [actor.id],
    );
    await client.query(
      `DELETE FROM app_event_access a WHERE a.account_id=$1 AND NOT EXISTS
      (SELECT 1 FROM app_commitment_consents c WHERE c.account_id=a.account_id AND c.event_id=a.event_id AND c.authorized_at IS NOT NULL)`,
      [actor.id],
    );
    await client.query("DELETE FROM app_events WHERE owner_id=$1 AND state='draft'", [actor.id]);
    await client.query(
      "INSERT INTO app_audit(id,actor_id,action) VALUES ($1,$2,'privacy.deletion-requested')",
      [randomUUID(), actor.id],
    );
    if (holdReasons.length) {
      const sessionValue = await newSession(client, actor.id, sessionHash);
      return { ...receipt(row), sessionValue };
    }
    await client.query("DELETE FROM app_identities WHERE account_id=$1", [actor.id]);
    await client.query("DELETE FROM app_sessions WHERE account_id=$1", [actor.id]);
    await client.query("UPDATE app_accounts SET state='disabled' WHERE id=$1", [actor.id]);
    const completed = (
      await client.query(
        "UPDATE app_deletion_requests SET completed_at=clock_timestamp() WHERE account_id=$1 RETURNING *",
        [actor.id],
      )
    ).rows[0];
    return { ...receipt(completed), sessionValue: null as string | null };
  });
}
