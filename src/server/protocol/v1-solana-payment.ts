import {
  v1SolanaTransfer,
  v1SolanaTokenProgram,
  v1SolanaUsdc,
} from "../../domain/v1-solana-transfer";
import { ReadOnlyRpc, unsigned } from "./rpc";
import { networkIdentity } from "./manifest";
import { AppFailure } from "../http/security";
import { record } from "./quote-signature";
import { decodeBase58, encodeBase58 } from "./encoding";
import type { V1Route } from "./v1-routing";

function tokenAccount(value: unknown, mint: string, owner: string) {
  const account = record(value);
  if (
    account.owner !== v1SolanaTokenProgram ||
    account.executable !== false ||
    !Array.isArray(account.data) ||
    account.data[1] !== "base64" ||
    typeof account.data[0] !== "string" ||
    account.data[0].length > 224
  )
    throw new Error("Unexpected SPL account program/encoding");
  const bytes = Buffer.from(account.data[0], "base64");
  if (
    bytes.length !== 165 ||
    bytes.toString("base64") !== account.data[0] ||
    encodeBase58(bytes.subarray(0, 32)) !== mint ||
    encodeBase58(bytes.subarray(32, 64)) !== owner ||
    bytes[108] !== 1
  )
    throw new Error("SPL account mint, owner or state differs");
  return bytes.readBigUInt64LE(64);
}
export async function prepareV1SolanaPayment(
  route: V1Route,
  source: string,
  transport?: typeof fetch,
) {
  if (route.network !== "solana") throw new Error("Expected Solana route");
  const network = networkIdentity("solana");
  if (network.assets.find((a) => a.id === "usdc")?.contract !== v1SolanaUsdc)
    throw new Error("Solana USDC identity changed");
  const clients = ["solana-public", "solana-publicnode"].map(
    (id) => new ReadOnlyRpc(id, transport),
  );
  const heads = await Promise.all(
    clients.map(async (rpc) => {
      const [genesis, latest] = await Promise.all([
        rpc.read("getGenesisHash", []),
        rpc.read("getLatestBlockhash", [{ commitment: "confirmed" }]),
      ]);
      if (genesis !== network.chainId) throw new Error("Solana source chain changed");
      const context = record(latest),
        value = record(context.value);
      unsigned(record(context.context).slot, 64);
      decodeBase58(String(value.blockhash), 32);
      return {
        blockhash: String(value.blockhash),
        lastValidBlockHeight: unsigned(value.lastValidBlockHeight, 64).toString(),
      };
    }),
  );
  const latest = heads[0],
    built = await v1SolanaTransfer({
      source,
      recipient: route.depositAddress,
      amount: route.input,
      ...latest,
    });
  const wire = Buffer.from(
      await built.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ),
    message = Buffer.from(built.transaction.serializeMessage()).toString("base64");
  const facts = await Promise.all(
    clients.map(async (rpc) => {
      const [valid, balance, from, to, rent, fee] = await Promise.all([
        rpc.read("isBlockhashValid", [latest.blockhash, { commitment: "confirmed" }]),
        rpc.read("getBalance", [source, { commitment: "finalized" }]),
        rpc.read("getAccountInfo", [
          built.sourceTokenAccount,
          { encoding: "base64", commitment: "finalized" },
        ]),
        rpc.read("getAccountInfo", [
          built.destinationTokenAccount,
          { encoding: "base64", commitment: "finalized" },
        ]),
        rpc.read("getMinimumBalanceForRentExemption", [165, { commitment: "finalized" }]),
        rpc.read("getFeeForMessage", [message, { commitment: "confirmed" }]),
      ]);
      if (record(valid).value !== true)
        throw new AppFailure(
          409,
          "The Solana blockhash is unavailable at both sources. Retry shortly.",
        );
      if (tokenAccount(record(from).value, v1SolanaUsdc, source) < BigInt(route.input))
        throw new AppFailure(422, "Your Solana wallet needs the quoted USDC amount.");
      const destination = record(to).value;
      if (destination !== null) tokenAccount(destination, v1SolanaUsdc, route.depositAddress);
      const feeAmount = unsigned(record(fee).value, 64),
        rentAmount = destination === null ? unsigned(rent, 64) : 0n;
      if (
        feeAmount === 0n ||
        feeAmount > 10000n ||
        feeAmount + rentAmount > 2500000n ||
        unsigned(record(balance).value, 64) < feeAmount + rentAmount
      )
        throw new AppFailure(
          422,
          "Solana gas or token-account rent exceeds the disclosed 0.0025-SOL limit, or your SOL balance is insufficient.",
        );
      const simulation = record(
        await rpc.read("simulateTransaction", [
          wire.toString("base64"),
          {
            encoding: "base64",
            commitment: "confirmed",
            sigVerify: false,
            replaceRecentBlockhash: false,
          },
        ]),
      );
      if (record(simulation.value).err !== null)
        throw new AppFailure(
          422,
          "The fixed Solana USDC transfer did not pass simulation. No payment was submitted.",
        );
      return { cost: feeAmount + rentAmount };
    }),
  );
  return {
    network: "solana" as const,
    source,
    recipient: route.depositAddress,
    inputAtomic: route.input,
    ...latest,
    transactionBase64: wire.toString("base64"),
    maximumGasLamports: facts
      .reduce((max, value) => (value.cost > max ? value.cost : max), 0n)
      .toString(),
    expiresAt: new Date(Math.min(Date.parse(route.expiresAt), Date.now() + 45000)).toISOString(),
  };
}
