import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import { engineeringManifest, engineeringManifestHash } from "../src/server/protocol/manifest";
import { compareFinalizedHeads } from "../src/server/protocol/finalized-heads";
import { ReadOnlyRpc, unsigned } from "../src/server/protocol/rpc";
import { record } from "../src/server/protocol/quote-signature";
import { decodeBase58, encodeBase58 } from "../src/server/protocol/encoding";
import { createHash } from "node:crypto";

export const nativeEngineeringRoot = "showup-dev-14989f.testnet";
const rootAccount = nativeEngineeringRoot;
const native = 10n ** 24n;
const maximumNative = 20n * native;
const principal = "5000000";

// Public metadata only. Preparation never loads a key, signs, creates accounts,
// funds an event or calls a mutating RPC method. Execution needs owner approval.
export async function prepareNativeEngineeringPlan(transport: typeof fetch = fetch) {
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
    const call = async (method_name: string, args: object) => {
      const response = await query("call_function", asset.usdc, {
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
    return {
      rootNativeBalance: unsigned(account.amount, 128).toString(),
      rootTokenBalance: unsigned(balance, 128).toString(),
      tokenCodeHash: token.code_hash,
      tokenStorageMinimum: unsigned(record(storage).min, 128).toString(),
      storagePricePerByte: unsigned(
        record(protocol.runtime_config).storage_amount_per_byte,
        128,
      ).toString(),
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
  const escrowNative =
    ((BigInt(wasm.length + 65_536) * storagePrice + native - 1n) / native + 1n) * native;
  const attendeeNative = native / 4n;
  const requiredNative =
    escrowNative + attendeeNative + 2n * BigInt(a.tokenStorageMinimum) + 2n * native;
  if (requiredNative > maximumNative)
    throw new Error("Engineering artifact exceeds the proposed native budget");
  const operationId = randomUUID(),
    suffix = operationId.replaceAll("-", "").slice(0, 10);
  const requirements = [
    ...(BigInt(a.rootNativeBalance) < requiredNative ? ["fund_project_testnet_native_wallet"] : []),
    ...(BigInt(a.rootNativeBalance) > maximumNative
      ? ["review_isolated_native_spending_budget"]
      : []),
    ...(BigInt(a.rootTokenBalance) < BigInt(principal)
      ? ["fund_project_testnet_token_wallet"]
      : []),
    "owner_public_signing_and_deployment_approval",
  ];
  const plan = {
    format: "showup.native-engineering.plan.v1",
    operationId,
    network: "near-testnet",
    domain: engineeringManifest.signingDomain,
    manifest: engineeringManifestHash,
    rootAccount,
    walletConsentOrigin: "https://liable-pleat-maritime.ngrok-free.dev",
    escrowAccount: `e-${suffix}.${rootAccount}`,
    attendeeAccount: `a-${suffix}.${rootAccount}`,
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
      maximumGasPerCall: "300000000000000",
    },
    facts: a,
    observedBlock: compared.block,
    sourceIds: compared.sourceIds,
    steps: [
      "create_escrow",
      "create_attendee",
      "deploy_pinned_wasm",
      "initialize_engineering_profile",
      "register_escrow_token_storage",
      "register_attendee_token_storage",
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
  if (process.argv.length !== 2)
    throw new Error("Preparation accepts no key, RPC or execution argument.");
  const result = await prepareNativeEngineeringPlan();
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
