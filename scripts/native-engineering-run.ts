// OPERATOR TOOL: never invoke without explicit approval of the printed plan hash,
// public testnet signing/deployment and its test-token budget. No .env is loaded.
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import { decodeBase58 } from "../src/server/protocol/encoding";
import { parseRpcJson, ReadOnlyRpc, unsigned } from "../src/server/protocol/rpc";
import { record } from "../src/server/protocol/quote-signature";
import { compareFinalizedHeads } from "../src/server/protocol/finalized-heads";
import { compareEngineeringSettlementState } from "../src/server/protocol/settlement-state";
import { createCommitmentConsent, consentWalletMessage } from "../src/server/commitments/consent";
import {
  contractAuthorization,
  contractReference,
} from "../src/server/commitments/contract-authorization";
import {
  nativeEngineeringRoot,
  nativeEngineeringGas,
  retainedNativeDeployment,
  prepareNativeEngineeringPlan,
} from "./native-engineering-plan";
import { engineeringManifest, engineeringManifestHash } from "../src/server/protocol/manifest";
import {
  nativeInteger,
  nativeKey,
  nativeString,
  signNativeTransaction,
  type NativeAction,
  type NativeKey,
} from "./lib/native-engineering-transaction";
import { createHash } from "node:crypto";

type Plan = Awaited<ReturnType<typeof prepareNativeEngineeringPlan>>["plan"];
type Image = {
  hash: string;
  signedBase64: string;
  signer: string;
  phase: "prepared" | "submitted" | "final" | "failed";
  validUntilMs?: number;
};
type Seeds = { escrow: string; attendee: string; credential: string; evidence: string };
type State = {
  plan: Plan;
  planHash: string;
  seeds?: Seeds;
  keySourceOperation?: string;
  event: string;
  registration: string;
  participant: string;
  rootTokenBaseline: string;
  terms: Record<string, unknown>;
  authorization?: Record<string, unknown>;
  release?: Record<string, unknown>;
  images: Record<string, Image>;
  completed: string[];
  recoveryStarted?: true;
};
const endpoint = "https://test.rpc.fastnear.com";
const directory = new URL("../contracts/.cache/native-engineering/", import.meta.url);
let operatorStage = "validate_approved_plan";
const json = (value: unknown) => Buffer.from(canonicalJson(value));
const call = (method: string, args: object, deposit = "0"): NativeAction => ({
  kind: "call",
  method,
  args: json(args),
  deposit,
  gas: nativeEngineeringGas,
});

// One HTTP attempt. It never retries, refreshes a nonce or exposes RPC bodies in
// errors. Status reads use only the persisted hash and original sender.
export async function nativeRpc(
  method: "send_tx" | "tx",
  params: object,
  transport: typeof fetch = fetch,
) {
  const response = await transport(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "showup-native-engineering", method, params }),
  });
  if (!response.ok || !response.body)
    throw new Error("Original native transaction needs reconciliation");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2_000_000) throw new Error("Native status exceeds the reviewed size");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const envelope = record(parseRpcJson(Buffer.concat(chunks, length).toString("utf8")));
  if (envelope.error || envelope.id !== "showup-native-engineering")
    throw new Error("Original native transaction needs reconciliation");
  return record(envelope.result);
}

export async function submitOriginalNativeImage(
  image: Image,
  save: () => Promise<void>,
  transport: typeof fetch = fetch,
) {
  if (image.phase === "final") return;
  if (image.phase === "failed")
    throw new Error("Original native transaction failed; recover its existing funds");
  // Mark possible submission durably BEFORE the request. A crash at either side
  // of HTTP must reconcile this image, even if the first request never arrived.
  const firstAttempt = image.phase === "prepared";
  if (
    firstAttempt &&
    image.validUntilMs !== undefined &&
    (!Number.isSafeInteger(image.validUntilMs) || Date.now() + 30_000 >= image.validUntilMs)
  )
    throw new Error("Original authorization needs recovery before a new broadcast");
  if (firstAttempt) {
    image.phase = "submitted";
    await save();
  }
  const result = await nativeRpc(
    firstAttempt ? "send_tx" : "tx",
    firstAttempt
      ? { signed_tx_base64: image.signedBase64, wait_until: "FINAL" }
      : { tx_hash: image.hash, sender_account_id: image.signer, wait_until: "FINAL" },
    transport,
  );
  if (
    record(result.transaction).hash !== image.hash ||
    result.final_execution_status !== "FINAL" ||
    !Array.isArray(result.receipts_outcome)
  )
    throw new Error("Original native transaction has not completed successfully");
  if (
    !Object.hasOwn(record(result.status), "SuccessValue") ||
    result.receipts_outcome.some((item) => {
      const status = record(record(record(item).outcome).status);
      return !Object.hasOwn(status, "SuccessValue") && !Object.hasOwn(status, "SuccessReceiptId");
    })
  ) {
    image.phase = "failed";
    await save();
    throw new Error("Original native transaction failed; recover its existing funds");
  }
  image.phase = "final";
  await save();
}

async function privateJson(path: string | URL) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 8_000_000)
      throw new Error("Private operator file permissions or size require review");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
// The caller already owns its operation's exclusive lock. A graceful stop keeps
// this durable claim, so another operation cannot borrow uncertain signing keys.
export async function acquireRetainedClaim(
  path: string | URL,
  operationId: string,
  planHash: string,
  resuming: boolean,
) {
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if (!resuming || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const claim = record(await privateJson(path));
    if (claim.operationId !== operationId || claim.planHash !== planHash)
      throw new Error("Retained accounts are claimed by another operation");
    return open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    await file.writeFile(JSON.stringify({ operationId, planHash }));
    await file.sync();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function durableJson(path: string | URL, value: unknown, initial = false) {
  const target = initial ? path : `${typeof path === "string" ? path : fileURLToPath(path)}.next`;
  const file = await open(target, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  if (!initial) await rename(target, path);
  const parent = await open(directory, constants.O_RDONLY);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
function key(state: Pick<State, "seeds">, name: keyof Seeds) {
  if (!state.seeds) throw new Error("Original retained key source unavailable");
  return nativeKey(Buffer.from(state.seeds[name], "base64"));
}

// No file access or key generation. The new operation retains only a reference
// to this recovered source; returned signers stay in process memory.
export function retainedSigningKeys(
  plan: Pick<Plan, "keySourcePlanHash" | "escrowAccount" | "attendeeAccount"> & {
    facts: { retained: { credentialKey: string; evidenceKey: string } | null };
  },
  source: {
    plan: Pick<Plan, "escrowAccount" | "attendeeAccount">;
    planHash: string;
    seeds?: Seeds;
    recoveryStarted?: true;
    completed: readonly string[];
    images: Record<string, Pick<Image, "phase">>;
  },
) {
  if (
    source.planHash !== plan.keySourcePlanHash ||
    canonicalHash(source.plan) !== plan.keySourcePlanHash ||
    !source.recoveryStarted ||
    source.plan.escrowAccount !== plan.escrowAccount ||
    source.plan.attendeeAccount !== plan.attendeeAccount ||
    !source.completed.includes("recover_test_tokens_to_project_wallet") ||
    !source.completed.includes("recover_original_event") ||
    Object.values(source.images).some(
      (image) => image.phase !== "final" && image.phase !== "failed",
    )
  )
    throw new Error("Original operation is not recovered for retained reuse");
  const keys = {
    escrow: key(source, "escrow"),
    attendee: key(source, "attendee"),
    credential: key(source, "credential"),
    evidence: key(source, "evidence"),
  };
  const expected = plan.facts.retained;
  if (
    !expected ||
    keys.credential.publicBytes.toString("base64") !== expected.credentialKey ||
    keys.evidence.publicBytes.toString("base64") !== expected.evidenceKey
  )
    throw new Error("Retained authority keys differ from deployed initialization");
  return keys;
}
const proof = (signer: NativeKey, value: unknown) => signer.sign(json(value)).toString("base64");
async function sources() {
  const first = new ReadOnlyRpc("near-testnet-archival"),
    second = new ReadOnlyRpc("near-testnet-fastnear");
  const signal = AbortSignal.timeout(30_000);
  const compared = await compareFinalizedHeads(
    "near",
    first,
    second,
    Date.now(),
    signal,
    "engineering",
  );
  const query = async (client: ReadOnlyRpc, params: object) => {
    const value = record(
      await client.read("query", { ...params, block_id: compared.block.hash }, signal),
    );
    if (
      value.block_hash !== compared.block.hash ||
      unsigned(value.block_height, 64).toString() !== compared.block.height
    )
      throw new Error("Native source block mismatch");
    return value;
  };
  async function read(params: object) {
    const [a, b] = await Promise.all([query(first, params), query(second, params)]);
    // Query envelopes contain provider-specific logs/metadata. Compare the exact
    // requested facts separately, retaining the common finalized block binding.
    return { a, b };
  }
  return { ...compared, read };
}
async function verifyAccess(account: string, signer: NativeKey) {
  const source = await sources();
  const { a, b } = await source.read({
    request_type: "view_access_key",
    account_id: account,
    public_key: signer.publicKey,
  });
  if (
    a.permission !== "FullAccess" ||
    b.permission !== "FullAccess" ||
    unsigned(a.nonce, 64) !== unsigned(b.nonce, 64)
  )
    throw new Error("Native signer control does not match both finalized sources");
  return { nonce: (unsigned(a.nonce, 64) + 1n).toString(), blockHash: source.block.hash };
}
async function tokenBalance(state: State, account: string) {
  const source = await sources();
  const { a, b } = await source.read({
    request_type: "call_function",
    account_id: state.plan.token,
    method_name: "ft_balance_of",
    args_base64: json({ account_id: account }).toString("base64"),
  });
  const decode = (value: Record<string, unknown>) => {
    if (
      !Array.isArray(value.result) ||
      value.result.length > 100 ||
      value.result.some((x) => !Number.isInteger(x) || x < 0 || x > 255)
    )
      throw new Error("Native balance encoding unavailable");
    return unsigned(JSON.parse(Buffer.from(value.result).toString()), 128).toString();
  };
  const result = decode(a);
  if (result !== decode(b)) throw new Error("Native token sources disagree");
  return result;
}
async function observe(state: State) {
  if (!state.authorization) throw new Error("Original native authorization unavailable");
  return compareEngineeringSettlementState({
    environment: "engineering",
    deployment: state.plan.escrowAccount,
    token: state.plan.token,
    domain: state.plan.domain,
    manifest: state.plan.manifest,
    event: contractReference(state.event),
    rulesHash: String(state.terms.rules_hash),
    escrowCodeHash: state.plan.artifact.codeHash,
    tokenCodeHash: state.plan.facts.tokenCodeHash,
    authorization: state.authorization,
  });
}

async function run(planPath: string, approvedHash: string, mode: "execute" | "resume" | "recover") {
  const resume = mode !== "execute";
  if (
    !/^[0-9a-f]{64}$/.test(approvedHash) ||
    !/^\/private\/tmp\/showup-native-engineering-[0-9a-f-]{36}\.json$/.test(planPath)
  )
    throw new Error("An exact prepared plan and approved hash are required");
  const envelope = record(await privateJson(planPath)),
    plan = envelope.plan as Plan;
  const reuseRetained = plan.format === "showup.native-engineering.reuse-plan.v1";
  if (
    envelope.planHash !== approvedHash ||
    canonicalHash(plan) !== approvedHash ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(plan.operationId)
  )
    throw new Error("Prepared plan differs from approval");
  // Recompute the current artifact and all fixed operation constraints. Balances
  // may change after owner funding; destinations, costs and code may not.
  operatorStage = "read_public_preflight";
  const fresh = resume ? null : (await prepareNativeEngineeringPlan(fetch, reuseRetained)).plan;
  const suffix = plan.operationId.replaceAll("-", "").slice(0, 10);
  const expected = fresh && {
    ...fresh,
    operationId: plan.operationId,
    escrowAccount: reuseRetained ? fresh.escrowAccount : `e-${suffix}.${fresh.rootAccount}`,
    attendeeAccount: reuseRetained ? fresh.attendeeAccount : `a-${suffix}.${fresh.rootAccount}`,
    facts: plan.facts,
    observedBlock: plan.observedBlock,
    requirements: plan.requirements,
  };
  if (
    (!reuseRetained && plan.format !== "showup.native-engineering.plan.v1") ||
    plan.network !== "near-testnet" ||
    plan.rootAccount !== nativeEngineeringRoot ||
    plan.domain !== engineeringManifest.signingDomain ||
    plan.manifest !== engineeringManifestHash ||
    plan.token !== engineeringManifest.networks.find((item) => item.id === "near")!.usdc ||
    plan.walletConsentOrigin !== "https://liable-pleat-maritime.ngrok-free.dev" ||
    (reuseRetained
      ? plan.reuseOf !== retainedNativeDeployment.operationId ||
        plan.keySourcePlanHash !== retainedNativeDeployment.originalPlanHash ||
        plan.escrowAccount !== retainedNativeDeployment.accounts.escrowAccount ||
        plan.attendeeAccount !== retainedNativeDeployment.accounts.attendeeAccount
      : plan.reuseOf !== undefined ||
        plan.escrowAccount !== `e-${suffix}.${nativeEngineeringRoot}` ||
        plan.attendeeAccount !== `a-${suffix}.${nativeEngineeringRoot}`) ||
    (fresh &&
      (canonicalJson(plan) !== canonicalJson(expected) ||
        plan.facts.tokenCodeHash !== fresh.facts.tokenCodeHash ||
        plan.facts.storagePricePerByte !== fresh.facts.storagePricePerByte))
  )
    throw new Error("Prepared operation needs a new review");
  if (!resume && fresh!.requirements.length !== 1)
    throw new Error("Prepared test funding is missing or exceeds the reviewed cap");
  // The fixed wallet file is parsed as data only AFTER the approved public plan
  // and funding preflight. No application configuration/keys are accessed.
  operatorStage = "load_project_testnet_wallet";
  const wallet = record(
    await privateJson(join(homedir(), ".showup-test-wallets", "near-testnet.json")),
  );
  if (
    Object.keys(wallet).sort().join() !== "account_id,network,private_key,public_key" ||
    wallet.network !== "testnet" ||
    typeof wallet.private_key !== "string" ||
    !wallet.private_key.startsWith("ed25519:")
  )
    throw new Error("Project testnet wallet configuration requires review");
  operatorStage = "derive_project_signer";
  const secret = decodeBase58(wallet.private_key.slice(8), 64),
    root = nativeKey(secret.subarray(0, 32));
  if (!root.publicBytes.equals(secret.subarray(32)) || wallet.public_key !== root.publicKey)
    throw new Error("Project wallet key binding requires review");
  operatorStage = "verify_root_access";
  await verifyAccess(plan.rootAccount, root);
  operatorStage = "create_private_state_directory";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const statePath = new URL(`${plan.operationId}.json`, directory),
    lockPath = new URL(`${plan.operationId}.lock`, directory);
  operatorStage = "acquire_operation_lock";
  const lock = await open(lockPath, "wx", 0o600);
  let sourceLock: Awaited<ReturnType<typeof open>> | undefined;
  let sourceSettled = false;
  const sourceLockPath = reuseRetained ? new URL(`${plan.reuseOf}.lock`, directory) : null;
  try {
    let retainedKeys: ReturnType<typeof retainedSigningKeys> | undefined;
    if (reuseRetained) {
      // Serialize operations using these same retained accounts and keys. The
      // recovered operation remains immutable; only its existing keys are read.
      sourceLock = await acquireRetainedClaim(
        sourceLockPath!,
        plan.operationId,
        approvedHash,
        resume,
      );
      const keySource = (await privateJson(new URL(`${plan.reuseOf}.json`, directory))) as State;
      retainedKeys = retainedSigningKeys(plan, keySource);
    }
    operatorStage = "initialize_operation_state";
    let state: State;
    if (resume) {
      state = (await privateJson(statePath)) as State;
      if (state.planHash !== approvedHash || canonicalJson(state.plan) !== canonicalJson(plan))
        throw new Error("Retained native state differs from approval");
    } else {
      const seeds = reuseRetained
        ? undefined
        : {
            escrow: randomBytes(32).toString("base64"),
            attendee: randomBytes(32).toString("base64"),
            credential: randomBytes(32).toString("base64"),
            evidence: randomBytes(32).toString("base64"),
          };
      const event = randomUUID(),
        registration = randomUUID(),
        participant = randomUUID();
      const destination = { network: "near", asset: plan.token, address: plan.rootAccount };
      const start = Date.now() + 3_600_000;
      const terms = {
        event: contractReference(event),
        host: plan.rootAccount,
        mode: "online",
        capacity: 1,
        principal: "5000000",
        sponsor_budget: "0",
        sponsor_return: destination,
        start_ms: start,
        end_ms: start + 1_800_000,
        latest_quiz_close_ms: 0,
        excluded: [canonicalHash({ operation: plan.operationId, role: "host" })],
        draw_policy: null,
        custody_proof_policy: null,
        native_nft: null,
        observer_policy: null,
        wallet_consent_origin: plan.walletConsentOrigin,
      };
      const rules_hash = canonicalHash({
        format: "showup.event.rules.v1",
        authorization_domain: plan.domain,
        deployment: plan.escrowAccount,
        manifest: plan.manifest,
        settlement_token: plan.token,
        terms,
      });
      state = {
        plan,
        planHash: approvedHash,
        ...(reuseRetained ? { keySourceOperation: plan.reuseOf } : { seeds }),
        event,
        registration,
        participant,
        rootTokenBaseline: fresh!.facts.rootTokenBalance,
        terms: { ...terms, rules_hash },
        images: {},
        completed: [],
      };
      await durableJson(statePath, state, true);
    }
    const save = () => durableJson(statePath, state);
    if (reuseRetained && (state.keySourceOperation !== plan.reuseOf || state.seeds !== undefined))
      throw new Error("Retained key reference differs from approval");
    if (state.recoveryStarted && mode !== "recover")
      throw new Error("Continue original recovery; new deposits are closed");
    const { escrow, attendee, credential, evidence } = retainedKeys ?? {
      escrow: key(state, "escrow"),
      attendee: key(state, "attendee"),
      credential: key(state, "credential"),
      evidence: key(state, "evidence"),
    };
    if (reuseRetained) {
      await verifyAccess(plan.escrowAccount, escrow);
      await verifyAccess(plan.attendeeAccount, attendee);
    }
    async function step(
      name: string,
      signerAccount: string,
      signer: NativeKey,
      receiver: string,
      actions: () => Promise<NativeAction[]> | NativeAction[],
    ) {
      operatorStage = "execute_original_step";
      if (state.completed.includes(name)) return;
      if (!state.images[name]) {
        const preparedActions = await actions(),
          access = await verifyAccess(signerAccount, signer);
        state.images[name] = {
          ...signNativeTransaction(
            { signer: signerAccount, receiver, actions: preparedActions, ...access },
            signer,
          ),
          signer: signerAccount,
          phase: "prepared",
        };
        await save();
      }
      if (
        ["reserve_original_authorization", "fund_original_registration"].includes(name) &&
        state.authorization &&
        state.images[name].validUntilMs !== Number(state.authorization.expires_ms)
      ) {
        state.images[name].validUntilMs = Number(state.authorization.expires_ms);
        await save();
      }
      await submitOriginalNativeImage(state.images[name], save);
      state.completed.push(name);
      await save();
      console.log(
        JSON.stringify({
          operationId: plan.operationId,
          step: name,
          transactionHash: state.images[name].hash,
          status: "final",
        }),
      );
    }
    if (mode === "recover") {
      state.recoveryStarted = true;
      await save();
      // Reconcile every possibly submitted original image before deciding where
      // principal remains. Recovery never allocates another input or reservation.
      for (const image of Object.values(state.images)) {
        if (image.phase === "submitted") {
          try {
            await submitOriginalNativeImage(image, save);
          } catch {
            if ((image as Image).phase !== "failed")
              throw new Error("Original native image is still uncertain");
          }
        }
      }
      if (
        !state.images.fund_original_registration &&
        state.authorization &&
        state.completed.includes("publish")
      ) {
        const source = await observe(state);
        if (source.eventState === "published" || source.eventState === "draft") {
          const afterDeadline = source.block.timestampMs >= Number(state.terms.end_ms) + 2_100_000;
          if (!afterDeadline && source.block.timestampMs >= Number(state.terms.end_ms) - 600_000)
            throw new Error("Wait for the original event fail-neutral deadline before recovery");
          await step("recover_original_event", plan.rootAccount, root, plan.escrowAccount, () => [
            call(afterDeadline ? "fail_neutral" : "cancel_or_abort", { event: state.terms.event }),
          ]);
        }
      }
      if (state.images.fund_original_registration) {
        let source = await observe(state);
        if (source.registration?.booked) {
          const afterDeadline = source.block.timestampMs >= Number(state.terms.end_ms) + 2_100_000;
          if (!afterDeadline && source.block.timestampMs >= Number(state.terms.end_ms) - 600_000)
            throw new Error("Wait for the original event fail-neutral deadline before recovery");
          await step("recover_original_event", plan.rootAccount, root, plan.escrowAccount, () => [
            call(afterDeadline ? "fail_neutral" : "cancel_or_abort", { event: state.terms.event }),
          ]);
          source = await observe(state);
        }
        if (source.principal?.pending || source.returned?.pending)
          throw new Error("Original native payment callback is still pending");
        for (const [kind, liability] of [
          ["principal", source.principal],
          ["return", source.returned],
        ] as const) {
          if (liability && liability.remaining !== "0")
            await step(
              `recover_original_${kind}`,
              plan.attendeeAccount,
              attendee,
              plan.escrowAccount,
              () => [call("withdraw", { id: `${state.authorization!.registration}:${kind}` })],
            );
        }
        source = await observe(state);
        if (
          source.accounting.owed !== "0" ||
          source.tokenBalance !== "0" ||
          source.registration?.booked
        )
          throw new Error("Native escrow still has an original obligation");
      }
      const balance = await tokenBalance(state, plan.attendeeAccount);
      if (balance === "5000000")
        await step(
          "recover_test_tokens_to_project_wallet",
          plan.attendeeAccount,
          attendee,
          plan.token,
          () => [call("ft_transfer", { receiver_id: plan.rootAccount, amount: "5000000" }, "1")],
        );
      else if (balance !== "0")
        throw new Error("Native recovery balance differs from original principal");
      if (
        (await tokenBalance(state, plan.attendeeAccount)) !== "0" ||
        BigInt(await tokenBalance(state, plan.rootAccount)) < BigInt(state.rootTokenBaseline)
      )
        throw new Error("Native original principal still requires reconciliation");
      sourceSettled = true;
      console.log(
        JSON.stringify({
          operationId: plan.operationId,
          recovery: "original_principal_returned",
          sourceQualified: false,
          liveFundingAllowed: false,
        }),
      );
      return;
    }
    if (reuseRetained) {
      await step("top_up_retained_attendee", plan.rootAccount, root, plan.attendeeAccount, () => [
        { kind: "transfer", deposit: plan.budget.attendeeNative },
      ]);
    } else {
      const child = (publicKey: string, deposit: string): NativeAction[] => [
        { kind: "create" },
        { kind: "transfer", deposit },
        { kind: "add_key", publicKey },
      ];
      await step("create_escrow", plan.rootAccount, root, plan.escrowAccount, () =>
        child(escrow.publicKey, plan.budget.escrowNative),
      );
      await step("create_attendee", plan.rootAccount, root, plan.attendeeAccount, () =>
        child(attendee.publicKey, plan.budget.attendeeNative),
      );
      await step("deploy_pinned_wasm", plan.escrowAccount, escrow, plan.escrowAccount, async () => {
        const code = await readFile(
          new URL(
            "../contracts/.cache/target/wasm32-unknown-unknown/release/showup_escrow.wasm",
            import.meta.url,
          ),
        );
        if (createHash("sha256").update(code).digest("hex") !== plan.artifact.sha256)
          throw new Error("Deployment artifact differs from approval");
        return [{ kind: "deploy", code }];
      });
      await step(
        "initialize_engineering_profile",
        plan.escrowAccount,
        escrow,
        plan.escrowAccount,
        () => [
          call("new", {
            token: plan.token,
            domain: plan.domain,
            manifest: plan.manifest,
            credential_key: credential.publicBytes.toString("base64"),
            evidence_key: evidence.publicBytes.toString("base64"),
          }),
        ],
      );
      for (const [name, account_id] of [
        ["register_escrow_token_storage", plan.escrowAccount],
        ["register_attendee_token_storage", plan.attendeeAccount],
      ])
        await step(name, plan.rootAccount, root, plan.token, () => [
          call(
            "storage_deposit",
            { account_id, registration_only: true },
            plan.budget.tokenStorageMinimum,
          ),
        ]);
    }
    await step("allocate_exact_test_principal", plan.rootAccount, root, plan.token, () => [
      call("ft_transfer", { receiver_id: plan.attendeeAccount, amount: "5000000" }, "1"),
    ]);
    await step("create_fixed_event", plan.escrowAccount, escrow, plan.escrowAccount, () => [
      call("create_event", { terms: state.terms }),
    ]);
    await step("publish", plan.rootAccount, root, plan.escrowAccount, () => [
      call("publish", { event: state.terms.event }),
    ]);
    await step(
      "reserve_original_authorization",
      plan.attendeeAccount,
      attendee,
      plan.escrowAccount,
      async () => {
        if (!state.authorization) {
          const now = Date.now(),
            profile = {
              environment: "engineering" as const,
              manifest: plan.manifest,
              token: plan.token,
            };
          const wallet = {
            network: "near" as const,
            chainId: "testnet",
            address: plan.attendeeAccount,
          };
          const consent = createCommitmentConsent(
            plan.walletConsentOrigin,
            {
              environment: "engineering",
              manifest: plan.manifest,
              deployment: plan.escrowAccount,
              event: state.event,
              rulesHash: String(state.terms.rules_hash),
              registration: state.registration,
              participant: state.participant,
              timeZone: "America/Denver",
              source: wallet,
              refund: wallet,
              payout: wallet,
              inputAsset: { contract: plan.token, decimals: 6 },
              maximumInput: "5000000",
              principal: "5000000",
              sourceGasMaximum: plan.budget.attendeeNative,
              routingFeeMaximum: "0",
              withdrawalFeeMaximum: "0",
              payoutMinimum: "5000000",
              quoteHash: canonicalHash({
                format: "showup.native-direct-test.v1",
                planHash: approvedHash,
              }),
              quoteExpiresAt: now + 900_000,
              registrationClosesAt: Number(state.terms.start_ms),
              authorizationExpiresAt: now + 900_000,
              reservationExpiresAt: now + 300_000,
            },
            now,
            profile,
          );
          const message = consentWalletMessage(consent);
          const payload = Buffer.concat([
            nativeInteger(String(2 ** 31 + 413), 4),
            nativeString(message.message),
            Buffer.from(message.nonce, "base64"),
            nativeString(message.recipient),
            Buffer.from([1]),
            nativeString(message.callbackUrl),
          ]);
          const signature = attendee
            .sign(createHash("sha256").update(payload).digest())
            .toString("base64");
          state.authorization = contractAuthorization(
            plan.walletConsentOrigin,
            consent,
            { signature, publicKey: attendee.publicKey, accountId: plan.attendeeAccount },
            now,
            profile,
          ).authorization;
          await save();
        }
        return [
          call("reserve", {
            authorization: state.authorization,
            proof: proof(credential, state.authorization),
          }),
        ];
      },
    );
    await step(
      "fund_original_registration",
      plan.attendeeAccount,
      attendee,
      plan.token,
      async () => {
        const source = await observe(state);
        if (
          source.registration?.state !== "reserved" ||
          source.registration.booked ||
          Date.now() >= Number(state.authorization!.expires_ms)
        )
          throw new Error("Original native funding authorization is unavailable");
        return [
          call(
            "ft_transfer_call",
            {
              receiver_id: plan.escrowAccount,
              amount: "5000000",
              msg: canonicalJson({
                kind: "commitment",
                authorization: state.authorization,
                proof: proof(credential, state.authorization),
              }),
            },
            "1",
          ),
        ];
      },
    );
    await step(
      "release_original_registration",
      plan.attendeeAccount,
      attendee,
      plan.escrowAccount,
      async () => {
        const source = await observe(state);
        if (
          !source.registration?.booked ||
          source.registration.state !== "funded" ||
          source.tokenBalance !== "5000000"
        )
          throw new Error("Actual native funded principal has not been observed");
        state.release ??= {
          domain: plan.domain,
          deployment: plan.escrowAccount,
          manifest: plan.manifest,
          event: state.terms.event,
          registration: state.authorization!.registration,
          participant: state.authorization!.participant,
          operation: "release",
          nonce: canonicalHash({ operation: plan.operationId, action: "release" }),
          expires_ms: Math.min(Date.now() + 120_000, Number(state.terms.start_ms) - 600_000),
        };
        await save();
        return [
          call("release", { action: state.release, proof: proof(credential, state.release) }),
        ];
      },
    );
    await step(
      "withdraw_original_principal",
      plan.attendeeAccount,
      attendee,
      plan.escrowAccount,
      async () => {
        const source = await observe(state);
        if (
          source.registration?.state !== "released" ||
          source.principal?.remaining !== "5000000" ||
          source.principal.pending
        )
          throw new Error("Original native return liability has not been observed");
        return [call("withdraw", { id: `${state.authorization!.registration}:principal` })];
      },
    );
    await step(
      "return_test_tokens_to_project_wallet",
      plan.attendeeAccount,
      attendee,
      plan.token,
      async () => {
        const source = await observe(state);
        if (
          source.principal?.paid !== "5000000" ||
          source.principal.remaining !== "0" ||
          source.accounting.owed !== "0" ||
          source.tokenBalance !== "0" ||
          (await tokenBalance(state, plan.attendeeAccount)) !== "5000000"
        )
          throw new Error("Original native principal payment has not been observed");
        return [call("ft_transfer", { receiver_id: plan.rootAccount, amount: "5000000" }, "1")];
      },
    );
    const source = await observe(state);
    if (
      (await tokenBalance(state, plan.attendeeAccount)) !== "0" ||
      BigInt(await tokenBalance(state, plan.rootAccount)) < BigInt(state.rootTokenBaseline) ||
      source.accounting.owed !== "0" ||
      source.tokenBalance !== "0" ||
      source.registration?.booked
    )
      throw new Error("Native final balances still require reconciliation");
    sourceSettled = true;
    console.log(
      JSON.stringify({
        operationId: plan.operationId,
        completed: state.completed.length,
        principalReturned: "5000000",
        block: source.block,
        sourceQualified: false,
        liveFundingAllowed: false,
      }),
    );
  } finally {
    if (sourceLock) {
      await sourceLock.close();
      if (sourceSettled) await unlink(sourceLockPath!);
    }
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, planPath, hash] = process.argv.slice(2);
  if (
    !["execute-approved-plan", "resume-approved-plan", "recover-approved-plan"].includes(command) ||
    !planPath ||
    !hash ||
    process.argv.length !== 5
  )
    throw new Error(
      "Use execute-approved-plan or resume-approved-plan with an explicitly approved plan path and hash",
    );
  const mode =
    command === "execute-approved-plan"
      ? "execute"
      : command === "resume-approved-plan"
        ? "resume"
        : "recover";
  await run(planPath, hash, mode).catch((error: unknown) => {
    // Never print exception messages, stacks, signed images, keys or RPC bodies.
    const category =
      error instanceof Error &&
      ["Error", "TypeError", "RangeError", "AbortError", "TimeoutError"].includes(error.name)
        ? error.name
        : "Error";
    console.error(JSON.stringify({ status: "stopped", stage: operatorStage, category }));
    console.error(
      "Native engineering stopped. Preserve its private state and reconcile the original transaction before any further signing.",
    );
    process.exitCode = 1;
  });
}
