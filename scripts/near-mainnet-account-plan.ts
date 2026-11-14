import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import { compareFinalizedHeads } from "../src/server/protocol/finalized-heads";
import { decodeBase58, encodeBase58 } from "../src/server/protocol/encoding";
import { record } from "../src/server/protocol/quote-signature";
import { NearAccountNotFound, ReadOnlyRpc, unsigned } from "../src/server/protocol/rpc";

// Public project metadata. This file has no signer, credential reader or write RPC.
export const mainnetAccount = {
  implicit: "14989fbcef30b7cfabafb3380a4b707e71513eec2b22ffc6f8b8ff7cd95a11cc",
  publicKey: "ed25519:2PQ8rQ56kQV6dFeiMNwEmbbQvxiTXGFPLt2uk4UyU8cB",
  proposedName: "showup-dev-14989f.near",
  factory: "near",
  factoryCodeHash: "HiyC5tB1gBDpgR4x1guEp1orBde5PXqUYGoWaZfX3JGX",
  factorySource:
    "https://github.com/near/near-linkdrop/tree/9a6bb316f6b7c83b504ce9c94a80c37178097655",
} as const;
const gas = 100_000_000_000_000n;
const maximumGasPurchasePrice = 1_000_000_000n;
const feeCap = 102_000_000_000_000_000_000_000n;

export function accountRegistrationBudget(protocolValue: unknown, headerValue: unknown) {
  const protocol = record(protocolValue),
    runtime = record(protocol.runtime_config),
    header = record(headerValue);
  const purchasePrice = unsigned(runtime.min_gas_purchase_price, 128),
    displayedPrice = unsigned(header.gas_price, 128);
  const costs = record(runtime.transaction_costs),
    creation = record(costs.action_creation_config);
  if (
    protocol.chain_id !== "mainnet" ||
    protocol.protocol_version !== 87 ||
    purchasePrice !== maximumGasPurchasePrice ||
    displayedPrice > maximumGasPurchasePrice ||
    unsigned(runtime.account_creation_charge, 128) !== 7_000_000_000_000_000_000_000n ||
    canonicalJson(costs.pessimistic_gas_price_inflation_ratio) !== "[1,1]" ||
    unsigned(runtime.storage_amount_per_byte, 128) !== 10_000_000_000_000_000_000n
  )
    throw new Error("Mainnet account/gas policy changed; reprice before approval");
  const args = {
    new_account_id: mainnetAccount.proposedName,
    new_public_key: mainnetAccount.publicKey,
  };
  const callBytes = Buffer.byteLength("create_account") + Buffer.byteLength(JSON.stringify(args));
  const cost = (value: unknown) => {
    const c = record(value);
    return unsigned(c.send_not_sir, 64) + unsigned(c.execution, 64);
  };
  const overhead =
    cost(costs.action_receipt_creation_config) +
    cost(creation.function_call_cost) +
    cost(creation.function_call_cost_per_byte) * BigInt(callBytes);
  // Include both outer send/execution charges conservatively. The account
  // creation charge is withheld from the purchased-gas refund, not principal.
  const purchaseUpper = (gas + overhead) * maximumGasPurchasePrice;
  if (
    purchaseUpper > feeCap ||
    unsigned(record(record(runtime.wasm_config).limit_config).max_total_prepaid_gas, 64) < gas
  )
    throw new Error("Account registration exceeds the frozen gas/fee cap");
  return {
    protocolVersion: 87,
    displayedGasPrice: displayedPrice.toString(),
    minimumGasPurchasePrice: purchasePrice.toString(),
    accountCreationCharge: String(runtime.account_creation_charge),
    gasPurchaseUpper: purchaseUpper.toString(),
  };
}

export function controllerFunding(controllerValue: unknown, keysValue: unknown) {
  const controller = record(controllerValue),
    keys = record(keysValue);
  if (controller.code_hash !== "1".repeat(32) || unsigned(controller.locked, 128) !== 0n)
    throw new Error("Implicit controller has unexpected contract or locked funds");
  if (
    !Array.isArray(keys.keys) ||
    keys.keys.length !== 1 ||
    record(keys.keys[0]).public_key !== mainnetAccount.publicKey ||
    record(record(keys.keys[0]).access_key).permission !== "FullAccess"
  )
    throw new Error("Implicit controller does not have exactly the expected FullAccess key");
  // Reserve full storage even when the zero-balance allowance applies.
  const collateral = unsigned(controller.storage_usage, 64) * 10_000_000_000_000_000_000n,
    amount = unsigned(controller.amount, 128);
  return {
    amount: amount.toString(),
    storageReserve: collateral.toString(),
    availableForFees: (amount > collateral ? amount - collateral : 0n).toString(),
    sufficient: amount >= collateral + feeCap,
  };
}

export async function prepareMainnetAccountPlan(transport: typeof fetch = fetch) {
  const keyBytes = decodeBase58(mainnetAccount.publicKey.slice(8), 32);
  if (keyBytes.toString("hex") !== mainnetAccount.implicit)
    throw new Error("Public key does not match the mainnet implicit account");
  const first = new ReadOnlyRpc("near-public", transport),
    second = new ReadOnlyRpc("near-fastnear", transport);
  const signal = AbortSignal.timeout(45_000);
  const finality = await compareFinalizedHeads("near", first, second, Date.now(), signal);
  const blockHash = finality.block.hash;
  async function facts(client: ReadOnlyRpc) {
    const query = async (account_id: string, request_type = "view_account", extra: object = {}) => {
      const result = record(
        await client.read(
          "query",
          { request_type, account_id, block_id: blockHash, ...extra },
          signal,
        ),
      );
      if (
        result.block_hash !== blockHash ||
        unsigned(result.block_height, 64).toString() !== finality.block.height
      )
        throw new Error("Account planning read is outside the compared block");
      return result;
    };
    async function account(account_id: string) {
      try {
        return await query(account_id);
      } catch (error) {
        if (
          error instanceof NearAccountNotFound &&
          error.accountId === account_id &&
          error.blockHash === blockHash &&
          error.blockHeight === finality.block.height
        )
          return null;
        throw error;
      }
    }
    const [factory, code, metadata, controller, proposed, block, protocolValue] = await Promise.all(
      [
        query(mainnetAccount.factory),
        query(mainnetAccount.factory, "view_code"),
        query(mainnetAccount.factory, "call_function", {
          method_name: "contract_source_metadata",
          args_base64: "e30=",
        }),
        account(mainnetAccount.implicit),
        account(mainnetAccount.proposedName),
        client.read("block", { block_id: blockHash }, signal),
        client.read("EXPERIMENTAL_protocol_config", { block_id: blockHash }, signal),
      ],
    );
    if (proposed !== null)
      throw new Error("Proposed mainnet name already exists; do not create or fund it");
    if (typeof code.code_base64 !== "string" || code.code_base64.length > 350_000)
      throw new Error("Factory code encoding/size differs");
    const codeBytes = Buffer.from(code.code_base64, "base64"),
      digest = createHash("sha256").update(codeBytes).digest();
    if (
      factory.code_hash !== mainnetAccount.factoryCodeHash ||
      code.hash !== mainnetAccount.factoryCodeHash ||
      encodeBase58(digest) !== mainnetAccount.factoryCodeHash
    )
      throw new Error("Mainnet factory code changed");
    if (
      !Array.isArray(metadata.result) ||
      metadata.result.length > 16384 ||
      metadata.result.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    )
      throw new Error("Factory source metadata encoding differs");
    const source = record(JSON.parse(Buffer.from(metadata.result).toString("utf8")));
    if (source.link !== mainnetAccount.factorySource)
      throw new Error("Factory source claim changed");
    const header = record(record(block).header);
    if (
      header.hash !== blockHash ||
      unsigned(header.height, 64).toString() !== finality.block.height
    )
      throw new Error("Account planning block changed");
    const budget = accountRegistrationBudget(protocolValue, header);
    let funding = null;
    if (controller !== null) {
      const keys = await query(mainnetAccount.implicit, "view_access_key_list");
      funding = controllerFunding(controller, keys);
    }
    return {
      factoryCodeHash: code.hash,
      factoryBytes: codeBytes.length,
      factorySha256: digest.toString("hex"),
      sourceClaim: source.link,
      ...budget,
      funding,
    };
  }
  const [a, b] = await Promise.all([facts(first), facts(second)]);
  if (canonicalHash(a) !== canonicalHash(b))
    throw new Error("Mainnet account planning sources disagree");
  const plan = {
    format: "showup.near.mainnet.account-registration.v1",
    network: "near-mainnet",
    signer: mainnetAccount.implicit,
    publicKey: mainnetAccount.publicKey,
    operations: [
      {
        receiver: mainnetAccount.factory,
        method: "create_account",
        args: {
          new_account_id: mainnetAccount.proposedName,
          new_public_key: mainnetAccount.publicKey,
        },
        attachedYoctoNear: "0",
        gas: gas.toString(),
      },
    ],
    factoryCodeHash: mainnetAccount.factoryCodeHash,
    maximumGasPurchasePrice: maximumGasPurchasePrice.toString(),
    maximumFeeYoctoNear: feeCap.toString(),
    maximumTotalYoctoNear: feeCap.toString(),
    maximumSignedImages: 1,
    writeRetries: 0,
    recovery: {
      originalPrincipal: "0",
      uncertainSubmission:
        "Reconcile the original hash/nonce and full receipt graph; never create another image while unresolved.",
      success:
        "Verify the new account, expected FullAccess key, zero initial balance and no contract at a common finalized block.",
      failure:
        "Preserve original transaction and receipt IDs; verify account absence or actual created state before any new approval.",
      accountDeletionAllowed: false,
    },
    gates: [
      "Finalized funding and expected controller FullAccess key",
      "Owner approval of this exact batch and its signing runtime",
      "Fresh name, code, gas, nonce and balance checks before a single signature",
    ],
    deploymentAllowed: false,
    tokenTransfersAllowed: false,
    signingPerformed: false,
    keysLoaded: false,
  };
  return {
    plan,
    planHash: canonicalHash(plan),
    readEvidence: { finality, ...a },
    fundingConfirmed: a.funding?.sufficient === true,
    readyToSign: false,
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  if (process.argv.length !== 2)
    throw new Error("Account preparation accepts no credentials, RPC or execution arguments");
  const result = await prepareMainnetAccountPlan();
  const path = `/private/tmp/showup-near-mainnet-account-${Date.now()}.json`;
  await writeFile(path, canonicalJson(result) + "\n", { flag: "wx", mode: 0o600 });
  console.log(
    JSON.stringify({
      path,
      planHash: result.planHash,
      fundingConfirmed: result.fundingConfirmed,
      readyToSign: false,
      keysLoaded: false,
    }),
  );
}
