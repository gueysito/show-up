import { setTimeout } from "node:timers/promises";
import { createDatabase } from "../server/db/client";
import { applyOperation, dispatchOutbox } from "./operations";
import { queueName, startQueue } from "./queue";
import { retirePrivacyRecords } from "../server/privacy/retention";

const privacyKey = process.env.SHOWUP_IDENTITY_KEY;
if (privacyKey !== undefined && !/^[0-9a-f]{64}$/.test(privacyKey))
  throw new Error("Invalid privacy maintenance key configuration");
const { pool } = createDatabase();
const boss = await startQueue();
let stopping = false;
let nextPrivacySweep = 0,
  reportedLegacyKey = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
  });
}
await boss.work<{ operationId: string }>(queueName, { pollingIntervalSeconds: 1 }, async (jobs) => {
  for (const job of jobs) await applyOperation(pool, job.data.operationId);
});
console.log("Showup worker ready; local operation receipts and privacy maintenance only");
while (!stopping) {
  if (Date.now() >= nextPrivacySweep) {
    nextPrivacySweep = Date.now() + 60_000;
    try {
      const progress = await retirePrivacyRecords(pool, privacyKey);
      if (progress.legacyNeedsKey && !reportedLegacyKey)
        console.error(
          "Legacy private receipts need the private worker configuration; pending material retained.",
        );
      reportedLegacyKey = progress.legacyNeedsKey;
    } catch {
      console.error("Privacy maintenance failed; pending material retained. Values redacted.");
    }
  }
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
