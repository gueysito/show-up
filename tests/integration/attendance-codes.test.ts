import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { authConfig } from "../../src/server/auth/config";
import { hash, unseal } from "../../src/server/auth/crypto";
import { activateHostCodeWindow, readHostCodeWindow } from "../../src/server/attendance/codes";
import { AppFailure } from "../../src/server/http/security";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { exportOwnData } from "../../src/server/privacy/export";
import { accountFixtures } from "../fixtures/accounts";
import { confirmedDeletion } from "../fixtures/deletion";
import { validDraft } from "../fixtures/draft";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Attendance checks require disposable test data");
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
  SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
  SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
})!;
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;

async function fixtures() {
  const f = await accountFixtures([["host"], ["host"], []]),
    eventId = randomUUID(),
    now = Date.now(),
    data = {
      ...validDraft(),
      startsAt: new Date(now + 60_000).toISOString(),
      endsAt: new Date(now + 3_660_000).toISOString(),
    };
  await f.pool.query(
    `INSERT INTO app_events(id,owner_id,revision,data,state,rules_hash,published_at,registration_closes_at)
    VALUES($1,$2,1,$3,'published','engineering-code-fixture',clock_timestamp(),$4)`,
    [eventId, f.accounts[0].id, data, data.startsAt],
  );
  const session = hash(f.accounts[0].value);
  return {
    ...f,
    eventId,
    data,
    session,
    activate: (phrase: string, operationId = randomUUID()) =>
      activateHostCodeWindow(f.pool, config, session, { eventId, operationId, phrase }),
  };
}

test("host code activation is encrypted, replayable and fresh across normalized rotations", async () => {
  const f = await fixtures();
  try {
    const phrase = `private ${randomUUID()}`,
      operation = randomUUID();
    const first = await f.activate(phrase, operation);
    assert.deepEqual(await f.activate(phrase.toUpperCase(), operation), first);
    assert.equal(Date.parse(first.expiresAt) - Date.parse(first.openedAt), 180_000);
    const row = (
      await f.pool.query("SELECT * FROM app_attendance_code_windows WHERE id=$1", [first.id])
    ).rows[0];
    assert.equal(JSON.stringify(row).includes(phrase), false);
    assert.equal((await readHostCodeWindow(f.pool, config, f.session, f.eventId))?.phrase, phrase);
    const mutation = (
      await f.pool.query("SELECT * FROM app_mutations WHERE operation_id=$1", [operation])
    ).rows[0];
    assert.equal(
      Object.hasOwn(
        unseal(
          config.encryptionKey,
          `mutation:${f.accounts[0].id}:${operation}`,
          mutation.encrypted_receipt,
        ) as object,
        "phrase",
      ),
      false,
    );
    const second = await f.activate("different phrase");
    await assert.rejects(f.activate(`  ${phrase.toUpperCase()}  `), status(409));
    assert.equal((await readHostCodeWindow(f.pool, config, f.session, f.eventId))?.id, second.id);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) FROM app_attendance_code_windows WHERE event_id=$1 AND retired_at IS NULL",
          [f.eventId],
        )
      ).rows[0].count,
      "1",
    );
    await assert.rejects(f.activate("another phrase", operation), status(409));
  } finally {
    await f.cleanup();
  }
});

test("only the active owning host can read or rotate a published online event code", async () => {
  const f = await fixtures();
  try {
    for (const other of [1, 2]) {
      await assert.rejects(
        readHostCodeWindow(f.pool, config, hash(f.accounts[other].value), f.eventId),
        status(404),
      );
      await assert.rejects(
        activateHostCodeWindow(f.pool, config, hash(f.accounts[other].value), {
          eventId: f.eventId,
          operationId: randomUUID(),
          phrase: "fresh",
        }),
        status(other === 2 ? 403 : 404),
      );
    }
    for (const data of [
      { ...f.data, mode: "physical" },
      {
        ...f.data,
        startsAt: new Date(Date.now() + 600_000).toISOString(),
        endsAt: new Date(Date.now() + 4_200_000).toISOString(),
      },
      {
        ...f.data,
        startsAt: new Date(Date.now() - 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 899_000).toISOString(),
      },
    ]) {
      await f.pool.query("UPDATE app_events SET data=$2 WHERE id=$1", [f.eventId, data]);
      await assert.rejects(f.activate("fresh"), status(409));
    }
    await f.pool.query(
      "UPDATE app_events SET data=$2,state='draft',published_at=NULL,rules_hash=NULL WHERE id=$1",
      [f.eventId, f.data],
    );
    await assert.rejects(f.activate("fresh"), status(409));
    await f.pool.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE account_id=$1", [
      f.accounts[0].id,
    ]);
    await assert.rejects(f.activate("fresh"), status(401));
    assert.equal(
      (
        await f.pool.query("SELECT count(*) FROM app_attendance_code_windows WHERE event_id=$1", [
          f.eventId,
        ])
      ).rows[0].count,
      "0",
    );
  } finally {
    await f.cleanup();
  }
});

test("code rotation clips to the fixed cutoff and concurrent reuse cannot create two windows", async () => {
  const f = await fixtures();
  try {
    const now = Date.now(),
      cutoff = now + 60_000;
    await f.pool.query("UPDATE app_events SET data=$2 WHERE id=$1", [
      f.eventId,
      {
        ...f.data,
        startsAt: new Date(now - 1_800_000).toISOString(),
        endsAt: new Date(cutoff + 900_000).toISOString(),
      },
    ]);
    const results = await Promise.allSettled([
      f.activate("race phrase"),
      f.activate(" RACE  PHRASE "),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected" && status(409)(r.reason)).length, 1);
    const current = await readHostCodeWindow(f.pool, config, f.session, f.eventId);
    assert.equal(Date.parse(current!.expiresAt), cutoff);
    await Promise.all([f.activate("second fresh phrase"), f.activate("third fresh phrase")]);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) FROM app_attendance_code_windows WHERE event_id=$1 AND retired_at IS NULL",
          [f.eventId],
        )
      ).rows[0].count,
      "1",
    );
  } finally {
    await f.cleanup();
  }
});

test("a code read waiting for the account lock does not block its writer from locking the event", async () => {
  const f = await fixtures(),
    held = await f.pool.connect();
  let reading: ReturnType<typeof readHostCodeWindow> | undefined;
  try {
    await f.activate("lock ordering phrase");
    await held.query("BEGIN");
    await held.query("SELECT 1 FROM app_accounts WHERE id=$1 FOR UPDATE", [f.accounts[0].id]);
    const pid = (await held.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    reading = readHostCodeWindow(f.pool, config, f.session, f.eventId);
    const deadline = Date.now() + 2000;
    let blocked = false;
    while (Date.now() < deadline) {
      blocked = Boolean(
        (
          await f.pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND $1=ANY(pg_blocking_pids(pid))",
            [pid],
          )
        ).rowCount,
      );
      if (blocked) break;
      await setTimeout(10);
    }
    assert.equal(blocked, true, "Code read did not reach the controlled account lock");
    await held.query("SET LOCAL lock_timeout='250ms'");
    await held.query("SELECT 1 FROM app_events WHERE id=$1 FOR UPDATE", [f.eventId]);
    await held.query("ROLLBACK");
    assert.equal((await reading)?.phrase, "lock ordering phrase");
  } finally {
    await held.query("ROLLBACK");
    held.release();
    await reading;
    await f.cleanup();
  }
});

test("code metadata is exported without phrases and published-host deletion preserves obligations while denying new codes", async () => {
  const f = await fixtures();
  try {
    const phrase = `private ${randomUUID()}`;
    await f.activate(phrase);
    const exported = await exportOwnData(f.pool, config, f.session);
    assert.equal(exported.hostedCodeWindows.length, 1);
    assert.equal(JSON.stringify(exported).includes(phrase), false);
    assert.deepEqual(
      (await exportOwnData(f.pool, config, hash(f.accounts[1].value))).hostedCodeWindows,
      [],
    );
    const deletion = await requestAccountDeletion(
      f.pool,
      config,
      f.session,
      confirmedDeletion(config, f.accounts[0].id, f.session),
    );
    assert.equal(deletion.state, "pending_reconciliation");
    await assert.rejects(f.activate("new phrase"), status(401));
    await assert.rejects(
      readHostCodeWindow(f.pool, config, hash(deletion.sessionValue!), f.eventId),
      status(404),
    );
    assert.equal(
      (await exportOwnData(f.pool, config, hash(deletion.sessionValue!))).hostedCodeWindows.length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("code-window migration rolls back and the database enforces one current, fresh, three-minute window", async () => {
  const f = await fixtures(),
    client = await f.pool.connect(),
    schema = `attendance_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query("CREATE TABLE app_events(id uuid PRIMARY KEY)");
    await client.query("INSERT INTO app_events(id) VALUES($1)", [f.eventId]);
    await client.query(await readFile("migrations/013-attendance-code-windows.sql", "utf8"));
    for (const seconds of [0, 181]) {
      await client.query("SAVEPOINT invalid_window");
      await assert.rejects(
        client.query(
          "INSERT INTO app_attendance_code_windows(id,event_id,code_index,encrypted_code,opened_at,expires_at) VALUES($1,$2,$3,'opaque',now(),now()+$4*interval '1 second')",
          [randomUUID(), f.eventId, "a".repeat(64), seconds],
        ),
        (e) => (e as { code: string }).code === "23514",
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_window");
    }
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query("SELECT to_regnamespace($1) AS schema", [schema])).rows[0].schema,
      null,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await f.cleanup();
  }
});
