import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { Transaction } from "@solana/web3.js";
import { nativeKey } from "../../scripts/lib/native-engineering-transaction";
import { encodeBase58, decodeBase58 } from "../../src/server/protocol/encoding";
import {
  v1SolanaTransfer,
  v1SolanaUsdc,
  v1SolanaTokenProgram,
  v1SolanaAssociatedProgram,
} from "../../src/domain/v1-solana-transfer";
import { prepareV1SolanaPayment } from "../../src/server/protocol/v1-solana-payment";
import { v1RouteRequest, type V1Route } from "../../src/server/protocol/v1-routing";
import {
  approveV1SolanaPayment,
  type V1SolanaWallet,
} from "../../src/components/access/v1-solana-wallet";

async function fixture() {
  const source = encodeBase58(nativeKey(randomBytes(32)).publicBytes),
    recipient = encodeBase58(nativeKey(randomBytes(32)).publicBytes),
    blockhash = encodeBase58(Buffer.alloc(32, 5));
  const route: V1Route = {
    network: "solana",
    request: v1RouteRequest("solana", source, "5b6160bc-b2bd-4c14-8c3e-7175fcfe38a2", "1000000"),
    response: {},
    input: "1100000",
    principal: "1000000",
    depositAddress: recipient,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  };
  const built = await v1SolanaTransfer({
    source,
    recipient,
    amount: route.input,
    blockhash,
    lastValidBlockHeight: "250",
  });
  const data = Buffer.alloc(165);
  decodeBase58(v1SolanaUsdc, 32).copy(data, 0);
  decodeBase58(source, 32).copy(data, 32);
  data.writeBigUInt64LE(1500000n, 64);
  data[108] = 1;
  const state = {
    genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    balance: 3000000,
    fee: 5000,
    rent: 2039280,
    valid: true,
    simulation: null as unknown,
    accountData: data,
  };
  const methods: string[] = [];
  const transport: typeof fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body));
    methods.push(input.method);
    const context = { slot: 100 };
    let result: unknown;
    if (input.method === "getGenesisHash") result = state.genesis;
    else if (input.method === "getLatestBlockhash")
      result = { context, value: { blockhash, lastValidBlockHeight: 250 } };
    else if (input.method === "isBlockhashValid") result = { context, value: state.valid };
    else if (input.method === "getBalance") result = { context, value: state.balance };
    else if (input.method === "getMinimumBalanceForRentExemption") result = state.rent;
    else if (input.method === "getFeeForMessage") result = { context, value: state.fee };
    else if (input.method === "getAccountInfo")
      result = {
        context,
        value:
          input.params[0] === built.sourceTokenAccount
            ? {
                owner: v1SolanaTokenProgram,
                executable: false,
                lamports: 2039280,
                data: [state.accountData.toString("base64"), "base64"],
              }
            : null,
      };
    else if (input.method === "simulateTransaction") {
      assert.equal(input.params[1].sigVerify, false);
      assert.equal(input.params[1].replaceRecentBlockhash, false);
      result = { context, value: { err: state.simulation } };
    } else throw new Error("Unapproved test RPC method");
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  return { source, recipient, route, built, state, methods, transport };
}
test("Solana source payment fixes native USDC, account creation, transfer amount and bounded gas; independent preflights reject unsafe requests", async () => {
  const f = await fixture(),
    payment = await prepareV1SolanaPayment(f.route, f.source, f.transport),
    tx = Transaction.from(Buffer.from(payment.transactionBase64, "base64"));
  assert.equal(payment.maximumGasLamports, "2044280");
  assert.equal(tx.feePayer!.toBase58(), f.source);
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[0].programId.toBase58(), v1SolanaAssociatedProgram);
  assert.deepEqual([...tx.instructions[0].data], [1]);
  assert.equal(tx.instructions[1].programId.toBase58(), v1SolanaTokenProgram);
  assert.equal(Buffer.from(tx.instructions[1].data).toString("hex"), "0ce0c810000000000006");
  assert.deepEqual(
    tx.instructions[1].keys.map((k) => k.pubkey.toBase58()),
    [f.built.sourceTokenAccount, v1SolanaUsdc, f.built.destinationTokenAccount, f.source],
  );
  assert.equal(f.methods.filter((m) => m === "simulateTransaction").length, 2);
  assert(!f.methods.some((m) => /send/i.test(m)));
  f.state.genesis = "devnet";
  await assert.rejects(prepareV1SolanaPayment(f.route, f.source, f.transport), /chain changed/);
  f.state.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  f.state.balance = 1000;
  await assert.rejects(prepareV1SolanaPayment(f.route, f.source, f.transport), /SOL balance/);
  f.state.balance = 3000000;
  f.state.fee = 20000;
  await assert.rejects(prepareV1SolanaPayment(f.route, f.source, f.transport), /limit/);
  f.state.fee = 5000;
  f.state.rent = 3000000;
  await assert.rejects(prepareV1SolanaPayment(f.route, f.source, f.transport), /limit/);
  f.state.rent = 2039280;
  f.state.accountData[108] = 2;
  await assert.rejects(prepareV1SolanaPayment(f.route, f.source, f.transport), /state differs/);
  f.state.accountData[108] = 1;
  f.state.accountData.writeBigUInt64LE(1n, 64);
  await assert.rejects(prepareV1SolanaPayment(f.route, f.source, f.transport), /USDC amount/);
  f.state.accountData.writeBigUInt64LE(1500000n, 64);
  f.state.valid = false;
  await assert.rejects(prepareV1SolanaPayment(f.route, f.source, f.transport), /blockhash/);
  f.state.valid = true;
  f.state.simulation = { InstructionError: [1, "InsufficientFunds"] };
  await assert.rejects(prepareV1SolanaPayment(f.route, f.source, f.transport), /simulation/);
});
test("Wallet Standard approval sends the exact reviewed Solana message on mainnet and rejects altered wire bytes before requesting a signature", async () => {
  const f = await fixture(),
    payment = await prepareV1SolanaPayment(f.route, f.source, f.transport),
    events: string[] = [],
    account = {
      address: f.source,
      publicKey: decodeBase58(f.source, 32),
      chains: ["solana:mainnet" as const],
      features: ["solana:signAndSendTransaction" as const],
    };
  const wallet: V1SolanaWallet = {
    version: "1.0.0",
    name: "Isolated fixture wallet",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains: ["solana:mainnet"],
    accounts: [account],
    features: {
      "standard:connect": {
        version: "1.0.0",
        async connect() {
          return { accounts: [account] };
        },
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy"],
        async signAndSendTransaction(input: {
          chain: string;
          transaction: Uint8Array;
          options: { skipPreflight: boolean; maxRetries: number };
        }) {
          events.push("wallet");
          assert.equal(input.chain, "solana:mainnet");
          assert.equal(input.options.skipPreflight, false);
          assert.equal(input.options.maxRetries, 0);
          assert.equal(
            Buffer.from(input.transaction).toString("base64"),
            payment.transactionBase64,
          );
          return [{ signature: new Uint8Array(64).fill(1) }];
        },
      },
    },
  };
  const reviewed = { inputAtomic: f.route.input, depositAddress: f.recipient };
  const hash = await approveV1SolanaPayment(payment, reviewed, f.source, wallet, () =>
    events.push("requested"),
  );
  assert.equal(decodeBase58(hash, 64).length, 64);
  assert.deepEqual(events, ["requested", "wallet"]);
  events.length = 0;
  const changed = Buffer.from(payment.transactionBase64, "base64");
  changed[changed.length - 1] = 9;
  await assert.rejects(
    approveV1SolanaPayment(
      { ...payment, transactionBase64: changed.toString("base64") },
      reviewed,
      f.source,
      wallet,
      () => events.push("requested"),
    ),
    /message changed/,
  );
  assert.deepEqual(events, []);
  await assert.rejects(
    approveV1SolanaPayment(
      payment,
      { ...reviewed, inputAtomic: "999999" },
      f.source,
      wallet,
      () => {},
    ),
    /differs/,
  );
});
