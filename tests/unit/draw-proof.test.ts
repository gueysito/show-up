import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { drawSeed, verifyDrawProof, type DrawContext } from "../../src/server/protocol/draw-proof";

test("independent draw verification binds every frozen context field and the original execution", () => {
  const keys = generateKeyPairSync("ed25519");
  const context: DrawContext = {
    domain: "showup.sandbox.authorization.v1",
    deployment: "escrow.local",
    manifest: "local-v1",
    event: "a".repeat(64),
    rules_hash: "b".repeat(64),
    snapshot_hash: "c".repeat(64),
    round: 0,
    exclusion_hash: createHash("sha256").update("[]").digest("hex"),
    provider: "outlayer.local",
    project: "showup.local/vrf-test",
    version_hash: "d".repeat(64),
    sender: "escrow.local",
    key: Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64"),
  };
  const requestId = "original-42";
  const alpha = `vrf:${requestId}:${context.sender}:${drawSeed(context)}`;
  const signature = sign(null, Buffer.from(alpha), keys.privateKey);
  const input = {
    context,
    requestId,
    alpha,
    signature: signature.toString("hex"),
    output: createHash("sha256").update(signature).digest("hex"),
  };
  assert.equal(verifyDrawProof(input), true);
  for (const field of Object.keys(context)) {
    const old = (context as unknown as Record<string, unknown>)[field];
    assert.equal(
      verifyDrawProof({
        ...input,
        context: { ...context, [field]: typeof old === "number" ? 1 : "e".repeat(64) },
      }),
      false,
      field,
    );
  }
  for (const field of ["requestId", "alpha", "signature", "output"])
    assert.equal(verifyDrawProof({ ...input, [field]: "wrong" }), false, field);
  const reversed = Object.fromEntries(Object.entries(context).reverse()) as DrawContext;
  assert.equal(drawSeed(reversed), drawSeed(context));
  assert.throws(() => drawSeed({ ...context, round: 1 }));
});
