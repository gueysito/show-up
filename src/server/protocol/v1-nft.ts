import {
  Interface,
  Transaction,
  Signature,
  recoverAddress,
  keccak256,
  getAddress,
  toQuantity,
} from "ethers";
import type { NFTDraft } from "../../domain/event-draft";
import type { V1NftTerms } from "./v1-escrow";
import { ReadOnlyRpc, unsigned } from "./rpc";
import { record } from "./quote-signature";
import { compareFinalizedHeads } from "./finalized-heads";
import { canonicalJson } from "./canonical";
import { decodeBase58 } from "./encoding";
import { AppFailure } from "../http/security";
import { v1NftMaximumGasWei } from "../../domain/v1-nft-budget";

export function v1NftGasLimit(estimate: bigint) {
  const buffered = (estimate * 125n + 99n) / 100n;
  if (estimate <= 0n || buffered > 250000n) throw new Error("NFT transfer gas outside V1 bounds");
  return buffered < 50000n ? 50000n : buffered;
}

export function v1NftGasBudget(estimate: bigint, suggestedPrice: bigint) {
  const gas = v1NftGasLimit(estimate),
    ceiling = v1NftMaximumGasWei / gas;
  if (suggestedPrice <= 0n || suggestedPrice > ceiling)
    throw new AppFailure(422, "Ethereum gas exceeds the NFT's small-transfer budget. Check later.");
  return {
    gas,
    fee: suggestedPrice * 2n < ceiling ? suggestedPrice * 2n : ceiling,
    priority: suggestedPrice / 10n || 1n,
  };
}

const erc721 = new Interface([
  "function ownerOf(uint256) view returns(address)",
  "function supportsInterface(bytes4) view returns(bool)",
  "function safeTransferFrom(address,address,uint256)",
]);
export function v1NftAddress(value: string) {
  const address = getAddress(value).toLowerCase();
  if (address === "0x" + "0".repeat(40)) throw new Error("Zero NFT address");
  return address;
}
export function v1NftTerms(draft: NFTDraft): V1NftTerms {
  if (
    draft.network !== "ethereum" ||
    !/^(0|[1-9][0-9]{0,38})$/.test(draft.assetId) ||
    BigInt(draft.assetId) >= 1n << 128n
  )
    throw new AppFailure(422, "Choose an Ethereum ERC-721 and its decimal token ID.");
  try {
    return {
      collection: v1NftAddress(draft.collection),
      token_id: draft.assetId,
      contributor: v1NftAddress(draft.contributorReturnAddress),
      custody: null,
      public_key: null,
      deriving: false,
      held: false,
      request: null,
    };
  } catch {
    throw new AppFailure(422, "Enter the NFT collection and its current owner's Ethereum address.");
  }
}
export function v1NftCustody(nft: Record<string, unknown>) {
  if (
    typeof nft.public_key !== "string" ||
    !nft.public_key.startsWith("secp256k1:") ||
    typeof nft.custody !== "string"
  )
    throw new AppFailure(409, "Wait for the contract's NFT custody address before transferring.");
  const key = decodeBase58(nft.public_key.slice(10), 64),
    expected = "0x" + keccak256(key).slice(-40);
  if (v1NftAddress(nft.custody) !== expected) throw new Error("NFT custody key mismatch");
  return expected;
}
export async function readV1NftHolding(
  nft: Pick<V1NftTerms, "collection" | "token_id">,
  transport?: typeof fetch,
) {
  const clients = [
      new ReadOnlyRpc("ethereum-drpc", transport),
      new ReadOnlyRpc("ethereum-publicnode", transport),
    ],
    signal = AbortSignal.timeout(30000),
    finality = await compareFinalizedHeads("ethereum", clients[0], clients[1], Date.now(), signal),
    block = toQuantity(BigInt(finality.block.height));
  const owners = await Promise.all(
    clients.map(async (rpc) => {
      const [code, support, owner] = await Promise.all([
        rpc.read("eth_getCode", [nft.collection, block], signal),
        rpc.read(
          "eth_call",
          [
            {
              to: nft.collection,
              data: erc721.encodeFunctionData("supportsInterface", ["0x80ac58cd"]),
            },
            block,
          ],
          signal,
        ),
        rpc.read(
          "eth_call",
          [
            {
              to: nft.collection,
              data: erc721.encodeFunctionData("ownerOf", [BigInt(nft.token_id)]),
            },
            block,
          ],
          signal,
        ),
      ]);
      if (
        typeof code !== "string" ||
        !/^0x(?:[0-9a-f]{2})+$/.test(code) ||
        erc721.decodeFunctionResult("supportsInterface", String(support))[0] !== true
      )
        throw new AppFailure(422, "This collection does not confirm ERC-721 support.");
      return v1NftAddress(erc721.decodeFunctionResult("ownerOf", String(owner))[0]);
    }),
  );
  if (owners[0] !== owners[1]) throw new Error("NFT ownership sources disagree");
  return { owner: owners[0], block: finality.block };
}
export function v1NftTransferData(
  nft: Pick<V1NftTerms, "token_id">,
  source: string,
  recipient: string,
) {
  if (v1NftAddress(source) === v1NftAddress(recipient)) throw new Error("NFT self transfer");
  return erc721.encodeFunctionData("safeTransferFrom", [source, recipient, BigInt(nft.token_id)]);
}

export type V1NftEnvelope = {
  nonce: string;
  gas_limit: string;
  priority_fee: string;
  max_fee: string;
};
export async function prepareV1NftTransfer(
  nft: V1NftTerms,
  source: string,
  recipient: string,
  transport?: typeof fetch,
) {
  if ((await readV1NftHolding(nft, transport)).owner !== source)
    throw new AppFailure(
      409,
      "The expected NFT owner is not confirmed yet. Wait and check the original transaction.",
    );
  const transaction = {
      from: source,
      to: nft.collection,
      value: "0x0",
      data: v1NftTransferData(nft, source, recipient),
    },
    facts = await Promise.all(
      ["ethereum-drpc", "ethereum-publicnode"].map(async (endpoint) => {
        const rpc = new ReadOnlyRpc(endpoint, transport);
        const [chain, nonce, pending, price, gas, balance] = await Promise.all([
          rpc.read("eth_chainId", []),
          rpc.read("eth_getTransactionCount", [source, "latest"]),
          rpc.read("eth_getTransactionCount", [source, "pending"]),
          rpc.read("eth_gasPrice", []),
          rpc.read("eth_estimateGas", [transaction]),
          rpc.read("eth_getBalance", [source, "latest"]),
        ]);
        if (unsigned(chain) !== 1n || unsigned(nonce, 64) !== unsigned(pending, 64))
          throw new AppFailure(
            409,
            "Wait for pending Ethereum transactions before preparing this NFT transfer.",
          );
        return {
          nonce: unsigned(nonce, 64),
          price: unsigned(price, 128),
          gas: unsigned(gas, 64),
          balance: unsigned(balance),
        };
      }),
    );
  if (facts[0].nonce !== facts[1].nonce) throw new Error("NFT nonce sources disagree");
  const max = (field: "price" | "gas") => facts.reduce((n, f) => (f[field] > n ? f[field] : n), 0n),
    { gas, fee, priority } = v1NftGasBudget(max("gas"), max("price"));
  const envelope = {
    nonce: facts[0].nonce.toString(),
    gas_limit: gas.toString(),
    max_fee: fee.toString(),
    priority_fee: priority.toString(),
  };
  v1NftReleaseTransaction(nft, source, recipient, envelope);
  if (facts.some((f) => f.balance < gas * fee))
    throw new AppFailure(
      422,
      "The NFT custody or funding wallet needs more ETH for the bounded transfer gas.",
    );
  return {
    envelope,
    transaction: {
      ...transaction,
      chainId: "0x1",
      type: "0x2",
      nonce: toQuantity(facts[0].nonce),
      gas: toQuantity(gas),
      maxFeePerGas: toQuantity(fee),
      maxPriorityFeePerGas: toQuantity(priority),
    },
    maximumGasWei: (gas * fee).toString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
}
export function v1NftReleaseTransaction(
  nft: V1NftTerms,
  custody: string,
  recipient: string,
  envelope: V1NftEnvelope,
) {
  const nonce = unsigned(envelope.nonce, 64),
    gas = unsigned(envelope.gas_limit, 64),
    priority = unsigned(envelope.priority_fee, 128),
    fee = unsigned(envelope.max_fee, 128);
  if (
    nonce > BigInt(Number.MAX_SAFE_INTEGER) ||
    gas < 50000n ||
    gas > 250000n ||
    priority > fee ||
    fee === 0n ||
    gas * fee > v1NftMaximumGasWei
  )
    throw new Error("NFT release exceeds the contract's gas policy");
  return Transaction.from({
    type: 2,
    chainId: 1n,
    nonce: Number(nonce),
    gasLimit: gas,
    maxFeePerGas: fee,
    maxPriorityFeePerGas: priority,
    to: nft.collection,
    value: 0n,
    data: v1NftTransferData(nft, custody, recipient),
    accessList: [],
  });
}
// Never accept a signer response as delivery. It only reconstructs the original
// fixed-beneficiary image, which must still be broadcast and observed on Ethereum.
export function signedV1NftRelease(
  nft: V1NftTerms,
  live: Record<string, unknown>,
  recipient: string,
  envelope: V1NftEnvelope,
) {
  const custody = v1NftCustody(live),
    request = record(live.request),
    tx = v1NftReleaseTransaction(nft, custody, recipient, envelope);
  if (
    request.state !== "signed" ||
    request.recipient !== recipient ||
    request.payload !== tx.unsignedHash.slice(2) ||
    request.unsigned_transaction !==
      Buffer.from(tx.unsignedSerialized.slice(2), "hex").toString("base64") ||
    typeof request.signature !== "string" ||
    request.signature.length > 2048
  )
    throw new Error("NFT signature does not match the fixed release");
  const response = record(JSON.parse(request.signature)),
    r = record(response.big_r).affine_point,
    s = record(response.s).scalar,
    parity = response.recovery_id;
  if (
    typeof r !== "string" ||
    !/^(02|03)[0-9a-f]{64}$/.test(r) ||
    typeof s !== "string" ||
    !/^[0-9a-f]{64}$/.test(s) ||
    (parity !== 0 && parity !== 1) ||
    response.scheme !== "Secp256k1" ||
    Number.parseInt(r.slice(0, 2), 16) !== 2 + Number(parity)
  )
    throw new Error("Invalid NFT signing response");
  const signature = Signature.from({ r: "0x" + r.slice(2), s: "0x" + s, yParity: parity });
  if (recoverAddress(tx.unsignedHash, signature).toLowerCase() !== custody)
    throw new Error("NFT release signer mismatch");
  tx.signature = signature;
  return {
    hash: tx.hash!,
    signedHex: tx.serialized,
    unsigned: tx.unsignedSerialized,
    semantic: canonicalJson({ nft, custody, recipient, envelope }),
  };
}
