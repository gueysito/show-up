import { getWallets } from "@wallet-standard/app";
import { encodeBase58 } from "../../server/protocol/encoding";

export type V1SolanaWallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
type Account = V1SolanaWallet["accounts"][number];
type Payment = {
  network: string;
  source: string;
  recipient: string;
  inputAtomic: string;
  blockhash: string;
  lastValidBlockHeight: string;
  transactionBase64: string;
  expiresAt: string;
  maximumGasLamports: string;
};
export function v1SolanaWallets() {
  return getWallets()
    .get()
    .filter(
      (wallet) =>
        wallet.chains.includes("solana:mainnet") &&
        "solana:signAndSendTransaction" in wallet.features,
    );
}
export const noV1SolanaWallets: readonly V1SolanaWallet[] = [];
let walletSnapshot: readonly V1SolanaWallet[] = noV1SolanaWallets;
export function readV1SolanaWallets() {
  const current = v1SolanaWallets();
  if (
    current.length !== walletSnapshot.length ||
    current.some((wallet, index) => wallet !== walletSnapshot[index])
  )
    walletSnapshot = current;
  return walletSnapshot;
}
export function subscribeV1SolanaWallets(callback: () => void) {
  const registry = getWallets(),
    off = registry.on("register", callback),
    removed = registry.on("unregister", callback);
  return () => {
    off();
    removed();
  };
}
export { getWallets };
export async function approveV1SolanaPayment(
  payment: Payment,
  reviewed: { inputAtomic: string; depositAddress: string },
  source: string,
  wallet: V1SolanaWallet,
  onRequest: () => void,
  now = Date.now(),
) {
  if (
    payment.network !== "solana" ||
    payment.source !== source ||
    payment.recipient !== reviewed.depositAddress ||
    payment.inputAtomic !== reviewed.inputAtomic ||
    !Number.isFinite(now) ||
    Date.parse(payment.expiresAt) <= now + 5000 ||
    !/^[0-9]{1,10}$/.test(payment.maximumGasLamports) ||
    BigInt(payment.maximumGasLamports) > 2500000n ||
    typeof payment.transactionBase64 !== "string" ||
    payment.transactionBase64.length > 1644
  )
    throw new Error("The Solana request differs from your reviewed quote or has expired.");
  const { v1SolanaTransfer } = await import("../../domain/v1-solana-transfer");
  const built = await v1SolanaTransfer({
    source,
    recipient: reviewed.depositAddress,
    amount: reviewed.inputAtomic,
    blockhash: payment.blockhash,
    lastValidBlockHeight: payment.lastValidBlockHeight,
  });
  const expected = await built.transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
    wire = Uint8Array.from(atob(payment.transactionBase64), (c) => c.charCodeAt(0));
  if (wire.length !== expected.length || !wire.every((byte, index) => byte === expected[index]))
    throw new Error("The Solana wallet message changed its amount, recipient or instructions.");
  const connect = wallet.features["standard:connect"] as
    { connect?: () => Promise<{ accounts: readonly Account[] }> } | undefined;
  if (typeof connect?.connect !== "function")
    throw new Error("Reconnect a Solana wallet that supports Wallet Standard.");
  const connected = await connect.connect(),
    account = connected.accounts.find(
      (account) => account.address === source && account.chains.includes("solana:mainnet"),
    );
  if (!account) throw new Error("Choose your verified source account in the Solana wallet.");
  const send = wallet.features["solana:signAndSendTransaction"] as
    | {
        supportedTransactionVersions?: readonly unknown[];
        signAndSendTransaction?: (input: {
          account: Account;
          chain: "solana:mainnet";
          transaction: Uint8Array;
          options: {
            commitment: "confirmed";
            preflightCommitment: "confirmed";
            skipPreflight: false;
            maxRetries: 0;
          };
        }) => Promise<readonly { signature: Uint8Array }[]>;
      }
    | undefined;
  if (
    typeof send?.signAndSendTransaction !== "function" ||
    !send.supportedTransactionVersions?.includes("legacy")
  )
    throw new Error("This wallet cannot send the reviewed Solana transaction.");
  onRequest();
  const outputs = await send.signAndSendTransaction({
    account,
    chain: "solana:mainnet",
    transaction: wire,
    options: {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      skipPreflight: false,
      maxRetries: 0,
    },
  });
  if (
    outputs.length !== 1 ||
    !(outputs[0].signature instanceof Uint8Array) ||
    outputs[0].signature.length !== 64
  )
    throw new Error("Check the original Solana wallet transaction before retrying.");
  return encodeBase58(outputs[0].signature);
}
