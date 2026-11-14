import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eventLoginReturn } from "../../src/server/auth/return-path";

test("login return context permits only an exact event path, without origins, capabilities or redirect modifiers", () => {
  const path = `/events/${randomUUID()}`;
  assert.equal(eventLoginReturn(path), path);
  assert.equal(eventLoginReturn(`${path}/commit`), `${path}/commit`);
  assert.equal(eventLoginReturn(undefined), null);
  for (const value of [
    `https://foreign.invalid${path}`,
    `/${path}`,
    `${path}?next=/host`,
    `${path}/commit?next=/host`,
    `${path}/commit/../manage`,
    `${path}/manage`,
    `${path}#fragment`,
    `${path}\n`,
    "/host",
    "/events/../account",
    "/events/%2Faccount",
    1,
    {},
  ])
    assert.throws(() => eventLoginReturn(value));
});
