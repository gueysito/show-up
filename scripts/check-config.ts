import { createDatabase } from "../src/server/db/client";

try {
  const { pool } = createDatabase();
  try {
    await pool.query("SELECT operation_id FROM outbox LIMIT 0");
  } finally {
    await pool.end();
  }
} catch {
  console.error("Startup refused: explicit local configuration and completed migrations required.");
  process.exitCode = 1;
}
