import { randomUUID } from "node:crypto";
import type pg from "pg";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";

export async function bootstrapAdmin(pool: pg.Pool, accountId: string) {
  if (!isUuid(accountId))
    throw new AppFailure(400, "Use the account reference shown after verified sign-in.");
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(739204002)");
    const existing = await client.query("SELECT 1 FROM app_roles WHERE role='admin'");
    if (existing.rowCount)
      throw new AppFailure(409, "An administrator already exists. Bootstrap is closed.");
    const account = await client.query(
      `SELECT a.id FROM app_accounts a
      WHERE a.id=$1 AND a.state='active' AND EXISTS (SELECT 1 FROM app_identities i WHERE i.account_id=a.id)
      FOR UPDATE`,
      [accountId],
    );
    if (!account.rowCount)
      throw new AppFailure(404, "An active provider-verified account is required.");
    await client.query("INSERT INTO app_roles (account_id,role) VALUES ($1,'admin')", [accountId]);
    await client.query(
      "INSERT INTO app_audit (id,actor_id,action,entity_id) VALUES ($1,$2,'admin.bootstrapped',$2)",
      [randomUUID(), accountId],
    );
  });
}
