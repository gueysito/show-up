import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeBase58 } from "../../src/server/protocol/encoding";
import { record } from "../../src/server/protocol/quote-signature";
import { v1Deployment } from "../../src/server/protocol/v1-escrow";
import { nativeKey } from "./native-engineering-transaction";

function parseSignerKey(value: string) {
  if (!value.startsWith("ed25519:")) throw new Error("Signer key format");
  const secret = decodeBase58(value.slice(8), 64);
  try {
    const key = nativeKey(secret.subarray(0, 32));
    if (key.publicKey !== v1Deployment.publicKey || !key.publicBytes.equals(secret.subarray(32)))
      throw new Error("Signer mismatch");
    return key;
  } finally {
    secret.fill(0);
  }
}

// The legacy filename/network label is unchanged. On-chain key membership is
// verified independently before this isolated owner-only loader is called.
export async function loadV1MainnetKey() {
  if (process.env.SHOWUP_ENV === "production")
    return parseSignerKey(process.env.SHOWUP_V1_SIGNER_KEY ?? "");

  const file = await open(
    join(homedir(), ".showup-test-wallets/near-testnet.json"),
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
      throw new Error("Signer file permissions");
    let wallet: Record<string, unknown>;
    try {
      wallet = record(JSON.parse(await file.readFile("utf8")));
    } catch {
      throw new Error("Signer file format");
    }
    if (
      Object.keys(wallet).sort().join() !== "account_id,network,private_key,public_key" ||
      wallet.account_id !== v1Deployment.owner ||
      wallet.network !== "testnet" ||
      wallet.public_key !== v1Deployment.publicKey ||
      typeof wallet.private_key !== "string"
    )
      throw new Error("Signer metadata");
    try {
      return parseSignerKey(wallet.private_key);
    } finally {
      wallet.private_key = undefined;
    }
  } finally {
    await file.close();
  }
}
