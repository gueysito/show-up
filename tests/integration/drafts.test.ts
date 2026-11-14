import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { DraftFailure, listDrafts, saveDraft } from "../../src/server/events/drafts";
import { getWorkspace, rateLimit } from "../../src/server/harness/workspace";
import { validDraft } from "../fixtures/draft";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Draft tests require a disposable test database");
const { pool } = createDatabase();
const one = randomUUID();
const two = randomUUID();
before(async () => {
  await migrate(pool);
  for (const id of [one, two])
    await pool.query(
      "INSERT INTO harness_workspaces (id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 day')",
      [id, createHash("sha256").update(id).digest("hex")],
    );
});
after(async () => {
  await pool.query("DELETE FROM harness_workspaces WHERE id=ANY($1::uuid[])", [[one, two]]);
  await pool.end();
});

test("concurrent identical saves return one receipt and one atomic outbox operation", async () => {
  const input = { id: randomUUID(), operationId: randomUUID(), revision: 0, data: validDraft() };
  const receipts = await Promise.all(Array.from({ length: 8 }, () => saveDraft(pool, one, input)));
  assert.ok(receipts.every((r) => r.revision === 1 && r.id === input.id));
  assert.equal(
    (await pool.query("SELECT 1 FROM outbox WHERE operation_id=$1", [input.operationId])).rowCount,
    1,
  );
  assert.equal(
    (await listDrafts(pool, one)).find((d) => d.id === input.id)?.data.title,
    input.data.title,
  );
  await assert.rejects(
    saveDraft(pool, one, { ...input, data: { ...input.data, title: "Changed replay" } }),
    (e: DraftFailure) => e.status === 409,
  );
});

test("a stale revision cannot overwrite another tab, and an ID swap cannot cross workspaces", async () => {
  const id = randomUUID();
  const data = validDraft();
  await saveDraft(pool, one, { id, operationId: randomUUID(), revision: 0, data });
  const results = await Promise.allSettled(
    ["First", "Second"].map((title) =>
      saveDraft(pool, one, {
        id,
        operationId: randomUUID(),
        revision: 1,
        data: { ...data, title },
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.ok(!(await listDrafts(pool, two)).some((d) => d.id === id));
  await assert.rejects(
    saveDraft(pool, two, { id, operationId: randomUUID(), revision: 0, data }),
    (e: DraftFailure) => e.status === 409,
  );
  assert.equal((await listDrafts(pool, one)).find((d) => d.id === id)?.revision, 2);
});

test("a committed retry returns its receipt even after the planned start", async (context) => {
  const now = Date.now();
  const data = validDraft();
  data.startsAt = new Date(now + 60000).toISOString();
  data.endsAt = new Date(now + 61 * 60000).toISOString();
  const input = { id: randomUUID(), operationId: randomUUID(), revision: 0, data };
  const receipt = await saveDraft(pool, one, input);
  context.mock.method(Date, "now", () => now + 120000);
  assert.deepEqual(await saveDraft(pool, one, input), receipt);
  await assert.rejects(
    saveDraft(pool, one, { ...input, operationId: randomUUID() }),
    (error: DraftFailure) => error.status === 422,
  );
});

test("invalid rule writes create neither a draft nor an outbox record", async () => {
  const id = randomUUID();
  const operationId = randomUUID();
  await assert.rejects(
    saveDraft(pool, one, {
      id,
      operationId,
      revision: 0,
      data: { ...validDraft(), capacity: 101 },
    }),
    (e: DraftFailure) => e.status === 422,
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM outbox WHERE operation_id=$1", [operationId])).rowCount,
    0,
  );
  assert.ok(!(await listDrafts(pool, one)).some((d) => d.id === id));
});

test("workspace expiry, shared rate limit and deletion preserve isolation", async () => {
  const workspace = await getWorkspace(pool, undefined, true);
  assert.ok(workspace.token);
  assert.equal((await getWorkspace(pool, workspace.token!, false)).id, workspace.id);
  const id = randomUUID();
  await saveDraft(pool, workspace.id, {
    id,
    operationId: randomUUID(),
    revision: 0,
    data: validDraft(),
  });
  const attempts = await Promise.allSettled(
    Array.from({ length: 65 }, () => rateLimit(pool, workspace.id)),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 60);
  await pool.query(
    "UPDATE harness_workspaces SET expires_at=now()-interval '1 second' WHERE id=$1",
    [workspace.id],
  );
  await assert.rejects(
    getWorkspace(pool, workspace.token!, false),
    (e: DraftFailure) => e.status === 401,
  );
  await pool.query("DELETE FROM harness_workspaces WHERE id=$1", [workspace.id]);
  assert.equal((await pool.query("SELECT 1 FROM event_drafts WHERE id=$1", [id])).rowCount, 0);
  assert.ok((await listDrafts(pool, one)).length > 0);
});
