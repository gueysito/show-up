import { createDatabase } from "../src/server/db/client";
import { authConfig } from "../src/server/auth/config";

try {
  const auth = authConfig();
  if (
    process.env.SHOWUP_ENV === "production" &&
    (!auth?.clients.google ||
      !auth.clients.telegram ||
      !/^[a-f0-9]{32}$/i.test(process.env.SHOWUP_WALLETCONNECT_PROJECT_ID ?? "") ||
      Object.hasOwn(process.env, "SHOWUP_V1_SIGNER_KEY"))
  ) {
    throw new Error("Hosted web configuration is incomplete or contains the worker signing key");
  }
  const { pool } = createDatabase();
  try {
    await pool.query("SELECT operation_id FROM outbox LIMIT 0");
    if (auth) await pool.query("SELECT identity_hash FROM app_identities LIMIT 0");
    if (process.env.SHOWUP_ENV === "production")
      await pool.query("SELECT funding_transaction_hash FROM app_v1_registrations LIMIT 0");
  } finally {
    await pool.end();
  }
} catch {
  console.error("Startup refused: explicit configuration and completed migrations required.");
  process.exitCode = 1;
}
