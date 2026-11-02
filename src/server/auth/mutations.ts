import { randomUUID } from "node:crypto";
import type pg from "pg";
import { hash, seal, unseal } from "./crypto";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";

export type Actor = { id: string; roles: string[] };

export function hasRole(actor: Actor, ...roles: string[]) {
  if (!roles.some((role) => actor.roles.includes(role)))
    throw new AppFailure(403, "This action requires the assigned role.");
}

export async function mutate<T>(
  pool: pg.Pool,
  encryptionKey: string,
  sessionHash: string,
  operationId: string,
  request: unknown,
  action: string,
  work: (client: pg.PoolClient, actor: Actor) => Promise<T>,
): Promise<T> {
  if (!isUuid(operationId)) throw new AppFailure(400, "A valid operation reference is required.");
  const requestHash = hash(JSON.stringify({ action, request }));
  return transaction(pool, async (client) => {
    const session = await client.query(
      `SELECT a.id FROM app_sessions s
      JOIN app_accounts a ON a.id=s.account_id WHERE s.token_hash=$1
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.state='active'
      FOR UPDATE OF a,s`,
      [sessionHash],
    );
    if (!session.rowCount) throw new AppFailure(401, "Sign in again to continue.");
    const actorId = session.rows[0].id as string;
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
      return unseal(encryptionKey, context, row.encrypted_receipt) as T;
    }
    const roles = await client.query("SELECT role FROM app_roles WHERE account_id=$1", [actorId]);
    const result = await work(client, {
      id: actorId,
      roles: roles.rows.map((row) => row.role as string),
    });
    await client.query(
      `INSERT INTO app_mutations (operation_id,actor_id,request_hash,encrypted_receipt)
      VALUES ($1,$2,$3,$4)`,
      [operationId, actorId, requestHash, seal(encryptionKey, context, result)],
    );
    await client.query("INSERT INTO app_audit (id,actor_id,action) VALUES ($1,$2,$3)", [
      randomUUID(),
      actorId,
      action,
    ]);
    return result;
  });
}
