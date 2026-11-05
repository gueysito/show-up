import assert from "node:assert/strict";
import test from "node:test";
import {
  v1IntentsAccountTransaction,
  v1IntentsWithdrawalTransaction,
  v1DemoReserveTransaction,
} from "../../scripts/lib/native-engineering-transaction";
import {
  v1RouteAccount,
  readV1RouteAccount,
  readV1IntentsBalance,
  v1Intents,
} from "../../src/server/protocol/v1-intents";
import { v1Deployment, type V1Snapshot } from "../../src/server/protocol/v1-escrow";

const registrationId = "6c6d5471-a0e7-4941-bb37-32f131270000",
  blockHash = "11111111111111111111111111111111";
function reader(bytes: Buffer) {
  let offset = 0;
  return {
    byte: () => bytes[offset++],
    skip: (n: number) => {
      offset += n;
    },
    u32: () => {
      const n = bytes.readUInt32LE(offset);
      offset += 4;
      return n;
    },
    u64: () => {
      const n = bytes.readBigUInt64LE(offset);
      offset += 8;
      return n;
    },
    u128: () => {
      const n = bytes.readBigUInt64LE(offset) + (bytes.readBigUInt64LE(offset + 8) << 64n);
      offset += 16;
      return n;
    },
    text: () => {
      const n = bytes.readUInt32LE(offset);
      offset += 4;
      const value = bytes.subarray(offset, offset + n).toString();
      offset += n;
      return value;
    },
    end: () => offset === bytes.length,
  };
}
test("isolated route accounts deploy no code, reuse only the retained key and forward only native USDC to their fixed registration", () => {
  const input = { registrationId, nonce: "1", blockHash },
    account = v1RouteAccount(registrationId),
    setup = reader(v1IntentsAccountTransaction(input).bytes);
  assert.equal(setup.text(), v1Deployment.account);
  setup.skip(33 + 8);
  assert.equal(setup.text(), account);
  setup.skip(32);
  assert.equal(setup.u32(), 3);
  assert.equal(setup.byte(), 0);
  assert.equal(setup.byte(), 3);
  assert.equal(setup.u128(), 20000000000000000000000n);
  assert.equal(setup.byte(), 5);
  setup.skip(33);
  assert.equal(setup.u64(), 0n);
  assert.equal(setup.byte(), 1);
  assert.equal(setup.end(), true);
  const transfer = reader(v1IntentsWithdrawalTransaction({ ...input, amount: "1000000" }).bytes);
  assert.equal(transfer.text(), account);
  transfer.skip(33 + 8);
  assert.equal(transfer.text(), "intents.near");
  transfer.skip(32);
  assert.equal(transfer.u32(), 1);
  assert.equal(transfer.byte(), 2);
  assert.equal(transfer.text(), "ft_withdraw");
  assert.deepEqual(JSON.parse(transfer.text()), {
    amount: "1000000",
    memo: null,
    msg: `deposit:${registrationId}`,
    receiver_id: v1Deployment.account,
    token: v1Deployment.token,
  });
  assert.equal(transfer.u64(), 100000000000000n);
  assert.equal(transfer.u128(), 1n);
  assert.equal(transfer.end(), true);
  for (const amount of ["0", "-1", "100000001"])
    assert.throws(() => v1IntentsWithdrawalTransaction({ ...input, amount }));
  for (const id of ["attacker.near", "../x", registrationId + ".near"])
    assert.throws(() => v1RouteAccount(id));
  assert.throws(() =>
    v1DemoReserveTransaction({ account: v1Deployment.owner, nonce: "1", blockHash }),
  );
});
test("route balance reads pin native USDC and both source blocks; absent or altered keys cannot receive source approvals", async () => {
  const snapshot: V1Snapshot = {
      event: null,
      block: { height: "100", hash: blockHash, timestampMs: Date.now() },
    },
    account = v1RouteAccount(registrationId);
  let missing = false,
    wrongKey = false,
    wrongCode = false,
    disagree = false;
  const transport: typeof fetch = async (url, init) => {
    const q = JSON.parse(String(init?.body)),
      p = q.params;
    if (missing && p.account_id === account && p.request_type === "view_account")
      return Response.json({
        jsonrpc: "2.0",
        id: q.id,
        error: {
          code: -32000,
          cause: {
            name: "UNKNOWN_ACCOUNT",
            info: { requested_account_id: account, block_hash: blockHash, block_height: 100 },
          },
        },
      });
    const result = {
      block_hash: blockHash,
      block_height: 100,
      ...(p.request_type === "view_account"
        ? {
            code_hash:
              p.account_id === "intents.near"
                ? wrongCode
                  ? "changed"
                  : v1Intents.codeHash
                : "1".repeat(32),
            amount: "20000000000000000000000",
            storage_usage: 182,
          }
        : p.request_type === "view_access_key_list"
          ? {
              keys: [
                {
                  public_key: wrongKey
                    ? "ed25519:11111111111111111111111111111111"
                    : v1Deployment.publicKey,
                  access_key: { permission: "FullAccess", nonce: 1 },
                },
              ],
            }
          : {
              result: [
                ...Buffer.from(
                  JSON.stringify(disagree && String(url).includes("drpc") ? "999999" : "1000000"),
                ),
              ],
            }),
    };
    if (p.method_name === "mt_balance_of")
      assert.deepEqual(JSON.parse(Buffer.from(p.args_base64, "base64").toString()), {
        account_id: account,
        token_id: `nep141:${v1Deployment.token}`,
      });
    return Response.json({ jsonrpc: "2.0", id: q.id, result });
  };
  assert.equal((await readV1RouteAccount(registrationId, snapshot, transport))!.account, account);
  assert.equal(await readV1IntentsBalance(registrationId, snapshot, transport), "1000000");
  missing = true;
  assert.equal(await readV1RouteAccount(registrationId, snapshot, transport), null);
  missing = false;
  wrongKey = true;
  await assert.rejects(readV1RouteAccount(registrationId, snapshot, transport), /authority/);
  wrongKey = false;
  disagree = true;
  await assert.rejects(readV1IntentsBalance(registrationId, snapshot, transport), /disagree/);
  disagree = false;
  wrongCode = true;
  await assert.rejects(readV1IntentsBalance(registrationId, snapshot, transport), /deployment/);
});
