import { getWallets } from "@wallet-standard/app";

type Wallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
type Account = Wallet["accounts"][number];
type InjectedWallet = {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signMessage(message: Uint8Array, format: "utf8"): Promise<{ signature: Uint8Array }>;
};
type MessageOutput = {
  signedMessage: Uint8Array;
  signature: Uint8Array;
  signatureType?: "ed25519";
};

export async function connectSolanaWallet() {
  const wallets = getWallets()
    .get()
    .filter(
      (wallet) =>
        wallet.name === "Phantom" &&
        wallet.chains.includes("solana:mainnet") &&
        "standard:connect" in wallet.features &&
        "solana:signMessage" in wallet.features,
    );
  if (wallets.length === 1) {
    const wallet = wallets[0];
    const connect = wallet.features["standard:connect"] as {
      connect(): Promise<{ accounts: readonly Account[] }>;
    };
    const signer = wallet.features["solana:signMessage"] as {
      signMessage(input: {
        account: Account;
        message: Uint8Array;
      }): Promise<readonly MessageOutput[]>;
    };
    const { accounts } = await connect.connect();
    const account = accounts.find(
      (candidate) =>
        candidate.chains.includes("solana:mainnet") &&
        candidate.features.includes("solana:signMessage"),
    );
    if (!account) throw new Error("No Solana signing account");
    return {
      address: account.address,
      async signMessage(message: Uint8Array) {
        // Only submit a proof of the exact Showup challenge, even if the wallet
        // supports returning a different message format.
        const outputs = await signer.signMessage({ account, message: message.slice() });
        const output = outputs[0];
        if (
          outputs.length !== 1 ||
          !(output?.signedMessage instanceof Uint8Array) ||
          (output.signatureType !== undefined && output.signatureType !== "ed25519") ||
          output.signedMessage.length !== message.length ||
          !output.signedMessage.every((byte, i) => byte === message[i])
        )
          throw new Error("Solana wallet returned a different message");
        return output.signature;
      },
    };
  }

  // Older Phantom browsers can still expose a legacy provider.
  const injected = window as unknown as {
    phantom?: { solana?: InjectedWallet };
    solana?: InjectedWallet & { isPhantom?: boolean };
  };
  const wallet = injected.phantom?.solana ?? (injected.solana?.isPhantom ? injected.solana : null);
  if (!wallet) return null;
  return {
    address: (await wallet.connect()).publicKey.toString(),
    async signMessage(message: Uint8Array) {
      return (await wallet.signMessage(message, "utf8")).signature;
    },
  };
}
