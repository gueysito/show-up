import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, verify, createPublicKey } from "node:crypto";
import test from "node:test";
import {
  nativeKey,
  nativeTransaction,
  signNativeTransaction,
  type NativeAction,
} from "../../scripts/lib/native-engineering-transaction";
import {
  acquireRetainedClaim,
  retainedSigningKeys,
  submitOriginalNativeImage,
} from "../../scripts/native-engineering-run";
import { canonicalHash } from "../../src/server/protocol/canonical";

test("native images match the independently decoded pinned NEAR V0 wire vector", async () => {
  const vector = JSON.parse(
    await readFile(
      new URL("../../contracts/sandbox-tests/fixtures/native-transaction.json", import.meta.url),
      "utf8",
    ),
  );
  const actions: NativeAction[] = [
    { kind: "create" },
    { kind: "transfer", deposit: "12500000000000000000000000" },
    { kind: "add_key", publicKey: vector.publicKey },
    {
      kind: "call",
      method: "ft_transfer",
      args: Buffer.from('{"amount":"5000000","receiver_id":"root.testnet"}'),
      gas: "300000000000000",
      deposit: "1",
    },
  ];
  const image = nativeTransaction({
    signer: "root.testnet",
    receiver: "a.root.testnet",
    publicKey: vector.publicKey,
    nonce: "9007199254740993",
    blockHash: vector.blockHash,
    actions,
  });
  assert.equal(image.bytes.toString("base64"), vector.unsignedBase64);
  assert.equal(image.hash, vector.hash);
  assert.doesNotThrow(() =>
    nativeTransaction({
      signer: "root.testnet",
      receiver: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
      publicKey: vector.publicKey,
      nonce: "1",
      blockHash: vector.blockHash,
      actions: [
        {
          kind: "call",
          method: "ft_transfer",
          args: Buffer.from("{}"),
          gas: "300000000000000",
          deposit: "1",
        },
      ],
    }),
  );
  assert.throws(() =>
    nativeTransaction({
      signer: "root.near",
      receiver: "a.root.testnet",
      publicKey: vector.publicKey,
      nonce: "1",
      blockHash: vector.blockHash,
      actions: [{ kind: "transfer", deposit: "1" }],
    }),
  );
  const key = nativeKey(randomBytes(32)),
    signed = signNativeTransaction(
      {
        signer: "root.testnet",
        receiver: "a.root.testnet",
        nonce: "9007199254740993",
        blockHash: vector.blockHash,
        actions: [{ kind: "deploy", code: Buffer.from([0, 97, 115, 109]) }],
      },
      key,
    );
  const bytes = Buffer.from(signed.signedBase64, "base64");
  const unsigned = nativeTransaction({
    signer: "root.testnet",
    receiver: "a.root.testnet",
    publicKey: key.publicKey,
    nonce: "9007199254740993",
    blockHash: vector.blockHash,
    actions: [{ kind: "deploy", code: Buffer.from([0, 97, 115, 109]) }],
  });
  assert.equal(bytes.at(-65), 0);
  assert.equal(
    verify(
      null,
      unsigned.digest,
      createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.publicBytes]),
        format: "der",
        type: "spki",
      }),
      bytes.subarray(-64),
    ),
    true,
  );
});

test("an uncertain native submission resumes only its original hash after durable marking", async () => {
  const image = {
    hash: "original-hash",
    signedBase64: "original-image",
    signer: "a.root.testnet",
    phase: "prepared" as "prepared" | "submitted" | "final" | "failed",
  };
  const calls: object[] = [],
    saved: string[] = [];
  const save = async () => {
    saved.push(image.phase);
  };
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    calls.push(body);
    assert.equal(saved.at(-1), "submitted");
    if (body.method === "send_tx") throw new Error("Acknowledgment lost");
    return Response.json({
      jsonrpc: "2.0",
      id: "showup-native-engineering",
      result: {
        transaction: { hash: "original-hash" },
        final_execution_status: "FINAL",
        status: { SuccessValue: "" },
        receipts_outcome: [
          { outcome: { status: { SuccessReceiptId: "child-receipt" } } },
          { outcome: { status: { SuccessValue: "" } } },
        ],
      },
    });
  };
  await assert.rejects(submitOriginalNativeImage(image, save, transport));
  assert.equal(image.phase, "submitted");
  await submitOriginalNativeImage(image, save, transport);
  assert.equal(image.phase, "final");
  assert.deepEqual(
    calls.map((value) => (value as { method: string }).method),
    ["send_tx", "tx"],
  );
  assert.deepEqual((calls[1] as { params: object }).params, {
    tx_hash: "original-hash",
    sender_account_id: "a.root.testnet",
    wait_until: "FINAL",
  });
  assert.deepEqual(saved, ["submitted", "final"]);
});

test("expired prepared financial images cannot broadcast but submitted images still reconcile", async () => {
  const image = {
    hash: "original-hash",
    signedBase64: "original-image",
    signer: "a.root.testnet",
    phase: "prepared" as "prepared" | "submitted" | "final" | "failed",
    validUntilMs: Date.now() - 1,
  };
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init!.body)).method, "tx");
    return Response.json({
      jsonrpc: "2.0",
      id: "showup-native-engineering",
      result: {
        transaction: { hash: image.hash },
        final_execution_status: "FINAL",
        status: { SuccessValue: "" },
        receipts_outcome: [],
      },
    });
  };
  await assert.rejects(
    submitOriginalNativeImage(image, async () => {}, transport),
    /recovery/,
  );
  assert.equal(calls, 0);
  assert.equal(image.phase, "prepared");
  image.phase = "submitted";
  await submitOriginalNativeImage(image, async () => {}, transport);
  assert.equal(calls, 1);
  assert.equal(image.phase, "final");
});

test("retained signing requires recovered images and the authority keys deployed on chain", () => {
  const seeds = {
    escrow: Buffer.alloc(32, 1).toString("base64"),
    attendee: Buffer.alloc(32, 2).toString("base64"),
    credential: Buffer.alloc(32, 3).toString("base64"),
    evidence: Buffer.alloc(32, 4).toString("base64"),
  };
  const priorPlan = {
    escrowAccount: "e.fictional.testnet",
    attendeeAccount: "a.fictional.testnet",
  };
  const planHash = canonicalHash(priorPlan);
  const plan = {
    ...priorPlan,
    keySourcePlanHash: planHash,
    facts: {
      retained: {
        credentialKey: nativeKey(Buffer.from(seeds.credential, "base64")).publicBytes.toString(
          "base64",
        ),
        evidenceKey: nativeKey(Buffer.from(seeds.evidence, "base64")).publicBytes.toString(
          "base64",
        ),
      },
    },
  } as Parameters<typeof retainedSigningKeys>[0];
  const source = {
    plan: priorPlan,
    planHash,
    seeds,
    recoveryStarted: true,
    completed: ["recover_test_tokens_to_project_wallet", "recover_original_event"],
    images: { reserve: { phase: "failed" }, recovery: { phase: "final" } },
  } as Parameters<typeof retainedSigningKeys>[1];
  const before = canonicalHash(source);
  const keys = retainedSigningKeys(plan, source);
  assert.equal(keys.credential.publicBytes.toString("base64"), plan.facts.retained!.credentialKey);
  assert.equal(canonicalHash(source), before, "Reuse must not modify recovered state");
  assert.throws(
    () => retainedSigningKeys(plan, { ...source, recoveryStarted: undefined }),
    /not recovered/,
  );
  assert.throws(
    () =>
      retainedSigningKeys(plan, {
        ...source,
        images: { pending: { ...source.images.reserve, phase: "submitted" } },
      }),
    /not recovered/,
  );
  assert.throws(
    () =>
      retainedSigningKeys(plan, {
        ...source,
        seeds: { ...seeds, evidence: Buffer.alloc(32, 5).toString("base64") },
      }),
    /authority keys differ/,
  );
});

test("a stopped reuse operation retains its account claim for only that approved operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "showup-retained-claim-"));
  const path = join(directory, "source.lock");
  try {
    const first = await acquireRetainedClaim(path, "original-operation", "original-plan", false);
    await first.close();
    await assert.rejects(
      acquireRetainedClaim(path, "another-operation", "another-plan", true),
      /another operation/,
    );
    await assert.rejects(
      acquireRetainedClaim(path, "original-operation", "changed-plan", true),
      /another operation/,
    );
    const resumed = await acquireRetainedClaim(path, "original-operation", "original-plan", true);
    await resumed.close();
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      operationId: "original-operation",
      planHash: "original-plan",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
