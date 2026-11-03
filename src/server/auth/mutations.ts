import { randomUUID } from "node:crypto";
import type pg from "pg";
import { hash, seal, unseal } from "./crypto";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { controlReceiptDeadline } from "../privacy/retention";
import { mutationActor, type MutationCredential } from "./attendance-actor";

export type Actor = { id: string; roles: string[] };

export function hasRole(actor: Actor, ...roles: string[]) {
  if (!roles.some((role) => actor.roles.includes(role)))
    throw new AppFailure(403, "This action requires the assigned role.");
}

export async function mutate<T>(
  pool: pg.Pool,
  encryptionKey: string,
  sessionHash: MutationCredential,
  operationId: string,
  request: unknown,
  action: string,
  work: (client: pg.PoolClient, actor: Actor) => Promise<T>,
  relatedAccounts: readonly string[] = [],
): Promise<T> {
  if (!isUuid(operationId)) throw new AppFailure(400, "A valid operation reference is required.");
  const requestHash = hash(JSON.stringify({ action, request }));
  return transaction(pool, async (client) => {
    // Cross-account attendance must lock all participants in one stable order,
    // before its actor/session and event. Related IDs come from stored credentials,
    // never caller-supplied account selectors, and are revalidated by the action.
    if (relatedAccounts.length) {
      if (typeof sessionHash !== "string")
        throw new AppFailure(403, "Bot replies cannot authorize staff actions.");
      if (relatedAccounts.length > 2 || relatedAccounts.some((id) => !isUuid(id)))
        throw new Error("Invalid related mutation accounts");
      const actor = (
        await client.query("SELECT account_id FROM app_sessions WHERE token_hash=$1", [sessionHash])
      ).rows[0];
      if (!actor) throw new AppFailure(401, "Sign in again to continue.");
      await client.query(
        "SELECT id FROM app_accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [[actor.account_id, ...relatedAccounts]],
      );
    }
    const actorId = (
      await mutationActor(client, sessionHash, "UPDATE", action, request, operationId)
    ).id;
    const previous = await client.query("SELECT * FROM app_mutations WHERE operation_id=$1", [
      operationId,
    ]);
    const context = `mutation:${actorId}:${operationId}`;
    if (previous.rowCount) {
      const row = previous.rows[0];
      if (row.actor_id !== actorId || row.request_hash !== requestHash)
        throw new AppFailure(
          409,
          "This operation reference was already used for a different request.",
        );
      if (row.payload_retired_at)
        throw new AppFailure(
          410,
          "This operation's private receipt has expired. Review current records before starting another operation.",
        );
      return unseal(encryptionKey, context, row.encrypted_receipt) as T;
    }
    const roles = await client.query("SELECT role FROM app_roles WHERE account_id=$1", [actorId]);
    const result = await work(client, {
      id: actorId,
      roles: roles.rows.map((row) => row.role as string),
    });
    await client.query(
      `INSERT INTO app_mutations (operation_id,actor_id,request_hash,encrypted_receipt,payload_expires_at)
      VALUES ($1,$2,$3,$4,COALESCE($5::timestamptz,clock_timestamp()+interval '90 days'))`,
      [
        operationId,
        actorId,
        requestHash,
        seal(encryptionKey, context, result),
        action === "wallet.challenge"
          ? (controlReceiptDeadline(result)?.toISOString() ?? null)
          : null,
      ],
    );
    await client.query("INSERT INTO app_audit (id,actor_id,action) VALUES ($1,$2,$3)", [
      randomUUID(),
      actorId,
      action,
    ]);
    return result;
  });
}
