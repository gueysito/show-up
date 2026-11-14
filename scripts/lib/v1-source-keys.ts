import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { Keypair } from "@solana/web3.js";

export const v1EvmSource = "0xaE74d31CB01A0F11cDeCe5a374aC5539DD20d77a";
export const v1SolanaSource = "BTXsA7ov3DCLd4yNyK1JpUokk1byw8mSgpGQ6FdGKjKd";
async function privateFile(name: "evm-testnet.json" | "solana-devnet.json") {
  const file = await open(
    join(homedir(), ".showup-test-wallets", name),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 4096
    )
      throw new Error("Source signer file permissions");
    try {
      return JSON.parse(await file.readFile("utf8")) as unknown;
    } catch {
      throw new Error("Source signer file format");
    }
  } finally {
    await file.close();
  }
}
// Existing test-labelled files contain the backed-up keys funded by the owner
// on mainnet. They remain outside the repository; no key is generated or edited.
export async function loadV1EvmSource() {
  const value = await privateFile("evm-testnet.json");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("EVM signer metadata");
  const wallet = value as Record<string, unknown>;
  if (
    Object.keys(wallet).sort().join() !== "networks,private_key,public_key_uncompressed" ||
    !Array.isArray(wallet.networks) ||
    wallet.networks.length !== 2 ||
    wallet.networks.some((n) => typeof n !== "string" || n.length > 64) ||
    typeof wallet.private_key !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(wallet.private_key) ||
    typeof wallet.public_key_uncompressed !== "string" ||
    !/^0x04[0-9a-fA-F]{128}$/.test(wallet.public_key_uncompressed)
  )
    throw new Error("EVM signer metadata");
  try {
    const signer = new Wallet(wallet.private_key);
    if (
      signer.address !== v1EvmSource ||
      signer.signingKey.publicKey.toLowerCase() !== wallet.public_key_uncompressed.toLowerCase()
    )
      throw new Error("EVM signer identity");
    return signer;
  } catch {
    throw new Error("EVM source signer could not be verified");
  } finally {
    wallet.private_key = undefined;
  }
}
export async function loadV1SolanaSource() {
  const value = await privateFile("solana-devnet.json");
  if (
    !Array.isArray(value) ||
    value.length !== 64 ||
    value.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
  )
    throw new Error("Solana signer file format");
  const secret = Uint8Array.from(value);
  try {
    const signer = await Keypair.fromSecretKey(secret);
    if (signer.publicKey.toBase58() !== v1SolanaSource) throw new Error("Solana signer identity");
    return signer;
  } catch {
    throw new Error("Solana source signer could not be verified");
  } finally {
    secret.fill(0);
    value.fill(0);
  }
}
