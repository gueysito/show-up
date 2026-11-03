import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { accountFixtures } from "../fixtures/accounts";
import {
  createLoopbackCoverageRecorder,
  readLoopbackCoverage,
  fenceAbandonedLoopbackCoverage,
} from "../../src/server/attendance/coverage-recorder";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { AppFailure } from "../../src/server/http/security";
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
test("closed measurement epochs retain ordered private metadata, immutable results and bounded trace pages", async () => {
  const f = await accountFixtures([]),
    epochs: string[] = [];
  try {
    const before = (await f.pool.query("SELECT count(*) FROM app_mutations")).rows[0].count;
    const recorder = await createLoopbackCoverageRecorder(
      f.pool,
      canonicalHash({ fixture: "inventory" }),
      10000,
    );
    epochs.push(recorder.epochId);
    await recorder.probe(200);
    await assert.rejects(readLoopbackCoverage(f.pool, recorder.epochId), status(409));
    const request = await recorder.begin("unknown");
    await recorder.classify(request, "qr_scan");
    await recorder.complete(request, 202);
    const original = (
      await f.pool.query("SELECT sequence FROM service_coverage_epochs WHERE id=$1", [
        recorder.epochId,
      ])
    ).rows[0].sequence;
    await recorder.complete(request, 202);
    assert.equal(
      (
        await f.pool.query("SELECT sequence FROM service_coverage_epochs WHERE id=$1", [
          recorder.epochId,
        ])
      ).rows[0].sequence,
      original,
    );
    await assert.rejects(recorder.complete(request, 503), status(409));
    await assert.rejects(recorder.classify(request, "qr_issue"), status(409));
    const rejected = await recorder.begin("code_entry");
    await recorder.complete(rejected, 429);
    const failed = await recorder.begin("code_entry");
    await recorder.complete(failed, 503);
    await recorder.probe(0);
    await recorder.stop();
    const first = await readLoopbackCoverage(f.pool, recorder.epochId, 0, 2);
    assert.equal(first.records.length, 2);
    assert.equal(first.sourceQualified, false);
    assert.equal(first.liveSubmissionAllowed, false);
    assert.equal(first.hadGap, false);
    assert.equal(first.counts?.find((row) => row.channel === "qr_scan")?.received, "1");
    assert.equal(first.counts?.find((row) => row.channel === "code_entry")?.unavailable, "1");
    assert.equal(first.probes?.unavailable, "1");
    const sequences = first.records.map((row) => row.frame.sequence);
    let next = first.next;
    while (next !== null) {
      const page = await readLoopbackCoverage(f.pool, recorder.epochId, next, 2);
      assert.equal(page.counts, null);
      assert.equal(page.head, first.head);
      sequences.push(...page.records.map((row) => row.frame.sequence));
      next = page.next;
    }
    assert.equal(new Set(sequences).size, sequences.length);
    assert.deepEqual(
      sequences,
      Array.from({ length: sequences.length }, (_, index) => index + 1),
    );
    await assert.rejects(recorder.begin("admission"), status(409));
    await assert.rejects(readLoopbackCoverage(f.pool, recorder.epochId, 999), status(409));
    await assert.rejects(readLoopbackCoverage(f.pool, randomUUID()), status(404));
    assert.equal((await f.pool.query("SELECT count(*) FROM app_mutations")).rows[0].count, before);
  } finally {
    await f.pool.query("DELETE FROM service_coverage_epochs WHERE id=ANY($1::uuid[])", [epochs]);
    await f.cleanup();
  }
});
test("an expired observation gap is permanent and a later process cannot backfill it", async () => {
  const f = await accountFixtures([]),
    epochs: string[] = [];
  try {
    const first = await createLoopbackCoverageRecorder(
      f.pool,
      canonicalHash({ fixture: "gap" }),
      100,
    );
    epochs.push(first.epochId);
    await first.probe(200);
    const through = (
      await f.pool.query("SELECT through_ms FROM service_coverage_epochs WHERE id=$1", [
        first.epochId,
      ])
    ).rows[0].through_ms;
    await new Promise((resolve) => setTimeout(resolve, 150));
    await first.probe(200);
    await first.stop();
    const trace = await readLoopbackCoverage(f.pool, first.epochId);
    assert.equal(trace.hadGap, true);
    assert.equal(String(trace.throughMs), through);
    const second = await createLoopbackCoverageRecorder(f.pool, canonicalHash({ fixture: "gap" }));
    epochs.push(second.epochId);
    await second.probe(200);
    await assert.rejects(fenceAbandonedLoopbackCoverage(f.pool, second.epochId), status(409));
    await second.stop();
    const fresh = await readLoopbackCoverage(f.pool, second.epochId);
    assert(fresh.startedMs > trace.throughMs);
    assert.notEqual(fresh.epochId, trace.epochId);
  } finally {
    await f.pool.query("DELETE FROM service_coverage_epochs WHERE id=ANY($1::uuid[])", [epochs]);
    await f.cleanup();
  }
});
test("measurement genesis, middle-record corruption and policy replacement cannot produce a valid trace", async () => {
  const f = await accountFixtures([]),
    epochs: string[] = [];
  try {
    const recorder = await createLoopbackCoverageRecorder(
      f.pool,
      canonicalHash({ fixture: "integrity" }),
    );
    epochs.push(recorder.epochId);
    const id = await recorder.begin("admission");
    await recorder.complete(id, 200);
    await recorder.stop();
    const row = (
      await f.pool.query(
        "SELECT payload FROM service_coverage_records WHERE epoch_id=$1 AND sequence=2",
        [recorder.epochId],
      )
    ).rows[0];
    await f.pool.query(
      "UPDATE service_coverage_records SET payload=jsonb_set(payload,'{channel}','\"unknown\"') WHERE epoch_id=$1 AND sequence=2",
      [recorder.epochId],
    );
    await assert.rejects(readLoopbackCoverage(f.pool, recorder.epochId), status(409));
    await f.pool.query(
      "UPDATE service_coverage_records SET payload=$2 WHERE epoch_id=$1 AND sequence=2",
      [recorder.epochId, row.payload],
    );
    await f.pool.query("UPDATE service_coverage_epochs SET inventory_hash=$2 WHERE id=$1", [
      recorder.epochId,
      "b".repeat(64),
    ]);
    await assert.rejects(readLoopbackCoverage(f.pool, recorder.epochId), status(409));
  } finally {
    await f.pool.query("DELETE FROM service_coverage_epochs WHERE id=ANY($1::uuid[])", [epochs]);
    await f.cleanup();
  }
});
