import { createDatabase } from "./client";
import { migrate } from "./migrations";
import { startQueue } from "../../worker/queue";

const { pool } = createDatabase();
try {
  await migrate(pool);
  const boss = await startQueue();
  await boss.stop();
  console.log("PASS: application migrations and pg-boss schema ready");
} catch {
  console.error(
    "Migration failed; inspect schema/version and database availability. Values redacted.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
