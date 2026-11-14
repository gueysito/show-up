import type pg from "pg";
import { seal, unseal } from "../server/auth/crypto";
import { canonicalHash, canonicalJson } from "../server/protocol/canonical";
import { readV1ActionSnapshot, storedV1Action } from "../server/events/v1-actions";
import {
  signedV1NftRelease,
  v1NftReleaseTransaction,
  type V1NftEnvelope,
} from "../server/protocol/v1-nft";
import { record } from "../server/protocol/quote-signature";
import { ReadOnlyRpc, unsigned, rpcCandidates } from "../server/protocol/rpc";
import { compareFinalizedHeads } from "../server/protocol/finalized-heads";
import { normalizeEvmAssetEvidence } from "../server/protocol/evm-asset-evidence";
import { networkManifest } from "../server/protocol/manifest";
import type { V1NftTerms } from "../server/protocol/v1-escrow";
import { Interface } from "ethers";

export type V1NftDeliveryImage = ReturnType<typeof signedV1NftRelease> & {
  nft: V1NftTerms;
  custody: string;
  recipient: string;
  envelope: V1NftEnvelope;
};
export type V1NftDeliveryGateway = {
  prepare(eventId: string): Promise<V1NftDeliveryImage | null>;
  submit(image: V1NftDeliveryImage): Promise<void>;
  observe(
    image: V1NftDeliveryImage,
  ): Promise<{ state: "delivered" | "failed"; height: string; fee: string } | null>;
};
// Separate derived Ethereum nonces do not contend with the NEAR owner queue.
// Persist the signed bytes before the sole write; unknown responses only query
// that original hash. No replacement nonce, fee bump or automatic second send.
export async function runV1NftDelivery(pool: pg.Pool, key: string, gateway: V1NftDeliveryGateway) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(739204082) AS locked")).rows[0].locked;
    if (!locked) return { state: "busy" };
    const row = (
      await pool.query(`SELECT a.event_id,d.state,d.transaction_hash,d.encrypted_transaction FROM app_v1_event_actions a
      LEFT JOIN app_v1_nft_deliveries d ON d.event_id=a.event_id
      WHERE a.kind='nft_release' AND a.state IN ('verified','failed') AND (d.event_id IS NULL OR d.state IN ('prepared','submitted'))
      ORDER BY (d.state IS NOT NULL) DESC,a.nft_delivery_checked_at NULLS FIRST,a.created_at,a.id LIMIT 1`)
    ).rows[0];
    if (!row) return { state: "idle" };
    const context = `v1-nft-delivery:${row.event_id}`;
    let image: V1NftDeliveryImage;
    if (!row.state) {
      await pool.query(
        "UPDATE app_v1_event_actions SET nft_delivery_checked_at=clock_timestamp() WHERE event_id=$1 AND kind='nft_release'",
        [row.event_id],
      );
      const prepared = await gateway.prepare(row.event_id);
      if (!prepared) return { state: "waiting", eventId: row.event_id };
      image = prepared;
      await pool.query(
        "INSERT INTO app_v1_nft_deliveries(event_id,transaction_hash,encrypted_transaction) VALUES($1,$2,$3)",
        [row.event_id, image.hash, seal(key, context, image)],
      );
      row.state = "prepared";
    } else {
      image = unseal(key, context, row.encrypted_transaction) as V1NftDeliveryImage;
      if (image.hash !== row.transaction_hash)
        throw new Error("Original NFT delivery hash mismatch");
    }
    if (row.state === "prepared") {
      await pool.query(
        "UPDATE app_v1_nft_deliveries SET state='submitted' WHERE event_id=$1 AND state='prepared'",
        [row.event_id],
      );
      await gateway.submit(image);
    }
    const observed = await gateway.observe(image);
    if (!observed) return { state: "submitted", eventId: row.event_id, hash: image.hash };
    await pool.query(
      "UPDATE app_v1_nft_deliveries SET state=$2,source_height=$3,execution_fee_wei=$4 WHERE event_id=$1 AND state='submitted'",
      [row.event_id, observed.state, observed.height, observed.fee],
    );
    return { state: observed.state, eventId: row.event_id, hash: image.hash };
  } finally {
    try {
      if (locked) await lock.query("SELECT pg_advisory_unlock(739204082)");
    } finally {
      lock.release();
    }
  }
}

export function v1NftDeliveryGateway(
  pool: pg.Pool,
  key: string,
  transport: typeof fetch = fetch,
): V1NftDeliveryGateway {
  return {
    async prepare(eventId) {
      const { snapshot, image: publication } = await readV1ActionSnapshot(
          pool,
          key,
          eventId,
          transport,
        ),
        nft = publication.terms.nft,
        live = record(snapshot.event!.nft);
      if (!nft || !["settled", "cancelled"].includes(String(snapshot.event!.status)))
        throw new Error("NFT release event changed");
      if (!live.request || record(live.request).state !== "signed") return null;
      const rows = (
        await pool.query(
          "SELECT * FROM app_v1_event_actions WHERE event_id=$1 AND kind='nft_release' ORDER BY attempt",
          [eventId],
        )
      ).rows;
      const request = record(live.request);
      const action = rows
        .map((row) => storedV1Action(key, row))
        .find((candidate) => {
          if (!candidate.nft || candidate.nft.recipient !== request.recipient) return false;
          const tx = v1NftReleaseTransaction(
            nft,
            String(live.custody),
            candidate.nft.recipient,
            candidate.nft.envelope,
          );
          return (
            request.payload === tx.unsignedHash.slice(2) &&
            request.unsigned_transaction ===
              Buffer.from(tx.unsignedSerialized.slice(2), "hex").toString("base64")
          );
        });
      if (!action?.nft) throw new Error("Matching NFT release parameters missing");
      const { recipient, envelope } = action.nft,
        signed = signedV1NftRelease(nft, live, recipient, envelope);
      return { ...signed, nft, custody: String(live.custody), recipient, envelope };
    },
    async submit(image) {
      const rpc = new ReadOnlyRpc("ethereum-drpc", transport);
      if (
        unsigned(await rpc.read("eth_chainId", [])) !== 1n ||
        unsigned(await rpc.read("eth_getTransactionCount", [image.custody, "pending"]), 64) !==
          BigInt(image.envelope.nonce)
      )
        throw new Error("Reconcile original NFT nonce before broadcasting");
      const endpoint = rpcCandidates.endpoints.find((e) => e.id === "ethereum-drpc")!;
      const response = await transport(endpoint.origin, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "v1-nft-delivery",
          method: "eth_sendRawTransaction",
          params: [image.signedHex],
        }),
      });
      if (response.status !== 200)
        throw new Error("NFT write response unknown; retain original hash");
      const result = record(await response.json());
      if (result.id !== "v1-nft-delivery" || result.error || result.result !== image.hash)
        throw new Error("NFT write response unknown; retain original hash");
    },
    async observe(image) {
      const clients = [
          new ReadOnlyRpc("ethereum-drpc", transport),
          new ReadOnlyRpc("ethereum-publicnode", transport),
        ],
        finality = await compareFinalizedHeads("ethereum", clients[0], clients[1]),
        token = new Interface(["function ownerOf(uint256) view returns(address)"]),
        intent = {
          deployment: "showup-dev-14989f.near",
          environment: "mainnet" as const,
          network: "ethereum" as const,
          manifest: networkManifest.revision,
          event: canonicalHash(image.nft),
          rulesHash: canonicalHash(image.nft),
          payout: canonicalHash(image.recipient),
          operation: "delivery" as const,
          collection: image.nft.collection,
          asset: "0x" + BigInt(image.nft.token_id).toString(16).padStart(64, "0"),
          source: image.custody,
          recipient: image.recipient,
          feeCap: (BigInt(image.envelope.gas_limit) * BigInt(image.envelope.max_fee)).toString(),
        };
      const facts = await Promise.all(
        clients.map(async (rpc) => {
          const [receipt, transaction] = await Promise.all([
            rpc.read("eth_getTransactionReceipt", [image.hash]),
            rpc.read("eth_getTransactionByHash", [image.hash]),
          ]);
          if (
            !receipt ||
            !transaction ||
            record(receipt).blockNumber === null ||
            unsigned(record(receipt).blockNumber, 64) > BigInt(finality.block.height)
          )
            return null;
          const [inclusionBlock, owner] = await Promise.all([
            rpc.read("eth_getBlockByNumber", [record(receipt).blockNumber, false]),
            rpc.read("eth_call", [
              {
                to: image.nft.collection,
                data: token.encodeFunctionData("ownerOf", [BigInt(image.nft.token_id)]),
              },
              "0x" + BigInt(finality.block.height).toString(16),
            ]),
          ]);
          return normalizeEvmAssetEvidence({
            intent,
            storedUnsigned: image.unsigned,
            requestedHash: image.hash,
            transaction,
            receipt,
            inclusionBlock,
            finalized: finality.block,
            ownerOfAtFinalized: owner,
          });
        }),
      );
      if (!facts[0] || !facts[1]) return null;
      if (canonicalJson(facts[0]) !== canonicalJson(facts[1]))
        throw new Error("NFT delivery sources disagree");
      return { state: facts[0].outcome, height: facts[0].blockHeight, fee: facts[0].executionFee };
    },
  };
}
