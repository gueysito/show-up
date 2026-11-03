import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { hash, token } from "../../src/server/auth/crypto";
import { sessionCookie } from "../../src/server/auth/sessions";

export async function accountFixtures(roles: string[][]) {
  // Preauthenticated engineering fixtures only, never a provider or runtime bypass.
  process.env.SHOWUP_ENV = "test";
  process.env.DATABASE_URL = "postgresql://showup@127.0.0.1:55433/showup_test";
  const { pool } = createDatabase();
  await migrate(pool);
  const accounts: { id: string; value: string }[] = [];
  for (const grants of roles) {
    const id = randomUUID();
    const value = token();
    await pool.query("INSERT INTO app_accounts (id) VALUES ($1)", [id]);
    await pool.query(
      "INSERT INTO app_sessions (token_hash,account_id,expires_at) VALUES ($1,$2,clock_timestamp()+interval '1 hour')",
      [hash(value), id],
    );
    for (const role of grants)
      await pool.query("INSERT INTO app_roles (account_id,role) VALUES ($1,$2)", [id, role]);
    accounts.push({ id, value });
  }
  async function enter(context: BrowserContext, index: number) {
    await context.addCookies([
      {
        name: sessionCookie,
        value: accounts[index].value,
        domain: "localhost",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  }
  async function cleanup() {
    const ids = accounts.map((account) => account.id);
    const eventOperations = `SELECT operation_id FROM outbox WHERE payload->>'eventId' IN
      (SELECT id::text FROM app_events WHERE owner_id=ANY($1::uuid[]))`;
    await pool.query(
      `DELETE FROM processed_operations WHERE operation_id IN (${eventOperations})`,
      [ids],
    );
    await pool.query(`DELETE FROM outbox WHERE operation_id IN (${eventOperations})`, [ids]);
    await pool.query("DELETE FROM app_event_access WHERE account_id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM app_attendance_qr_scans WHERE validator_id=ANY($1::uuid[])", [
      ids,
    ]);
    await pool.query("DELETE FROM app_attendance_qr WHERE account_id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM app_invitations WHERE issuer_id=ANY($1::uuid[])", [ids]);
    const watches = await pool.query(
      `DELETE FROM app_commitment_settlement_links WHERE consent_id IN
      (SELECT id FROM app_commitment_consents WHERE account_id=ANY($1::uuid[])) RETURNING watch_id`,
      [ids],
    );
    await pool.query("DELETE FROM app_settlement_watches WHERE id=ANY($1::uuid[])", [
      watches.rows.map((row) => row.watch_id),
    ]);
    await pool.query("DELETE FROM app_commitment_consents WHERE account_id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM app_event_credentials WHERE account_id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM app_events WHERE owner_id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM app_wallet_challenges WHERE account_id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM app_wallets WHERE account_id=ANY($1::uuid[])", [ids]);
    for (const table of [
      "app_mutations",
      "app_audit",
      "app_roles",
      "app_identities",
      "app_sessions",
    ])
      await pool.query(
        `DELETE FROM ${table} WHERE ${["app_mutations", "app_audit"].includes(table) ? "actor_id" : "account_id"}=ANY($1::uuid[])`,
        [ids],
      );
    await pool.query("DELETE FROM app_deletion_requests WHERE account_id=ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM app_accounts WHERE id=ANY($1::uuid[])", [ids]);
    await pool.end();
  }
  return { pool, accounts, enter, cleanup };
}
