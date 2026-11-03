import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { attendanceFixtures } from "../fixtures/attendance";
import { hash } from "../../src/server/auth/crypto";
import { listStaffAttendanceEvents } from "../../src/server/attendance/staff";
import { AppFailure } from "../../src/server/http/security";
const failure = (status: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === status;

test("staff discovery exposes only minimal published physical metadata for prepublication host or validator credentials", async () => {
  const f = await attendanceFixtures("physical", true);
  try {
    for (const [index, assignment] of [
      [1, "host"],
      [2, "validator"],
    ] as const) {
      const result = await listStaffAttendanceEvents(f.pool, hash(f.accounts[index].value));
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].eventId, f.eventId);
      assert.equal(result.events[0].assignment, assignment);
      assert.deepEqual(Object.keys(result.events[0]).sort(), [
        "assignment",
        "cutoff",
        "eventId",
        "opensAt",
        "timeZone",
        "title",
      ]);
    }
    await f.pool.query("INSERT INTO app_roles(account_id,role) VALUES($1,'admin')", [
      f.accounts[0].id,
    ]);
    assert.deepEqual((await listStaffAttendanceEvents(f.pool, f.session)).events, []);
    await assert.rejects(
      listStaffAttendanceEvents(f.pool, f.session, { eventId: f.eventId }),
      failure(404),
    );
    await assert.rejects(
      listStaffAttendanceEvents(f.pool, f.session, { before: f.eventId }),
      failure(404),
    );
    await assert.rejects(
      listStaffAttendanceEvents(f.pool, f.session, { eventId: randomUUID() }),
      failure(404),
    );
    await assert.rejects(
      listStaffAttendanceEvents(f.pool, f.session, { eventId: "bad" }),
      failure(400),
    );
    await f.pool.query(
      "UPDATE app_events SET data=jsonb_set(data,'{mode}','\"digital\"') WHERE id=$1",
      [f.eventId],
    );
    assert.deepEqual(
      (await listStaffAttendanceEvents(f.pool, hash(f.accounts[2].value))).events,
      [],
    );
  } finally {
    await f.cleanup();
  }
});

test("staff discovery drops revoked, late or missing credentials and rejects expired sessions and deletion recovery", async () => {
  const f = await attendanceFixtures("physical");
  const staff = hash(f.accounts[2].value);
  try {
    await f.pool.query(
      "UPDATE app_event_validators SET revoked_at=clock_timestamp() WHERE event_id=$1",
      [f.eventId],
    );
    assert.deepEqual((await listStaffAttendanceEvents(f.pool, staff)).events, []);
    await f.pool.query(
      "UPDATE app_event_validators SET revoked_at=NULL,assigned_at=clock_timestamp() WHERE event_id=$1",
      [f.eventId],
    );
    assert.deepEqual((await listStaffAttendanceEvents(f.pool, staff)).events, []);
    await f.pool.query(
      "UPDATE app_event_validators SET assigned_at=now()-interval '1 day' WHERE event_id=$1",
      [f.eventId],
    );
    await f.pool.query(
      "UPDATE app_event_credentials SET created_at=clock_timestamp() WHERE event_id=$1",
      [f.eventId],
    );
    assert.deepEqual((await listStaffAttendanceEvents(f.pool, staff)).events, []);
    await f.pool.query("DELETE FROM app_event_credentials WHERE event_id=$1", [f.eventId]);
    assert.deepEqual((await listStaffAttendanceEvents(f.pool, staff)).events, []);
    await f.pool.query("UPDATE app_accounts SET state='deletion_requested' WHERE id=$1", [
      f.accounts[2].id,
    ]);
    await assert.rejects(listStaffAttendanceEvents(f.pool, staff), failure(401));
    await f.pool.query("UPDATE app_accounts SET state='active' WHERE id=$1", [f.accounts[2].id]);
    await f.pool.query(
      "UPDATE app_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [staff],
    );
    await assert.rejects(listStaffAttendanceEvents(f.pool, staff), failure(401));
  } finally {
    await f.cleanup();
  }
});

test("staff event history is bounded and cursor references are actor-scoped", async () => {
  const f = await attendanceFixtures("physical");
  try {
    const events = await f.pool.query(
      `INSERT INTO app_events(id,owner_id,revision,data,state,rules_hash,published_at,registration_closes_at)
      SELECT gen_random_uuid(),owner_id,1,data,'published',rules_hash,published_at-n*interval '1 second',registration_closes_at
      FROM app_events CROSS JOIN generate_series(1,51) AS n WHERE id=$1 RETURNING id`,
      [f.eventId],
    );
    await f.pool.query(
      `INSERT INTO app_event_credentials(event_id,account_id,encrypted_credential,created_at)
      SELECT id,$2,encrypted_credential,created_at-interval '1 day' FROM unnest($1::uuid[]) AS id
      CROSS JOIN app_event_credentials c WHERE c.event_id=$3 AND c.account_id=$2`,
      [events.rows.map((row) => row.id), f.accounts[1].id, f.eventId],
    );
    const actor = hash(f.accounts[1].value),
      first = await listStaffAttendanceEvents(f.pool, actor);
    assert.equal(first.events.length, 50);
    assert(first.nextCursor);
    const next = await listStaffAttendanceEvents(f.pool, actor, { before: first.nextCursor });
    assert.equal(next.events.length, 2);
    assert.equal(next.nextCursor, null);
    assert.equal(new Set([...first.events, ...next.events].map((event) => event.eventId)).size, 52);
    await assert.rejects(
      listStaffAttendanceEvents(f.pool, f.session, { before: first.nextCursor }),
      failure(404),
    );
    assert.equal(
      (await listStaffAttendanceEvents(f.pool, actor, { eventId: next.events[1].eventId })).events
        .length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});
