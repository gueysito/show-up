import { createDatabase } from "../src/server/db/client";

const { pool } = createDatabase();
try {
  const pending = await pool.query(
    "SELECT count(*)::int AS pending FROM outbox WHERE dispatched_at IS NULL",
  );
  const jobs = await pool.query(
    "SELECT name, state, count(*)::int FROM pgboss.job GROUP BY name, state",
  );
  console.log({ outbox: pending.rows, jobs: jobs.rows });
} catch {
  console.error("Job status unavailable; check local configuration and migrations.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
