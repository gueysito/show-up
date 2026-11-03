import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceFixtures } from "../fixtures/attendance";
import { listOwnFinancialRecords } from "../../src/server/commitments/records";
import { hash } from "../../src/server/auth/crypto";

test("own check-in windows expose published timing without answers, roster or a funded-seat claim", async () => {
  const f = await attendanceFixtures("digital", true);
  try {
    const history = await listOwnFinancialRecords(f.pool, f.config, f.session),
      record = history.records[0];
    const terms = (f.source.views.event as { terms: { start_ms: number; end_ms: number } }).terms;
    assert.deepEqual(record.attendanceWindow, {
      mode: "digital",
      opensAt: new Date(terms.start_ms - 300000).toISOString(),
      onTimeThrough: new Date(terms.start_ms + 600000).toISOString(),
      cutoff: new Date(terms.end_ms - 900000).toISOString(),
    });
    assert.equal(record.escrowState, "not_confirmed");
    assert.equal(record.fundingAllowed, false);
    assert.equal(JSON.stringify(record.attendanceWindow).includes("correctOption"), false);
    assert.deepEqual(
      (await listOwnFinancialRecords(f.pool, f.config, hash(f.accounts[2].value))).records,
      [],
    );
  } finally {
    await f.cleanup();
  }
});

test("damaged check-in timing suppresses entry metadata while preserving the original financial approval", async () => {
  const f = await attendanceFixtures();
  try {
    await f.pool.query("UPDATE app_events SET data=jsonb_set(data,'{endsAt}','null') WHERE id=$1", [
      f.eventId,
    ]);
    const record = (await listOwnFinancialRecords(f.pool, f.config, f.session)).records[0];
    assert.equal(record.attendanceWindow, null);
    assert.equal(record.id, f.consent.id);
    assert(record.authorizedAt);
    assert.equal(record.terms.principal, "5000000");
    assert.equal(record.escrowState, "not_confirmed");
  } finally {
    await f.cleanup();
  }
});
