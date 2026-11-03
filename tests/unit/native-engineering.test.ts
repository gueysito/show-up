import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes, verify, createPublicKey } from "node:crypto";
import test from "node:test";
import {
  nativeKey,
  nativeTransaction,
  signNativeTransaction,
  type NativeAction,
} from "../../scripts/lib/native-engineering-transaction";
import { submitOriginalNativeImage } from "../../scripts/native-engineering-run";

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
