import { randomUUID } from "node:crypto";
import type pg from "pg";
import { seal, unseal } from "../server/auth/crypto";
import { transaction } from "../server/db/client";
import { canonicalHash } from "../server/protocol/canonical";
import { readV1Snapshot, readV1Record } from "../server/protocol/v1-escrow";
import { readV1IntentsBalance, v1RouteAccount } from "../server/protocol/v1-intents";
import { validateV1Route, type V1Route } from "../server/protocol/v1-routing";
import {
  storedV1Registration,
  matchesV1Registration,
  type V1RegistrationImage,
  type V1RegistrationRow,
} from "../server/commitments/v1-registration";
import { v1Claim } from "../server/events/v1-actions";
import type { SignedV1Publication } from "./v1-publication";
import { v1QueueAdmitted } from "./v1-queue";

export type V1IntentsWithdrawal = {
  format: "showup.v1.intents-withdrawal.v1";
  id: string;
  registration: V1RegistrationImage;
  amount: string;
  previouslyFunded: boolean;
  recoveryTotal: string;
  minimumHeight: string;
};
export type V1IntentsGateway<T> = {
  prepare(image: T): Promise<SignedV1Publication>;
  submit(signed: SignedV1Publication): Promise<void>;
  final(
    signed: SignedV1Publication,
    image: T,
  ): Promise<{ success: boolean; minimumHeight: string; gasYoctoNear: string }>;
  observe(image: T, minimumHeight: string): Promise<{ confirmed: boolean; height: string }>;
};

export async function enqueueV1IntentsWithdrawal(
  pool: pg.Pool,
  key: string,
  transport?: typeof fetch,
  now = Date.now(),
) {
  const row = (
    await pool.query(`SELECT r.*,q.expires_at,q.quote_hash,q.encrypted_quote FROM app_v1_route_quotes q JOIN app_v1_registrations r ON r.id=q.registration_id
    JOIN app_v1_route_accounts a ON a.registration_id=r.id AND a.state='verified'
    WHERE r.state IN ('registered','funded') AND NOT EXISTS(SELECT 1 FROM app_v1_route_withdrawals w WHERE w.registration_id=r.id AND w.state IN ('requested','prepared','submitted'))
    AND (SELECT count(*) FROM app_v1_route_withdrawals w WHERE w.registration_id=r.id)<3
    ORDER BY q.intents_checked_at NULLS FIRST,q.created_at,q.registration_id LIMIT 1`)
  ).rows[0] as
    | (V1RegistrationRow & { expires_at: Date; quote_hash: string; encrypted_quote: string })
    | undefined;
  if (!row) return;
  await pool.query(
    "UPDATE app_v1_route_quotes SET intents_checked_at=clock_timestamp() WHERE registration_id=$1",
    [row.id],
  );
  const registration = storedV1Registration(key, row),
    storedQuote = unseal(key, `v1-route:${row.id}`, row.encrypted_quote) as V1Route;
  if (
    canonicalHash(storedQuote) !== row.quote_hash ||
    storedQuote.request.recipientType !== "INTENTS" ||
    storedQuote.request.recipient !== v1RouteAccount(row.id) ||
    storedQuote.request.customRecipientMsg !== `deposit:${row.id}` ||
    storedQuote.request.amount !== registration.amount ||
    storedQuote.request.refundTo !== registration.source?.address
  )
    throw new Error("Intents frozen quote mismatch");
  const checked = validateV1Route(
    storedQuote.network,
    storedQuote.request,
    storedQuote.response,
    Date.now(),
    true,
  );
  if (Date.parse(checked.expiresAt) !== row.expires_at.getTime())
    throw new Error("Intents quote deadline mismatch");
  const snapshot = await readV1Snapshot(row.event_id, transport),
    balance = BigInt(await readV1IntentsBalance(row.id, snapshot, transport));
  if (balance === 0n || (balance < BigInt(registration.amount) && now < row.expires_at.getTime()))
    return;
  const reg = await readV1Record("get_registration", row.id, snapshot.block, transport),
    claim = v1Claim(
      await readV1Record("get_claim", `recovery:${row.id}`, snapshot.block, transport),
      registration.payout,
    );
  if (!matchesV1Registration(reg, registration))
    throw new Error("Intents withdrawal registration differs");
  const amount = (
      balance > BigInt(registration.amount) ? BigInt(registration.amount) : balance
    ).toString(),
    image: V1IntentsWithdrawal = {
      format: "showup.v1.intents-withdrawal.v1",
      id: randomUUID(),
      registration,
      amount,
      previouslyFunded: reg!.funded === true,
      recoveryTotal: claim.total,
      minimumHeight: snapshot.block.height,
    };
  return transaction(pool, async (client) => {
    await client.query("SELECT id FROM app_v1_registrations WHERE id=$1 FOR UPDATE", [row.id]);
    const previous = (
      await client.query(
        "SELECT state,attempt FROM app_v1_route_withdrawals WHERE registration_id=$1 ORDER BY attempt DESC LIMIT 1",
        [row.id],
      )
    ).rows[0];
    if (previous && ["requested", "prepared", "submitted"].includes(previous.state)) return;
    const attempt = (previous?.attempt ?? 0) + 1;
    if (attempt > 3) return;
    await client.query(
      "INSERT INTO app_v1_route_withdrawals(id,registration_id,attempt,image_hash,encrypted_image) VALUES($1,$2,$3,$4,$5)",
      [
        image.id,
        row.id,
        attempt,
        canonicalHash(image),
        seal(key, `v1-intents-withdrawal:${image.id}`, image),
      ],
    );
    return { withdrawalId: image.id };
  });
}

// Both account setup and forwarding retain one original native image. The same
// global admission lock prevents an unknown transaction from being replaced.
export async function runV1IntentsQueue(
  pool: pg.Pool,
  key: string,
  kind: "route_account" | "route_withdrawal",
  gateway: V1IntentsGateway<V1RegistrationImage | V1IntentsWithdrawal>,
) {
  const lock = await pool.connect();
  let locked = false;
  try {
    locked = (await lock.query("SELECT pg_try_advisory_lock(739204081) AS locked")).rows[0].locked;
    if (!locked || !(await v1QueueAdmitted(pool, kind))) return { state: "busy" };
    const table = kind === "route_account" ? "app_v1_route_accounts" : "app_v1_route_withdrawals",
      column = kind === "route_account" ? "registration_id" : "id",
      row = (
        await pool.query(`SELECT a.*,r.encrypted_image AS registration_image,r.image_hash AS registration_hash,r.account_id,r.event_id,r.id AS registration_ref
        FROM ${table} a JOIN app_v1_registrations r ON r.id=a.registration_id WHERE a.state IN ('requested','prepared','submitted')
        ORDER BY (a.state IN ('prepared','submitted')) DESC,a.created_at,a.registration_id LIMIT 1`)
      ).rows[0];
    if (!row) return { state: "idle" };
    const registration = storedV1Registration(key, {
        ...row,
        id: row.registration_ref,
        encrypted_image: row.registration_image,
        image_hash: row.registration_hash,
      }),
      id = kind === "route_account" ? row.registration_id : row.id,
      image =
        kind === "route_account"
          ? registration
          : (unseal(
              key,
              `v1-intents-withdrawal:${id}`,
              row.encrypted_image,
            ) as V1IntentsWithdrawal),
      context = `v1-${kind}-transaction:${id}`;
    if (
      kind === "route_withdrawal" &&
      (canonicalHash(image) !== row.image_hash ||
        canonicalHash((image as V1IntentsWithdrawal).registration) !==
          canonicalHash(registration) ||
        (image as V1IntentsWithdrawal).id !== id)
    )
      throw new Error("Original Intents withdrawal integrity");
    let signed: SignedV1Publication;
    if (row.state === "requested") {
      if (kind === "route_account" && Date.now() >= registration.startMs) {
        await pool.query(
          "UPDATE app_v1_route_accounts SET state='failed' WHERE registration_id=$1",
          [registration.id],
        );
        await pool.query(
          "UPDATE app_v1_registrations SET state='failed' WHERE id=$1 AND state='requested'",
          [registration.id],
        );
        return { state: "failed" };
      }
      signed = await gateway.prepare(image);
      if (signed.semantic !== canonicalHash(image))
        throw new Error("Intents signed semantics mismatch");
      await pool.query(
        `UPDATE ${table} SET state='prepared',transaction_hash=$2,encrypted_transaction=$3 WHERE ${column}=$1 AND state='requested'`,
        [id, signed.hash, seal(key, context, signed)],
      );
      row.state = "prepared";
    } else {
      signed = unseal(key, context, row.encrypted_transaction) as SignedV1Publication;
      if (signed.hash !== row.transaction_hash || signed.semantic !== canonicalHash(image))
        throw new Error("Original Intents transaction mismatch");
    }
    if (row.state === "prepared") {
      if (Date.now() + 30000 >= signed.validUntilMs)
        throw new Error("Original Intents transaction expired; reconcile it first");
      await pool.query(
        `UPDATE ${table} SET state='submitted' WHERE ${column}=$1 AND state='prepared'`,
        [id],
      );
      await gateway.submit(signed);
    }
    const final = await gateway.final(signed, image);
    await pool.query(`UPDATE ${table} SET gas_yocto_near=$2 WHERE ${column}=$1`, [
      id,
      final.gasYoctoNear,
    ]);
    if (!final.success) {
      await pool.query(`UPDATE ${table} SET state='failed' WHERE ${column}=$1`, [id]);
      if (kind === "route_account")
        await pool.query(
          "UPDATE app_v1_registrations SET state='failed' WHERE id=$1 AND state='requested'",
          [registration.id],
        );
      return { state: "failed", hash: signed.hash };
    }
    const observed = await gateway.observe(image, final.minimumHeight);
    if (BigInt(observed.height) < BigInt(final.minimumHeight) || !observed.confirmed)
      throw new Error("Intents transaction is not yet confirmed by its original receipt");
    await pool.query(
      `UPDATE ${table} SET state='verified',source_height=$2 WHERE ${column}=$1 AND state='submitted'`,
      [id, observed.height],
    );
    return { state: "verified", hash: signed.hash };
  } finally {
    try {
      if (locked) await lock.query("SELECT pg_advisory_unlock(739204081)");
    } finally {
      lock.release();
    }
  }
}
