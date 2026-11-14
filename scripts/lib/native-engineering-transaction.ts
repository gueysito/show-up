import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { decodeBase58, encodeBase58 } from "../../src/server/protocol/encoding";
import { walletAddress } from "../../src/server/wallets/proof";
import { mainnetAccount } from "../near-mainnet-account-plan";
import { canonicalJson } from "../../src/server/protocol/canonical";
import { v1Deployment } from "../../src/server/protocol/v1-escrow";
import { v1RouteAccount, v1Intents } from "../../src/server/protocol/v1-intents";

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
export function v1StorageRegistrationTransaction(
  input: Parameters<typeof v1PrizeFundingTransaction>[0],
) {
  if (input.amount !== "0") throw new Error("USDC receiving registration does not transfer USDC");
  return v1WalletCall(input, {
    methodName: "storage_deposit",
    args: { account_id: input.signer, registration_only: true },
    gas: "30000000000000",
    deposit: "1250000000000000000000",
  });
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
  return v1WalletCall(input, {
    methodName: "ft_transfer_call",
    args: {
      receiver_id: v1Deployment.account,
      amount: input.amount,
      msg: `${purpose}:${input.eventId}`,
    },
    gas: "100000000000000",
    deposit: "1",
  });
}

function v1WalletCall(
  input: Parameters<typeof v1PrizeFundingTransaction>[0],
  params: {
    methodName: "storage_deposit" | "ft_transfer_call";
    args: Record<string, string | boolean>;
    gas: string;
    deposit: string;
  },
) {
  const tx = encodeTransaction(
    {
      ...input,
      receiver: v1Deployment.token,
      actions: [
        {
          kind: "call",
          method: params.methodName,
          gas: params.gas,
          deposit: params.deposit,
          args: Buffer.from(canonicalJson(params.args)),
        },
      ],
    },
    new Set([input.signer, v1Deployment.token]),
  );
  return {
    ...tx,
    walletTransaction: {
      signerId: input.signer,
      receiverId: v1Deployment.token,
      actions: [{ type: "FunctionCall" as const, params }],
    },
  };
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

export function v1IntentsAccountTransaction(input: {
  registrationId: string;
  nonce: string;
  blockHash: string;
}) {
  const receiver = v1RouteAccount(input.registrationId);
  return encodeTransaction(
    {
      signer: v1Deployment.account,
      receiver,
      publicKey: v1Deployment.publicKey,
      nonce: input.nonce,
      blockHash: input.blockHash,
      actions: [
        { kind: "create" },
        { kind: "transfer", deposit: v1Intents.accountFunding },
        { kind: "add_key", publicKey: v1Deployment.publicKey },
      ],
    },
    new Set([v1Deployment.account, receiver]),
  );
}
export function v1IntentsWithdrawalTransaction(input: {
  registrationId: string;
  nonce: string;
  blockHash: string;
  amount: string;
}) {
  if (!/^[1-9][0-9]*$/.test(input.amount) || BigInt(input.amount) > 100000000n)
    throw new Error("Intents withdrawal amount outside V1 bounds");
  const signer = v1RouteAccount(input.registrationId);
  return encodeTransaction(
    {
      signer,
      receiver: v1Intents.account,
      publicKey: v1Deployment.publicKey,
      nonce: input.nonce,
      blockHash: input.blockHash,
      actions: [
        {
          kind: "call",
          method: "ft_withdraw",
          args: Buffer.from(
            canonicalJson({
              token: v1Deployment.token,
              receiver_id: v1Deployment.account,
              amount: input.amount,
              memo: null,
              msg: `deposit:${input.registrationId}`,
            }),
          ),
          gas: "100000000000000",
          deposit: "1",
        },
      ],
    },
    new Set([signer, v1Intents.account]),
  );
}
export function signV1IntentsTransaction(
  image: ReturnType<typeof v1IntentsAccountTransaction>,
  key: NativeKey,
) {
  if (key.publicKey !== v1Deployment.publicKey) throw new Error("Intents signer mismatch");
  return {
    hash: image.hash,
    signedBase64: Buffer.concat([image.bytes, Buffer.from([0]), key.sign(image.digest)]).toString(
      "base64",
    ),
  };
}

// NEP-366: the controller pays gas while the isolated account remains the
// predecessor of ft_withdraw. Both signatures bind the fixed token/registration.
// This does not add delegated actions to the ordinary mainnet action envelope.
export function v1SponsoredIntentsWithdrawal(
  input: {
    registrationId: string;
    amount: string;
    nonce: string;
    senderNonce: string;
    blockHash: string;
    blockHeight: string;
  },
  key: NativeKey,
) {
  if (key.publicKey !== v1Deployment.publicKey) throw new Error("Intents signer mismatch");
  if (!/^[1-9][0-9]*$/.test(input.amount) || BigInt(input.amount) > 100000000n)
    throw new Error("Intents withdrawal amount outside V1 bounds");
  const sender = v1RouteAccount(input.registrationId),
    delegate = Buffer.concat([
      nativeString(sender),
      nativeString(v1Intents.account),
      nativeInteger("1", 4),
      action({
        kind: "call",
        method: "ft_withdraw",
        args: Buffer.from(
          canonicalJson({
            token: v1Deployment.token,
            receiver_id: v1Deployment.account,
            amount: input.amount,
            memo: null,
            msg: `deposit:${input.registrationId}`,
          }),
        ),
        gas: "100000000000000",
        deposit: "1",
      }),
      nativeInteger(input.senderNonce, 8),
      nativeInteger((BigInt(input.blockHeight) + 240n).toString(), 8),
      publicKey(key.publicKey),
    ]),
    delegateDigest = createHash("sha256")
      .update(Buffer.concat([nativeInteger(String(2 ** 30 + 366), 4), delegate]))
      .digest(),
    signature = key.sign(delegateDigest);
  if (signature.length !== 64) throw new Error("Invalid delegate signature");
  const bytes = Buffer.concat([
      nativeString(v1Deployment.owner),
      publicKey(key.publicKey),
      nativeInteger(input.nonce, 8),
      nativeString(sender),
      decodeBase58(input.blockHash, 32),
      nativeInteger("1", 4),
      Buffer.from([8]),
      delegate,
      Buffer.from([0]),
      signature,
    ]),
    digest = createHash("sha256").update(bytes).digest();
  return { bytes, digest, hash: encodeBase58(digest), delegateDigest };
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

// Fixed project demo accounts reuse the already backed-up owner key. This does
// not relax the ordinary V1 envelope's ban on account/key creation.
export const v1DemoAccounts = [
  "attendee-a.showup-dev-14989f.near",
  "attendee-b.showup-dev-14989f.near",
] as const;
export function v1DemoReserveTransaction(input: {
  account: string;
  nonce: string;
  blockHash: string;
}) {
  if (!(v1DemoAccounts as readonly string[]).includes(input.account))
    throw new Error("Outside the fixed demo gas accounts");
  return encodeTransaction(
    {
      signer: input.account,
      receiver: v1Deployment.account,
      publicKey: v1Deployment.publicKey,
      nonce: input.nonce,
      blockHash: input.blockHash,
      actions: [{ kind: "transfer", deposit: "100000000000000000000000" }],
    },
    new Set([input.account, v1Deployment.account]),
  );
}
export function v1DemoSetupTransaction(input: {
  account: string;
  nonce: string;
  blockHash: string;
}) {
  if (!(v1DemoAccounts as readonly string[]).includes(input.account))
    throw new Error("Outside the fixed V1 demo accounts");
  return encodeTransaction(
    {
      signer: v1Deployment.account,
      receiver: input.account,
      publicKey: v1Deployment.publicKey,
      nonce: input.nonce,
      blockHash: input.blockHash,
      actions: [
        { kind: "create" },
        { kind: "transfer", deposit: "165000000000000000000000" },
        { kind: "add_key", publicKey: v1Deployment.publicKey },
      ],
    },
    new Set([v1Deployment.account, ...v1DemoAccounts]),
  );
}
export function v1DemoReturnTransaction(input: {
  account: string;
  nonce: string;
  blockHash: string;
  amount: string;
}) {
  if (
    !(v1DemoAccounts as readonly string[]).includes(input.account) ||
    !/^[1-9][0-9]*$/.test(input.amount) ||
    BigInt(input.amount) > 3_000_000n
  )
    throw new Error("Outside the fixed V1 demo return envelope");
  return encodeTransaction(
    {
      signer: input.account,
      receiver: v1Deployment.token,
      publicKey: v1Deployment.publicKey,
      nonce: input.nonce,
      blockHash: input.blockHash,
      actions: [
        {
          kind: "call",
          method: "ft_transfer",
          args: Buffer.from(
            canonicalJson({ receiver_id: v1Deployment.owner, amount: input.amount }),
          ),
          gas: "30000000000000",
          deposit: "1",
        },
      ],
    },
    new Set([...v1DemoAccounts, v1Deployment.token]),
  );
}
