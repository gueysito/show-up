import assert from "node:assert/strict";
import test from "node:test";
import { Interface, Transaction, id, toQuantity } from "ethers";
import type pg from "pg";
import { v1NftDeliveryGateway } from "../../src/worker/v1-nft-delivery";
import { v1NftFixture } from "../fixtures/v1-nft";
import {
  v1NftTerms,
  v1NftCustody,
  v1NftReleaseTransaction,
  signedV1NftRelease,
  readV1NftHolding,
  prepareV1NftTransfer,
} from "../../src/server/protocol/v1-nft";
import { matchesV1Terms } from "../../src/server/protocol/v1-escrow";
import { v1DraftTerms } from "../../src/server/events/v1-publication";
import { validDraft } from "../fixtures/draft";
import { randomUUID } from "node:crypto";

test("NFT terms freeze one Ethereum ERC-721 while mutable custody state cannot change its collection, asset or contributor", () => {
  const f = v1NftFixture(),
    terms = v1DraftTerms(randomUUID(), {
      ...validDraft(),
      commitment: "1",
      capacity: 2,
      sponsorBudget: "0",
      nft: f.draft,
    });
  assert.equal(v1NftCustody(f.live), f.custody);
  assert.equal(
    matchesV1Terms(
      { ...terms, nft: { ...f.live, held: true, request: { state: "signed" } } },
      terms,
    ),
    true,
  );
  for (const change of [
    { collection: f.contributor },
    { token_id: "2830" },
    { contributor: f.custody },
  ])
    assert.equal(matchesV1Terms({ ...terms, nft: { ...f.live, ...change } }, terms), false);
  for (const change of [
    { network: "base" as const },
    { assetId: "0x123" },
    { assetId: (1n << 128n).toString() },
    { contributorReturnAddress: "0x" + "0".repeat(40) },
  ])
    assert.throws(() => v1NftTerms({ ...f.draft, ...change }));
  assert.throws(() => v1NftCustody({ ...f.live, custody: f.contributor }));
});
test("NFT release reconstructs the deployed contract's EIP-1559 safe transfer and accepts only the original custody signature", () => {
  const f = v1NftFixture(),
    recipient = f.recipient.address.toLowerCase(),
    tx = v1NftReleaseTransaction(f.nft, f.custody, recipient, f.envelope),
    signature = f.signer.signingKey.sign(tx.unsignedHash),
    response = {
      scheme: "Secp256k1",
      big_r: { affine_point: (signature.yParity === 0 ? "02" : "03") + signature.r.slice(2) },
      s: { scalar: signature.s.slice(2) },
      recovery_id: signature.yParity,
    };
  f.live.request = {
    state: "signed",
    recipient,
    payload: tx.unsignedHash.slice(2),
    unsigned_transaction: Buffer.from(tx.unsignedSerialized.slice(2), "hex").toString("base64"),
    signature: JSON.stringify(response),
  };
  const result = signedV1NftRelease(f.nft, f.live, recipient, f.envelope),
    parsed = Transaction.from(result.signedHex),
    expected = new Interface([
      "function safeTransferFrom(address,address,uint256)",
    ]).encodeFunctionData("safeTransferFrom", [f.custody, recipient, 2829]);
  assert.equal(parsed.data, expected);
  assert.equal(parsed.chainId, 1n);
  assert.equal(parsed.value, 0n);
  assert.equal(parsed.from?.toLowerCase(), f.custody);
  assert.equal(parsed.hash, result.hash);
  for (const change of [{ nonce: "1" }, { max_fee: "999999999999" }, { gas_limit: "49999" }])
    assert.throws(() => signedV1NftRelease(f.nft, f.live, recipient, { ...f.envelope, ...change }));
  assert.throws(() => signedV1NftRelease(f.nft, f.live, f.contributor, f.envelope));
  assert.throws(() =>
    signedV1NftRelease({ ...f.nft, token_id: "2830" }, f.live, recipient, f.envelope),
  );
  const original = f.live.request as Record<string, unknown>;
  f.live.request = {
    ...original,
    signature: JSON.stringify({ ...response, recovery_id: 1 - signature.yParity }),
  };
  assert.throws(() => signedV1NftRelease(f.nft, f.live, recipient, f.envelope));
});
test("two Ethereum sources preflight NFT ownership, nonce, gas and actual transfer simulation before a wallet request", async () => {
  const f = v1NftFixture();
  assert.equal((await readV1NftHolding(f.nft, f.transport)).owner, f.contributor);
  const payment = await prepareV1NftTransfer(f.nft, f.contributor, f.custody, f.transport);
  assert.equal(payment.transaction.from, f.contributor);
  assert.equal(payment.transaction.value, "0x0");
  assert.equal(payment.transaction.chainId, "0x1");
  assert.ok(BigInt(payment.maximumGasWei) <= 100000000000000n);
  f.setPending("0x1");
  await assert.rejects(
    prepareV1NftTransfer(f.nft, f.contributor, f.custody, f.transport),
    /pending/,
  );
  f.setPending("0x0");
  f.setSimulation(false);
  await assert.rejects(prepareV1NftTransfer(f.nft, f.contributor, f.custody, f.transport));
  f.setSimulation(true);
  f.setPrice("0x1000000000");
  await assert.rejects(prepareV1NftTransfer(f.nft, f.contributor, f.custody, f.transport));
  f.setPrice("0x989680");
  f.setBalance("0x0");
  await assert.rejects(
    prepareV1NftTransfer(f.nft, f.contributor, f.custody, f.transport),
    /needs more ETH/,
  );
});

test("NFT delivery requires the original signed image, finalized inclusion and the exact ERC-721 transfer on both sources", async () => {
  const f = v1NftFixture(),
    recipient = f.recipient.address.toLowerCase(),
    tx = v1NftReleaseTransaction(f.nft, f.custody, recipient, f.envelope);
  tx.signature = f.signer.signingKey.sign(tx.unsignedHash);
  const image = {
      nft: f.nft,
      custody: f.custody,
      recipient,
      envelope: f.envelope,
      hash: tx.hash!,
      signedHex: tx.serialized,
      unsigned: tx.unsignedSerialized,
      semantic: "test-only",
    },
    block = { ...f.block, transactions: [tx.hash] },
    raw = {
      hash: tx.hash,
      type: "0x2",
      chainId: "0x1",
      nonce: "0x0",
      gas: toQuantity(tx.gasLimit),
      maxFeePerGas: toQuantity(tx.maxFeePerGas!),
      maxPriorityFeePerGas: toQuantity(tx.maxPriorityFeePerGas!),
      to: f.nft.collection,
      from: f.custody,
      value: "0x0",
      input: tx.data,
      accessList: [],
      r: tx.signature.r,
      s: tx.signature.s,
      yParity: toQuantity(tx.signature.yParity),
      blockNumber: "0x64",
      blockHash: block.hash,
      transactionIndex: "0x0",
    },
    log = {
      address: f.nft.collection,
      topics: [
        id("Transfer(address,address,uint256)"),
        "0x" + f.custody.slice(2).padStart(64, "0"),
        "0x" + recipient.slice(2).padStart(64, "0"),
        "0x" + (2829).toString(16).padStart(64, "0"),
      ],
      data: "0x",
      removed: false,
      transactionHash: tx.hash,
      blockHash: block.hash,
      blockNumber: "0x64",
      transactionIndex: "0x0",
    },
    receipt = {
      transactionHash: tx.hash,
      blockNumber: "0x64",
      blockHash: block.hash,
      from: f.custody,
      to: f.nft.collection,
      type: "0x2",
      contractAddress: null,
      transactionIndex: "0x0",
      status: "0x1",
      gasUsed: "0x10ac8",
      effectiveGasPrice: "0xf4240",
      cumulativeGasUsed: "0x10ac8",
      logs: [log],
    };
  let pending = true;
  const transport: typeof fetch = async (url, init) => {
      const input = JSON.parse(String(init?.body));
      if (
        ![
          "eth_getTransactionReceipt",
          "eth_getTransactionByHash",
          "eth_getBlockByNumber",
          "eth_call",
        ].includes(input.method)
      )
        return f.transport(url, init);
      const result =
        input.method === "eth_getTransactionReceipt"
          ? pending
            ? null
            : receipt
          : input.method === "eth_getTransactionByHash"
            ? raw
            : input.method === "eth_getBlockByNumber"
              ? block
              : "0x" + recipient.slice(2).padStart(64, "0");
      return Response.json({ jsonrpc: "2.0", id: input.id, result });
    },
    gateway = v1NftDeliveryGateway({} as pg.Pool, "unused-for-read-only-observation", transport);
  assert.equal(await gateway.observe(image), null);
  pending = false;
  assert.deepEqual(await gateway.observe(image), {
    state: "delivered",
    height: "100",
    fee: "68296000000",
  });
  log.topics[2] = "0x" + f.contributor.slice(2).padStart(64, "0");
  await assert.rejects(gateway.observe(image), /transfer log/);
  log.topics[2] = "0x" + recipient.slice(2).padStart(64, "0");
  raw.input = raw.input.slice(0, -1) + (raw.input.endsWith("0") ? "1" : "0");
  await assert.rejects(gateway.observe(image), /authorized image/);
});
