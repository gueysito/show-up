import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  attemptAttendanceCode,
  type OwnAttendanceCandidate,
} from "../../src/server/attendance/attempts";
import { activateHostCodeWindow } from "../../src/server/attendance/codes";
import { hash } from "../../src/server/auth/crypto";
import { AppFailure } from "../../src/server/http/security";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { exportOwnData } from "../../src/server/privacy/export";
import { attendanceFixtures } from "../fixtures/attendance";
import { confirmedDeletion } from "../fixtures/deletion";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Attendance attempt checks require disposable data");
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;

test("incorrect code attempts commit, normalized transport retries do not burn attempts and the fifth correct attempt persists one pending candidate", async () => {
  const f = await attendanceFixtures();
  try {
    const operation = randomUUID();
    const first = await f.attempt("wrong phrase", operation);
    assert.deepEqual(first, { status: "incorrect_code", remainingAttempts: 4 });
    assert.deepEqual(await f.attempt(" WRONG  PHRASE ", operation), first);
    for (let i = 0; i < 3; i++) await f.attempt(`different wrong ${i}`);
    const accepted = (await f.attempt(" fresh  ATTENDANCE phrase ")) as OwnAttendanceCandidate;
    assert.equal(accepted.status, "pending_contract");
    assert.equal(accepted.classification, "on_time");
    assert.equal(accepted.attendanceConfirmed, false);
    assert.equal(accepted.liveSubmissionAllowed, false);
    assert.equal(accepted.environment, "sandbox");
    assert.deepEqual(await f.attempt("a new guess after acceptance"), accepted);
    assert.equal(
      (
        await f.pool.query(
          "SELECT attempts FROM app_attendance_code_attempts WHERE window_id=$1 AND account_id=$2",
          [f.window.id, f.accounts[0].id],
        )
      ).rows[0].attempts,
      5,
    );
    assert.equal(
      (
        await f.pool.query("SELECT count(*) FROM app_attendance_candidates WHERE event_id=$1", [
          f.eventId,
        ])
      ).rows[0].count,
      "1",
    );
  } finally {
    await f.cleanup();
  }
});

test("concurrent wrong guesses cannot exceed five and rotation starts a fresh budget without reviving the old phrase", async () => {
  const f = await attendanceFixtures();
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.attempt(`wrong ${i}`)));
    assert.equal(results.filter((result) => result.status === "incorrect_code").length, 5);
    assert.equal(results.filter((result) => result.status === "attempt_limit").length, 3);
    assert.equal((await f.attempt()).status, "attempt_limit");
    const rotated = await activateHostCodeWindow(f.pool, f.config, hash(f.accounts[1].value), {
      eventId: f.eventId,
      operationId: randomUUID(),
      phrase: "New distinct phrase",
    });
    const engineering = { ...f.engineering, testClock: Date.parse(rotated.openedAt) + 1 };
    assert.deepEqual(await f.attempt("Fresh attendance phrase", randomUUID(), engineering), {
      status: "incorrect_code",
      remainingAttempts: 4,
    });
    assert.equal(
      (await f.attempt("new distinct PHRASE", randomUUID(), engineering)).status,
      "pending_contract",
    );
  } finally {
    await f.cleanup();
  }
});

test("concurrent correct deliveries and lost acknowledgments retain one immutable candidate and original receipt time", async () => {
  const f = await attendanceFixtures();
  try {
    const operation = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => f.attempt(undefined, operation)),
    );
    for (const result of results) assert.deepEqual(result, results[0]);
    const row = (
      await f.pool.query("SELECT * FROM app_attendance_candidates WHERE event_id=$1", [f.eventId])
    ).rows[0];
    const later = { ...f.engineering, testClock: f.received + 240_000 };
    assert.deepEqual(await f.attempt(undefined, operation, later), results[0]);
    const after = (
      await f.pool.query("SELECT * FROM app_attendance_candidates WHERE id=$1", [row.id])
    ).rows[0];
    assert.equal(row.encrypted_candidate === after.encrypted_candidate, true);
    assert.equal(after.received_at.getTime(), f.received);
    assert.equal(
      (
        await f.pool.query(
          "SELECT attempts FROM app_attendance_code_attempts WHERE window_id=$1 AND account_id=$2",
          [f.window.id, f.accounts[0].id],
        )
      ).rows[0].attempts,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("live default, account swaps, unsigned approval and replaced funded context cannot expose code matches or create candidates", async () => {
  const f = await attendanceFixtures();
  try {
    await assert.rejects(
      attemptAttendanceCode(f.pool, f.config, f.session, f.input()),
      status(503),
    );
    await assert.rejects(
      attemptAttendanceCode(f.pool, f.config, hash(f.accounts[2].value), f.input(), f.engineering),
      status(404),
    );
    const changed = structuredClone(f.engineering);
    (changed.source.context.authorization.payout as Record<string, unknown>).address =
      "changed.near";
    await assert.rejects(f.attempt(undefined, randomUUID(), changed));
    const unfunded = structuredClone(f.engineering);
    (unfunded.source.views.event as Record<string, unknown>).funded = [];
    (unfunded.source.views.registration as Record<string, unknown>).state = "reserved";
    unfunded.source.views.accounting = {
      received: "0",
      delivered: "0",
      owed: "0",
      unallocated: "0",
    };
    unfunded.source.views.tokenBalance = "0";
    await assert.rejects(f.attempt(undefined, randomUUID(), unfunded));
    await assert.rejects(
      attemptAttendanceCode(
        f.pool,
        f.config,
        f.session,
        { ...f.input(), funded: true } as Parameters<typeof attemptAttendanceCode>[3],
        f.engineering,
      ),
      status(400),
    );
    await f.pool.query(
      "UPDATE app_commitment_consents SET authorized_at=NULL,encrypted_proof=NULL WHERE id=$1",
      [f.consent.id],
    );
    await assert.rejects(f.attempt(), status(409));
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_attendance_code_attempts WHERE window_id=$1", [
          f.window.id,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await f.cleanup();
  }
});

test("server receipt time chooses the pre-rotation window; an expired window cannot create a candidate", async () => {
  const f = await attendanceFixtures();
  try {
    const rotation = f.received + 1000;
    const rotated = await activateHostCodeWindow(f.pool, f.config, hash(f.accounts[1].value), {
      eventId: f.eventId,
      operationId: randomUUID(),
      phrase: "Later window phrase",
    });
    await f.pool.query("UPDATE app_attendance_code_windows SET retired_at=$2 WHERE id=$1", [
      f.window.id,
      new Date(rotation),
    ]);
    await f.pool.query(
      "UPDATE app_attendance_code_windows SET opened_at=$2,expires_at=$3 WHERE id=$1",
      [rotated.id, new Date(rotation), new Date(rotation + 180_000)],
    );
    assert.equal(
      (await f.attempt(undefined, randomUUID(), { ...f.engineering, testClock: rotation - 1 }))
        .status,
      "pending_contract",
    );
  } finally {
    await f.cleanup();
  }
  const expired = await attendanceFixtures();
  try {
    assert.deepEqual(
      await expired.attempt(undefined, randomUUID(), {
        ...expired.engineering,
        testClock: Date.parse(expired.window.expiresAt),
      }),
      { status: "window_closed" },
    );
  } finally {
    await expired.cleanup();
  }
});

test("persisted server arrival preserves on-time equality, late arrival and final cutoff equality", async () => {
  for (const boundary of ["on_time", "late", "cutoff"] as const) {
    const f = await attendanceFixtures();
    try {
      const terms = (f.source.views.event as Record<string, unknown>).terms as Record<
        string,
        number
      >;
      const received =
        boundary === "cutoff"
          ? terms.end_ms - 900_000
          : terms.start_ms + 600_000 + (boundary === "late" ? 1 : 0);
      await f.pool.query(
        "UPDATE app_attendance_code_windows SET opened_at=$2,expires_at=$3 WHERE id=$1",
        [
          f.window.id,
          new Date(received - 1000),
          new Date(Math.min(received + 179_000, terms.end_ms - 900_000)),
        ],
      );
      const result = (await f.attempt(undefined, randomUUID(), {
        ...f.engineering,
        testClock: received,
      })) as OwnAttendanceCandidate;
      assert.equal(result.classification, boundary === "on_time" ? "on_time" : "late");
      assert.equal(Date.parse(result.receivedAt), received);
    } finally {
      await f.cleanup();
    }
  }
});

test("own export and deletion preserve pending financial candidates without retaining failed-guess counters or exposing other accounts", async () => {
  const f = await attendanceFixtures();
  try {
    const accepted = (await f.attempt()) as OwnAttendanceCandidate;
    const exported = await exportOwnData(f.pool, f.config, f.session);
    assert.deepEqual(exported.attendanceCandidates, [accepted]);
    assert.deepEqual(
      (await exportOwnData(f.pool, f.config, hash(f.accounts[2].value))).attendanceCandidates,
      [],
    );
    const before = (
      await f.pool.query(
        "SELECT candidate_hash,encrypted_candidate FROM app_attendance_candidates WHERE id=$1",
        [accepted.id],
      )
    ).rows[0];
    const deleted = await requestAccountDeletion(
      f.pool,
      f.config,
      f.session,
      confirmedDeletion(f.config, f.accounts[0].id, f.session),
    );
    assert.equal(deleted.state, "pending_reconciliation");
    const recovery = await exportOwnData(f.pool, f.config, hash(deleted.sessionValue!));
    assert.deepEqual(recovery.attendanceCandidates, [accepted]);
    assert.equal(
      (
        await f.pool.query("SELECT 1 FROM app_attendance_code_attempts WHERE account_id=$1", [
          f.accounts[0].id,
        ])
      ).rowCount,
      0,
    );
    const after = (
      await f.pool.query(
        "SELECT candidate_hash,encrypted_candidate FROM app_attendance_candidates WHERE id=$1",
        [accepted.id],
      )
    ).rows[0];
    assert.deepEqual(after, before);
    await assert.rejects(f.attempt(), status(401));
  } finally {
    await f.cleanup();
  }
});

test("attendance migration rolls back and enforces the approval's account/event binding", async () => {
  const f = await attendanceFixtures(),
    client = await f.pool.connect(),
    schema = `attempts_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query("CREATE TABLE app_accounts(id uuid PRIMARY KEY)");
    await client.query("CREATE TABLE app_events(id uuid PRIMARY KEY)");
    await client.query("CREATE TABLE app_sessions(token_hash text PRIMARY KEY)");
    await client.query("CREATE TABLE app_attendance_code_windows(id uuid PRIMARY KEY)");
    await client.query(await readFile("migrations/006-commitment-consent.sql", "utf8"));
    await client.query(await readFile("migrations/015-attendance-attempts.sql", "utf8"));
    const accountA = randomUUID(),
      accountB = randomUUID(),
      eventA = randomUUID(),
      eventB = randomUUID(),
      consentId = randomUUID(),
      windowId = randomUUID();
    await client.query("INSERT INTO app_accounts(id) VALUES($1),($2)", [accountA, accountB]);
    await client.query("INSERT INTO app_events(id) VALUES($1),($2)", [eventA, eventB]);
    await client.query("INSERT INTO app_sessions(token_hash) VALUES('fixture-session-index')");
    await client.query(
      `INSERT INTO app_commitment_consents(id,account_id,event_id,session_hash,consent_hash,encrypted_consent,signing_expires_at,authorization_expires_at)
      VALUES($1,$2,$3,'fixture-session-index',$4,'opaque',now(),now()+interval '1 minute')`,
      [consentId, accountA, eventA, "a".repeat(64)],
    );
    for (const [account, event] of [
      [accountB, eventA],
      [accountA, eventB],
    ]) {
      await client.query("SAVEPOINT wrong_binding");
      await assert.rejects(
        client.query(
          `INSERT INTO app_attendance_candidates(id,event_id,account_id,consent_id,environment,classification,received_at,candidate_hash,encrypted_candidate)
        VALUES($1,$2,$3,$4,'sandbox','on_time',now(),$5,'opaque')`,
          [randomUUID(), event, account, consentId, "b".repeat(64)],
        ),
        (error) => (error as { code: string }).code === "23503",
      );
      await client.query("ROLLBACK TO SAVEPOINT wrong_binding");
    }
    await client.query("INSERT INTO app_attendance_code_windows(id) VALUES($1)", [windowId]);
    await client.query("SAVEPOINT too_many_attempts");
    await assert.rejects(
      client.query(
        "INSERT INTO app_attendance_code_attempts(window_id,account_id,attempts) VALUES($1,$2,6)",
        [windowId, accountA],
      ),
      (error) => (error as { code: string }).code === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT too_many_attempts");
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
