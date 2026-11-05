import type pg from "pg";
import { seal, unseal } from "../server/auth/crypto";
import { canonicalHash } from "../server/protocol/canonical";
import {
  observeV1Publication,
  storedV1Publication,
  type V1PublicationRow,
  type V1PublicationImage,
} from "../server/events/v1-publication";
import type { V1Snapshot } from "../server/protocol/v1-escrow";

export type SignedV1Publication = {
  hash: string;
  signedBase64: string;
  semantic: string;
  validUntilMs: number;
};
export type V1PublicationGateway = {
  prepare: (image: V1PublicationImage) => Promise<SignedV1Publication>;
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
    const row = (
      await pool.query(`SELECT p.*,e.owner_id,e.data,e.revision FROM app_publication_images p
      JOIN app_events e ON e.id=p.event_id WHERE p.environment='near-mainnet-v1'
      AND p.transaction_state IN ('requested','prepared','submitted') ORDER BY p.created_at,p.event_id LIMIT 1`)
    ).rows[0] as V1PublicationRow | undefined;
    if (!row) return { state: "idle" };
    const image = storedV1Publication(key, row),
      eventId = row.event_id;
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
      signed = await gateway.prepare(image);
      if (signed.semantic !== canonicalHash(image.terms))
        throw new Error("V1 signed terms mismatch");
      await pool.query(
        `UPDATE app_publication_images SET transaction_state='prepared',transaction_hash=$2,
        encrypted_transaction=$3 WHERE event_id=$1 AND transaction_state='requested'`,
        [eventId, signed.hash, seal(key, context, signed)],
      );
      row.transaction_state = "prepared";
    } else {
      signed = unseal(key, context, row.encrypted_transaction!) as SignedV1Publication;
      if (signed.hash !== row.transaction_hash || signed.semantic !== canonicalHash(image.terms))
        throw new Error("V1 original image mismatch");
    }
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
    await observeV1Publication(pool, key, eventId, snapshot);
    return { state: "verified", eventId, hash: signed.hash, gasYoctoNear: final.gasYoctoNear };
  } finally {
    if (locked) await lock.query("SELECT pg_advisory_unlock(739204081)");
    lock.release();
  }
}
