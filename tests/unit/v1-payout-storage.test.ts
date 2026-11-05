import assert from "node:assert/strict";
import test from "node:test";
import { v1PayoutStorageReady } from "../../src/server/protocol/v1-payout-storage";
import { prepareV1WalletPayment } from "../../src/server/protocol/v1-wallet-payment";
import { v1Deployment, type V1Snapshot } from "../../src/server/protocol/v1-escrow";
import { v1StorageRegistrationTransaction } from "../../scripts/lib/native-engineering-transaction";
import { encodeBase58 } from "../../src/server/protocol/encoding";

test("NEAR receiving readiness requires agreeing finalized token storage; setup fixes self-registration, collateral and gas without moving USDC", async () => {
  const block = encodeBase58(Buffer.alloc(32, 8)),
    snapshot: V1Snapshot = {
      block: { hash: block, height: "100", timestampMs: Date.now() },
      event: null,
    },
    wallet = { address: v1Deployment.owner, publicKey: v1Deployment.publicKey },
    event = "5b6160bc-b2bd-4c14-8c3e-7175fcfe38a2";
  let ready = false,
    disagree = false,
    min = "1250000000000000000000",
    usage = 182;
  const transport: typeof fetch = async (url, init) => {
    const q = JSON.parse(String(init?.body)),
      p = q.params,
      bytes =
        p.method_name === "storage_balance_of"
          ? ready
            ? {
                total: disagree && String(url).includes("drpc") ? "1" : "1250000000000000000000",
                available: "0",
              }
            : null
          : p.method_name === "storage_balance_bounds"
            ? { min, max: min }
            : "0";
    const result =
      q.method === "EXPERIMENTAL_protocol_config"
        ? {
            chain_id: "mainnet",
            protocol_version: 87,
            runtime_config: {
              min_gas_purchase_price: "1000000000",
              storage_amount_per_byte: "10000000000000000000",
            },
          }
        : {
            block_hash: block,
            block_height: 100,
            ...(p.request_type === "view_account"
              ? { amount: "200000000000000000000000", storage_usage: usage }
              : p.request_type === "view_access_key"
                ? { nonce: "1", permission: "FullAccess" }
                : { result: [...Buffer.from(JSON.stringify(bytes))] }),
          };
    return Response.json({ jsonrpc: "2.0", id: q.id, result });
  };
  assert.equal(await v1PayoutStorageReady(wallet.address, snapshot, transport), false);
  ready = true;
  assert.equal(await v1PayoutStorageReady(wallet.address, snapshot, transport), true);
  disagree = true;
  await assert.rejects(
    v1PayoutStorageReady(wallet.address, snapshot, transport),
    /sources disagree/,
  );
  disagree = false;
  const request = await prepareV1WalletPayment(
    { origin: "https://localhost:3444" },
    snapshot,
    wallet,
    event,
    event,
    "0",
    "storage",
    transport,
  );
  assert.equal(request.amountAtomic, "0");
  assert.equal(request.attachedYoctoNear, "1250000000000000000000");
  const wire = Buffer.from(request.unsignedBase64, "base64");
  let offset = 0;
  const text = () => {
    const size = wire.readUInt32LE(offset);
    offset += 4;
    const value = wire.subarray(offset, offset + size).toString("utf8");
    offset += size;
    return value;
  };
  assert.equal(text(), wallet.address);
  offset += 33 + 8;
  assert.equal(text(), v1Deployment.token);
  offset += 32;
  assert.equal(wire.readUInt32LE(offset), 1);
  offset += 4;
  assert.equal(wire[offset++], 2);
  assert.equal(text(), "storage_deposit");
  assert.deepEqual(JSON.parse(text()), { account_id: wallet.address, registration_only: true });
  assert.equal(wire.readBigUInt64LE(offset), 30000000000000n);
  offset += 8;
  assert.equal(
    wire.readBigUInt64LE(offset) + (wire.readBigUInt64LE(offset + 8) << 64n),
    1250000000000000000000n,
  );
  offset += 16;
  assert.equal(offset, wire.length);
  assert.equal(
    new URL(request.walletUrl).searchParams.get("callbackUrl"),
    `https://localhost:3444/events/${event}/commit`,
  );
  min = "2500000000000000000000";
  await assert.rejects(
    prepareV1WalletPayment(
      { origin: "https://localhost:3444" },
      snapshot,
      wallet,
      event,
      event,
      "0",
      "storage",
      transport,
    ),
    /costs changed/,
  );
  min = "1250000000000000000000";
  usage = 10000;
  await assert.rejects(
    prepareV1WalletPayment(
      { origin: "https://localhost:3444" },
      snapshot,
      wallet,
      event,
      event,
      "0",
      "storage",
      transport,
    ),
    /gas reserve/,
  );
  assert.throws(
    () =>
      v1StorageRegistrationTransaction({
        signer: wallet.address,
        publicKey: wallet.publicKey,
        nonce: "2",
        blockHash: block,
        eventId: event,
        amount: "1",
      }),
    /does not transfer USDC/,
  );
});
