import assert from "node:assert/strict";
import { canonicalJson } from "../../src/server/protocol/canonical";
import { V1ReadOnlyRpc } from "../../src/server/protocol/v1-rpc";
import { NearAccountNotFound, unsigned } from "../../src/server/protocol/rpc";
import { record } from "../../src/server/protocol/quote-signature";
import { readV1Snapshot, v1Deployment } from "../../src/server/protocol/v1-escrow";
import {
  v1DemoAccounts,
  v1DemoSetupTransaction,
  v1DemoReturnTransaction,
  v1PrizeFundingTransaction,
  signV1MainnetTransaction,
} from "../../scripts/lib/native-engineering-transaction";
import { loadV1MainnetKey } from "../../scripts/lib/v1-mainnet-key";
import { mainnetOwnerNonce, mainnetUsdc, type mainnetJournal } from "./v1-mainnet";

type Journal = Awaited<ReturnType<typeof mainnetJournal>>;
type Unsigned = { bytes: Buffer; digest: Buffer; hash: string };
export async function signDemoImage(image: Unsigned, semantic: string) {
  const key = await loadV1MainnetKey();
  assert.equal(key.publicKey, v1Deployment.publicKey);
  return {
    hash: image.hash,
    signedBase64: Buffer.concat([image.bytes, Buffer.from([0]), key.sign(image.digest)]).toString(
      "base64",
    ),
    semantic,
    validUntilMs: Date.now() + 120000,
  };
}
export async function demoAccount(account: string, block: string) {
  const values = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (endpoint) => {
      const rpc = new V1ReadOnlyRpc(endpoint),
        params = { account_id: account, block_id: block };
      let found: Record<string, unknown>;
      try {
        found = record(await rpc.read("query", { ...params, request_type: "view_account" }));
      } catch (error) {
        if (
          error instanceof NearAccountNotFound &&
          error.accountId === account &&
          error.blockHash === block
        )
          return null;
        throw error;
      }
      assert.equal(found.block_hash, block);
      assert.equal(
        found.code_hash,
        account === v1Deployment.account ? v1Deployment.codeHash : "1".repeat(32),
      );
      const list = record(
        await rpc.read("query", { ...params, request_type: "view_access_key_list" }),
      );
      assert.equal(list.block_hash, block);
      const keys = list.keys;
      assert(Array.isArray(keys) && keys.length === 1);
      assert.equal(record(keys[0]).public_key, v1Deployment.publicKey);
      assert.equal(record(record(keys[0]).access_key).permission, "FullAccess");
      return {
        amount: unsigned(found.amount, 128).toString(),
        storageUsage: unsigned(found.storage_usage, 64).toString(),
        nonce: unsigned(record(record(keys[0]).access_key).nonce, 64).toString(),
      };
    }),
  );
  assert.deepEqual(values[0], values[1]);
  return values[0];
}
export async function prepareDemoAccounts(journal: Journal) {
  const event = "v1-account-preflight";
  let snapshot = await readV1Snapshot(event);
  assert.deepEqual(await mainnetUsdc(snapshot.block.hash), ["2549953", "0"]);
  const parent = await demoAccount(v1Deployment.account, snapshot.block.hash);
  assert(parent);
  assert(
    BigInt(parent.amount) - BigInt(parent.storageUsage) * 10n ** 19n >
      430_000_000_000_000_000_000_000n,
    "Escrow needs free balance for two demo accounts",
  );
  const existing = await Promise.all(
    v1DemoAccounts.map((account) => demoAccount(account, snapshot.block.hash)),
  );
  assert(
    existing.every((account) => account === null),
    "Demo accounts already exist; reconcile their original journal instead of recreating them",
  );
  for (let index = 0; index < v1DemoAccounts.length; index++) {
    snapshot = await readV1Snapshot(event);
    const image = v1DemoSetupTransaction({
      account: v1DemoAccounts[index],
      blockHash: snapshot.block.hash,
      nonce: await mainnetOwnerNonce(snapshot.block.hash, v1Deployment.account),
    });
    await journal.submit(
      `setup_${index}`,
      await signDemoImage(image, `fixed-demo-account:${index}`),
      v1Deployment.account,
    );
    snapshot = await readV1Snapshot(event);
    const account = await demoAccount(v1DemoAccounts[index], snapshot.block.hash);
    assert(account && BigInt(account.amount) >= 160_000_000_000_000_000_000_000n);
    await journal.save({ demoAccounts: v1DemoAccounts, lastSetup: index });
  }
  // Register native USDC storage and allocate one existing project USDC each.
  for (let index = 0; index < v1DemoAccounts.length; index++) {
    snapshot = await readV1Snapshot(event);
    const image = signV1MainnetTransaction(
      {
        signer: v1Deployment.owner,
        receiver: v1Deployment.token,
        blockHash: snapshot.block.hash,
        nonce: await mainnetOwnerNonce(snapshot.block.hash),
        actions: [
          {
            kind: "call",
            method: "storage_deposit",
            args: Buffer.from(
              canonicalJson({ account_id: v1DemoAccounts[index], registration_only: true }),
            ),
            gas: "30000000000000",
            deposit: "1250000000000000000000",
          },
          {
            kind: "call",
            method: "ft_transfer",
            args: Buffer.from(
              canonicalJson({ receiver_id: v1DemoAccounts[index], amount: "1000000" }),
            ),
            gas: "30000000000000",
            deposit: "1",
          },
        ],
      },
      await loadV1MainnetKey(),
    );
    await journal.submit(`allocate_${index}`, {
      ...image,
      semantic: `allocate-one-usdc:${index}`,
      validUntilMs: Date.now() + 120000,
    });
  }
  snapshot = await readV1Snapshot(event);
  const balances = await mainnetUsdc(snapshot.block.hash, [
    v1Deployment.owner,
    v1Deployment.account,
    ...v1DemoAccounts,
  ]);
  assert.deepEqual(balances, ["549953", "0", "1000000", "1000000"]);
  await journal.save({ allocatedUsdc: balances });
}
export async function fundDemoPrize(journal: Journal, eventId: string) {
  const snapshot = await readV1Snapshot(eventId),
    key = await loadV1MainnetKey();
  const image = v1PrizeFundingTransaction({
    signer: v1Deployment.owner,
    publicKey: key.publicKey,
    nonce: await mainnetOwnerNonce(snapshot.block.hash),
    blockHash: snapshot.block.hash,
    eventId,
    amount: "250000",
  });
  await journal.submit("prize", await signDemoImage(image, `prize:${eventId}:250000`));
}
export async function restoreDemoUsdc(journal: Journal, eventId: string) {
  for (let index = 0; index < v1DemoAccounts.length; index++) {
    const snapshot = await readV1Snapshot(eventId),
      amount = (await mainnetUsdc(snapshot.block.hash, [v1DemoAccounts[index]]))[0];
    if (amount === "0") continue;
    const name = `restore_${index}`;
    if (journal.images[name]) {
      await journal.final(name, journal.images[name], v1DemoAccounts[index]);
      continue;
    }
    const image = v1DemoReturnTransaction({
      account: v1DemoAccounts[index],
      nonce: await mainnetOwnerNonce(snapshot.block.hash, v1DemoAccounts[index]),
      blockHash: snapshot.block.hash,
      amount,
    });
    await journal.submit(
      name,
      await signDemoImage(image, `return-demo-usdc:${index}:${amount}`),
      v1DemoAccounts[index],
    );
  }
  const snapshot = await readV1Snapshot(eventId),
    balances = await mainnetUsdc(snapshot.block.hash, [
      v1Deployment.owner,
      v1Deployment.account,
      ...v1DemoAccounts,
    ]);
  assert.deepEqual(balances, ["2549953", "0", "0", "0"]);
  await journal.save({
    phase: "restored",
    finalUsdc: balances,
    finalHeight: snapshot.block.height,
  });
}
