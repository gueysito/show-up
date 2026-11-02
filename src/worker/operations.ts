import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { transaction } from "../server/db/client";
import { queueName } from "./queue";

type OperationSender = {
  send: (...args: Parameters<PgBoss["send"]>) => ReturnType<PgBoss["send"]>;
};

export async function dispatchOutbox(pool: pg.Pool, boss: OperationSender) {
  return transaction(pool, async (client) => {
    const result = await client.query<{ operation_id: string }>(
      `SELECT operation_id FROM outbox WHERE dispatched_at IS NULL
       ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED`,
    );
    for (const row of result.rows) {
      await boss.send(
        queueName,
        { operationId: row.operation_id },
        {
          id: row.operation_id,
          db: { executeSql: (text, values) => client.query(text, values) },
        },
      );
      await client.query("UPDATE outbox SET dispatched_at = now() WHERE operation_id = $1", [
        row.operation_id,
      ]);
    }
    return result.rowCount ?? 0;
  });
}

export async function applyOperation(pool: pg.Pool, operationId: string) {
  await transaction(pool, async (client) => {
    const result = await client.query<{ topic: string }>(
      "SELECT topic FROM outbox WHERE operation_id = $1 FOR SHARE",
      [operationId],
    );
    if (!result.rows[0]) throw new Error("Unknown operation");
    // This local receipt is the entire effect. External actions need their own reconciliation.
    await client.query(
      `INSERT INTO processed_operations (operation_id, topic) VALUES ($1, $2)
       ON CONFLICT (operation_id) DO NOTHING`,
      [operationId, result.rows[0].topic],
    );
  });
}
