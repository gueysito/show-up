import type pg from "pg";
import { v1QueueAdmitted } from "./v1-queue";
import { seal, unseal } from "../server/auth/crypto";
import { canonicalHash } from "../server/protocol/canonical";
import {
  observeV1Publication,
  storedV1Publication,
  type V1PublicationRow,
  type V1PublicationImage,
  type V1PublicationPhase,
} from "../server/events/v1-publication";
import { matchesV1Terms, type V1Snapshot } from "../server/protocol/v1-escrow";

export type SignedV1Publication = {
  hash: string;
  signedBase64: string;
  semantic: string;
  validUntilMs: number;
  phase?: V1PublicationPhase;
};
export type V1PublicationGateway = {
  prepare: (
    image: V1PublicationImage,
    phase?: V1PublicationPhase,
  ) => Promise<SignedV1Publication | null>;
  submit: (image: SignedV1Publication) => Promise<void>;
  final: (
    image: SignedV1Publication,
  ) => Promise<{ success: boolean; minimumHeight: string; gasYoctoNear: string }>;
  snapshot: (eventId: string) => Promise<V1Snapshot>;
};

// One shared controller nonce owner. A process death releases the session lock;
// submitted images are only looked up by their retained original hash afterwards.
export async function runV1Publication(pool: pg.Pool, key: string, gateway: V1PublicationGateway) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(739204081) AS locked")).rows[0].locked;
    if (!locked) return { state: "busy" };
    if (!(await v1QueueAdmitted(pool, "publication"))) return { state: "busy" };
    const row = (
      await pool.query(`SELECT p.*,e.owner_id,e.data,e.revision FROM app_publication_images p
      JOIN app_events e ON e.id=p.event_id WHERE p.environment='near-mainnet-v1'
      AND p.transaction_state IN ('requested','prepared','submitted')
      AND (p.nft_publication_check_after IS NULL OR p.nft_publication_check_after <= clock_timestamp())
      ORDER BY (p.transaction_state IN ('prepared','submitted')) DESC,p.created_at,p.event_id LIMIT 1`)
    ).rows[0] as V1PublicationRow | undefined;
    if (!row) return { state: "idle" };
    const image = storedV1Publication(key, row),
      eventId = row.event_id;
    const phase = row.execution_phase ?? "atomic";
    const context = `v1-publication-transaction:${eventId}`;
    let signed: SignedV1Publication;
    if (row.transaction_state === "requested") {
      if (Date.now() >= image.terms.start_ms) {
        await pool.query(
          "UPDATE app_publication_images SET transaction_state='failed',failure_code='event_started' WHERE event_id=$1",
          [eventId],
        );
        return { state: "failed", eventId };
      }
      const prepared = await gateway.prepare(image, phase);
      if (!prepared) {
        if (phase !== "publish" || !image.terms.nft)
          throw new Error("Unexpected NFT publication wait");
        await pool.query(
          "UPDATE app_publication_images SET nft_publication_check_after=clock_timestamp()+interval '30 seconds' WHERE event_id=$1 AND transaction_state='requested'",
          [eventId],
        );
        return { state: "waiting", eventId };
      }
      signed = prepared;
      if (signed.semantic !== canonicalHash(image.terms))
        throw new Error("V1 signed terms mismatch");
      await pool.query(
        `UPDATE app_publication_images SET transaction_state='prepared',transaction_hash=$2,
        encrypted_transaction=$3,nft_publication_check_after=NULL WHERE event_id=$1 AND transaction_state='requested'`,
        [eventId, signed.hash, seal(key, context, signed)],
      );
      row.transaction_state = "prepared";
    } else {
      signed = unseal(key, context, row.encrypted_transaction!) as SignedV1Publication;
      if (signed.hash !== row.transaction_hash || signed.semantic !== canonicalHash(image.terms))
        throw new Error("V1 original image mismatch");
    }
    if ((signed.phase ?? "atomic") !== phase)
      throw new Error("V1 original transaction phase mismatch");
    if (row.transaction_state === "prepared") {
      if (Date.now() + 30_000 >= signed.validUntilMs)
        throw new Error("V1 prepared image expired; reconcile before replacement");
      await pool.query(
        "UPDATE app_publication_images SET transaction_state='submitted' WHERE event_id=$1 AND transaction_state='prepared'",
        [eventId],
      );
      await gateway.submit(signed);
    }
    const final = await gateway.final(signed);
    await pool.query("UPDATE app_publication_images SET gas_yocto_near=$2 WHERE event_id=$1", [
      eventId,
      final.gasYoctoNear,
    ]);
    if (!final.success) {
      await pool.query(
        "UPDATE app_publication_images SET transaction_state='failed',failure_code='transaction_failed' WHERE event_id=$1",
        [eventId],
      );
      return { state: "failed", eventId, hash: signed.hash };
    }
    const snapshot = await gateway.snapshot(eventId);
    if (BigInt(snapshot.block.height) < BigInt(final.minimumHeight))
      throw new Error(
        "V1 state has not reached the original receipt block; reconcile the same hash",
      );
    if (phase === "create") {
      if (
        !snapshot.event ||
        snapshot.event.status !== "draft" ||
        !matchesV1Terms(snapshot.event, image.terms)
      )
        throw new Error("V1 created prize terms differ");
      await pool.query(
        `UPDATE app_publication_images SET transaction_state='awaiting_prize',
        creation_transaction_hash=transaction_hash,creation_encrypted_transaction=encrypted_transaction,
        creation_gas_yocto_near=gas_yocto_near,creation_source_height=$2 WHERE event_id=$1 AND transaction_state='submitted'`,
        [eventId, snapshot.block.height],
      );
      return {
        state: "awaiting_prize",
        eventId,
        hash: signed.hash,
        gasYoctoNear: final.gasYoctoNear,
      };
    }
    await observeV1Publication(pool, key, eventId, snapshot);
    return { state: "verified", eventId, hash: signed.hash, gasYoctoNear: final.gasYoctoNear };
  } finally {
    try {
      if (locked) await lock.query("SELECT pg_advisory_unlock(739204081)");
    } finally {
      lock.release();
    }
  }
}
