import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  issueAttendanceQr,
  scanAttendanceQr,
  confirmAttendanceQr,
  parseAttendanceQr,
} from "../../src/server/attendance/qr";
import { hash, seal, unseal } from "../../src/server/auth/crypto";
import { mutate } from "../../src/server/auth/mutations";
import { newSession } from "../../src/server/auth/sessions";
import { AppFailure } from "../../src/server/http/security";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { exportOwnData } from "../../src/server/privacy/export";
import { attendanceFixtures } from "../fixtures/attendance";
import { confirmedDeletion } from "../fixtures/deletion";

if (process.env.SHOWUP_ENV !== "test") throw new Error("QR checks require disposable data");
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
async function fixture() {
  const f = await attendanceFixtures("physical");
  const clock = (at = f.received) => ({ ...f.engineering, testClock: at });
  const issue = (operationId = randomUUID(), at = f.received) =>
    issueAttendanceQr(
      f.pool,
      f.config,
      f.session,
      { eventId: f.eventId, consentId: f.consent.id, operationId },
      clock(at),
    );
  const scan = (payload: string, index = 2, at = f.received + 1, operationId = randomUUID()) =>
    scanAttendanceQr(
      f.pool,
      f.config,
      hash(f.accounts[index].value),
      { eventId: f.eventId, operationId, payload },
      clock(at),
    );
  const confirm = (
    scanId: string,
    index = 2,
    at = f.received + 2,
    operationId = randomUUID(),
    confirmPresence = true,
  ) =>
    confirmAttendanceQr(
      f.pool,
      f.config,
      hash(f.accounts[index].value),
      { eventId: f.eventId, operationId, scanId, confirmPresence },
      clock(at),
    );
  return { ...f, clock, issue, scan, confirm };
}

test("physical QR scan requires explicit same-session presence confirmation and preserves one private pending candidate", async () => {
  const f = await fixture();
  try {
    const qr = await f.issue(),
      payload = parseAttendanceQr(qr.payload);
    assert.deepEqual(Object.keys(payload).sort(), [
      "credential",
      "eventId",
      "expiresAt",
      "format",
      "nonce",
    ]);
    assert.equal(payload.expiresAt, f.received + 60_000);
    for (const account of f.accounts) assert.equal(qr.payload.includes(account.id), false);
    assert.equal(qr.payload.includes("fictional-wallet.near"), false);
    assert.equal(qr.liveSubmissionAllowed, false);
    const scan = await f.scan(qr.payload);
    assert.match(scan.alias, /^Attendee [0-9a-f]{16}$/);
    assert.equal(scan.status, "presence_confirmation_required");
    assert.equal(scan.attendanceConfirmed, false);
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
      0,
    );
    await assert.rejects(f.confirm(scan.scanId, 2, undefined, undefined, false), status(400));
    const operation = randomUUID(),
      result = await f.confirm(scan.scanId, 2, f.received + 2, operation);
    assert.equal(result.status, "pending_contract");
    assert.equal(result.attendanceConfirmed, false);
    assert.equal(result.liveSubmissionAllowed, false);
    assert.equal(result.receivedAt, new Date(f.received + 2).toISOString());
    assert.deepEqual(await f.confirm(scan.scanId, 2, f.received + 90_000, operation), result);
    for (const key of ["accountId", "consentId", "candidateId", "credential", "source", "nonce"])
      assert.equal(Object.hasOwn(result, key), false);
    const row = (
      await f.pool.query("SELECT * FROM app_attendance_candidates WHERE event_id=$1", [f.eventId])
    ).rows[0];
    const original = unseal(
      f.config.encryptionKey,
      `attendance-candidate:${f.accounts[0].id}:${row.id}`,
      row.encrypted_candidate,
    ) as {
      packet: { receipt: { proof_class: string; nonce: string } };
      validator: { scanId: string; scannedAt: number; confirmedAt: number };
    };
    assert.equal(original.packet.receipt.proof_class, "staff_qr");
    assert.equal(original.packet.receipt.nonce, payload.nonce);
    assert.equal(original.validator.scanId, scan.scanId);
    assert.equal(original.validator.scannedAt, f.received + 1);
    assert.equal(original.validator.confirmedAt, f.received + 2);
    await assert.rejects(f.confirm(scan.scanId), status(410));
    await assert.rejects(f.scan(qr.payload), status(410));
    await assert.rejects(f.issue(), status(409));
    const own = await exportOwnData(f.pool, f.config, f.session);
    assert.equal(own.attendanceCandidates.length, 1);
    assert.equal(own.attendanceQrWindows.length, 1);
    assert.equal(own.validatorScans.length, 0);
    const staff = await exportOwnData(f.pool, f.config, hash(f.accounts[2].value));
    assert.equal(staff.validatorScans.length, 1);
    assert.equal(staff.attendanceCandidates.length, 0);
    assert.equal(JSON.stringify(staff.validatorScans).includes(f.accounts[0].id), false);
    assert.equal(JSON.stringify(own.attendanceQrWindows).includes(payload.credential), false);
  } finally {
    await f.cleanup();
  }
});

test("QR event, nonce, expiry and published staff authority cannot be swapped; the published host can inspect", async () => {
  const f = await fixture();
  try {
    const qr = await f.issue(),
      payload = parseAttendanceQr(qr.payload);
    await assert.rejects(
      f.scan(JSON.stringify({ ...payload, eventId: randomUUID() })),
      status(400),
    );
    for (const changed of [
      { ...payload, nonce: "0".repeat(64) },
      { ...payload, expiresAt: payload.expiresAt + 1 },
      { ...payload, credential: "a".repeat(43) },
    ])
      await assert.rejects(f.scan(JSON.stringify(changed)), status(404));
    await assert.rejects(f.scan(qr.payload, 0), status(403));
    await f.pool.query("UPDATE app_event_validators SET revoked_at=now() WHERE event_id=$1", [
      f.eventId,
    ]);
    await assert.rejects(f.scan(qr.payload), status(403));
    await f.pool.query(
      "UPDATE app_event_validators SET revoked_at=NULL,assigned_at=now() WHERE event_id=$1",
      [f.eventId],
    );
    await assert.rejects(f.scan(qr.payload), status(403));
    assert.equal((await f.scan(qr.payload, 1)).status, "presence_confirmation_required");
    await f.pool.query("DELETE FROM app_roles WHERE account_id=$1 AND role='host'", [
      f.accounts[1].id,
    ]);
    await assert.rejects(f.scan(qr.payload, 1), status(403));
  } finally {
    await f.cleanup();
  }
});

test("QR expiry is exclusive at sixty seconds while a clipped final cutoff permits scan and confirmation equality", async () => {
  const f = await fixture();
  try {
    const qr = await f.issue();
    const scan = await f.scan(qr.payload, 2, f.received + 59_998);
    await assert.rejects(f.confirm(scan.scanId, 2, f.received + 60_000), status(410));
    await assert.rejects(f.scan(qr.payload, 2, f.received + 60_000), status(410));
    const cutoff =
      Number((f.source.views.event as { terms: { end_ms: number } }).terms.end_ms) - 900_000;
    const clipped = await f.issue(randomUUID(), cutoff - 30_000);
    assert.equal(clipped.expiresAt, cutoff);
    const finalScan = await f.scan(clipped.payload, 2, cutoff);
    const accepted = await f.confirm(finalScan.scanId, 2, cutoff);
    assert.equal(accepted.classification, "late");
    assert.equal(Date.parse(accepted.receivedAt), cutoff);
  } finally {
    await f.cleanup();
  }
});

test("original QR issuance retries retain one credential and replacement revokes old scans", async () => {
  const f = await fixture();
  try {
    const operation = randomUUID();
    const deliveries = await Promise.all(Array.from({ length: 6 }, () => f.issue(operation)));
    assert.equal(new Set(deliveries.map((value) => value.payload)).size, 1);
    const old = deliveries[0],
      scan = await f.scan(old.payload);
    const replacement = await f.issue(randomUUID(), f.received + 10);
    assert.notEqual(replacement.payload, old.payload);
    await assert.rejects(f.issue(randomUUID(), f.received + 5), status(409));
    await assert.rejects(f.scan(old.payload, 2, f.received + 11), status(410));
    await assert.rejects(f.confirm(scan.scanId, 2, f.received + 11), status(410));
    assert.equal(
      (await f.scan(replacement.payload, 2, f.received + 11)).status,
      "presence_confirmation_required",
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM app_attendance_qr WHERE event_id=$1 AND retired_at IS NULL",
          [f.eventId],
        )
      ).rowCount,
      1,
    );
    await assert.rejects(
      issueAttendanceQr(f.pool, f.config, f.session, {
        eventId: f.eventId,
        consentId: f.consent.id,
        operationId: operation,
      }),
      status(409),
    );
  } finally {
    await f.cleanup();
  }
});

test("scan handles are bound to the validator account and exact signed-in session", async () => {
  const f = await fixture();
  try {
    const qr = await f.issue(),
      scan = await f.scan(qr.payload);
    await assert.rejects(f.confirm(scan.scanId, 1), status(404));
    const client = await f.pool.connect();
    let next: string;
    try {
      next = await newSession(client, f.accounts[2].id, hash(f.accounts[2].value));
    } finally {
      client.release();
    }
    await assert.rejects(f.confirm(scan.scanId), status(401));
    await assert.rejects(
      confirmAttendanceQr(
        f.pool,
        f.config,
        hash(next),
        {
          eventId: f.eventId,
          operationId: randomUUID(),
          scanId: scan.scanId,
          confirmPresence: true,
        },
        f.clock(),
      ),
      status(404),
    );
    const rescanned = await scanAttendanceQr(
      f.pool,
      f.config,
      hash(next),
      { eventId: f.eventId, operationId: randomUUID(), payload: qr.payload },
      f.clock(f.received + 2),
    );
    assert.notEqual(rescanned.scanId, scan.scanId);
    assert.equal(
      (
        await confirmAttendanceQr(
          f.pool,
          f.config,
          hash(next),
          {
            eventId: f.eventId,
            operationId: randomUUID(),
            scanId: rescanned.scanId,
            confirmPresence: true,
          },
          f.clock(f.received + 3),
        )
      ).status,
      "pending_contract",
    );
  } finally {
    await f.cleanup();
  }
});

test("different assigned validators racing to confirm produce one candidate without a lock inversion", async () => {
  const f = await fixture();
  try {
    const qr = await f.issue();
    const scans = await Promise.all([f.scan(qr.payload, 1), f.scan(qr.payload, 2)]);
    const results = await Promise.allSettled([
      f.confirm(scans[0].scanId, 1),
      f.confirm(scans[1].scanId, 2),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    assert.equal(status(410)(rejected.reason), true);
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("source qualification, released funding and fixed staff exclusions are checked again before confirmation", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      issueAttendanceQr(f.pool, f.config, f.session, {
        eventId: f.eventId,
        consentId: f.consent.id,
        operationId: randomUUID(),
      }),
      status(503),
    );
    const qr = await f.issue();
    await assert.rejects(
      scanAttendanceQr(f.pool, f.config, hash(f.accounts[2].value), {
        eventId: f.eventId,
        operationId: randomUUID(),
        payload: qr.payload,
      }),
      status(503),
    );
    const scan = await f.scan(qr.payload);
    const unfunded = structuredClone(f.engineering);
    (unfunded.source.views.registration as { state: string }).state = "released";
    await assert.rejects(
      confirmAttendanceQr(
        f.pool,
        f.config,
        hash(f.accounts[2].value),
        {
          eventId: f.eventId,
          operationId: randomUUID(),
          scanId: scan.scanId,
          confirmPresence: true,
        },
        unfunded,
      ),
    );
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [f.eventId]))
        .rowCount,
      0,
    );
    const stored = (
      await f.pool.query(
        "SELECT encrypted_credential FROM app_event_credentials WHERE event_id=$1 AND account_id=$2",
        [f.eventId, f.accounts[2].id],
      )
    ).rows[0];
    await f.pool.query(
      "UPDATE app_event_credentials SET encrypted_credential=$3 WHERE event_id=$1 AND account_id=$2",
      [
        f.eventId,
        f.accounts[2].id,
        seal(
          f.config.encryptionKey,
          `event-credential:${f.accounts[2].id}:${f.eventId}`,
          randomUUID(),
        ),
      ],
    );
    await assert.rejects(f.confirm(scan.scanId), status(409));
    await f.pool.query(
      "UPDATE app_event_credentials SET encrypted_credential=$3 WHERE event_id=$1 AND account_id=$2",
      [f.eventId, f.accounts[2].id, stored.encrypted_credential],
    );
    assert.equal((await f.confirm(scan.scanId)).status, "pending_contract");
  } finally {
    await f.cleanup();
  }
});

test("deleting an attendee erases QR capabilities/scans while retaining original financial recovery; deleting staff denies new confirmation", async () => {
  const f = await fixture();
  try {
    const qr = await f.issue(),
      scan = await f.scan(qr.payload);
    const deleted = await requestAccountDeletion(
      f.pool,
      f.config,
      f.session,
      confirmedDeletion(f.config, f.accounts[0].id, f.session),
    );
    assert.equal(deleted.state, "pending_reconciliation");
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_attendance_qr WHERE event_id=$1", [f.eventId]))
        .rowCount,
      0,
    );
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_attendance_qr_scans WHERE id=$1", [scan.scanId]))
        .rowCount,
      0,
    );
    await assert.rejects(f.confirm(scan.scanId), status(404));
    assert.equal(
      (await exportOwnData(f.pool, f.config, hash(deleted.sessionValue!))).attendanceQrWindows
        .length,
      0,
    );
  } finally {
    await f.cleanup();
  }
  const staff = await fixture();
  try {
    const qr = await staff.issue(),
      scan = await staff.scan(qr.payload),
      session = hash(staff.accounts[2].value);
    await requestAccountDeletion(
      staff.pool,
      staff.config,
      session,
      confirmedDeletion(staff.config, staff.accounts[2].id, session),
    );
    await assert.rejects(staff.confirm(scan.scanId), status(404));
    assert.equal(
      (
        await staff.pool.query("SELECT 1 FROM app_attendance_candidates WHERE event_id=$1", [
          staff.eventId,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await staff.cleanup();
  }
});

test("cross-account QR mutations acquire lower account IDs before waiting for the higher actor", async () => {
  const f = await fixture(),
    blocker = await f.pool.connect(),
    probe = await f.pool.connect();
  const [lower, higher] = [...f.accounts].sort((a, b) => a.id.localeCompare(b.id));
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM app_accounts WHERE id=$1 FOR UPDATE", [higher.id]);
    pending = mutate(
      f.pool,
      f.config.encryptionKey,
      hash(higher.value),
      randomUUID(),
      {},
      "test.qr-account-order",
      async () => ({ ordered: true }),
      [lower.id],
    );
    // Observe the actual lock wait, rather than guessing when the transaction ran.
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      waiting = (
        await probe.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM app_accounts WHERE id=ANY%') AS waiting`)
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true);
    await assert.rejects(
      probe.query("SELECT id FROM app_accounts WHERE id=$1 FOR UPDATE NOWAIT", [lower.id]),
      (error) => (error as { code: string }).code === "55P03",
    );
    await blocker.query("COMMIT");
    assert.deepEqual(await pending, { ordered: true });
  } finally {
    await blocker.query("ROLLBACK");
    await pending?.catch(() => {});
    probe.release();
    blocker.release();
    await f.cleanup();
  }
});

test("QR migration rolls back and bounds credential lifetime without accepting a different approval owner", async () => {
  const f = await fixture(),
    client = await f.pool.connect(),
    schema = `qr_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query("CREATE TABLE app_accounts(id uuid PRIMARY KEY)");
    await client.query("CREATE TABLE app_events(id uuid PRIMARY KEY)");
    await client.query(
      "CREATE TABLE app_commitment_consents(id uuid,account_id uuid,event_id uuid,PRIMARY KEY(id,account_id,event_id))",
    );
    await client.query("CREATE TABLE app_attendance_candidates(id uuid PRIMARY KEY)");
    await client.query(await readFile("migrations/016-attendance-qr.sql", "utf8"));
    const account = randomUUID(),
      other = randomUUID(),
      event = randomUUID(),
      consent = randomUUID();
    await client.query("INSERT INTO app_accounts VALUES($1),($2)", [account, other]);
    await client.query("INSERT INTO app_events VALUES($1)", [event]);
    await client.query("INSERT INTO app_commitment_consents VALUES($1,$2,$3)", [
      consent,
      account,
      event,
    ]);
    for (const [owner, expiry, code] of [
      [account, 61, "23514"],
      [other, 60, "23503"],
    ] as const) {
      await client.query("SAVEPOINT invalid_qr");
      await assert.rejects(
        client.query(
          `INSERT INTO app_attendance_qr(id,event_id,account_id,consent_id,credential_index,encrypted_payload,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,'opaque',now(),now()+$6*interval '1 second')`,
          [randomUUID(), event, owner, consent, "a".repeat(64), expiry],
        ),
        (error) => (error as { code: string }).code === code,
      );
      await client.query("ROLLBACK TO SAVEPOINT invalid_qr");
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
