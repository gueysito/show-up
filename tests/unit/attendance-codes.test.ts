import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { attendanceCodeIndex, normalizeAttendanceCode } from "../../src/server/attendance/codes";

test("attendance phrases normalize compatibility, case and extra whitespace while rejecting invisible or oversized input", () => {
  for (const input of ["  Fresh   Word  ", "ＦＲＥＳＨ WORD", "fresh\t\nword"])
    assert.equal(normalizeAttendanceCode(input), "fresh word");
  for (const input of [null, "", "   ", "x\u200by", "x\u0000y", "x".repeat(81), "\ud800"])
    assert.throws(() => normalizeAttendanceCode(input));
});

test("code reuse indexes are keyed and scoped to one event without storing a guessable phrase hash", () => {
  const keys = { indexKey: randomBytes(32).toString("hex") },
    event = randomUUID(),
    first = attendanceCodeIndex(keys, event, "Fresh Word");
  assert.equal(first, attendanceCodeIndex(keys, event, "  fresh  word "));
  assert.notEqual(first, attendanceCodeIndex(keys, randomUUID(), "Fresh Word"));
  assert.notEqual(
    first,
    attendanceCodeIndex({ indexKey: randomBytes(32).toString("hex") }, event, "Fresh Word"),
  );
  assert.match(first, /^[0-9a-f]{64}$/);
});
