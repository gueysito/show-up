import { createDatabase, transaction } from "../../src/server/db/client";
import { applyOperation } from "../../src/worker/operations";
import { queueName, startQueue } from "../../src/worker/queue";

const [mode, operationId] = process.argv.slice(2);
if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Crash fixture requires Showup test database");
const { pool } = createDatabase();
const stay = () => new Promise<void>(() => {});

if (mode === "writer-before" || mode === "writer-after") {
  await transaction(pool, async (client) => {
    await client.query(
      "INSERT INTO outbox (operation_id, topic, payload) VALUES ($1, 'foundation.probe', '{}')",
      [operationId],
    );
    if (mode === "writer-before") {
      process.send?.("before-commit");
      await stay();
    }
  });
  process.send?.("after-commit");
  await stay();
} else {
  const boss = await startQueue();
  const jobs = await boss.fetch<{ operationId: string }>(queueName);
  if (jobs.length !== 1) throw new Error("Expected one recoverable job");
  if (mode === "consumer-after") await applyOperation(pool, jobs[0].data.operationId);
  process.send?.(mode === "consumer-after" ? "effect-committed" : "claimed");
  await stay();
}
