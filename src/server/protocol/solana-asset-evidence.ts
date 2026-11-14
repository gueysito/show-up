import { createHash, createPublicKey, verify } from "node:crypto";
import {
  coreProgram,
  custodyChainId,
  solanaCustodyMessage,
  type CustodyIntent,
} from "./custody-transactions";
import { decodeBase58, encodeBase58 } from "./encoding";
import type { FinalizedHeader } from "./finalized-heads";
import { record } from "./quote-signature";
import { unsigned } from "./rpc";

function bytes(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > maximum * 2)
    throw new Error("Invalid Solana evidence bytes");
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maximum || decoded.toString("base64") !== value)
    throw new Error("Noncanonical Solana evidence bytes");
  return decoded;
}
function encoded(value: unknown, maximum: number): Buffer {
  if (!Array.isArray(value) || value.length !== 2 || value[1] !== "base64")
    throw new Error("Expected raw base64 RPC data");
  return bytes(value[0], maximum);
}

// Pin: mpl-core a5c35db generated BaseAssetV1/UpdateAuthority/Key definitions.
// Deliberately only an uncompressed collection asset with no appended plugins.
// Collection/program authorities still require a separate qualification review.
export function decodeSimpleCoreAsset(data: Buffer, collection: string) {
  if (data.length < 75 || data.length > 8192 || data[0] !== 1 || data[33] !== 2)
    throw new Error("Unsupported Core asset/update authority");
  if (encodeBase58(data.subarray(34, 66)) !== collection) throw new Error("Wrong Core collection");
  let offset = 66;
  for (let field = 0; field < 2; field++) {
    if (offset + 4 > data.length) throw new Error("Truncated Core text length");
    const length = data.readUInt32LE(offset);
    offset += 4;
    if (length > 2048 || offset + length > data.length) throw new Error("Invalid Core text bounds");
    new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset, offset + length));
    offset += length;
  }
  const sequence = data[offset++];
  if (sequence === 1) offset += 8;
  else if (sequence !== 0) throw new Error("Invalid Core sequence option");
  if (offset !== data.length)
    throw new Error("Core plugins, padding or truncated sequence are unqualified");
  return { owner: encodeBase58(data.subarray(1, 33)), collection };
}

export function normalizeCoreHolding(input: {
  intent: CustodyIntent;
  chainId: string;
  queriedAsset: string;
  account: unknown;
  finalized: FinalizedHeader;
}) {
  if (
    input.intent.network !== "solana" ||
    input.chainId !== custodyChainId(input.intent) ||
    input.queriedAsset !== input.intent.asset
  )
    throw new Error("Wrong Solana asset context");
  const account = record(input.account),
    context = record(account.context),
    value = record(account.value);
  // minContextSlot is a lower bound, not a historical-state pin. Require the
  // actual account response's slot to be the compared finalized bank exactly.
  if (
    unsigned(context.slot, 64).toString() !== input.finalized.height ||
    value.owner !== coreProgram ||
    value.executable !== false
  )
    throw new Error("Core account is not from the compared finalized slot/program");
  decodeBase58(input.finalized.hash, 32);
  const data = encoded(value.data, 8192);
  if (
    value.space !== undefined &&
    value.space !== null &&
    unsigned(value.space) !== BigInt(data.length)
  )
    throw new Error("Core account data size mismatch");
  const lamports = unsigned(value.lamports, 64);
  const asset = decodeSimpleCoreAsset(data, input.intent.collection);
  return {
    ...asset,
    held: asset.owner === input.intent.source,
    asset: input.intent.asset,
    dataSha256: createHash("sha256").update(data).digest("hex"),
    lamports: lamports.toString(),
    program: coreProgram,
    slot: input.finalized.height,
    blockHash: input.finalized.hash,
    authorityQualified: false as const,
    fundingAllowed: false as const,
  };
}

function signedImage(
  intent: CustodyIntent,
  storedUnsigned: string,
  wire: Buffer,
  requestedSignature: string,
) {
  const message = bytes(storedUnsigned, 1024);
  if (
    message.length < 269 ||
    wire.length !== message.length + 65 ||
    wire[0] !== 1 ||
    !wire.subarray(65).equals(message) ||
    encodeBase58(wire.subarray(1, 65)) !== requestedSignature
  )
    throw new Error("Executed Solana wire image/signature mismatch");
  const expected = solanaCustodyMessage(intent, {
    blockhash: encodeBase58(message.subarray(228, 260)),
    computeUnits: message.readUInt32LE(265),
    estimatedFee: "1",
  });
  if (expected.message !== storedUnsigned)
    throw new Error("Solana image is not the fixed authorized transfer");
  const key = decodeBase58(intent.source, 32);
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") },
    format: "jwk",
  });
  if (!verify(null, message, publicKey, wire.subarray(1, 65)))
    throw new Error("Invalid custody signer");
}

// One source's raw transaction/status/account facts only. Independent source and
// cluster identity checks must precede this; no receipt is signed or route enabled.
export function normalizeSolanaAssetEvidence(input: {
  intent: CustodyIntent;
  chainId: string;
  storedUnsigned: string;
  requestedSignature: string;
  transaction: unknown;
  signatureStatuses: unknown;
  inclusionSlot: string;
  inclusionBlock: unknown;
  finalized: FinalizedHeader;
  queriedAsset: string;
  accountAtFinalized: unknown;
}) {
  if (input.intent.network !== "solana" || input.chainId !== custodyChainId(input.intent))
    throw new Error("Wrong evidence family/cluster");
  decodeBase58(input.requestedSignature, 64);
  const raw = record(input.transaction),
    meta = record(raw.meta),
    block = record(input.inclusionBlock);
  const slot = unsigned(raw.slot, 64);
  if (
    raw.version !== "legacy" ||
    slot === 0n ||
    slot.toString() !== input.inclusionSlot ||
    slot > unsigned(input.finalized.height, 64) ||
    input.finalized.blockHeight === undefined ||
    unsigned(block.blockHeight, 64) > unsigned(input.finalized.blockHeight, 64) ||
    unsigned(block.blockTime, 64) !== unsigned(raw.blockTime, 64)
  )
    throw new Error("Transaction is not in compared finalized history");
  if (typeof block.blockhash !== "string") throw new Error("Missing Solana inclusion block hash");
  decodeBase58(block.blockhash, 32);
  if (
    (slot.toString() === input.finalized.height && block.blockhash !== input.finalized.hash) ||
    !Array.isArray(block.signatures) ||
    block.signatures.length > 30_000 ||
    block.signatures.filter((signature) => signature === input.requestedSignature).length !== 1
  )
    throw new Error("Solana transaction inclusion missing or conflicting");
  signedImage(
    input.intent,
    input.storedUnsigned,
    encoded(raw.transaction, 1280),
    input.requestedSignature,
  );
  const statuses = record(input.signatureStatuses);
  if (!Array.isArray(statuses.value) || statuses.value.length !== 1)
    throw new Error("Missing historical signature status");
  const status = record(statuses.value[0]);
  if (
    unsigned(record(statuses.context).slot, 64) < slot ||
    status.confirmationStatus !== "finalized" ||
    status.confirmations !== null ||
    unsigned(status.slot, 64) !== slot ||
    JSON.stringify(status.err) !== JSON.stringify(meta.err)
  )
    throw new Error("Signature is not finalized with the same outcome");
  if (meta.err === undefined || (meta.err !== null && typeof meta.err !== "object"))
    throw new Error("Invalid transaction outcome");
  if (meta.loadedAddresses !== undefined) {
    const loaded = record(meta.loadedAddresses);
    if (
      !Array.isArray(loaded.readonly) ||
      !Array.isArray(loaded.writable) ||
      loaded.readonly.length ||
      loaded.writable.length
    )
      throw new Error("Loaded accounts forbidden in fixed legacy transfer");
  }
  if (
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== 7 ||
    meta.postBalances.length !== 7
  )
    throw new Error("Missing fixed-account balance evidence");
  const before = meta.preBalances.map((value) => unsigned(value, 64)),
    after = meta.postBalances.map((value) => unsigned(value, 64));
  const fee = unsigned(meta.fee, 64);
  if (fee === 0n) throw new Error("Missing charged transaction fee");
  const debit = before[0] >= after[0] ? before[0] - after[0] : null;
  const totalFee = debit !== null && debit >= fee ? debit : null;
  const holding =
    input.accountAtFinalized === null
      ? null
      : normalizeCoreHolding({
          intent: input.intent,
          chainId: input.chainId,
          queriedAsset: input.queriedAsset,
          account: input.accountAtFinalized,
          finalized: input.finalized,
        });
  const delivered = meta.err === null;
  return {
    network: "solana" as const,
    transaction: input.requestedSignature,
    image: input.storedUnsigned,
    outcome: delivered ? ("delivered" as const) : ("failed" as const),
    recipient: input.intent.recipient,
    observedOwner: holding?.owner ?? null,
    slot: slot.toString(),
    blockHash: block.blockhash,
    finalizedAtSlot: input.finalized.height,
    transactionFee: fee.toString(),
    totalFee: totalFee?.toString() ?? null,
    totalFeeQualified: totalFee !== null,
    feeCapExceeded: (totalFee ?? fee) > unsigned(input.intent.feeCap, 128),
    authorityQualified: false as const,
    fundingAllowed: false as const,
  };
}
