import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import { after, before, test } from "node:test";
import pg from "pg";
import { createDatabase, transaction } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { applyOperation, dispatchOutbox } from "../../src/worker/operations";
import { deadQueueName, queueName, startQueue } from "../../src/worker/queue";

if (process.env.SHOWUP_ENV !== "test") throw new Error("Integration tests require SHOWUP_ENV=test");
const { pool } = createDatabase();
let boss: Awaited<ReturnType<typeof startQueue>>;

before(async () => {
  assert.equal((await pool.query("SELECT current_database() AS name")).rows[0].name, "showup_test");
  await migrate(pool);
  boss = await startQueue();
  await boss.deleteAllJobs(queueName);
  await boss.deleteAllJobs(deadQueueName);
  await pool.query("TRUNCATE processed_operations, outbox");
});
after(async () => {
  await boss?.stop();
  await pool.end();
});

async function eventually(check: () => Promise<boolean>, timeout = 8000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await setTimeout(100);
  } while (Date.now() < end);
  assert.fail("Database condition did not become true within deadline");
}

async function killAt(mode: string, operationId: string, marker: string) {
  const child = fork(
    new URL("../fixtures/crash-process.ts", import.meta.url),
    [mode, operationId],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  try {
    const state = await Promise.race([
      once(child, "message").then(([message]) => message),
      once(child, "exit").then(() => "early exit"),
      setTimeout(10000, "timed out", { ref: false }),
    ]);
    assert.equal(state, marker);
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await exited;
  }
}

async function insertOperation() {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO outbox (operation_id, topic, payload) VALUES ($1, 'foundation.probe', '{}')",
    [id],
  );
  return id;
}

test("migrations serialize, reject changed history, and roll back failed DDL", async () => {
  const schema = `migration_${randomUUID().replaceAll("-", "")}`;
  const folder = await mkdtemp(`${tmpdir()}/showup-migration-`);
  const url = pathToFileURL(`${folder}/`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  const isolated = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  try {
    const sql = await readFile(
      new URL("../../migrations/001-foundation.sql", import.meta.url),
      "utf8",
    );
    await writeFile(new URL("001-foundation.sql", url), sql);
    await Promise.all([migrate(isolated, url), migrate(isolated, url)]);
    assert.equal(
      (await isolated.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
      "1",
    );
    await writeFile(new URL("001-foundation.sql", url), `${sql}\n-- changed`);
    await assert.rejects(migrate(isolated, url), /Applied migration changed/);
    await writeFile(new URL("001-foundation.sql", url), sql);
    await writeFile(
      new URL("002-failure.sql", url),
      "CREATE TABLE rollback_probe(id int); SELECT 1/0;",
    );
    await assert.rejects(migrate(isolated, url));
    assert.equal(
      (await isolated.query("SELECT to_regclass('rollback_probe') AS name")).rows[0].name,
      null,
    );
    assert.equal(
      (await isolated.query("SELECT count(*) FROM schema_migrations")).rows[0].count,
      "1",
    );
  } finally {
    await isolated.end();
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await rm(folder, { recursive: true });
  }
});

test("SIGKILL before commit creates no work; after commit preserves work", async () => {
  const beforeId = randomUUID();
  await killAt("writer-before", beforeId, "before-commit");
  await eventually(
    async () =>
      !(await pool.query("SELECT 1 FROM outbox WHERE operation_id=$1", [beforeId])).rowCount,
  );
  const afterId = randomUUID();
  await killAt("writer-after", afterId, "after-commit");
  assert.equal(
    (await pool.query("SELECT 1 FROM outbox WHERE operation_id=$1", [afterId])).rowCount,
    1,
  );
  await dispatchOutbox(pool, boss);
  const jobs = await boss.fetch<{ operationId: string }>(queueName, { batchSize: 20 });
  assert.ok(jobs.some((job) => job.data.operationId === afterId));
  for (const job of jobs) {
    await applyOperation(pool, job.data.operationId);
    await boss.complete(queueName, job);
  }
});

test("outbox enqueue and marker roll back together on dispatcher failure", async () => {
  const id = await insertOperation();
  const send = boss.send.bind(boss);
  const failingBoss = {
    send: async (...args: Parameters<typeof boss.send>) => {
      await send(...args);
      throw new Error("Injected failure after actual database enqueue");
    },
  };
  await assert.rejects(dispatchOutbox(pool, failingBoss), /Injected failure/);
  assert.equal(
    (await pool.query("SELECT dispatched_at FROM outbox WHERE operation_id=$1", [id])).rows[0]
      .dispatched_at,
    null,
  );
  assert.equal((await pool.query("SELECT 1 FROM pgboss.job WHERE id=$1", [id])).rowCount, 0);
  await Promise.all(Array.from({ length: 6 }, () => dispatchOutbox(pool, boss)));
  assert.equal((await pool.query("SELECT 1 FROM pgboss.job WHERE id=$1", [id])).rowCount, 1);
  const [job] = await boss.fetch<{ operationId: string }>(queueName);
  await Promise.all(Array.from({ length: 12 }, () => applyOperation(pool, job.data.operationId)));
  await boss.complete(queueName, job);
  assert.equal(
    (await pool.query("SELECT 1 FROM processed_operations WHERE operation_id=$1", [id])).rowCount,
    1,
  );
});

for (const mode of ["consumer-before", "consumer-after"]) {
  test(`claimed job recovers after SIGKILL: ${mode}`, { timeout: 15000 }, async () => {
    const id = await insertOperation();
    await boss.send(
      queueName,
      { operationId: id },
      { id, expireInSeconds: 1, retryDelay: 0, retryBackoff: false },
    );
    await pool.query("UPDATE outbox SET dispatched_at=now() WHERE operation_id=$1", [id]);
    await killAt(mode, id, mode === "consumer-before" ? "claimed" : "effect-committed");
    await eventually(async () => {
      await boss.supervise(queueName);
      const jobs = await boss.fetch<{ operationId: string }>(queueName);
      if (!jobs.length) return false;
      assert.equal(jobs[0].data.operationId, id);
      await applyOperation(pool, id);
      await boss.complete(queueName, jobs[0]);
      return true;
    });
    assert.equal(
      (await pool.query("SELECT 1 FROM processed_operations WHERE operation_id=$1", [id])).rowCount,
      1,
    );
  });
}

test("bounded retries exhaust into a visible dead-letter queue", async () => {
  const id = await insertOperation();
  await boss.send(
    queueName,
    { operationId: id },
    { id, retryLimit: 1, retryDelay: 0, retryBackoff: false },
  );
  const [first] = await boss.fetch(queueName);
  await boss.fail(queueName, first, { reason: "deliberate test failure" });
  const [retry] = await boss.fetch(queueName);
  await boss.fail(queueName, retry, { reason: "deliberate test failure" });
  const dead = await boss.fetch<{ operationId: string }>(deadQueueName, { batchSize: 100 });
  assert.ok(dead.some((job) => job.data.operationId === id));
  for (const job of dead) await boss.complete(deadQueueName, job);
});

test("transaction helper rolls back the complete application write", async () => {
  const id = randomUUID();
  await assert.rejects(
    transaction(pool, async (client) => {
      await client.query("INSERT INTO outbox VALUES ($1,'foundation.probe','{}',now(),null)", [id]);
      throw new Error("Abort");
    }),
  );
  assert.equal((await pool.query("SELECT 1 FROM outbox WHERE operation_id=$1", [id])).rowCount, 0);
});
