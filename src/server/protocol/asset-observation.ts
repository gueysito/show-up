import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "./canonical";
import { decodeBase58 } from "./encoding";
import { engineeringManifest } from "./manifest";
import { custodyIntentHash, type CustodyIntent } from "./custody-transactions";
import { unsigned } from "./rpc";

export type AssetObservation = {
  format: string;
  domain: string;
  deployment: string;
  manifest: string;
  event: string;
  rules_hash: string;
  network: string;
  chain_id: string;
  profile_hash: string;
  sources: [string, string];
  collection: string;
  asset: string;
  custody: string;
  owner: string;
  operation: string;
  intent_hash: string | null;
  image_hash: string | null;
  transaction: string | null;
  transaction_block_height: string | null;
  transaction_block_hash: string | null;
  transaction_ms: number | null;
  block_height: string;
  block_hash: string;
  block_ms: number;
  observed_ms: number;
  expires_ms: number;
  finalized: boolean;
  fee: string;
};
export type ObservationContext = {
  domain: string;
  deployment: string;
  event: string;
  rules_hash: string;
  custody: { network: string; collection: string; asset: string; source: string };
  policy: { key: string; profile_hash: string; sources: [string, string] };
  intent?: CustodyIntent;
  image?: ObservationImage;
  images?: ObservationImage[];
};
type ObservationImage = {
  intent_hash: string;
  unsigned: string;
  execution?: { fee_exposure: string };
};
const fields: (keyof AssetObservation)[] = [
  "format",
  "domain",
  "deployment",
  "manifest",
  "event",
  "rules_hash",
  "network",
  "chain_id",
  "profile_hash",
  "sources",
  "collection",
  "asset",
  "custody",
  "owner",
  "operation",
  "intent_hash",
  "image_hash",
  "transaction",
  "transaction_block_height",
  "transaction_block_hash",
  "transaction_ms",
  "block_height",
  "block_hash",
  "block_ms",
  "observed_ms",
  "expires_ms",
  "finalized",
  "fee",
];

function hash(network: string, value: string, transaction = false) {
  if (network === "solana") decodeBase58(value, transaction ? 64 : 32);
  else if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error("Invalid observation hash");
}

function observedImage(receipt: AssetObservation, context: ObservationContext) {
  const images = context.images ?? (context.image ? [context.image] : []);
  if (images.length > 3) throw new Error("Observation signing history limit");
  return images.find(
    (image) =>
      createHash("sha256").update(Buffer.from(image.unsigned, "base64")).digest("hex") ===
      receipt.image_hash,
  );
}

export function assetObservationFeeReview(
  receipt: AssetObservation,
  context: ObservationContext,
): boolean {
  try {
    if (receipt.operation === "holding") return false;
    const image = observedImage(receipt, context);
    return (
      !context.intent ||
      !image?.execution ||
      unsigned(receipt.fee, 128) > unsigned(context.intent.feeCap, 128) ||
      unsigned(receipt.fee, 128) > unsigned(image.execution.fee_exposure, 128)
    );
  } catch {
    return true;
  }
}

// Verification only, against already frozen event/key/intent context. No key
// creation, RPC fetch, signature request, route activation or recipient choice.
export function verifyAssetObservation(
  receipt: AssetObservation,
  proof: string,
  context: ObservationContext,
  now: number,
): boolean {
  try {
    if (
      Object.keys(receipt).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(receipt, field))
    )
      return false;
    const network = engineeringManifest.networks.find(
      (item) => item.id === context.custody.network,
    );
    if (!network || network.id === "near") return false;
    if (
      receipt.format !== "showup.asset.observation.v2" ||
      receipt.domain !== context.domain ||
      receipt.deployment !== context.deployment ||
      receipt.event !== context.event ||
      receipt.rules_hash !== context.rules_hash ||
      receipt.manifest !== engineeringManifest.revision ||
      receipt.network !== network.id ||
      receipt.chain_id !== network.chainId ||
      receipt.profile_hash !== context.policy.profile_hash ||
      canonicalJson(receipt.sources) !== canonicalJson(context.policy.sources) ||
      receipt.collection !== context.custody.collection ||
      receipt.asset !== context.custody.asset ||
      receipt.custody !== context.custody.source ||
      receipt.finalized !== true ||
      typeof receipt.block_height !== "string" ||
      !/^(0|[1-9][0-9]{0,19})$/.test(receipt.block_height) ||
      typeof receipt.fee !== "string" ||
      !/^(0|[1-9][0-9]{0,38})$/.test(receipt.fee) ||
      unsigned(receipt.block_height, 64) === 0n
    )
      return false;
    for (const time of [receipt.block_ms, receipt.observed_ms, receipt.expires_ms, now])
      if (!Number.isSafeInteger(time) || time < 0) return false;
    if (
      receipt.block_ms > receipt.observed_ms ||
      receipt.observed_ms > now ||
      now - receipt.observed_ms > 60_000 ||
      receipt.observed_ms - receipt.block_ms > (network.id === "solana" ? 120_000 : 1_800_000) ||
      receipt.expires_ms <= now ||
      receipt.expires_ms <= receipt.observed_ms ||
      receipt.expires_ms - receipt.observed_ms > 60_000
    )
      return false;
    hash(network.id, receipt.block_hash);
    if (network.id === "solana") decodeBase58(receipt.owner, 32);
    else if (!/^0x[0-9a-f]{40}$/.test(receipt.owner) || /^0x0{40}$/.test(receipt.owner))
      return false;
    if (receipt.operation === "holding") {
      if (
        receipt.intent_hash !== null ||
        receipt.image_hash !== null ||
        receipt.transaction !== null ||
        receipt.transaction_block_height !== null ||
        receipt.transaction_block_hash !== null ||
        receipt.transaction_ms !== null ||
        unsigned(receipt.fee, 128) !== 0n
      )
        return false;
    } else {
      const { intent } = context;
      const image = observedImage(receipt, context);
      if (
        !intent ||
        !image ||
        intent.deployment !== context.deployment ||
        intent.event !== context.event ||
        intent.rulesHash !== context.rules_hash ||
        intent.network !== network.id ||
        intent.environment !== "engineering" ||
        intent.manifest !== engineeringManifest.revision ||
        intent.collection !== context.custody.collection ||
        intent.asset !== context.custody.asset ||
        intent.source !== context.custody.source ||
        !["delivery", "return"].includes(receipt.operation) ||
        receipt.operation !== intent.operation ||
        receipt.owner !== intent.recipient ||
        receipt.intent_hash !== image.intent_hash ||
        image.intent_hash !== custodyIntentHash(intent) ||
        receipt.image_hash !==
          createHash("sha256").update(Buffer.from(image.unsigned, "base64")).digest("hex")
      )
        return false;
      if (!receipt.transaction) return false;
      hash(network.id, receipt.transaction, true);
      if (
        typeof receipt.transaction_block_height !== "string" ||
        !/^[1-9][0-9]{0,19}$/.test(receipt.transaction_block_height) ||
        unsigned(receipt.transaction_block_height, 64) > unsigned(receipt.block_height, 64) ||
        !receipt.transaction_block_hash ||
        receipt.transaction_ms === null ||
        !Number.isSafeInteger(receipt.transaction_ms) ||
        receipt.transaction_ms <= 0 ||
        receipt.transaction_ms > receipt.block_ms
      )
        return false;
      hash(network.id, receipt.transaction_block_hash);
      if (
        receipt.transaction_block_height === receipt.block_height &&
        receipt.transaction_block_hash !== receipt.block_hash
      )
        return false;
    }
    const key = Buffer.from(context.policy.key, "base64");
    const signature = Buffer.from(proof, "base64");
    if (
      key.length !== 32 ||
      key.toString("base64") !== context.policy.key ||
      signature.length !== 64 ||
      signature.toString("base64") !== proof
    )
      return false;
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") },
      format: "jwk",
    });
    return verify(null, Buffer.from(canonicalJson(receipt)), publicKey, signature);
  } catch {
    return false;
  }
}
