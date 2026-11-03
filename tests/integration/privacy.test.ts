import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { authConfig, issuers } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { establishIdentity } from "../../src/server/auth/identities";
import { findSession } from "../../src/server/auth/sessions";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { AppFailure } from "../../src/server/http/security";
import { findPrivacySession } from "../../src/server/privacy/access";
import { exportOwnData } from "../../src/server/privacy/export";
import { issueWalletChallenge } from "../../src/server/wallets/service";
import { validDraft } from "../fixtures/draft";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Privacy checks require the disposable test database");
const { pool } = createDatabase(),
  accounts: string[] = [],
  operations: string[] = [];
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
  SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
  SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
})!;
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
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
async function account() {
  const subject = randomUUID(),
    result = await establishIdentity(pool, config, "telegram", {
      issuer: issuers.telegram,
      subject,
    });
  accounts.push(result.accountId);
  return { ...result, subject, session: hash(result.value) };
}

test("own export includes private authored answers while excluding other accounts and authentication material", async () => {
  const owner = await account(),
    other = await account();
  await pool.query("INSERT INTO app_roles(account_id,role) VALUES ($1,'host')", [owner.accountId]);
  const draft = validDraft();
  draft.quizzes = [
    {
      question: "Fictional private question",
      type: "short",
      options: [],
      correctOption: 0,
      aliases: ["private author answer"],
      plannedAt: new Date(Date.parse(draft.startsAt) + 900_000).toISOString(),
      durationSeconds: 90,
    },
  ];
  const operationId = randomUUID();
  operations.push(operationId);
  await saveAccountDraft(pool, config.encryptionKey, owner.session, {
    id: randomUUID(),
    operationId,
    revision: 0,
    data: draft,
  });
  const exported = await exportOwnData(pool, config, owner.session);
  assert.equal(exported.account.id, owner.accountId);
  assert.equal(exported.linkedIdentities[0].subject, owner.subject);
  assert.deepEqual(exported.hostedEvents[0].data.quizzes[0].aliases, ["private author answer"]);
  assert.deepEqual((await exportOwnData(pool, config, other.session)).hostedEvents, []);
  const json = JSON.stringify(exported);
  for (const value of [other.accountId, other.subject, owner.value, owner.session])
    assert.equal(json.includes(value), false);
  for (const field of ["token_hash", "identity_hash", "encrypted_identity", "encrypted_receipt"])
    assert.equal(json.includes(field), false);
});

test("restricted deletion-state reads cannot regain normal authority, and disabled/revoked sessions cannot export", async () => {
  const owner = await account();
  await pool.query("UPDATE app_accounts SET state='deletion_requested' WHERE id=$1", [
    owner.accountId,
  ]);
  assert.equal(await findSession(pool, owner.value), null);
  assert.equal((await findPrivacySession(pool, owner.value))!.state, "deletion_requested");
  assert.equal(
    (await exportOwnData(pool, config, owner.session)).account.state,
    "deletion_requested",
  );
  await assert.rejects(
    issueWalletChallenge(pool, config, owner.session, {
      operationId: randomUUID(),
      network: "near",
      address: "fictional.near",
    }),
    status(401),
  );
  await pool.query("UPDATE app_accounts SET state='disabled' WHERE id=$1", [owner.accountId]);
  assert.equal(await findPrivacySession(pool, owner.value), null);
  await assert.rejects(exportOwnData(pool, config, owner.session), status(401));
  await pool.query("UPDATE app_accounts SET state='active' WHERE id=$1", [owner.accountId]);
  await pool.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [
    owner.session,
  ]);
  await assert.rejects(exportOwnData(pool, config, owner.session), status(401));
});
