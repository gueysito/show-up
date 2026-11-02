import { PgBoss } from "pg-boss";
import { databaseConfig } from "../server/config";

export const queueName = "showup-operation";
export const deadQueueName = "showup-dead";

export async function startQueue() {
  const boss = new PgBoss({
    connectionString: databaseConfig().connectionString,
    schema: "pgboss",
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
    schedule: false,
  });
  boss.on("error", () =>
    console.error("Queue error; operation retained for recovery. Values redacted."),
  );
  await boss.start();
  await boss.createQueue(deadQueueName);
  await boss.createQueue(queueName, {
    retryLimit: 3,
    retryDelay: 2,
    retryBackoff: true,
    retryDelayMax: 30,
    expireInSeconds: 30,
    deadLetter: deadQueueName,
  });
  return boss;
}
