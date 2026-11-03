import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  attendanceCheckpointWire,
  verifyAttendanceCheckpoint,
  type AttendanceCheckpoint,
} from "../../src/server/attendance/checkpoint-wire";
import { parseRpcJson } from "../../src/server/protocol/rpc";
import { randomUUID } from "node:crypto";
import { attendanceManifestHash } from "../../src/server/attendance/journal";
import { canonicalHash, canonicalJson } from "../../src/server/protocol/canonical";
import { settlementFixture } from "../fixtures/settlement";
import { validateSettlementState } from "../../src/server/protocol/settlement-state";

const checkpoint: AttendanceCheckpoint = {
  domain: "showup.sandbox.authorization.v1",
  deployment: "escrow.test.near",
  manifest: "local-v1",
  event: "1".repeat(64),
  rules_hash: "2".repeat(64),
  ledger_version: "18446744073709551615",
  complete_through_ms: 1_800_000_000_000,
  expires_ms: 1_800_000_300_000,
};
test("checkpoint wire preserves Rust u64 digits as a bare JSON integer and deterministic schema order", () => {
  const wire = attendanceCheckpointWire(checkpoint);
  assert(wire.includes('"ledger_version":18446744073709551615,'));
  assert.equal(
    (parseRpcJson(wire) as { ledger_version: bigint }).ledger_version,
    18446744073709551615n,
  );
  assert(wire.startsWith('{"complete_through_ms":1800000000000,"deployment":'));
  assert.equal(
    attendanceCheckpointWire(
      Object.fromEntries(Object.entries(checkpoint).reverse()) as AttendanceCheckpoint,
    ),
    wire,
  );
});

test("checkpoint signatures bind exact unsafe-range ledger bytes and the separately frozen evidence key", () => {
  const key = generateKeyPairSync("ed25519"),
    publicKey = Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url").toString(
      "base64",
    );
  const signature = sign(
    null,
    Buffer.from(attendanceCheckpointWire(checkpoint)),
    key.privateKey,
  ).toString("base64");
  assert.equal(verifyAttendanceCheckpoint(checkpoint, signature, publicKey), true);
  assert.equal(
    verifyAttendanceCheckpoint(
      { ...checkpoint, ledger_version: "18446744073709551614" },
      signature,
      publicKey,
    ),
    false,
  );
  assert.equal(
    verifyAttendanceCheckpoint(checkpoint, signature, Buffer.alloc(32, 8).toString("base64")),
    false,
  );
  assert.equal(verifyAttendanceCheckpoint(checkpoint, signature.slice(0, -1), publicKey), false);
});

test("private frozen manifests support the approved 100-candidate capacity beyond the signed-attestation limit", () => {
  const source = settlementFixture(),
    facts = validateSettlementState(source.context, source.views, source.block);
  facts.capacity = 100;
  facts.ledgerVersion = "100";
  facts.funded = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(64, "0"));
  const value = {
    eventId: randomUUID(),
    contextHash: "a".repeat(64),
    evidencePublicKey: "b".repeat(44),
    frozenFacts: facts,
    items: Array.from({ length: 100 }, () => ({
      id: randomUUID(),
      hash: "c".repeat(64),
      contextHash: "d".repeat(64),
      receiptHash: "e".repeat(64),
    })),
  };
  assert(Buffer.byteLength(canonicalJson(value)) > 32768);
  assert.throws(() => canonicalHash(value), /Attestation size limit/);
  const digest = attendanceManifestHash(value);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.notEqual(
    attendanceManifestHash({ ...value, items: value.items.slice().reverse() }),
    digest,
  );
  assert.throws(
    () => attendanceManifestHash({ ...value, items: [...value.items, value.items[0]] }),
    /candidate limit/,
  );
});
test("checkpoint wire rejects rounded, overflowing, noncanonical or extended signing fields", () => {
  for (const version of [
    "18446744073709551616",
    "01",
    "-1",
    "1e3",
    "0xff",
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() =>
      attendanceCheckpointWire({ ...checkpoint, ledger_version: version } as AttendanceCheckpoint),
    );
  for (const changed of [
    { ...checkpoint, complete_through_ms: 0.5 },
    { ...checkpoint, event: "bad" },
    { ...checkpoint, expires_ms: 0 },
    { ...checkpoint, complete: true },
  ])
    assert.throws(() => attendanceCheckpointWire(changed));
});
