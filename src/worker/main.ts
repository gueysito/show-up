import { setTimeout } from "node:timers/promises";
import { createDatabase } from "../server/db/client";
import { applyOperation, dispatchOutbox } from "./operations";
import { queueName, startQueue } from "./queue";

const { pool } = createDatabase();
const boss = await startQueue();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
  });
}
await boss.work<{ operationId: string }>(queueName, { pollingIntervalSeconds: 1 }, async (jobs) => {
  for (const job of jobs) await applyOperation(pool, job.data.operationId);
});
console.log("Showup worker ready; local operation receipts only");
while (!stopping) {
  try {
    await dispatchOutbox(pool, boss);
  } catch {
    console.error("Outbox dispatch failed; pending records retained. Values redacted.");
  }
  await setTimeout(500);
}
await boss.stop({ graceful: true, timeout: 25000 });
await pool.end();
console.log("Showup worker stopped");
