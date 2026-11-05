import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { v1MainnetStep, v1SubmitOriginal } from "../../scripts/v1-mainnet";
import { mainnetAccount } from "../../scripts/near-mainnet-account-plan";
import {
  nativeTransaction,
  v1MainnetTransaction,
  type NativeAction,
  type NativeTransactionInput,
} from "../../scripts/lib/native-engineering-transaction";

test("V1 mainnet images match independently decoded NEAR unwrap and atomic deployment vectors", async () => {
  const vectors = JSON.parse(
    await readFile(
      new URL(
        "../../contracts/sandbox-tests/fixtures/v1-mainnet-transactions.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const vector of vectors) {
    const input: NativeTransactionInput = {
      ...vector,
      actions: vector.actions.map((value: { kind: string; codeBase64?: string; args?: string }) =>
        value.kind === "deploy"
          ? { kind: "deploy", code: Buffer.from(value.codeBase64!, "base64") }
          : ({ ...value, args: Buffer.from(value.args!) } as NativeAction),
      ),
    };
    const image = v1MainnetTransaction(input);
    assert.equal(image.bytes.toString("base64"), vector.unsignedBase64);
    assert.equal(image.hash, vector.hash);
    assert.throws(() => nativeTransaction(input), "Legacy testnet guard was broadened");
    for (const changed of [
      { ...input, signer: "attacker.near" },
      { ...input, receiver: "attacker.near" },
      { ...input, publicKey: "ed25519:11111111111111111111111111111111" },
      { ...input, nonce: "18446744073709551616" },
      { ...input, actions: [{ kind: "create" } as NativeAction] },
      {
        ...input,
        actions: [{ kind: "transfer", deposit: "4000000000000000000000000" } as NativeAction],
      },
      {
        ...input,
        actions: [
          {
            kind: "call",
            method: "near_withdraw",
            args: Buffer.from("{}"),
            gas: "200000000000000",
            deposit: "1",
          } as NativeAction,
        ],
      },
    ])
      assert.throws(() => v1MainnetTransaction(changed));
  }
});

test("V1 operator fixes the deployment owner, funding amount and one-USDC round trip", () => {
  const context = {
    event: "v1-smoke-20261105",
    registration: "v1-smoke-20261105-attendee",
    start: 1_800_000_000_000,
    baseline: "2549953",
    artifact: "reviewed",
  };
  const deploy = v1MainnetStep("deploy", context, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  assert.equal(deploy.signer, mainnetAccount.proposedName);
  assert.equal(deploy.receiver, deploy.signer);
  assert.equal(deploy.actions.length, 2);
  assert.equal(deploy.actions[0].kind, "deploy");
  const init = deploy.actions[1];
  assert.equal(init.kind, "call");
  if (init.kind !== "call") throw Error("Initialization missing");
  assert.equal(init.method, "new");
  assert.equal(JSON.parse(init.args.toString()).owner, mainnetAccount.implicit);
  assert.equal(v1MainnetStep("fund", context, Buffer.alloc(0)).actions[0].kind, "transfer");
  const funding = v1MainnetStep("fund", context, Buffer.alloc(0)).actions[0];
  assert(funding.kind === "transfer");
  assert.equal(funding.deposit, "3712070000000000000000000");
  const payment = v1MainnetStep("deposit", context, Buffer.alloc(0)).actions[0];
  assert(payment.kind === "call");
  assert.deepEqual(JSON.parse(payment.args.toString()), {
    amount: "1000000",
    msg: `deposit:${context.registration}`,
    receiver_id: mainnetAccount.proposedName,
  });
  const withdrawal = v1MainnetStep("withdraw", context, Buffer.alloc(0)).actions[0];
  assert(withdrawal.kind === "call");
  assert.deepEqual(JSON.parse(withdrawal.args.toString()), { claim: context.registration });
});

test("V1 operator dry mode never broadcasts and uncertain execution only reads the original hash", async () => {
  const image: Parameters<typeof v1SubmitOriginal>[0] = {
    step: "create",
    semantic: "fixed",
    signer: mainnetAccount.implicit,
    hash: "original-hash",
    signedBase64: "original-image",
    phase: "prepared",
    validUntilMs: Date.now() + 120_000,
  };
  const calls: { method: string; params: object }[] = [],
    persisted: string[] = [];
  const rpc: NonNullable<Parameters<typeof v1SubmitOriginal>[3]> = async (method, params) => {
    calls.push({ method, params });
    if (method === "send_tx") throw Error("Acknowledgment lost");
    return { final_execution_status: "FINAL" };
  };
  const save = async () => {
    persisted.push(image.phase);
  };
  assert.equal(await v1SubmitOriginal(image, false, save, rpc), null);
  assert.equal(calls.length, 0);
  assert.equal(image.phase, "prepared");
  await assert.rejects(v1SubmitOriginal(image, true, save, rpc));
  assert.deepEqual(persisted, ["submitted"]);
  image.validUntilMs = 0;
  await v1SubmitOriginal(image, false, save, rpc);
  assert.deepEqual(calls, [
    { method: "send_tx", params: { signed_tx_base64: "original-image", wait_until: "FINAL" } },
    {
      method: "tx",
      params: {
        tx_hash: "original-hash",
        sender_account_id: mainnetAccount.implicit,
        wait_until: "FINAL",
      },
    },
  ]);
  image.phase = "prepared";
  await assert.rejects(v1SubmitOriginal(image, true, save, rpc));
  assert.equal(calls.length, 2);
});
