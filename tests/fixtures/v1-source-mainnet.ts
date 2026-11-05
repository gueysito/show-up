import assert from "node:assert/strict";
import { Interface, Transaction as EvmTransaction } from "ethers";
import { PublicKey, Transaction as SolanaTransaction } from "@solana/web3.js";
import type pg from "pg";
import type { AuthConfig } from "../../src/server/auth/config";
import { ownedV1Route } from "../../src/server/commitments/v1-route";
import { unseal } from "../../src/server/auth/crypto";
import { canonicalJson, canonicalHash } from "../../src/server/protocol/canonical";
import { ReadOnlyRpc, rpcCandidates, unsigned } from "../../src/server/protocol/rpc";
import { record } from "../../src/server/protocol/quote-signature";
import { boundedJson } from "../../src/server/protocol/one-click";
import { networkIdentity } from "../../src/server/protocol/manifest";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import {
  v1SolanaAssociatedProgram,
  v1SolanaTokenProgram,
  v1SolanaUsdc,
} from "../../src/domain/v1-solana-transfer";
import {
  loadV1EvmSource,
  loadV1SolanaSource,
  v1EvmSource,
  v1SolanaSource,
} from "../../scripts/lib/v1-source-keys";
import type { mainnetJournal } from "./v1-mainnet";

export type SourceNetwork = "base" | "solana" | "ethereum";
const submittedSources = new WeakSet<object>();
function approved() {
  if (process.env.SHOWUP_MAINNET_ROUTING !== "1")
    throw new Error("Explicit mainnet source routing execution required");
}
export async function sourceMainnetBalances(network: SourceNetwork) {
  const values = await Promise.all(
    (network === "solana"
      ? ["solana-public", "solana-publicnode"]
      : network === "base"
        ? ["base-public", "base-publicnode"]
        : ["ethereum-drpc", "ethereum-publicnode"]
    ).map(async (endpoint) => {
      const rpc = new ReadOnlyRpc(endpoint);
      if (network === "solana") {
        assert.equal(await rpc.read("getGenesisHash", []), networkIdentity("solana").chainId);
        const [ata] = await PublicKey.findProgramAddress(
            [
              new PublicKey(v1SolanaSource).toBytes(),
              new PublicKey(v1SolanaTokenProgram).toBytes(),
              new PublicKey(v1SolanaUsdc).toBytes(),
            ],
            new PublicKey(v1SolanaAssociatedProgram),
          ),
          [native, raw] = await Promise.all([
            rpc.read("getBalance", [v1SolanaSource, { commitment: "finalized" }]),
            rpc.read("getAccountInfo", [
              ata.toBase58(),
              { encoding: "base64", commitment: "finalized" },
            ]),
          ]),
          account = record(record(raw).value),
          data = account.data as string[];
        assert.equal(account.owner, v1SolanaTokenProgram);
        assert.equal(data[1], "base64");
        const bytes = Buffer.from(data[0], "base64");
        assert.equal(bytes.length, 165);
        assert.equal(encodeBase58(bytes.subarray(0, 32)), v1SolanaUsdc);
        assert.equal(encodeBase58(bytes.subarray(32, 64)), v1SolanaSource);
        return {
          usdc: bytes.readBigUInt64LE(64).toString(),
          native: unsigned(record(native).value, 64).toString(),
        };
      }
      assert.equal(
        unsigned(await rpc.read("eth_chainId", [])).toString(),
        networkIdentity(network).chainId,
      );
      const abi = new Interface(["function balanceOf(address) view returns(uint256)"]),
        token = networkIdentity(network).assets.find((a) => a.id === "usdc")!,
        [balance, native] = await Promise.all([
          rpc.read("eth_call", [
            { to: token.contract, data: abi.encodeFunctionData("balanceOf", [v1EvmSource]) },
            "latest",
          ]),
          rpc.read("eth_getBalance", [v1EvmSource, "latest"]),
        ]);
      return {
        usdc: abi.decodeFunctionResult("balanceOf", String(balance))[0].toString(),
        native: unsigned(native).toString(),
      };
    }),
  );
  assert.deepEqual(values[0], values[1]);
  return values[0];
}

export async function sourceMainnetApproval(input: {
  pool: pg.Pool;
  config: AuthConfig;
  session: string;
  eventId: string;
  network: SourceNetwork;
  journal: Awaited<ReturnType<typeof mainnetJournal>>;
  wire: unknown;
}) {
  approved();
  const saved = await ownedV1Route(input.pool, input.config, input.session, input.eventId);
  assert(saved?.encryptedPayment && saved.paymentHash);
  const payment = unseal(
    input.config.encryptionKey,
    `v1-route-payment:${saved.image.id}`,
    saved.encryptedPayment,
  ) as Record<string, unknown>;
  assert.equal(canonicalHash(payment), saved.paymentHash);
  assert.equal(payment.network, input.network);
  assert.equal(payment.inputAtomic, saved.route.input);
  assert(BigInt(saved.route.input) <= 2000000n);
  assert(Date.parse(String(payment.expiresAt)) > Date.now() + 3000);
  if (submittedSources.has(input.journal))
    throw new Error("Original source approval already retained; no second signature or send");
  submittedSources.add(input.journal);
  let hash: string,
    params: unknown[],
    method: string,
    endpoint: string,
    signed: Record<string, unknown>;
  if (input.network === "solana") {
    assert(BigInt(String(payment.maximumGasLamports)) <= 2500000n);
    assert(Array.isArray(input.wire));
    const wire = Uint8Array.from(input.wire as number[]);
    assert.equal(Buffer.from(wire).toString("base64"), payment.transactionBase64);
    const tx = SolanaTransaction.from(wire),
      message = Buffer.from(tx.serializeMessage());
    await tx.sign(await loadV1SolanaSource());
    assert.equal(Buffer.from(tx.serializeMessage()).equals(message), true);
    const bytes = await tx.serialize();
    assert(tx.signature);
    hash = encodeBase58(tx.signature);
    const signedBase64 = Buffer.from(bytes).toString("base64");
    params = [
      signedBase64,
      { encoding: "base64", skipPreflight: false, maxRetries: 0, preflightCommitment: "confirmed" },
    ];
    method = "sendTransaction";
    endpoint = "solana-public";
    signed = { signedBase64 };
  } else {
    assert.equal(canonicalJson(input.wire), canonicalJson(payment.transaction));
    const tx = record(input.wire),
      abi = new Interface(["function transfer(address,uint256)"]),
      decoded = abi.decodeFunctionData("transfer", String(tx.data));
    assert.equal(String(tx.from).toLowerCase(), v1EvmSource.toLowerCase());
    assert.equal(
      String(tx.to).toLowerCase(),
      networkIdentity(input.network)
        .assets.find((a) => a.id === "usdc")!
        .contract.toLowerCase(),
    );
    assert.equal(decoded[0].toLowerCase(), saved.route.depositAddress.toLowerCase());
    assert.equal(decoded[1].toString(), saved.route.input);
    assert.equal(unsigned(tx.chainId).toString(), networkIdentity(input.network).chainId);
    assert.equal(unsigned(tx.value), 0n);
    assert.equal(unsigned(tx.gas), 100000n);
    assert(
      unsigned(tx.gasPrice) > 0n &&
        unsigned(tx.gasPrice) * 100000n + (input.network === "base" ? 5000000000000n : 0n) <=
          (input.network === "base" ? 20000000000000n : 80000000000000n),
    );
    const signer = await loadV1EvmSource(),
      signedHex = await signer.signTransaction({
        type: 0,
        chainId: unsigned(tx.chainId),
        nonce: Number(unsigned(tx.nonce, 64)),
        to: String(tx.to),
        value: 0n,
        data: String(tx.data),
        gasLimit: unsigned(tx.gas),
        gasPrice: unsigned(tx.gasPrice),
      });
    hash = EvmTransaction.from(signedHex).hash!;
    params = [signedHex];
    method = "eth_sendRawTransaction";
    endpoint = input.network === "base" ? "base-public" : "ethereum-drpc";
    signed = { signedHex };
  }
  await input.journal.save({
    phase: "source_submitted",
    source: { network: input.network, hash, ...signed, payment, quote: saved.route },
  });
  try {
    const response = await fetch(rpcCandidates.endpoints.find((e) => e.id === endpoint)!.origin, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "v1-source-payment", method, params }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200);
    const result = record(await boundedJson(response));
    assert.equal(result.id, "v1-source-payment");
    assert.equal(result.error, undefined);
    assert.equal(result.result, hash);
    await input.journal.save({ phase: "source_submitted", sourceAcknowledged: true });
  } catch {
    // The original source image is retained. Return its known hash for status
    // lookup only; this function never signs or sends a replacement.
    await input.journal.save({ phase: "source_submitted", sourceAcknowledged: false });
  }
  console.log(JSON.stringify({ phase: "source_submitted", network: input.network, hash }));
  return hash;
}
