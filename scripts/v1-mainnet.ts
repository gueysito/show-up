// Local V1 operator, under AGENTS.md's mainnet budget. No .env or remote signer.
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import { decodeBase58, encodeBase58 } from "../src/server/protocol/encoding";
import { compareFinalizedHeads } from "../src/server/protocol/finalized-heads";
import {
  NearAccountNotFound,
  RpcCooldown,
  ReadOnlyRpc,
  parseRpcJson,
  unsigned,
} from "../src/server/protocol/rpc";
import { record } from "../src/server/protocol/quote-signature";
import { mainnetAccount, prepareMainnetAccountPlan } from "./near-mainnet-account-plan";
import {
  nativeKey,
  signV1MainnetTransaction,
  v1MainnetTransaction,
  type NativeAction,
} from "./lib/native-engineering-transaction";

const owner = mainnetAccount.implicit,
  escrow = mainnetAccount.proposedName;
const token = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const wasmHash = "3efb9c95ab79e6d996694a99da4a762f5896a39676063c7c49589a0ecde8b063";
const codeHash = encodeBase58(Buffer.from(wasmHash, "hex"));
const writeOrigin = "https://rpc.mainnet.fastnear.com";
const funding = "3712070000000000000000000",
  storage = "1250000000000000000000";
const directory = fileURLToPath(new URL("../contracts/.cache/v1-mainnet/", import.meta.url));
const steps = [
  "create",
  "fund",
  "deploy",
  "storage",
  "event",
  "publish",
  "register",
  "deposit",
  "cancel",
  "withdraw",
] as const;
type Step = (typeof steps)[number];
type Context = {
  event: string;
  registration: string;
  start: number;
  baseline: string;
  artifact: string;
};
type Account = { amount: string; code: string; nonce: string };
type Facts = {
  block: string;
  height: string;
  root: Account;
  escrow: Account | null;
  rootUsdc: string;
  escrowUsdc: string;
  storage: unknown;
  event: Record<string, unknown> | null;
  registration: Record<string, unknown> | null;
  claim: Record<string, unknown> | null;
  accounting: Record<string, unknown> | null;
};
type Receipt = {
  step: Step;
  semantic: string;
  signer: string;
  hash: string;
  signedBase64: string;
  phase: "prepared" | "submitted" | "final" | "verified";
  tokensBurnt?: string;
  after?: Facts;
  validUntilMs: number;
  receiptHeight?: string;
};
const bytes = (value: unknown) => Buffer.from(canonicalJson(value));
const call = (
  method: string,
  args: object,
  gas = "30000000000000",
  deposit = "0",
): NativeAction => ({ kind: "call", method, args: bytes(args), gas, deposit });
let stage = "arguments";

// No user-selected methods, token, beneficiary, artifact or amount.
export function v1MainnetStep(step: Step, context: Context, code: Buffer) {
  const registration = {
    id: context.registration,
    event: context.event,
    sender: owner,
    payout: owner,
    ethereum: null,
  };
  const actions: Record<Step, NativeAction[]> = {
    create: [
      call(
        "create_account",
        { new_account_id: escrow, new_public_key: mainnetAccount.publicKey },
        "100000000000000",
      ),
    ],
    fund: [{ kind: "transfer", deposit: funding }],
    deploy: [
      { kind: "deploy", code },
      call("new", { owner, token, signer: "v1.signer" }, "50000000000000"),
    ],
    storage: [
      call(
        "storage_deposit",
        { account_id: escrow, registration_only: true },
        "30000000000000",
        storage,
      ),
    ],
    event: [
      call("create_event", {
        terms: {
          id: context.event,
          title: "Mainnet escrow verification",
          start_ms: context.start,
          end_ms: context.start + 3_600_000,
          capacity: 1,
          deposit: "1000000",
          prize: "0",
          sponsor: escrow,
          nft: null,
        },
      }),
    ],
    publish: [call("publish", { event: context.event })],
    register: [call("register", registration)],
    deposit: [
      call(
        "ft_transfer_call",
        { receiver_id: escrow, amount: "1000000", msg: `deposit:${context.registration}` },
        "100000000000000",
        "1",
      ),
    ],
    cancel: [call("cancel", { event: context.event })],
    withdraw: [call("withdraw", { claim: context.registration }, "100000000000000")],
  };
  return {
    signer: step === "deploy" ? escrow : owner,
    receiver:
      step === "create" ? "near" : step === "storage" || step === "deposit" ? token : escrow,
    actions: actions[step],
  };
}

function retryAt(response: Response, now: number) {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const until = /^\d{1,8}$/.test(header) ? now + Number(header) * 1000 : Date.parse(header);
  return Number.isSafeInteger(until) && until >= now ? until : undefined;
}
export function v1RpcPacer(
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<unknown> = (milliseconds, signal) =>
    pause(milliseconds, undefined, { signal }),
  now: () => number = Date.now,
) {
  const pending = new Map<string, Promise<unknown>>(),
    next = new Map<string, number>();
  return {
    cooldown(origin: string, until: number) {
      next.set(origin, Math.max(next.get(origin) ?? 0, until + 1000));
    },
    async run<T>(origin: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const previous = pending.get(origin) ?? Promise.resolve();
      const admission = previous
        .catch(() => {})
        .then(async () => {
          signal?.throwIfAborted();
          if (!next.has(origin)) next.set(origin, now() + 1000);
          while (next.get(origin)! > now()) {
            await wait(next.get(origin)! - now(), signal);
            signal?.throwIfAborted();
          }
          signal?.throwIfAborted();
          next.set(origin, now() + 1000);
        });
      pending.set(
        origin,
        admission.then(
          () => undefined,
          () => undefined,
        ),
      );
      return admission.then(operation);
    },
  };
}
const pacer = v1RpcPacer();
async function transport(input: string | URL | Request, init?: RequestInit) {
  let response = await fetch(input, { ...init, redirect: "error" });
  if (response.status === 429) {
    const origin = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ).origin;
    const until = retryAt(response, Date.now()) ?? Date.now() + 10_000;
    pacer.cooldown(origin, until);
    if (!response.headers.has("retry-after")) {
      const headers = new Headers(response.headers);
      headers.set("retry-after", "10");
      response = new Response(response.body, {
        status: 429,
        statusText: response.statusText,
        headers,
      });
    }
  }
  if (response.ok && response.status !== 200) throw new Error("RPC HTTP status");
  return response;
}
class V1ReadOnlyRpc extends ReadOnlyRpc {
  constructor(id: string) {
    super(id, transport);
  }
  override read(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return pacer.run(this.endpoint.origin, () => super.read(method, params, signal), signal);
  }
}

export async function v1ReadWithCooldown<T>(
  read: () => Promise<T>,
  wait: (milliseconds: number) => Promise<unknown> = pause,
  now: () => number = Date.now,
) {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof RpcCooldown) || error.retryAt > now() + 60_000) throw error;
    console.log(
      JSON.stringify({ status: "waiting_for_rpc_read_cooldown", retryAt: error.retryAt }),
    );
    await wait(Math.max(0, error.retryAt - now()) + 1000);
    return read();
  }
}
async function writeRpc(method: "send_tx" | "tx", params: object) {
  return pacer.run(writeOrigin, async () => {
    const response = await transport(writeOrigin, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "showup-v1", method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 429 && method === "tx") {
      const until = retryAt(response, Date.now());
      if (until !== undefined) throw new RpcCooldown(until);
    }
    if (response.status !== 200) throw new Error("Original transaction needs reconciliation");
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("RPC size");
    const value = record(parseRpcJson(text));
    if (value.error || value.id !== "showup-v1") throw new Error("Reconcile original image");
    return record(value.result);
  });
}

// A prepared image needs explicit execution; submitted images only reconcile.
export async function v1SubmitOriginal(
  image: Receipt,
  execute: boolean,
  persist: () => Promise<void>,
  rpc: typeof writeRpc = writeRpc,
) {
  const first = image.phase === "prepared";
  if (first && !execute) return null;
  if (
    first &&
    (!Number.isSafeInteger(image.validUntilMs) || Date.now() + 30_000 >= image.validUntilMs)
  )
    throw new Error("Prepared image expired; reconcile before replacement");
  if (first) {
    image.phase = "submitted";
    await persist();
  }
  return rpc(
    first ? "send_tx" : "tx",
    first
      ? { signed_tx_base64: image.signedBase64, wait_until: "FINAL" }
      : { tx_hash: image.hash, sender_account_id: image.signer, wait_until: "FINAL" },
  );
}

export async function v1WaitForState<T extends { height: string }>(
  minimum: bigint,
  read: () => Promise<T>,
  wait: (milliseconds: number) => Promise<unknown> = pause,
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const facts = await read();
    if (unsigned(facts.height, 64) >= minimum) return facts;
    if (attempt < 2) await wait(1000);
  }
  throw new Error("Finalized sources have not reached the original receipt blocks");
}

async function receiptHeight(outcomes: Record<string, unknown>[]) {
  if (outcomes.length > 32) throw new Error("Unexpected receipt count");
  const hashes = [
    ...new Set(
      outcomes.map((value) => {
        if (typeof value.block_hash !== "string") throw new Error("Receipt block missing");
        decodeBase58(value.block_hash, 32);
        return value.block_hash;
      }),
    ),
  ];
  const client = new V1ReadOnlyRpc("near-fastnear");
  const heights = await Promise.all(
    hashes.map(async (hash) => {
      const header = record(
        record(await client.read("block", { block_id: hash }, AbortSignal.timeout(20_000))).header,
      );
      if (header.hash !== hash) throw new Error("Receipt block mismatch");
      return unsigned(header.height, 64);
    }),
  );
  return heights.reduce((maximum, height) => (height > maximum ? height : maximum), 0n);
}
async function privateJson<T>(path: string): Promise<T | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Operator file open");
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== (process.getuid?.() ?? -1) ||
      stat.mode & 0o077 ||
      stat.size > 4_000_000
    )
      throw new Error("Operator file permissions");
    return JSON.parse(await file.readFile("utf8")) as T;
  } finally {
    await file.close();
  }
}
// Transaction journals can include a full WASM image; they are not attestations.
export function v1ReceiptJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 2_000_000)
    throw new Error("Operator receipt size");
  return encoded + "\n";
}
async function save(path: string, value: unknown) {
  await writeFile(path + ".next", v1ReceiptJson(value), { mode: 0o600 });
  await rename(path + ".next", path);
}
async function signerKey() {
  const file = await open(
    join(homedir(), ".showup-test-wallets/near-testnet.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== (process.getuid?.() ?? -1) ||
      stat.mode & 0o077 ||
      stat.size > 4096
    )
      throw new Error("Signer file permissions");
    const wallet = record(JSON.parse(await file.readFile("utf8")));
    if (
      Object.keys(wallet).sort().join() !== "account_id,network,private_key,public_key" ||
      wallet.account_id !== owner ||
      wallet.network !== "testnet" ||
      wallet.public_key !== mainnetAccount.publicKey ||
      typeof wallet.private_key !== "string" ||
      !wallet.private_key.startsWith("ed25519:")
    )
      throw new Error("Signer metadata");
    const secret = decodeBase58(wallet.private_key.slice(8), 64),
      key = nativeKey(secret.subarray(0, 32));
    if (key.publicKey !== mainnetAccount.publicKey || !key.publicBytes.equals(secret.subarray(32)))
      throw new Error("Signer mismatch");
    secret.fill(0);
    wallet.private_key = undefined;
    return key;
  } finally {
    await file.close();
  }
}
async function snapshot(context: Context): Promise<Facts> {
  return v1ReadWithCooldown(() => snapshotOnce(context));
}
async function snapshotOnce(context: Context): Promise<Facts> {
  const clients = [new V1ReadOnlyRpc("near-drpc"), new V1ReadOnlyRpc("near-fastnear")];
  const signal = AbortSignal.timeout(45_000),
    finality = await compareFinalizedHeads("near", clients[0], clients[1], Date.now(), signal);
  const hash = finality.block.hash;
  const facts = await Promise.all(
    clients.map(async (client) => {
      async function query(account_id: string, request_type = "view_account", extra: object = {}) {
        const result = record(
          await client.read(
            "query",
            { account_id, request_type, block_id: hash, ...extra },
            signal,
          ),
        );
        if (result.block_hash !== hash || String(result.block_height) !== finality.block.height)
          throw new Error("Query block mismatch");
        return result;
      }
      async function account(account_id: string): Promise<Account | null> {
        let value;
        try {
          value = await query(account_id);
        } catch (error) {
          if (
            error instanceof NearAccountNotFound &&
            error.accountId === account_id &&
            error.blockHash === hash
          )
            return null;
          throw error;
        }
        const [keys, key] = await Promise.all([
          query(account_id, "view_access_key_list"),
          query(account_id, "view_access_key", { public_key: mainnetAccount.publicKey }),
        ]);
        if (
          !Array.isArray(keys.keys) ||
          keys.keys.length !== 1 ||
          record(keys.keys[0]).public_key !== mainnetAccount.publicKey ||
          record(record(keys.keys[0]).access_key).permission !== "FullAccess" ||
          key.permission !== "FullAccess"
        )
          throw new Error("Unexpected account keys");
        return {
          amount: unsigned(value.amount, 128).toString(),
          code: String(value.code_hash),
          nonce: unsigned(key.nonce, 64).toString(),
        };
      }
      async function view(account_id: string, method_name: string, args: object): Promise<unknown> {
        const result = await query(account_id, "call_function", {
          method_name,
          args_base64: bytes(args).toString("base64"),
        });
        if (!Array.isArray(result.result) || result.result.length > 100_000)
          throw new Error("View size");
        return JSON.parse(Buffer.from(result.result as number[]).toString("utf8")) as unknown;
      }
      const [root, target, protocol, block, metadata, bounds] = await Promise.all([
        account(owner),
        account(escrow),
        client.read("EXPERIMENTAL_protocol_config", { block_id: hash }, signal),
        client.read("block", { block_id: hash }, signal),
        view(token, "ft_metadata", {}),
        view(token, "storage_balance_bounds", {}),
      ]);
      const runtime = record(record(protocol).runtime_config);
      if (
        !root ||
        root.code !== "1".repeat(32) ||
        record(protocol).chain_id !== "mainnet" ||
        record(protocol).protocol_version !== 87 ||
        unsigned(runtime.storage_amount_per_byte) !== 10n ** 19n ||
        unsigned(runtime.min_gas_purchase_price) > 1_000_000_000n ||
        unsigned(record(record(block).header).gas_price) > 1_000_000_000n ||
        record(metadata).decimals !== 6 ||
        record(metadata).symbol !== "USDC" ||
        record(bounds).min !== storage
      )
        throw new Error("Chain/token policy changed");
      if (target && target.code !== "1".repeat(32) && target.code !== codeHash)
        throw new Error("Unexpected contract code");
      const deployed = target?.code === codeHash;
      const [rootUsdc, escrowUsdc, registered, event, registration, claim, accounting] =
        await Promise.all([
          view(token, "ft_balance_of", { account_id: owner }),
          view(token, "ft_balance_of", { account_id: escrow }),
          view(token, "storage_balance_of", { account_id: escrow }),
          deployed ? view(escrow, "get_event", { event: context.event }) : null,
          deployed
            ? view(escrow, "get_registration", { registration: context.registration })
            : null,
          deployed ? view(escrow, "get_claim", { claim: context.registration }) : null,
          deployed ? view(escrow, "accounting", {}) : null,
        ]);
      return {
        root,
        escrow: target,
        rootUsdc: unsigned(rootUsdc, 128).toString(),
        escrowUsdc: unsigned(escrowUsdc, 128).toString(),
        storage: registered,
        event: event === null ? null : record(event),
        registration: registration === null ? null : record(registration),
        claim: claim === null ? null : record(claim),
        accounting: accounting === null ? null : record(accounting),
      };
    }),
  );
  if (canonicalHash(facts[0]) !== canonicalHash(facts[1])) throw new Error("Sources disagree");
  return { block: hash, height: finality.block.height, ...facts[0] };
}
function checkBefore(step: Step, facts: Facts, context: Context) {
  const index = steps.indexOf(step),
    target = facts.escrow;
  if (step === "create") {
    if (target || BigInt(facts.root.amount) < 3_900_000_000_000_000_000_000_000n)
      throw new Error("Creation/funding state");
    return;
  }
  if (!target) throw new Error("Account missing");
  if (step === "fund" && (target.code !== "1".repeat(32) || target.amount !== "0"))
    throw new Error("Funding state");
  if (
    step === "deploy" &&
    (target.code !== "1".repeat(32) || BigInt(target.amount) < BigInt(funding))
  )
    throw new Error("Deployment state");
  if (index > 2 && target.code !== codeHash) throw new Error("Expected deployed code");
  if (step === "storage" && facts.storage !== null) throw new Error("Storage already present");
  if (
    step === "event" &&
    (facts.event !== null ||
      facts.accounting?.received !== "0" ||
      facts.rootUsdc !== context.baseline)
  )
    throw new Error("Event creation state");
  if (step === "publish" && facts.event?.status !== "draft") throw new Error("Publication state");
  if (step === "register" && (facts.event?.status !== "published" || facts.registration !== null))
    throw new Error("Registration state");
  if (
    step === "deposit" &&
    (facts.event?.status !== "published" ||
      facts.registration?.funded !== false ||
      facts.rootUsdc !== context.baseline ||
      facts.escrowUsdc !== "0")
  )
    throw new Error("Deposit state");
  if (
    step === "cancel" &&
    (facts.event?.status !== "published" ||
      facts.registration?.funded !== true ||
      facts.escrowUsdc !== "1000000")
  )
    throw new Error("Cancellation state");
  if (
    step === "withdraw" &&
    (facts.event?.status !== "cancelled" ||
      facts.claim?.recipient !== owner ||
      facts.claim.remaining !== "1000000" ||
      facts.claim.pending !== false)
  )
    throw new Error("Withdrawal state");
}
function checkAfter(step: Step, facts: Facts, context: Context) {
  if (!facts.escrow) throw new Error("Account verification failed");
  if (step === "create" && facts.escrow.code !== "1".repeat(32))
    throw new Error("Creation code mismatch");
  if (step === "fund" && facts.escrow.amount !== funding) throw new Error("Funding mismatch");
  if (steps.indexOf(step) >= 2 && facts.escrow.code !== codeHash)
    throw new Error("Deployment hash mismatch");
  if (step === "storage" && record(facts.storage).total !== storage)
    throw new Error("USDC storage mismatch");
  if (step === "event" && facts.event?.title !== "Mainnet escrow verification")
    throw new Error("Event mismatch");
  if (step === "publish" && facts.event?.status !== "published")
    throw new Error("Publication mismatch");
  if (
    step === "register" &&
    (facts.registration?.sender !== owner ||
      facts.registration.payout !== owner ||
      facts.registration.funded !== false)
  )
    throw new Error("Registration mismatch");
  if (
    step === "deposit" &&
    (facts.registration?.funded !== true ||
      facts.accounting?.received !== "1000000" ||
      facts.escrowUsdc !== "1000000" ||
      BigInt(facts.rootUsdc) !== BigInt(context.baseline) - 1_000_000n)
  )
    throw new Error("Deposit conservation mismatch");
  if (
    step === "cancel" &&
    (facts.event?.status !== "cancelled" ||
      facts.claim?.recipient !== owner ||
      facts.claim.remaining !== "1000000")
  )
    throw new Error("Cancellation mismatch");
  if (
    step === "withdraw" &&
    (facts.claim?.paid !== "1000000" ||
      facts.claim.remaining !== "0" ||
      facts.claim.pending !== false ||
      facts.rootUsdc !== context.baseline ||
      facts.escrowUsdc !== "0" ||
      facts.accounting?.held !== "0")
  )
    throw new Error("Refund conservation mismatch");
}
async function main() {
  const requested = process.argv[2] ?? "status",
    execute = process.argv[3] === "--execute";
  if (
    process.argv.length > 4 ||
    (process.argv[3] && !execute) ||
    (requested !== "status" && !steps.includes(requested as Step))
  )
    throw new Error("Invalid arguments");
  const code = await readFile(
    new URL(
      "../contracts/.cache/target/wasm32-unknown-unknown/release/showup_v1.wasm",
      import.meta.url,
    ),
  );
  if (code.length !== 321207 || createHash("sha256").update(code).digest("hex") !== wasmHash)
    throw new Error("Unreviewed artifact");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const contextPath = join(directory, "context.json");
  let context = await privateJson<Context>(contextPath);
  if (!context) {
    const event = `v1-smoke-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
    context = {
      event,
      registration: event + "-attendee",
      start: Date.now() + 86_400_000,
      baseline: "0",
      artifact: wasmHash,
    };
    const initial = await snapshot(context);
    context.baseline = initial.rootUsdc;
    if (BigInt(context.baseline) < 1_000_000n) throw new Error("Smoke deposit unavailable");
    await writeFile(contextPath, canonicalJson(context) + "\n", { mode: 0o600, flag: "wx" });
  }
  if (
    context.artifact !== wasmHash ||
    !/^v1-smoke-[0-9]{8}$/.test(context.event) ||
    context.registration !== context.event + "-attendee" ||
    !Number.isSafeInteger(context.start)
  )
    throw new Error("Operator context mismatch");
  if (requested === "status") {
    stage = "read_status";
    console.log(
      JSON.stringify({
        status: "read-only",
        rpcHttpStatus: 200,
        artifact: wasmHash,
        ...(await snapshot(context)),
      }),
    );
    return;
  }
  const step = requested as Step,
    operation = v1MainnetStep(step, context, code);
  const semantic = canonicalHash({
    ...operation,
    actions: operation.actions.map((action) =>
      action.kind === "deploy"
        ? { kind: "deploy", sha256: wasmHash }
        : action.kind === "call"
          ? { ...action, args: action.args.toString("base64") }
          : action,
    ),
  });
  const path = join(directory, step + ".json");
  let image = await privateJson<Receipt>(path);
  if (image) {
    if (image.step !== step || image.semantic !== semantic || image.signer !== operation.signer)
      throw new Error("Original image mismatch");
    if (image.phase === "verified") {
      console.log(
        JSON.stringify({
          status: "already-verified",
          step,
          hash: image.hash,
          tokensBurnt: image.tokensBurnt,
        }),
      );
      return;
    }
  } else {
    stage = "preflight_" + step;
    for (const previous of steps.slice(0, steps.indexOf(step))) {
      if ((await privateJson<Receipt>(join(directory, previous + ".json")))?.phase !== "verified")
        throw new Error("Previous step not verified");
    }
    if (step === "create") await prepareMainnetAccountPlan();
    const facts = await snapshot(context);
    checkBefore(step, facts, context);
    const signer = operation.signer === owner ? facts.root : facts.escrow!;
    const attached = operation.actions.reduce(
      (sum, action) => sum + ("deposit" in action ? BigInt(action.deposit) : 0n),
      0n,
    );
    if (BigInt(signer.amount) < attached + 160_000_000_000_000_000_000_000n)
      throw new Error("Insufficient bounded gas reserve");
    const input = {
      ...operation,
      nonce: (BigInt(signer.nonce) + 1n).toString(),
      blockHash: facts.block,
    };
    const unsignedImage = v1MainnetTransaction({ ...input, publicKey: mainnetAccount.publicKey });
    if (!execute) {
      console.log(
        JSON.stringify({
          status: "ready",
          step,
          signer: input.signer,
          receiver: input.receiver,
          hash: unsignedImage.hash,
          semantic,
          attachedYoctoNear: attached.toString(),
          maximumFeeYoctoNear: "160000000000000000000000",
          rpcHttpStatus: 200,
        }),
      );
      return;
    }
    stage = "sign_" + step;
    const signed = signV1MainnetTransaction(input, await signerKey());
    if (signed.hash !== unsignedImage.hash) throw new Error("Signed image mismatch");
    image = {
      step,
      semantic,
      signer: operation.signer,
      ...signed,
      phase: "prepared",
      validUntilMs: Date.now() + 120_000,
    };
    stage = "persist_" + step;
    const encoded = v1ReceiptJson(image);
    const lock = await open(join(directory, step + ".lock"), "wx", 0o600);
    await lock.close();
    await writeFile(path, encoded, { mode: 0o600, flag: "wx" });
  }
  stage = "submit_or_reconcile_" + step;
  const result =
    image.phase === "prepared"
      ? await v1SubmitOriginal(image, execute, () => save(path, image))
      : await v1ReadWithCooldown(() => v1SubmitOriginal(image, false, () => save(path, image)));
  if (!result) {
    console.log(JSON.stringify({ status: "prepared-not-submitted", step, hash: image.hash }));
    return;
  }
  if (!Array.isArray(result.receipts_outcome)) throw new Error("Missing receipt graph");
  const outcomes = [result.transaction_outcome, ...(result.receipts_outcome as unknown[])].map(
    record,
  );
  if (
    record(result.transaction).hash !== image.hash ||
    result.final_execution_status !== "FINAL" ||
    !Object.hasOwn(record(result.status), "SuccessValue") ||
    outcomes.some((value) => {
      const status = record(record(value.outcome).status);
      return !Object.hasOwn(status, "SuccessValue") && !Object.hasOwn(status, "SuccessReceiptId");
    })
  )
    throw new Error("Original transaction not successful/final");
  image.phase = "final";
  image.tokensBurnt = outcomes
    .reduce((sum, value) => sum + unsigned(record(value.outcome).tokens_burnt, 128), 0n)
    .toString();
  await save(path, image);
  stage = "verify_" + step;
  const minimum = await v1ReadWithCooldown(() => receiptHeight(outcomes));
  image.receiptHeight = minimum.toString();
  await save(path, image);
  const after = await v1WaitForState(minimum, () => snapshot(context));
  checkAfter(step, after, context);
  image.phase = "verified";
  image.after = after;
  await save(path, image);
  console.log(
    JSON.stringify({
      status: "verified",
      step,
      hash: image.hash,
      tokensBurnt: image.tokensBurnt,
      block: after.height,
      controllerNative: after.root.amount,
      escrowNative: after.escrow?.amount,
      controllerUsdc: after.rootUsdc,
      escrowUsdc: after.escrowUsdc,
      rpcHttpStatus: 200,
    }),
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: "stopped",
        stage,
        publicReadDetail:
          (stage.startsWith("verify_") || stage === "read_status") && error instanceof Error
            ? error.message.slice(0, 160)
            : undefined,
        retryAt: error instanceof RpcCooldown ? error.retryAt : undefined,
        message: "Reconcile the original receipt; no replacement nonce or automatic resend.",
      }),
    );
    process.exitCode = 1;
  });
