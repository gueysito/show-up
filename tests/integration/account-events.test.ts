import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { authConfig, issuers } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { establishIdentity } from "../../src/server/auth/identities";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import {
  correctPublishedDescription,
  duplicateAccountEvent,
  listAccountEvents,
  requestPublication,
  saveAccountDraft,
} from "../../src/server/events/accounts";
import { AppFailure } from "../../src/server/http/security";
import { readPublicationReadiness } from "../../src/server/events/publication";
import { validDraft } from "../fixtures/draft";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Event tests require the disposable test database");
const { pool } = createDatabase();
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
  SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
  SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
})!;
const accounts: string[] = [];
const operations: string[] = [];
before(() => migrate(pool));
after(async () => {
  await pool.query("DELETE FROM processed_operations WHERE operation_id=ANY($1::uuid[])", [
    operations,
  ]);
  await pool.query("DELETE FROM outbox WHERE operation_id=ANY($1::uuid[])", [operations]);
  await pool.query("DELETE FROM app_events WHERE owner_id=ANY($1::uuid[])", [accounts]);
  for (const table of ["app_mutations", "app_audit", "app_roles", "app_identities", "app_sessions"])
    await pool.query(
      `DELETE FROM ${table} WHERE ${["app_mutations", "app_audit"].includes(table) ? "actor_id" : "account_id"}=ANY($1::uuid[])`,
      [accounts],
    );
  await pool.query("DELETE FROM app_accounts WHERE id=ANY($1::uuid[])", [accounts]);
  await pool.end();
});
async function account(role?: "host" | "admin") {
  const login = await establishIdentity(pool, config, "telegram", {
    issuer: issuers.telegram,
    subject: randomUUID(),
  });
  accounts.push(login.accountId);
  if (role)
    await pool.query("INSERT INTO app_roles (account_id,role) VALUES ($1,$2)", [
      login.accountId,
      role,
    ]);
  return { id: login.accountId, session: hash(login.value) };
}
function operation() {
  const id = randomUUID();
  operations.push(id);
  return id;
}
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;

test("publication requirements come from an owned current saved revision and cannot qualify routes or leak answers", async () => {
  const host = await account("host"),
    other = await account("host"),
    admin = await account("admin");
  const draft = { id: randomUUID(), operationId: operation(), revision: 0, data: validDraft() };
  await saveAccountDraft(pool, config.encryptionKey, host.session, draft);
  const result = await readPublicationReadiness(pool, host.session, draft.id, 1);
  assert.equal(result.publicationAllowed, false);
  assert.equal(result.revision, 1);
  assert.equal(result.checks.find((check) => check.id === "rules")!.state, "ready");
  assert.equal(Object.hasOwn(result, "data"), false);
  assert.equal(Object.hasOwn(result, "quizzes"), false);
  await assert.rejects(readPublicationReadiness(pool, other.session, draft.id, 1), status(404));
  await assert.rejects(readPublicationReadiness(pool, admin.session, draft.id, 1), status(403));
  await assert.rejects(readPublicationReadiness(pool, host.session, draft.id, 2), status(409));
  await assert.rejects(
    requestPublication(pool, config.encryptionKey, host.session, operation(), draft.id),
    status(409),
  );
  assert.equal((await listAccountEvents(pool, host.id))[0].state, "draft");
  await pool.query("DELETE FROM app_roles WHERE account_id=$1", [host.id]);
  await assert.rejects(readPublicationReadiness(pool, host.session, draft.id, 1), status(403));
  await pool.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [
    other.session,
  ]);
  await assert.rejects(readPublicationReadiness(pool, other.session, draft.id, 1), status(401));
});

test("host drafts are private; admin alone is not a host and ID swaps cannot change ownership", async () => {
  const owner = await account("host");
  const other = await account("host");
  const admin = await account("admin");
  const draft = { id: randomUUID(), operationId: operation(), revision: 0, data: validDraft() };
  await assert.rejects(
    saveAccountDraft(pool, config.encryptionKey, admin.session, draft),
    status(403),
  );
  await saveAccountDraft(pool, config.encryptionKey, owner.session, draft);
  assert.equal((await listAccountEvents(pool, owner.id))[0].data.title, draft.data.title);
  assert.deepEqual(await listAccountEvents(pool, other.id), []);
  assert.deepEqual(await listAccountEvents(pool, admin.id), []);
  await assert.rejects(
    saveAccountDraft(pool, config.encryptionKey, other.session, {
      ...draft,
      operationId: operation(),
      revision: 1,
    }),
    status(404),
  );
  await assert.rejects(
    duplicateAccountEvent(pool, config.encryptionKey, other.session, operation(), draft.id),
    status(404),
  );
});

test("save replay and stale-tab races preserve one durable revision and ID-only outbox", async () => {
  const owner = await account("host");
  const data = validDraft();
  const first = { id: randomUUID(), operationId: operation(), revision: 0, data };
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      saveAccountDraft(pool, config.encryptionKey, owner.session, first),
    ),
  );
  assert.ok(results.every((result) => result.revision === 1));
  const outcomes = await Promise.allSettled(
    ["One", "Two"].map((title) =>
      saveAccountDraft(pool, config.encryptionKey, owner.session, {
        ...first,
        operationId: operation(),
        revision: 1,
        data: { ...data, title },
      }),
    ),
  );
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    (await listAccountEvents(pool, owner.id)).find((event) => event.id === first.id)?.revision,
    2,
  );
  assert.deepEqual(
    (await pool.query("SELECT payload FROM outbox WHERE operation_id=$1", [first.operationId]))
      .rows[0].payload,
    { eventId: first.id, revision: 1 },
  );
});

test("duplication is idempotent and creates a new unpublished unfunded event with no grants", async () => {
  const owner = await account("host");
  const original = { id: randomUUID(), operationId: operation(), revision: 0, data: validDraft() };
  await saveAccountDraft(pool, config.encryptionKey, owner.session, original);
  const op = operation();
  const one = await duplicateAccountEvent(
    pool,
    config.encryptionKey,
    owner.session,
    op,
    original.id,
  );
  const two = await duplicateAccountEvent(
    pool,
    config.encryptionKey,
    owner.session,
    op,
    original.id,
  );
  assert.equal(one.id, two.id);
  assert.notEqual(one.id, original.id);
  assert.equal(one.data.title, `Copy of ${original.data.title}`);
  assert.equal(one.state, "draft");
  const stored = (
    await pool.query("SELECT state,rules_hash,published_at FROM app_events WHERE id=$1", [one.id])
  ).rows[0];
  assert.deepEqual(stored, { state: "draft", rules_hash: null, published_at: null });
  assert.equal(
    (await pool.query("SELECT 1 FROM app_invitations WHERE event_id=$1", [one.id])).rowCount,
    0,
  );
  assert.equal(
    (await pool.query("SELECT 1 FROM app_event_access WHERE event_id=$1", [one.id])).rowCount,
    0,
  );
});

test("publication fails closed; published material terms reject writes while description corrections preserve hash", async () => {
  const owner = await account("host");
  const first = { id: randomUUID(), operationId: operation(), revision: 0, data: validDraft() };
  await saveAccountDraft(pool, config.encryptionKey, owner.session, first);
  await assert.rejects(
    requestPublication(pool, config.encryptionKey, owner.session, operation(), first.id),
    status(409),
  );
  assert.equal(
    (await pool.query("SELECT state FROM app_events WHERE id=$1", [first.id])).rows[0].state,
    "draft",
  );
  // A locked engineering fixture only; this is not evidence of funded publication.
  await pool.query(
    "UPDATE app_events SET state='published',published_at=clock_timestamp(),rules_hash='fixture-immutable' WHERE id=$1",
    [first.id],
  );
  await assert.rejects(
    saveAccountDraft(pool, config.encryptionKey, owner.session, {
      ...first,
      revision: 1,
      operationId: operation(),
      data: { ...first.data, commitment: "7" },
    }),
    status(409),
  );
  await correctPublishedDescription(
    pool,
    config.encryptionKey,
    owner.session,
    operation(),
    first.id,
    1,
    "Spelling corrected",
  );
  const row = (
    await pool.query("SELECT data,rules_hash,revision FROM app_events WHERE id=$1", [first.id])
  ).rows[0];
  assert.equal(row.data.description, "Spelling corrected");
  assert.equal(row.data.commitment, first.data.commitment);
  assert.equal(row.rules_hash, "fixture-immutable");
  assert.equal(row.revision, 2);
});
