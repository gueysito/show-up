import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { databaseConfig } from "../config";

export function createDatabase() {
  const pool = new pg.Pool({
    ...databaseConfig(),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    application_name: "showup-local",
  });
  return { pool, db: drizzle(pool) };
}

export async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
