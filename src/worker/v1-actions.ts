import type pg from "pg";
import { v1QueueAdmitted } from "./v1-queue";
import { seal, unseal } from "../server/auth/crypto";
import { canonicalHash } from "../server/protocol/canonical";
import { AppFailure } from "../server/http/security";
import { storedV1Action, type V1ActionImage, type V1ActionRow } from "../server/events/v1-actions";
import type { SignedV1Publication } from "./v1-publication";

export type V1ActionGateway = {
  prepare: (image: V1ActionImage) => Promise<SignedV1Publication>;
  submit: (signed: SignedV1Publication) => Promise<void>;
  final: (
    signed: SignedV1Publication,
  ) => Promise<{ success: boolean; minimumHeight: string; gasYoctoNear: string }>;
  observe: (
    image: V1ActionImage,
    minimumHeight: string,
  ) => Promise<{ height: string; confirmed: boolean }>;
};
export async function runV1Action(pool: pg.Pool, key: string, gateway: V1ActionGateway) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(739204081) AS locked")).rows[0].locked;
    if (!locked) return { state: "busy" };
    if (!(await v1QueueAdmitted(pool, "action"))) return { state: "busy" };
    const row = (
      await pool.query(`SELECT * FROM app_v1_event_actions a WHERE state IN ('requested','prepared','submitted')
      AND (kind NOT IN ('settle','cancel') OR NOT EXISTS(SELECT 1 FROM app_v1_event_actions pending WHERE pending.event_id=a.event_id AND pending.kind='check_in' AND pending.state IN ('requested','prepared','submitted')))
      ORDER BY (state IN ('prepared','submitted')) DESC,created_at,id LIMIT 1`)
    ).rows[0] as V1ActionRow | undefined;
    if (!row) return { state: "idle" };
    const image = storedV1Action(key, row),
      context = `v1-action-transaction:${row.id}`;
    let signed: SignedV1Publication;
    if (row.state === "requested") {
      if (
        image.kind === "settle" &&
        (
          await pool.query(
            "SELECT 1 FROM app_v1_event_actions WHERE event_id=$1 AND kind='check_in' AND state='failed'",
            [image.eventId],
          )
        ).rowCount
      ) {
        await pool.query("UPDATE app_v1_event_actions SET state='failed' WHERE id=$1", [row.id]);
        return { state: "failed", actionId: row.id };
      }
      try {
        signed = await gateway.prepare(image);
      } catch (error) {
        if (!(error instanceof AppFailure) || error.status !== 409) throw error;
        await pool.query(
          "UPDATE app_v1_event_actions SET state='failed' WHERE id=$1 AND state='requested'",
          [row.id],
        );
        return { state: "failed", actionId: row.id };
      }
      if (signed.semantic !== canonicalHash(image))
        throw new Error("V1 action signed semantics mismatch");
      await pool.query(
        "UPDATE app_v1_event_actions SET state='prepared',transaction_hash=$2,encrypted_transaction=$3 WHERE id=$1 AND state='requested'",
        [row.id, signed.hash, seal(key, context, signed)],
      );
      row.state = "prepared";
    } else {
      signed = unseal(key, context, row.encrypted_transaction!) as SignedV1Publication;
      if (signed.hash !== row.transaction_hash || signed.semantic !== canonicalHash(image))
        throw new Error("V1 original action image mismatch");
    }
    if (row.state === "prepared") {
      if (Date.now() + 30000 >= signed.validUntilMs)
        throw new Error("Original V1 action expired; reconcile before replacement");
      await pool.query(
        "UPDATE app_v1_event_actions SET state='submitted' WHERE id=$1 AND state='prepared'",
        [row.id],
      );
      await gateway.submit(signed);
    }
    const final = await gateway.final(signed);
    await pool.query("UPDATE app_v1_event_actions SET gas_yocto_near=$2 WHERE id=$1", [
      row.id,
      final.gasYoctoNear,
    ]);
    if (!final.success) {
      await pool.query("UPDATE app_v1_event_actions SET state='failed' WHERE id=$1", [row.id]);
      return { state: "failed", actionId: row.id, hash: signed.hash };
    }
    const observed = await gateway.observe(image, final.minimumHeight);
    if (BigInt(observed.height) < BigInt(final.minimumHeight))
      throw new Error("V1 action receipt observation regressed");
    // A successful withdraw call can contain a failed token transfer with a
    // successful recovery callback. Only the fixed recipient's paid claim counts.
    const state = observed.confirmed ? "verified" : "failed";
    await pool.query(
      "UPDATE app_v1_event_actions SET state=$2,source_height=$3 WHERE id=$1 AND state='submitted'",
      [row.id, state, observed.height],
    );
    if (state === "verified" && ["settle", "cancel"].includes(image.kind))
      await pool.query(
        "UPDATE app_events SET state=$2,updated_at=clock_timestamp() WHERE id=$1 AND state<>'draft'",
        [image.eventId, image.kind === "settle" ? "closed" : "cancelled"],
      );
    if (state === "verified" && image.kind === "cancel")
      await pool.query(
        "UPDATE app_publication_images SET transaction_state='cancelled' WHERE event_id=$1 AND transaction_state IN ('awaiting_prize','failed')",
        [image.eventId],
      );
    return { state, actionId: row.id, hash: signed.hash, gasYoctoNear: final.gasYoctoNear };
  } finally {
    try {
      if (locked) await lock.query("SELECT pg_advisory_unlock(739204081)");
    } finally {
      lock.release();
    }
  }
}
