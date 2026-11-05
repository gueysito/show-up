import type pg from "pg";
import { seal, unseal } from "../server/auth/crypto";
import { canonicalHash } from "../server/protocol/canonical";
import {
  matchesV1Registration,
  storedV1Registration,
  type V1RegistrationImage,
  type V1RegistrationRow,
} from "../server/commitments/v1-registration";
import type { SignedV1Publication } from "./v1-publication";
import type { V1Snapshot } from "../server/protocol/v1-escrow";
import { AppFailure } from "../server/http/security";

export type V1RegistrationGateway = {
  prepare: (image: V1RegistrationImage) => Promise<SignedV1Publication>;
  submit: (signed: SignedV1Publication) => Promise<void>;
  final: (
    signed: SignedV1Publication,
  ) => Promise<{ success: boolean; minimumHeight: string; gasYoctoNear: string }>;
  observe: (
    image: V1RegistrationImage,
  ) => Promise<{ snapshot: V1Snapshot; registration: Record<string, unknown> | null }>;
};
export async function runV1Registration(
  pool: pg.Pool,
  key: string,
  gateway: V1RegistrationGateway,
) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(739204081) AS locked")).rows[0].locked;
    if (!locked) return { state: "busy" };
    const row = (
      await pool.query(
        "SELECT * FROM app_v1_registrations WHERE state IN ('requested','prepared','submitted') ORDER BY created_at,id LIMIT 1",
      )
    ).rows[0] as V1RegistrationRow | undefined;
    if (!row) return { state: "idle" };
    const image = storedV1Registration(key, row),
      context = `v1-registration-transaction:${row.id}`;
    let signed: SignedV1Publication;
    if (row.state === "requested") {
      if (Date.now() >= image.startMs) {
        await pool.query("UPDATE app_v1_registrations SET state='failed' WHERE id=$1", [row.id]);
        return { state: "failed", registrationId: row.id };
      }
      try {
        signed = await gateway.prepare(image);
      } catch (error) {
        if (!(error instanceof AppFailure) || error.status !== 409) throw error;
        await pool.query(
          "UPDATE app_v1_registrations SET state='failed' WHERE id=$1 AND state='requested'",
          [row.id],
        );
        return { state: "failed", registrationId: row.id };
      }
      if (signed.semantic !== canonicalHash(image))
        throw new Error("Registration signed semantics mismatch");
      await pool.query(
        "UPDATE app_v1_registrations SET state='prepared',transaction_hash=$2,encrypted_transaction=$3 WHERE id=$1 AND state='requested'",
        [row.id, signed.hash, seal(key, context, signed)],
      );
      row.state = "prepared";
    } else {
      signed = unseal(key, context, row.encrypted_transaction!) as SignedV1Publication;
      if (signed.hash !== row.transaction_hash || signed.semantic !== canonicalHash(image))
        throw new Error("Registration original image mismatch");
    }
    if (row.state === "prepared") {
      if (Date.now() + 30000 >= signed.validUntilMs)
        throw new Error("Original registration image expired; reconcile before replacement");
      await pool.query(
        "UPDATE app_v1_registrations SET state='submitted' WHERE id=$1 AND state='prepared'",
        [row.id],
      );
      await gateway.submit(signed);
    }
    const final = await gateway.final(signed);
    await pool.query("UPDATE app_v1_registrations SET gas_yocto_near=$2 WHERE id=$1", [
      row.id,
      final.gasYoctoNear,
    ]);
    if (!final.success) {
      await pool.query("UPDATE app_v1_registrations SET state='failed' WHERE id=$1", [row.id]);
      return { state: "failed", registrationId: row.id, hash: signed.hash };
    }
    const observed = await gateway.observe(image);
    if (
      BigInt(observed.snapshot.block.height) < BigInt(final.minimumHeight) ||
      !matchesV1Registration(observed.registration, image)
    )
      throw new Error("Registration source does not confirm original transaction");
    await pool.query(
      "UPDATE app_v1_registrations SET state='registered',source_height=$2 WHERE id=$1 AND state='submitted'",
      [row.id, observed.snapshot.block.height],
    );
    return {
      state: "registered",
      registrationId: row.id,
      hash: signed.hash,
      gasYoctoNear: final.gasYoctoNear,
    };
  } finally {
    try {
      if (locked) await lock.query("SELECT pg_advisory_unlock(739204081)");
    } finally {
      lock.release();
    }
  }
}
