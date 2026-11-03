import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { decodeBase58 } from "../protocol/encoding";
import { networkIdentity, type Network } from "../protocol/manifest";

export const walletNetworks = ["near", "base", "ethereum", "solana"] as const;
export type WalletChallenge = {
  format: "showup.wallet.control.v1";
  id: string;
  network: Network;
  chainId: string;
  address: string;
  origin: string;
  message: string;
  nonce: string;
  recipient: string;
  callbackUrl: string;
  returnEventId?: string;
  issuedAt: number;
  expiresAt: number;
};
export type WalletSignature = { signature: string; publicKey?: string; accountId?: string };
export type WalletMessage = Pick<
  WalletChallenge,
  "network" | "address" | "message" | "nonce" | "recipient" | "callbackUrl"
>;

export function walletAddress(network: Network, value: string): string {
  if (!walletNetworks.includes(network) || typeof value !== "string" || value.length > 128)
    throw new Error("Unsupported wallet address");
  if (network === "base" || network === "ethereum") return getAddress(value).toLowerCase();
  if (network === "solana") {
    decodeBase58(value, 32);
    return value;
  }
  if (value.length < 2 || value.length > 64 || !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value))
    throw new Error("Invalid NEAR account");
  return value;
}

function message(input: Omit<WalletChallenge, "message">) {
  const family =
    input.network === "base" || input.network === "ethereum"
      ? "Ethereum"
      : input.network === "near"
        ? "NEAR"
        : "Solana";
  const displayed = family === "Ethereum" ? getAddress(input.address) : input.address;
  return [
    `${input.recipient} wants you to sign in with your ${family} account:`,
    displayed,
    "",
    "Verify wallet control for your signed-in Showup account. No transfer or spending approval is authorized.",
    "",
    `URI: ${input.origin}/account/wallets`,
    "Version: 1",
    `Chain ID: ${input.chainId}`,
    `Nonce: ${Buffer.from(input.nonce, "base64").toString("hex")}`,
    `Issued At: ${new Date(input.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(input.expiresAt).toISOString()}`,
    `Request ID: ${input.id}`,
  ].join("\n");
}

export function createWalletChallenge(
  origin: string,
  network: Network,
  address: string,
  now = Date.now(),
  returnEventId?: string,
): WalletChallenge {
  const url = new URL(origin);
  if (url.protocol !== "https:" || origin !== url.origin || !Number.isSafeInteger(now))
    throw new Error("Wallet verification requires a fixed HTTPS origin and valid time");
  if (
    returnEventId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(returnEventId)
  )
    throw new Error("Invalid wallet event return");
  const id = randomUUID();
  const challenge: Omit<WalletChallenge, "message"> = {
    format: "showup.wallet.control.v1",
    id,
    network,
    chainId: networkIdentity(network).chainId,
    address: walletAddress(network, address),
    origin,
    nonce: randomBytes(32).toString("base64"),
    recipient: url.host,
    callbackUrl: `${origin}/account/wallets?challenge=${id}${returnEventId ? `&event=${returnEventId}` : ""}`,
    ...(returnEventId && { returnEventId }),
    issuedAt: now,
    expiresAt: now + 300_000,
  };
  return { ...challenge, message: message(challenge) };
}

function base64(value: string, size: number) {
  if (typeof value !== "string" || value.length > size * 2) throw new Error("Signature bounds");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== size || bytes.toString("base64") !== value)
    throw new Error("Noncanonical signature/nonce");
  return bytes;
}

function borshString(value: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 8192) throw new Error("Wallet message bounds");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

// NEP-413: little-endian u32 tag, string, fixed 32-byte nonce, string,
// Option<string> callback URL. Sign SHA-256 of these bytes, never a transaction.
export function nearMessageDigest(
  challenge: Pick<WalletMessage, "message" | "nonce" | "recipient" | "callbackUrl">,
): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  return createHash("sha256")
    .update(
      Buffer.concat([
        tag,
        borshString(challenge.message),
        base64(challenge.nonce, 32),
        borshString(challenge.recipient),
        Buffer.from([1]),
        borshString(challenge.callbackUrl),
      ]),
    )
    .digest();
}

// Cryptographic check only. NEAR ALSO requires a current finalized FullAccess
// membership check; the service must not persist a verified binding without it.
export function verifyWalletSignature(
  challenge: WalletChallenge,
  proof: WalletSignature,
  origin: string,
  now = Date.now(),
): boolean {
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      origin !== url.origin ||
      challenge.format !== "showup.wallet.control.v1" ||
      challenge.origin !== origin ||
      challenge.recipient !== url.host ||
      challenge.chainId !== networkIdentity(challenge.network).chainId ||
      challenge.address !== walletAddress(challenge.network, challenge.address) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(challenge.id) ||
      (challenge.returnEventId !== undefined &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          challenge.returnEventId,
        )) ||
      challenge.callbackUrl !==
        `${origin}/account/wallets?challenge=${challenge.id}${challenge.returnEventId ? `&event=${challenge.returnEventId}` : ""}` ||
      ![now, challenge.issuedAt, challenge.expiresAt].every(Number.isSafeInteger) ||
      challenge.expiresAt - challenge.issuedAt !== 300_000 ||
      now < challenge.issuedAt ||
      now >= challenge.expiresAt ||
      challenge.message !== message(challenge)
    )
      return false;
    base64(challenge.nonce, 32);
    return verifyWalletMessageSignature(challenge, proof);
  } catch {
    return false;
  }
}

// Signature primitive only. Callers must reconstruct their own purpose-specific
// message and enforce origin, nonce, owner, expiry and NEAR FullAccess membership.
export function verifyWalletMessageSignature(
  challenge: WalletMessage,
  proof: WalletSignature,
): boolean {
  try {
    if (
      challenge.address !== walletAddress(challenge.network, challenge.address) ||
      typeof challenge.message !== "string" ||
      Buffer.byteLength(challenge.message) > 8192
    )
      return false;
    const fields = Object.keys(proof).sort();
    if (challenge.network === "base" || challenge.network === "ethereum") {
      if (
        fields.join() !== "signature" ||
        !/^0x[0-9a-fA-F]{128}(?:[0-9a-fA-F]{2})?$/.test(proof.signature)
      )
        return false;
      return verifyMessage(challenge.message, proof.signature).toLowerCase() === challenge.address;
    }
    let key: Buffer;
    let payload: Buffer;
    if (challenge.network === "solana") {
      if (fields.join() !== "signature") return false;
      key = decodeBase58(challenge.address, 32);
      payload = Buffer.from(challenge.message, "utf8");
    } else {
      if (
        fields.join() !== "accountId,publicKey,signature" ||
        proof.accountId !== challenge.address ||
        typeof proof.publicKey !== "string" ||
        !proof.publicKey.startsWith("ed25519:")
      )
        return false;
      key = decodeBase58(proof.publicKey.slice("ed25519:".length), 32);
      payload = nearMessageDigest(challenge);
    }
    const publicKey = createPublicKey({
      format: "jwk",
      key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") },
    });
    return verify(null, payload, publicKey, base64(proof.signature, 64));
  } catch {
    return false;
  }
}
