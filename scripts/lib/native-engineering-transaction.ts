import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { decodeBase58, encodeBase58 } from "../../src/server/protocol/encoding";
import { walletAddress } from "../../src/server/wallets/proof";
import { mainnetAccount } from "../near-mainnet-account-plan";
import { canonicalJson } from "../../src/server/protocol/canonical";
import { v1Deployment } from "../../src/server/protocol/v1-escrow";

export type NativeAction =
  | { kind: "create" }
  | { kind: "deploy"; code: Buffer }
  | { kind: "call"; method: string; args: Buffer; gas: string; deposit: string }
  | { kind: "transfer"; deposit: string }
  | { kind: "add_key"; publicKey: string };

export function nativeKey(seed: Buffer) {
  if (seed.length !== 32) throw new Error("An Ed25519 seed is required");
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicBytes = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return {
    publicKey: `ed25519:${encodeBase58(publicBytes)}`,
    publicBytes,
    sign: (message: Uint8Array) => sign(null, message, key),
  };
}
export type NativeKey = ReturnType<typeof nativeKey>;

export function nativeInteger(value: string, bytes: number) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid native integer");
  let integer = BigInt(value);
  if (integer >= 1n << BigInt(bytes * 8)) throw new Error("Native integer overflow");
  const encoded = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) {
    encoded[i] = Number(integer & 255n);
    integer >>= 8n;
  }
  return encoded;
}
export function nativeBytes(value: Uint8Array) {
  if (value.length > 1_400_000) throw new Error("Native image exceeds the reviewed size");
  return Buffer.concat([nativeInteger(String(value.length), 4), value]);
}
export const nativeString = (value: string) => nativeBytes(Buffer.from(value));
function publicKey(value: string) {
  if (!value.startsWith("ed25519:")) throw new Error("Only Ed25519 keys are supported");
  return Buffer.concat([Buffer.from([0]), decodeBase58(value.slice(8), 32)]);
}
function account(value: string, allowed?: ReadonlySet<string>) {
  if (
    walletAddress("near", value) !== value ||
    (allowed ? !allowed.has(value) : !value.endsWith(".testnet") && !/^[0-9a-f]{64}$/.test(value))
  )
    throw new Error(
      allowed
        ? "Outside the approved V1 mainnet accounts"
        : "Only testnet names and implicit account identifiers are supported",
    );
  return nativeString(value);
}
function deposit(value: string) {
  if (BigInt(value) > 20n * 10n ** 24n) throw new Error("Native transfer exceeds the reviewed cap");
  return nativeInteger(value, 16);
}
function action(value: NativeAction): Buffer {
  switch (value.kind) {
    case "create":
      return Buffer.from([0]);
    case "deploy":
      return Buffer.concat([Buffer.from([1]), nativeBytes(value.code)]);
    case "call":
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(value.method) || BigInt(value.gas) > 300_000_000_000_000n)
        throw new Error("Native call exceeds the reviewed shape");
      return Buffer.concat([
        Buffer.from([2]),
        nativeString(value.method),
        nativeBytes(value.args),
        nativeInteger(value.gas, 8),
        deposit(value.deposit),
      ]);
    case "transfer":
      return Buffer.concat([Buffer.from([3]), deposit(value.deposit)]);
    case "add_key":
      return Buffer.concat([
        Buffer.from([5]),
        publicKey(value.publicKey),
        Buffer.alloc(8),
        Buffer.from([1]),
      ]);
  }
}

// Native V0 Borsh bytes have no version prefix. Persist the signed result before
// the only broadcast attempt; a fresh nonce must never replace an unknown image.
export type NativeTransactionInput = {
  signer: string;
  receiver: string;
  publicKey: string;
  nonce: string;
  blockHash: string;
  actions: NativeAction[];
};
function encodeTransaction(input: NativeTransactionInput, allowed?: ReadonlySet<string>) {
  if (!input.actions.length || input.actions.length > 4)
    throw new Error("Unexpected native action count");
  const bytes = Buffer.concat([
    account(input.signer, allowed),
    publicKey(input.publicKey),
    nativeInteger(input.nonce, 8),
    account(input.receiver, allowed),
    decodeBase58(input.blockHash, 32),
    nativeInteger(String(input.actions.length), 4),
    ...input.actions.map(action),
  ]);
  const digest = createHash("sha256").update(bytes).digest();
  return { bytes, digest, hash: encodeBase58(digest) };
}

export function nativeTransaction(input: NativeTransactionInput) {
  return encodeTransaction(input);
}

// Public unsigned wallet request. The caller cannot select the token, recipient,
// method, gas, attached NEAR or message prefix. No project signing key is used.
export function v1PrizeFundingTransaction(input: {
  signer: string;
  publicKey: string;
  nonce: string;
  blockHash: string;
  eventId: string;
  amount: string;
}) {
  return v1TokenFundingTransaction(input, "prize");
}

export function v1DepositFundingTransaction(
  input: Parameters<typeof v1PrizeFundingTransaction>[0],
) {
  return v1TokenFundingTransaction(input, "deposit");
}

function v1TokenFundingTransaction(
  input: Parameters<typeof v1PrizeFundingTransaction>[0],
  purpose: "prize" | "deposit",
) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.eventId) ||
    !/^[1-9][0-9]*$/.test(input.amount) ||
    BigInt(input.amount) > 100_000_000n
  )
    throw new Error("Invalid fixed prize funding request");
  return encodeTransaction(
    {
      ...input,
      receiver: v1Deployment.token,
      actions: [
        {
          kind: "call",
          method: "ft_transfer_call",
          gas: "100000000000000",
          deposit: "1",
          args: Buffer.from(
            canonicalJson({
              receiver_id: v1Deployment.account,
              amount: input.amount,
              msg: `${purpose}:${input.eventId}`,
            }),
          ),
        },
      ],
    },
    new Set([input.signer, v1Deployment.token]),
  );
}

// Explicit V1 mainnet policy. Legacy engineering callers retain their testnet guard.
export function v1MainnetTransaction(input: NativeTransactionInput) {
  if (
    !([mainnetAccount.implicit, mainnetAccount.proposedName] as string[]).includes(input.signer) ||
    input.publicKey !== mainnetAccount.publicKey ||
    input.actions.some((value) => value.kind === "create" || value.kind === "add_key") ||
    input.actions.reduce(
      (gas, value) => gas + (value.kind === "call" ? BigInt(value.gas) : 0n),
      0n,
    ) > 150_000_000_000_000n ||
    input.actions.reduce(
      (sum, value) => sum + ("deposit" in value ? BigInt(value.deposit) : 0n),
      0n,
    ) > 3_730_000_000_000_000_000_000_000n
  )
    throw new Error("Outside the approved V1 mainnet envelope");
  return encodeTransaction(
    input,
    new Set([
      mainnetAccount.implicit,
      mainnetAccount.proposedName,
      mainnetAccount.factory,
      "wrap.near",
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    ]),
  );
}

export function signV1MainnetTransaction(
  input: Omit<NativeTransactionInput, "publicKey">,
  key: NativeKey,
) {
  const image = v1MainnetTransaction({ ...input, publicKey: key.publicKey });
  return {
    hash: image.hash,
    signedBase64: Buffer.concat([image.bytes, Buffer.from([0]), key.sign(image.digest)]).toString(
      "base64",
    ),
  };
}
export function signNativeTransaction(
  input: Omit<Parameters<typeof nativeTransaction>[0], "publicKey">,
  key: NativeKey,
) {
  const image = nativeTransaction({ ...input, publicKey: key.publicKey });
  const signature = key.sign(image.digest);
  return {
    hash: image.hash,
    signedBase64: Buffer.concat([image.bytes, Buffer.from([0]), signature]).toString("base64"),
  };
}
