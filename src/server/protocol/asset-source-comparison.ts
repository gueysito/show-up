import { setTimeout as delay } from "node:timers/promises";
import { Interface, keccak256 } from "ethers";
import { canonicalHash } from "./canonical";
import { custodyChainId, custodyIntentHash, type CustodyIntent } from "./custody-transactions";
import { decodeBase58 } from "./encoding";
import { normalizeEvmAssetEvidence, normalizeEvmHolding } from "./evm-asset-evidence";
import { compareFinalizedBlock, compareFinalizedHeads } from "./finalized-heads";
import { networkIdentity } from "./manifest";
import { record } from "./quote-signature";
import { ReadOnlyRpc, unsigned } from "./rpc";
import { normalizeCoreHolding, normalizeSolanaAssetEvidence } from "./solana-asset-evidence";

const erc721 = new Interface(["function ownerOf(uint256 tokenId) view returns (address)"]);
function network(intent: CustodyIntent) {
  custodyIntentHash(intent);
  if (
    intent.environment !== "mainnet" ||
    !["base", "ethereum", "solana"].includes(intent.network) ||
    custodyChainId(intent) !== networkIdentity(intent.network).chainId
  )
    throw new Error("No fixed read sources for this custody environment/network");
  return intent.network;
}
function agree<T>(a: T, b: T): T {
  if (canonicalHash(a) !== canonicalHash(b)) throw new Error("Exact-asset sources disagree");
  return a;
}
function result<T>(fact: T, finality: Awaited<ReturnType<typeof compareFinalizedHeads>>) {
  return {
    fact,
    finality,
    matched: true as const,
    independenceVerified: false as const,
    assetQualified: false as const,
    fundingAllowed: false as const,
  };
}

// Fixed public candidates only. No service key, signing key, dynamic origin,
// broadcaster or publication write. A matching observation remains unqualified.
export async function compareCustodyHoldingSources(
  intent: CustodyIntent,
  first: ReadOnlyRpc,
  second: ReadOnlyRpc,
) {
  const kind = network(intent),
    signal = AbortSignal.timeout(30_000);
  const initial = await compareFinalizedHeads(kind, first, second, Date.now(), signal);
  if (kind !== "solana") {
    const block = { blockHash: initial.block.hash, requireCanonical: true };
    const read = async (client: ReadOnlyRpc) => {
      const [owner, code] = await Promise.all([
        client.read(
          "eth_call",
          [
            {
              to: intent.collection,
              data: erc721.encodeFunctionData("ownerOf", [BigInt(intent.asset)]),
              gas: "0x493e0",
            },
            block,
          ],
          signal,
        ),
        client.read("eth_getCode", [intent.collection, block], signal),
      ]);
      if (typeof code !== "string" || !/^0x(?:[0-9a-f]{2}){1,65536}$/.test(code))
        throw new Error("Missing or oversized collection code");
      return { ...normalizeEvmHolding(intent, owner, initial.block), codeHash: keccak256(code) };
    };
    const [a, b] = await Promise.all([read(first), read(second)]);
    return result(agree(a, b), initial);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const params = [
      intent.asset,
      { commitment: "finalized", encoding: "base64", minContextSlot: Number(initial.block.height) },
    ];
    const [a, b] = await Promise.all([
      first.read("getAccountInfo", params, signal),
      second.read("getAccountInfo", params, signal),
    ]);
    const aSlot = unsigned(record(record(a).context).slot, 64),
      bSlot = unsigned(record(record(b).context).slot, 64);
    if (aSlot !== bSlot) {
      if (attempt === 2) throw new Error("Finalized account response slots disagree");
      await delay(250 * (attempt + 1), undefined, { signal });
      continue;
    }
    if (aSlot < unsigned(initial.block.height, 64) || aSlot > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Account response is behind the required finalized bank");
    const finality = await compareFinalizedBlock(
      "solana",
      first,
      second,
      aSlot.toString(),
      Date.now(),
      signal,
    );
    const context = {
      intent,
      chainId: custodyChainId(intent),
      queriedAsset: intent.asset,
      finalized: finality.block,
    };
    return result(
      agree(
        normalizeCoreHolding({ ...context, account: a }),
        normalizeCoreHolding({ ...context, account: b }),
      ),
      finality,
    );
  }
  throw new Error("No matching finalized asset snapshot");
}

function signingImage(value: string) {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("Invalid stored signing image");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > 1024 || bytes.toString("base64") !== value)
    throw new Error("Noncanonical stored signing image");
  return bytes;
}

export async function compareCustodyDeliverySources(
  input: { intent: CustodyIntent; storedImageBase64: string; transaction: string },
  first: ReadOnlyRpc,
  second: ReadOnlyRpc,
) {
  const kind = network(input.intent),
    image = signingImage(input.storedImageBase64),
    signal = AbortSignal.timeout(30_000);
  if (kind === "solana") decodeBase58(input.transaction, 64);
  else if (!/^0x[0-9a-f]{64}$/.test(input.transaction))
    throw new Error("Invalid custody transaction hash");
  const finality = await compareFinalizedHeads(kind, first, second, Date.now(), signal);
  const uncertain = { outcome: "uncertain" as const, fundingAllowed: false as const };
  const read = async (client: ReadOnlyRpc) => {
    if (kind !== "solana") {
      const [transaction, receipt] = await Promise.all([
        client.read("eth_getTransactionByHash", [input.transaction], signal),
        client.read("eth_getTransactionReceipt", [input.transaction], signal),
      ]);
      if (transaction === null || receipt === null) return uncertain;
      const height = unsigned(record(receipt).blockNumber, 64);
      const block = await client.read(
        "eth_getBlockByNumber",
        ["0x" + height.toString(16), false],
        signal,
      );
      return normalizeEvmAssetEvidence({
        intent: input.intent,
        storedUnsigned: "0x" + image.toString("hex"),
        requestedHash: input.transaction,
        transaction,
        receipt,
        inclusionBlock: block,
        finalized: finality.block,
        ownerOfAtFinalized: null,
      });
    }
    const [transaction, statuses] = await Promise.all([
      client.read(
        "getTransaction",
        [
          input.transaction,
          { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 },
        ],
        signal,
      ),
      client.read(
        "getSignatureStatuses",
        [[input.transaction], { searchTransactionHistory: true }],
        signal,
      ),
    ]);
    const values = record(statuses).value;
    if (!Array.isArray(values) || values.length !== 1)
      throw new Error("Invalid signature status response");
    if (transaction === null || values[0] === null) return uncertain;
    const slot = unsigned(record(transaction).slot, 64);
    if (slot > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe transaction slot");
    const block = await client.read(
      "getBlock",
      [
        Number(slot),
        {
          commitment: "finalized",
          transactionDetails: "signatures",
          rewards: false,
          maxSupportedTransactionVersion: 0,
        },
      ],
      signal,
    );
    return normalizeSolanaAssetEvidence({
      intent: input.intent,
      chainId: custodyChainId(input.intent),
      storedUnsigned: input.storedImageBase64,
      requestedSignature: input.transaction,
      transaction,
      signatureStatuses: statuses,
      inclusionSlot: slot.toString(),
      inclusionBlock: block,
      finalized: finality.block,
      queriedAsset: input.intent.asset,
      accountAtFinalized: null,
    });
  };
  const [a, b] = await Promise.all([read(first), read(second)]);
  return result(agree(a, b), finality);
}
