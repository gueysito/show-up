import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseAttendanceQr } from "../../src/server/attendance/qr";
import { AppFailure } from "../../src/server/http/security";

test("personal QR parsing accepts only bounded opaque event credentials and rejects identity or authority fields", () => {
  const payload = {
    format: "showup.attendance.qr.v1",
    eventId: randomUUID(),
    credential: "a".repeat(43),
    nonce: "b".repeat(64),
    expiresAt: 1_800_000_000_000,
  };
  assert.deepEqual(parseAttendanceQr(JSON.stringify(payload)), payload);
  for (const value of [
    null,
    {},
    "null",
    "[]",
    "{",
    "x".repeat(1025),
    JSON.stringify({ ...payload, wallet: "private.near" }),
    JSON.stringify({ ...payload, confirmed: true }),
    JSON.stringify({ ...payload, format: "other" }),
    JSON.stringify({ ...payload, eventId: "unknown" }),
    JSON.stringify({ ...payload, credential: "a".repeat(44) }),
    JSON.stringify({ ...payload, nonce: "bad" }),
    JSON.stringify({ ...payload, expiresAt: 0.5 }),
  ])
    assert.throws(
      () => parseAttendanceQr(value),
      (error) => error instanceof AppFailure && error.status === 400,
    );
});
