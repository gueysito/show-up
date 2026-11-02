import { createDatabase } from "../src/server/db/client";
import { authConfig } from "../src/server/auth/config";

try {
  const auth = authConfig();
  const { pool } = createDatabase();
  try {
    await pool.query("SELECT operation_id FROM outbox LIMIT 0");
    if (auth) await pool.query("SELECT identity_hash FROM app_identities LIMIT 0");
  } finally {
    await pool.end();
  }
} catch {
  console.error("Startup refused: explicit local configuration and completed migrations required.");
  process.exitCode = 1;
}
