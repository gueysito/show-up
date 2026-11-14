import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import { engineeringManifest, engineeringManifestHash } from "../src/server/protocol/manifest";
import { compareFinalizedHeads } from "../src/server/protocol/finalized-heads";
import { ReadOnlyRpc, unsigned } from "../src/server/protocol/rpc";
import { record } from "../src/server/protocol/quote-signature";
import { decodeBase58, encodeBase58 } from "../src/server/protocol/encoding";
import { createHash } from "node:crypto";
import retainedReceipt from "../docs/evidence/native-testnet-2750f947-d374-424d-9b4c-328379227ada.json" with { type: "json" };

export const nativeEngineeringRoot = "showup-dev-14989f.testnet";
export const nativeEngineeringGas = "200000000000000";
export const retainedNativeDeployment = retainedReceipt;
const rootAccount = nativeEngineeringRoot;
const native = 10n ** 24n;
const maximumNative = 20n * native;
const principal = "5000000";

// Public metadata only. Preparation never loads a key, signs, creates accounts,
// funds an event or calls a mutating RPC method. Execution needs owner approval.
export async function prepareNativeEngineeringPlan(
  transport: typeof fetch = fetch,
  reuseRetained = false,
) {
  const first = new ReadOnlyRpc("near-testnet-archival", transport),
    second = new ReadOnlyRpc("near-testnet-fastnear", transport),
    signal = AbortSignal.timeout(30_000);
  const compared = await compareFinalizedHeads(
    "near",
    first,
    second,
    Date.now(),
    signal,
    "engineering",
  );
  const asset = engineeringManifest.networks.find((item) => item.id === "near")!;
  const wasm = await readFile(
    new URL(
      "../contracts/.cache/target/wasm32-unknown-unknown/release/showup_escrow.wasm",
      import.meta.url,
    ),
  );
  const digest = createHash("sha256").update(wasm).digest();
  const artifact = {
    bytes: wasm.length,
    sha256: digest.toString("hex"),
    codeHash: encodeBase58(digest),
  };
  if (reuseRetained && canonicalJson(artifact) !== canonicalJson(retainedReceipt.contractArtifact))
    throw new Error("Retained deployment artifact differs from the recorded receipt");
  async function facts(client: ReadOnlyRpc) {
    const query = async (
      request_type: string,
      account_id: string,
      extra: Record<string, unknown> = {},
    ) => {
      const response = record(
        await client.read(
          "query",
          { request_type, account_id, block_id: compared.block.hash, ...extra },
          signal,
        ),
      );
      if (
        response.block_hash !== compared.block.hash ||
        unsigned(response.block_height, 64).toString() !== compared.block.height
      )
        throw new Error("Engineering preflight view differs from the finalized block");
      return response;
    };
    const call = async (method_name: string, args: object, account = asset.usdc) => {
      const response = await query("call_function", account, {
        method_name,
        args_base64: Buffer.from(canonicalJson(args)).toString("base64"),
      });
      if (
        !Array.isArray(response.result) ||
        response.result.length > 16_384 ||
        response.result.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
      )
        throw new Error("Engineering asset view encoding unavailable");
      return JSON.parse(Buffer.from(response.result).toString("utf8"));
    };
    const [account, token, metadata, balance, storage, protocolValue] = await Promise.all([
      query("view_account", rootAccount),
      query("view_account", asset.usdc),
      call("ft_metadata", {}),
      call("ft_balance_of", { account_id: rootAccount }),
      call("storage_balance_bounds", {}),
      client.read("EXPERIMENTAL_protocol_config", { block_id: compared.block.hash }, signal),
    ]);
    const protocol = record(protocolValue);
    if (protocol.chain_id !== "testnet" || record(metadata).decimals !== 6)
      throw new Error("Engineering network or token precision differs from the pinned profile");
    if (typeof token.code_hash !== "string") throw new Error("Engineering token code unavailable");
    decodeBase58(token.code_hash, 32);
    let retained = null;
    if (reuseRetained) {
      const { escrowAccount, attendeeAccount } = retainedReceipt.accounts;
      const initializationHash = retainedReceipt.transactions.find(
        (item) => item.step === "initialize_engineering_profile",
      )!.hash;
      const [
        escrow,
        attendee,
        escrowTokens,
        attendeeTokens,
        escrowStorage,
        attendeeStorage,
        ledger,
        initialized,
      ] = await Promise.all([
        query("view_account", escrowAccount),
        query("view_account", attendeeAccount),
        call("ft_balance_of", { account_id: escrowAccount }),
        call("ft_balance_of", { account_id: attendeeAccount }),
        call("storage_balance_of", { account_id: escrowAccount }),
        call("storage_balance_of", { account_id: attendeeAccount }),
        call("accounting", {}, escrowAccount),
        client.read(
          "tx",
          {
            tx_hash: initializationHash,
            sender_account_id: escrowAccount,
            wait_until: "NONE",
          },
          signal,
        ),
      ]);
      const initialization = record(initialized),
        transaction = record(initialization.transaction);
      const actions = transaction.actions;
      if (!Array.isArray(actions) || actions.length !== 1)
        throw new Error("Retained initialization unavailable");
      const action = record(record(actions[0]).FunctionCall);
      if (
        initialization.final_execution_status !== "FINAL" ||
        transaction.hash !== initializationHash ||
        transaction.signer_id !== escrowAccount ||
        transaction.receiver_id !== escrowAccount ||
        action.method_name !== "new" ||
        typeof action.args !== "string" ||
        action.args.length > 4096
      )
        throw new Error("Retained initialization differs from its receipt");
      const init = record(JSON.parse(Buffer.from(action.args, "base64").toString("utf8")));
      for (const field of ["credential_key", "evidence_key"])
        if (typeof init[field] !== "string" || Buffer.from(init[field], "base64").length !== 32)
          throw new Error("Retained authority key unavailable");
      const accounting = record(ledger);
      const nativeStorageCost =
        unsigned(escrow.storage_usage, 64) *
        unsigned(record(protocol.runtime_config).storage_amount_per_byte, 128);
      if (unsigned(escrow.amount, 128) < nativeStorageCost + native)
        throw new Error(
          "Retained escrow needs reviewed native funding above its storage collateral",
        );
      if (
        escrow.code_hash !== artifact.codeHash ||
        attendee.code_hash !== encodeBase58(Buffer.alloc(32)) ||
        init.token !== asset.usdc ||
        init.domain !== engineeringManifest.signingDomain ||
        init.manifest !== engineeringManifestHash ||
        init.credential_key === init.evidence_key ||
        unsigned(escrowTokens, 128) !== 0n ||
        unsigned(attendeeTokens, 128) !== 0n ||
        unsigned(accounting.owed, 128) !== 0n ||
        unsigned(accounting.unallocated, 128) !== 0n ||
        unsigned(accounting.received, 128) !== unsigned(accounting.delivered, 128) ||
        unsigned(record(escrowStorage).total, 128) < unsigned(record(storage).min, 128) ||
        unsigned(record(attendeeStorage).total, 128) < unsigned(record(storage).min, 128)
      )
        throw new Error("Retained deployment has changed or holds unresolved funds");
      retained = {
        escrowNativeBalance: unsigned(escrow.amount, 128).toString(),
        attendeeNativeBalance: unsigned(attendee.amount, 128).toString(),
        credentialKey: String(init.credential_key),
        evidenceKey: String(init.evidence_key),
        escrowCodeHash: String(escrow.code_hash),
      };
    }
    return {
      rootNativeBalance: unsigned(account.amount, 128).toString(),
      rootTokenBalance: unsigned(balance, 128).toString(),
      tokenCodeHash: token.code_hash,
      tokenStorageMinimum: unsigned(record(storage).min, 128).toString(),
      storagePricePerByte: unsigned(
        record(protocol.runtime_config).storage_amount_per_byte,
        128,
      ).toString(),
      retained,
    };
  }
  const [a, b] = await Promise.all([facts(first), facts(second)]);
  if (canonicalJson(a) !== canonicalJson(b))
    throw new Error("Engineering preflight sources disagree");
  const storagePrice = BigInt(a.storagePricePerByte);
  if (!storagePrice || BigInt(a.tokenStorageMinimum) > native / 10n)
    throw new Error("Engineering storage budget requires a new review");
  // WASM plus bounded event-state allowance, rounded up, with one native token
  // left free in escrow. This is execution funding, separate from test principal.
  const escrowNative = reuseRetained
    ? 0n
    : ((BigInt(wasm.length + 65_536) * storagePrice + native - 1n) / native + 1n) * native;
  const attendeeNative = reuseRetained ? native : native / 4n;
  const requiredNative = reuseRetained
    ? (native * 3n) / 2n
    : escrowNative + attendeeNative + 2n * BigInt(a.tokenStorageMinimum) + 2n * native;
  if (requiredNative > maximumNative)
    throw new Error("Engineering artifact exceeds the proposed native budget");
  const operationId = randomUUID(),
    suffix = operationId.replaceAll("-", "").slice(0, 10);
  const requirements = [
    ...(BigInt(a.rootNativeBalance) < requiredNative ? ["fund_project_testnet_native_wallet"] : []),
    ...(BigInt(a.rootNativeBalance) +
      BigInt(a.retained?.escrowNativeBalance ?? "0") +
      BigInt(a.retained?.attendeeNativeBalance ?? "0") >
    maximumNative
      ? ["review_isolated_native_spending_budget"]
      : []),
    ...(BigInt(a.rootTokenBalance) < BigInt(principal)
      ? ["fund_project_testnet_token_wallet"]
      : []),
    reuseRetained
      ? "owner_public_signing_reuse_approval"
      : "owner_public_signing_and_deployment_approval",
  ];
  const plan = {
    format: reuseRetained
      ? "showup.native-engineering.reuse-plan.v1"
      : "showup.native-engineering.plan.v1",
    ...(reuseRetained
      ? {
          reuseOf: retainedReceipt.operationId,
          keySourcePlanHash: retainedReceipt.originalPlanHash,
        }
      : {}),
    operationId,
    network: "near-testnet",
    domain: engineeringManifest.signingDomain,
    manifest: engineeringManifestHash,
    rootAccount,
    walletConsentOrigin: "https://liable-pleat-maritime.ngrok-free.dev",
    escrowAccount: reuseRetained
      ? retainedReceipt.accounts.escrowAccount
      : `e-${suffix}.${rootAccount}`,
    attendeeAccount: reuseRetained
      ? retainedReceipt.accounts.attendeeAccount
      : `a-${suffix}.${rootAccount}`,
    token: asset.usdc,
    artifact,
    scope: {
      principal,
      capacity: 1,
      sponsorBudget: "0",
      nft: false,
      quizzes: 0,
      startsAfterMs: 3_600_000,
      durationMs: 1_800_000,
    },
    budget: {
      maximumNative: maximumNative.toString(),
      minimumNative: requiredNative.toString(),
      escrowNative: escrowNative.toString(),
      attendeeNative: attendeeNative.toString(),
      tokenStorageMinimum: a.tokenStorageMinimum,
      maximumTestTokenPrincipal: principal,
      maximumGasPerCall: nativeEngineeringGas,
    },
    facts: a,
    observedBlock: compared.block,
    sourceIds: compared.sourceIds,
    steps: [
      ...(reuseRetained
        ? ["top_up_retained_attendee"]
        : [
            "create_escrow",
            "create_attendee",
            "deploy_pinned_wasm",
            "initialize_engineering_profile",
            "register_escrow_token_storage",
            "register_attendee_token_storage",
          ]),
      "allocate_exact_test_principal",
      "create_fixed_event",
      "publish",
      "reserve_original_authorization",
      "fund_original_registration",
      "release_original_registration",
      "withdraw_original_principal",
      "return_test_tokens_to_project_wallet",
    ],
    recovery: {
      maximumAdditionalImages: 4,
      reconcileOriginalHashBeforeRecovery: true,
      newDepositOrReservationAllowed: false,
      actions: [
        "cancel_or_abort_original_event",
        "fail_neutral_after_original_deadline",
        "withdraw_original_liabilities",
        "return_original_test_principal",
      ],
      retainChildAccountsAndKeys: true,
    },
    requirements,
    sourceQualified: false,
    liveFundingAllowed: false,
    signingPerformed: false,
    keysLoaded: false,
  };
  return { plan, planHash: canonicalHash(plan) };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--reuse-retained"))
    throw new Error("Preparation accepts no key, RPC or execution argument.");
  const result = await prepareNativeEngineeringPlan(fetch, process.argv[2] === "--reuse-retained");
  const path = `/private/tmp/showup-native-engineering-${result.plan.operationId}.json`;
  await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
  console.log(
    JSON.stringify({
      path,
      planHash: result.planHash,
      requirements: result.plan.requirements,
      signingPerformed: false,
      keysLoaded: false,
    }),
  );
}
