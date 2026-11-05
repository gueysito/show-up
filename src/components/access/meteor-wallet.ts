import type { NearWalletBase, WalletManifest } from "@hot-labs/near-connect";
import type { WalletChallenge, WalletSignature } from "../../server/wallets/proof";

const revision = "ef1be35fc3712f2de60a7563aed543d78e73f763";
const permissions = {
  location: true,
  storage: true,
  allowsOpen: ["https://wallet.meteorwallet.app", "https://meteorwallet.app", "meteorwallet://"],
};
const meteorManifest: WalletManifest = {
  id: "meteor-wallet",
  platform: ["ios", "android"],
  name: "Meteor Wallet",
  description: "NEAR wallet",
  icon: "",
  website: "https://meteorwallet.app/",
  version: revision,
  type: "sandbox",
  executor: `https://raw.githubusercontent.com/Meteor-Wallet/meteor_wallet_sdk/${revision}/storage/meteor-near-connect-latest.js`,
  permissions,
  features: {
    mainnet: true,
    testnet: false,
    signInWithoutAddKey: true,
    signInAndSignMessage: true,
    signInWithFunctionCallKey: false,
    signMessage: true,
    signTransaction: false,
    signAndSendTransaction: true,
    signAndSendTransactions: false,
    signDelegateActions: false,
  },
};

let wallet: Promise<NearWalletBase> | undefined;
export function getMeteorWallet() {
  return (wallet ??= import("@hot-labs/near-connect").then(({ NearConnector, SandboxWallet }) => {
    const values = new Map<string, string>();
    const connector = new NearConnector({
      network: "mainnet",
      autoConnect: false,
      footerBranding: null,
      manifest: { version: "1.0.0", wallets: [] },
      storage: {
        async get(key) {
          return values.get(key) ?? null;
        },
        async set(key, value) {
          values.set(key, value);
        },
        async remove(key) {
          values.delete(key);
        },
      },
    });
    return new SandboxWallet(connector, meteorManifest);
  }));
}

export async function verifyMeteorWallet(challenge: WalletChallenge): Promise<WalletSignature> {
  if (
    challenge.network !== "near" ||
    challenge.nearTransport !== "meteor" ||
    challenge.origin !== window.location.origin ||
    challenge.expiresAt <= Date.now()
  )
    throw new Error("Invalid Meteor challenge");
  const signer = await getMeteorWallet();
  const accounts = await signer.signInAndSignMessage({
    network: "mainnet",
    messageParams: {
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: Uint8Array.from(atob(challenge.nonce), (byte) => byte.charCodeAt(0)),
    },
  });
  const proof = accounts.find((account) => account.accountId === challenge.address)?.signedMessage;
  if (
    proof?.accountId !== challenge.address ||
    typeof proof.publicKey !== "string" ||
    !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(proof.publicKey) ||
    typeof proof.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature)
  )
    throw new Error("Meteor did not return the expected signature");
  return { accountId: proof.accountId, publicKey: proof.publicKey, signature: proof.signature };
}
