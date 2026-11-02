import { bootstrapAdmin } from "../src/server/auth/bootstrap";
import { createDatabase } from "../src/server/db/client";
import { AppFailure } from "../src/server/http/security";
import { loadAuthEnvironment } from "./auth-environment";

// databaseConfig limits this command to the explicitly named disposable local DB.
Object.assign(process.env, await loadAuthEnvironment());
const { pool } = createDatabase();
try {
  await bootstrapAdmin(pool, process.argv[2] ?? "");
  console.log(
    "Initial administrator granted to the specified verified account. Bootstrap is now closed.",
  );
} catch (error) {
  console.error(
    error instanceof AppFailure ? error.message : "Bootstrap failed. No success is confirmed.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
