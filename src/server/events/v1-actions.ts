import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { identityIndex, seal, unseal } from "../auth/crypto";
import { hasRole, mutate } from "../auth/mutations";
import { requirePrivacyActor } from "../privacy/access";
import { transaction } from "../db/client";
import { AppFailure, limit } from "../http/security";
import { canonicalHash } from "../protocol/canonical";
import {
  readV1Snapshot,
  readV1Record,
  matchesV1Terms,
  v1TransactionUrl,
  type V1Snapshot,
} from "../protocol/v1-escrow";
import { storedV1Publication, type V1PublicationRow } from "./v1-publication";
import {
  ownedV1Registration,
  storedV1Registration,
  matchesV1Registration,
  type V1RegistrationImage,
} from "../commitments/v1-registration";
import { isUuid } from "./drafts";
import { unsigned } from "../protocol/rpc";
import type { V1NftEnvelope } from "../protocol/v1-nft";

export type V1ActionKind =
  "check_in" | "settle" | "cancel" | "withdraw" | "nft_release" | "nft_retry" | "nft_derive";
export type V1ActionImage = {
  format: "showup.v1.event-action.v1";
  id: string;
  eventId: string;
  accountId: string;
  kind: V1ActionKind;
  target: string;
  attempt: number;
  minimumHeight: string;
  registration?: V1RegistrationImage;
  recipient?: string;
  previousPaid?: string;
  amount?: string;
  nft?: { envelope: V1NftEnvelope; recipient: string };
};
export type V1ActionRow = {
  id: string;
  event_id: string;
  account_id: string;
  kind: V1ActionKind;
  target: string;
  attempt: number;
  image_hash: string;
  encrypted_image: string;
  state: string;
  transaction_hash: string | null;
  encrypted_transaction: string | null;
  source_height: string | null;
};
export function storedV1Action(key: string, row: V1ActionRow): V1ActionImage {
  const image = unseal(key, `v1-action:${row.id}`, row.encrypted_image) as V1ActionImage;
  if (
    image.format !== "showup.v1.event-action.v1" ||
    image.id !== row.id ||
    image.eventId !== row.event_id ||
    image.accountId !== row.account_id ||
    image.kind !== row.kind ||
    image.target !== row.target ||
    image.attempt !== row.attempt ||
    canonicalHash(image) !== row.image_hash
  )
    throw new Error("V1 action integrity");
  return image;
}
export async function readV1ActionSnapshot(
  pool: pg.Pool,
  key: string,
  eventId: string,
  transport?: typeof fetch,
) {
  if (!isUuid(eventId)) throw new AppFailure(404, "Event unavailable.");
  const row = (
    await pool.query(
      `SELECT p.*,e.owner_id,e.data,e.revision FROM app_publication_images p JOIN app_events e ON e.id=p.event_id WHERE p.event_id=$1 AND p.environment='near-mainnet-v1' AND (p.transaction_state IN ('verified','awaiting_prize','cancelled','failed') OR (p.execution_phase='publish' AND p.transaction_state IN ('requested','prepared','submitted')))`,
      [eventId],
    )
  ).rows[0] as (V1PublicationRow & { source_height: string }) | undefined;
  if (!row) throw new AppFailure(404, "Published mainnet event unavailable.");
  const image = storedV1Publication(key, row),
    snapshot = await readV1Snapshot(eventId, transport);
  const floor = (
    await pool.query(
      "SELECT max(source_height)::text AS height FROM app_v1_event_actions WHERE event_id=$1 AND state='verified'",
      [eventId],
    )
  ).rows[0].height;
  if (
    !snapshot.event ||
    !matchesV1Terms(snapshot.event, image.terms) ||
    BigInt(snapshot.block.height) <
      BigInt(row.source_height ?? row.creation_source_height ?? "0") ||
    (floor && BigInt(snapshot.block.height) < BigInt(floor))
  )
    throw new Error("V1 event observation regressed");
  return {
    snapshot,
    image,
    publicationPending: ["requested", "prepared", "submitted"].includes(row.transaction_state),
  };
}
async function hostEvent(
  client: pg.PoolClient,
  eventId: string,
  actor: { id: string; roles: string[] },
) {
  hasRole(actor, "host");
  const row = (
    await client.query("SELECT * FROM app_events WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
      eventId,
      actor.id,
    ])
  ).rows[0];
  if (!row) throw new AppFailure(404, "Private event unavailable.");
  return row;
}
async function closing(client: Pick<pg.PoolClient, "query">, eventId: string) {
  return Boolean(
    (
      await client.query(
        "SELECT 1 FROM app_v1_event_actions WHERE event_id=$1 AND kind IN ('settle','cancel') AND state<>'failed'",
        [eventId],
      )
    ).rowCount,
  );
}
function live(snapshot: V1Snapshot) {
  const event = snapshot.event;
  if (
    !event ||
    event.status !== "published" ||
    snapshot.block.timestampMs < Number(event.start_ms) ||
    snapshot.block.timestampMs >= Number(event.end_ms) ||
    Date.now() < Number(event.start_ms) ||
    Date.now() >= Number(event.end_ms)
  )
    throw new AppFailure(409, "Check-in is outside the live event window.");
}
export async function rotateV1Code(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  operationId: string,
  eventId: string,
  transport?: typeof fetch,
) {
  // Authorize before querying a private event's mainnet state.
  const owner = (
    await pool.query(
      "SELECT e.id FROM app_events e JOIN app_sessions s ON s.account_id=e.owner_id WHERE e.id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()",
      [eventId, session],
    )
  ).rowCount;
  if (!owner) throw new AppFailure(404, "Private event unavailable.");
  const { snapshot } = await readV1ActionSnapshot(pool, config.encryptionKey, eventId, transport);
  live(snapshot);
  return mutate(
    pool,
    config.encryptionKey,
    session,
    operationId,
    { eventId },
    "event.v1-code-rotated",
    async (client, actor) => {
      await hostEvent(client, eventId, actor);
      if (await closing(client, eventId)) throw new AppFailure(409, "This event is closing.");
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0"),
        expires = Math.min(Date.now() + 180000, Number(snapshot.event!.end_ms));
      await client.query(
        "INSERT INTO app_v1_code_windows(event_id,code_index,encrypted_code,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO UPDATE SET code_index=$2,encrypted_code=$3,expires_at=$4",
        [
          eventId,
          identityIndex(config.indexKey, "showup.v1.live-code.v1", `${eventId}:${code}`),
          seal(config.encryptionKey, `v1-code:${eventId}`, code),
          new Date(expires),
        ],
      );
      return { eventId, code, expiresAt: new Date(expires).toISOString() };
    },
  );
}
export async function enqueueV1Action(
  client: pg.PoolClient,
  key: string,
  input: Omit<V1ActionImage, "format" | "id" | "attempt">,
) {
  const previous = (
    await client.query(
      "SELECT * FROM app_v1_event_actions WHERE event_id=$1 AND kind=$2 AND target=$3 ORDER BY attempt DESC LIMIT 1",
      [input.eventId, input.kind, input.target],
    )
  ).rows[0] as V1ActionRow | undefined;
  if (previous && previous.state !== "failed") {
    const priorImage = storedV1Action(key, previous);
    if (
      input.kind !== "withdraw" ||
      previous.state !== "verified" ||
      priorImage.previousPaid === input.previousPaid
    )
      return { actionId: previous.id, state: previous.state };
  }
  if ((previous?.attempt ?? 0) >= 3)
    throw new AppFailure(409, "Three attempts exhausted. Reconcile the original transactions.");
  const image: V1ActionImage = {
    ...input,
    format: "showup.v1.event-action.v1",
    id: randomUUID(),
    attempt: (previous?.attempt ?? 0) + 1,
  };
  await client.query(
    "INSERT INTO app_v1_event_actions(id,event_id,account_id,kind,target,attempt,image_hash,encrypted_image) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      image.id,
      image.eventId,
      image.accountId,
      image.kind,
      image.target,
      image.attempt,
      canonicalHash(image),
      seal(key, `v1-action:${image.id}`, image),
    ],
  );
  return { actionId: image.id, state: "requested" };
}
export async function requestV1CheckIn(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  operationId: string,
  eventId: string,
  code: string,
  transport?: typeof fetch,
) {
  const own = await ownedV1Registration(pool, config.encryptionKey, session, eventId);
  if (!own) throw new AppFailure(404, "Your funded registration is unavailable.");
  await limit(pool, `v1-code:${own.row.account_id}:${eventId}`, 5);
  if (!/^\d{6}$/.test(code)) throw new AppFailure(400, "Enter the host's six-digit code.");
  const { snapshot } = await readV1ActionSnapshot(pool, config.encryptionKey, eventId, transport);
  live(snapshot);
  const registration = await readV1Record(
    "get_registration",
    own.image.id,
    snapshot.block,
    transport,
  );
  if (
    !matchesV1Registration(registration, own.image) ||
    registration!.funded !== true ||
    BigInt(snapshot.block.height) < BigInt(own.row.funding_height ?? own.row.source_height ?? "0")
  )
    throw new AppFailure(409, "Your funded deposit is not confirmed.");
  const codeIndex = identityIndex(config.indexKey, "showup.v1.live-code.v1", `${eventId}:${code}`);
  return mutate(
    pool,
    config.encryptionKey,
    session,
    operationId,
    { eventId, codeIndex },
    "event.v1-check-in-requested",
    async (client, actor) => {
      await client.query("SELECT id FROM app_events WHERE id=$1 FOR UPDATE", [eventId]);
      if (await closing(client, eventId))
        throw new AppFailure(409, "This event is closing. No new check-in was accepted.");
      const window = (
        await client.query(
          "SELECT * FROM app_v1_code_windows WHERE event_id=$1 AND expires_at>clock_timestamp()",
          [eventId],
        )
      ).rows[0];
      if (!window || !timingSafeEqual(Buffer.from(window.code_index), Buffer.from(codeIndex)))
        throw new AppFailure(
          409,
          "The code is incorrect or expired. Ask the host for the current code.",
        );
      return enqueueV1Action(client, config.encryptionKey, {
        eventId,
        accountId: actor.id,
        kind: "check_in",
        target: own.image.id,
        registration: own.image,
        minimumHeight: snapshot.block.height,
      });
    },
  );
}
export async function requestV1Close(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  operationId: string,
  eventId: string,
  kind: "settle" | "cancel",
  transport?: typeof fetch,
) {
  const actor = (
    await pool.query(
      "SELECT e.owner_id FROM app_events e JOIN app_sessions s ON s.account_id=e.owner_id WHERE e.id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()",
      [eventId, session],
    )
  ).rows[0];
  if (!actor) throw new AppFailure(404, "Private event unavailable.");
  const { snapshot } = await readV1ActionSnapshot(pool, config.encryptionKey, eventId, transport);
  if (
    (snapshot.event!.status !== "published" &&
      !(kind === "cancel" && snapshot.event!.status === "draft")) ||
    (kind === "settle" && snapshot.block.timestampMs < Number(snapshot.event!.end_ms))
  )
    throw new AppFailure(409, "This event cannot close in its current state.");
  return mutate(
    pool,
    config.encryptionKey,
    session,
    operationId,
    { eventId, kind },
    "event.v1-close-requested",
    async (client, owner) => {
      await hostEvent(client, eventId, owner);
      if (kind === "cancel" && snapshot.event!.status === "draft") {
        const publication = (
          await client.query(
            "SELECT transaction_state FROM app_publication_images WHERE event_id=$1 FOR UPDATE",
            [eventId],
          )
        ).rows[0];
        if (["requested", "prepared", "submitted"].includes(publication?.transaction_state))
          throw new AppFailure(
            409,
            "Publication is queued. Wait for its result before cancelling.",
          );
      }
      const other = (
        await client.query(
          "SELECT 1 FROM app_v1_event_actions WHERE event_id=$1 AND kind IN ('settle','cancel') AND kind<>$2 AND state<>'failed'",
          [eventId, kind],
        )
      ).rowCount;
      if (other)
        throw new AppFailure(
          409,
          "A closing transaction already exists. Check its original status.",
        );
      if (
        kind === "settle" &&
        (
          await client.query(
            "SELECT 1 FROM app_v1_event_actions WHERE event_id=$1 AND kind='check_in' AND state='failed'",
            [eventId],
          )
        ).rowCount
      )
        throw new AppFailure(409, "A check-in failed. Cancel the event to return every deposit.");
      return enqueueV1Action(client, config.encryptionKey, {
        eventId,
        accountId: owner.id,
        kind,
        target: eventId,
        minimumHeight: snapshot.block.height,
      });
    },
  );
}
export async function enqueueV1Deadline(pool: pg.Pool, key: string, transport?: typeof fetch) {
  const candidate = (
    await pool.query(
      `SELECT e.id FROM app_events e JOIN app_publication_images p ON p.event_id=e.id WHERE e.state='published' AND p.environment='near-mainnet-v1' AND p.transaction_state='verified' AND (e.data->>'endsAt')::timestamptz<=to_timestamp($1/1000.0) AND NOT EXISTS(SELECT 1 FROM app_v1_event_actions a WHERE a.event_id=e.id AND (a.kind IN ('settle','cancel') OR (a.kind='check_in' AND a.state IN ('requested','prepared','submitted')))) ORDER BY p.created_at,e.id LIMIT 1`,
      [Date.now()],
    )
  ).rows[0];
  if (!candidate) return;
  const { snapshot, image } = await readV1ActionSnapshot(pool, key, candidate.id, transport);
  if (["settled", "cancelled"].includes(String(snapshot.event!.status))) {
    await pool.query(
      "UPDATE app_events SET state=$2,updated_at=clock_timestamp() WHERE id=$1 AND state='published'",
      [candidate.id, snapshot.event!.status === "settled" ? "closed" : "cancelled"],
    );
    return;
  }
  if (snapshot.event!.status !== "published" || snapshot.block.timestampMs < image.terms.end_ms)
    return;
  return transaction(pool, async (client) => {
    await client.query("SELECT id FROM app_events WHERE id=$1 FOR UPDATE", [candidate.id]);
    if (
      (
        await client.query(
          "SELECT 1 FROM app_v1_event_actions WHERE event_id=$1 AND kind IN ('settle','cancel')",
          [candidate.id],
        )
      ).rowCount
    )
      return;
    const failed = (
      await client.query(
        "SELECT 1 FROM app_v1_event_actions WHERE event_id=$1 AND kind='check_in' AND state='failed'",
        [candidate.id],
      )
    ).rowCount;
    return enqueueV1Action(client, key, {
      eventId: candidate.id,
      accountId: image.ownerId,
      kind: failed ? "cancel" : "settle",
      target: candidate.id,
      minimumHeight: snapshot.block.height,
    });
  });
}
export function v1Claim(value: Record<string, unknown> | null, recipient: string) {
  if (!value) return { remaining: "0", paid: "0", pending: false, inFlight: "0", total: "0" };
  if (value.recipient !== recipient || typeof value.pending !== "boolean")
    throw new Error("Claim recipient/state mismatch");
  const remaining = unsigned(value.remaining, 128),
    paid = unsigned(value.paid, 128),
    inFlight = unsigned(value.in_flight, 128);
  if (value.pending !== inFlight > 0n) throw new Error("Claim in-flight mismatch");
  return {
    remaining: remaining.toString(),
    paid: paid.toString(),
    pending: value.pending,
    inFlight: inFlight.toString(),
    total: (remaining + paid + inFlight).toString(),
  };
}
export async function requestV1Withdrawal(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  operationId: string,
  eventId: string,
  claimKind: "deposit" | "recovery" | "prize",
  transport?: typeof fetch,
) {
  if (!isUuid(operationId)) throw new AppFailure(400, "Invalid operation reference.");
  const identity = await transaction(pool, (c) => requirePrivacyActor(c, session));
  const own = await ownedV1Registration(pool, config.encryptionKey, session, eventId, true);
  const owner = (
    await pool.query("SELECT id FROM app_events WHERE id=$1 AND owner_id=$2", [
      eventId,
      identity.id,
    ])
  ).rowCount;
  if (claimKind === "prize" ? !owner : !own)
    throw new AppFailure(404, "Your claim is unavailable.");
  const { snapshot, image } = await readV1ActionSnapshot(
    pool,
    config.encryptionKey,
    eventId,
    transport,
  );
  const target =
    claimKind === "prize"
      ? `prize:${eventId}`
      : claimKind === "recovery"
        ? `recovery:${own!.image.id}`
        : own!.image.id;
  const recipient = claimKind === "prize" ? image.terms.sponsor : own!.image.payout;
  const claim = v1Claim(
    await readV1Record("get_claim", target, snapshot.block, transport),
    recipient,
  );
  if (claim.pending || BigInt(claim.remaining) === 0n)
    throw new AppFailure(409, "No unpaid claim is ready. Check the original payment status.");
  return transaction(pool, async (client) => {
    const actor = await requirePrivacyActor(client, session);
    if (actor.id !== identity.id) throw new AppFailure(401, "Sign in again.");
    await client.query("SELECT id FROM app_events WHERE id=$1 FOR UPDATE", [eventId]);
    const result = await enqueueV1Action(client, config.encryptionKey, {
      eventId,
      accountId: actor.id,
      kind: "withdraw",
      target,
      recipient,
      previousPaid: claim.paid,
      amount: claim.remaining,
      minimumHeight: snapshot.block.height,
    });
    await client.query(
      "INSERT INTO app_audit(id,actor_id,action) VALUES($1,$2,'event.v1-withdrawal-requested')",
      [randomUUID(), actor.id],
    );
    return result;
  });
}
export async function readV1PaidRefund(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
) {
  if (!isUuid(eventId)) return null;
  const own = await ownedV1Registration(pool, config.encryptionKey, session, eventId, true);
  if (own?.row.state !== "funded") return null;
  const { rows } = await pool.query<V1ActionRow & { title: string }>(
    `SELECT w.*, e.data->>'title' AS title
       FROM app_v1_event_actions w JOIN app_events e ON e.id=w.event_id
      WHERE w.event_id=$1 AND w.account_id=$2 AND w.target=$3
        AND w.kind='withdraw' AND w.state='verified' AND w.source_height IS NOT NULL
        AND w.transaction_hash IS NOT NULL
        AND EXISTS (SELECT 1 FROM app_v1_event_actions c
          WHERE c.event_id=w.event_id AND c.kind='cancel' AND c.state='verified'
            AND c.source_height<=w.source_height)
      ORDER BY w.attempt DESC LIMIT 1`,
    [eventId, own.row.account_id, own.image.id],
  );
  const payment = rows[0];
  if (!payment?.transaction_hash || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payment.transaction_hash))
    return null;
  // The worker only marks a withdrawal verified after the token transfer completes.
  const withdrawal = storedV1Action(config.encryptionKey, payment);
  const paid = unsigned(withdrawal.amount, 128) + unsigned(withdrawal.previousPaid, 128);
  if (withdrawal.recipient !== own.image.payout || paid !== BigInt(own.image.amount)) return null;
  return {
    title: payment.title,
    amount: paid,
    payout: own.image.payout,
    transactionUrl: v1TransactionUrl(payment.transaction_hash),
  };
}

export async function readV1OwnReceipt(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const own = await ownedV1Registration(pool, config.encryptionKey, session, eventId, true);
  if (!own || !["registered", "funded"].includes(own.row.state)) return null;
  const { snapshot } = await readV1ActionSnapshot(pool, config.encryptionKey, eventId, transport),
    registration = await readV1Record("get_registration", own.image.id, snapshot.block, transport);
  if (
    !matchesV1Registration(registration, own.image) ||
    BigInt(snapshot.block.height) < BigInt(own.row.funding_height ?? own.row.source_height ?? "0")
  )
    throw new Error("V1 receipt registration mismatch");
  const claim = v1Claim(
      await readV1Record("get_claim", own.image.id, snapshot.block, transport),
      own.image.payout,
    ),
    recovery = v1Claim(
      await readV1Record("get_claim", `recovery:${own.image.id}`, snapshot.block, transport),
      own.image.payout,
    ),
    event = snapshot.event!;
  const terminal = ["settled", "cancelled"].includes(String(event.status)),
    winner = event.winner === own.image.id;
  const principal =
    terminal &&
    registration!.funded === true &&
    (event.status === "cancelled" || registration!.attended === true || event.winner === null)
      ? BigInt(own.image.amount)
      : 0n;
  const prize = event.status === "settled" && winner ? unsigned(event.prize, 128) : 0n;
  const share = BigInt(claim.total) - principal - prize;
  if (share < 0n) throw new Error("V1 claim conservation mismatch");
  const actions = (
    await pool.query(
      "SELECT id,kind,state,target,transaction_hash FROM app_v1_event_actions WHERE event_id=$1 AND (account_id=$2 OR kind IN ('settle','cancel')) ORDER BY created_at,id",
      [eventId, own.row.account_id],
    )
  ).rows;
  const nftDelivery = event.nft
    ? (
        await pool.query(
          "SELECT state,transaction_hash FROM app_v1_nft_deliveries WHERE event_id=$1",
          [eventId],
        )
      ).rows[0]
    : null;
  return {
    eventId,
    status: String(event.status),
    funded: registration!.funded === true,
    attended: registration!.attended === true,
    winner,
    payout: own.image.payout,
    principal: principal.toString(),
    share: share.toString(),
    prize: prize.toString(),
    claim,
    payoutTransactionUrl: (() => {
      const payment = [...actions]
        .reverse()
        .find(
          (action) =>
            action.kind === "withdraw" &&
            action.target === own.image.id &&
            action.state === "verified",
        );
      return payment?.transaction_hash ? v1TransactionUrl(payment.transaction_hash) : null;
    })(),
    withdrawalQueued: actions.some(
      (action) =>
        action.kind === "withdraw" &&
        action.target === own.image.id &&
        ["requested", "prepared", "submitted"].includes(action.state),
    ),
    recovery,
    nft: event.nft
      ? {
          winner,
          recipient: own.image.ethereum?.address ?? null,
          state: nftDelivery?.state ?? "awaiting_release",
          transactionUrl: nftDelivery
            ? `https://etherscan.io/tx/${nftDelivery.transaction_hash}`
            : null,
        }
      : null,
    actions: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      state: a.state,
      transactionUrl: a.transaction_hash ? v1TransactionUrl(a.transaction_hash) : null,
    })),
  };
}
export async function readV1HostState(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const owner = await transaction(pool, async (c) => {
    const actor = await requirePrivacyActor(c, session);
    const row = (
      await c.query("SELECT * FROM app_events WHERE id=$1 AND owner_id=$2", [eventId, actor.id])
    ).rows[0];
    if (!row) throw new AppFailure(404, "Private event unavailable.");
    return row;
  });
  const { snapshot, image } = await readV1ActionSnapshot(
    pool,
    config.encryptionKey,
    eventId,
    transport,
  );
  const rows = (
    await pool.query(
      "SELECT * FROM app_v1_registrations WHERE event_id=$1 ORDER BY created_at,id",
      [eventId],
    )
  ).rows;
  const funded = snapshot.event!.funded;
  if (!Array.isArray(funded)) throw new Error("V1 funded roster encoding");
  const checked = (
    await pool.query(
      "SELECT target FROM app_v1_event_actions WHERE event_id=$1 AND kind='check_in' AND state='verified'",
      [eventId],
    )
  ).rows.map((r) => r.target);
  const code = (
    await pool.query(
      "SELECT encrypted_code,expires_at FROM app_v1_code_windows WHERE event_id=$1 AND expires_at>clock_timestamp()",
      [eventId],
    )
  ).rows[0];
  const actions = (
    await pool.query(
      "SELECT id,kind,state,transaction_hash FROM app_v1_event_actions WHERE event_id=$1 ORDER BY created_at,id",
      [eventId],
    )
  ).rows;
  const claim = v1Claim(
    await readV1Record("get_claim", `prize:${eventId}`, snapshot.block, transport),
    image.terms.sponsor,
  );
  return {
    eventId,
    title: (owner.data as { title: string }).title,
    status: String(snapshot.event!.status),
    hasNft: Boolean(image.terms.nft),
    startsAt: Number(snapshot.event!.start_ms),
    endsAt: Number(snapshot.event!.end_ms),
    code:
      code && snapshot.event!.status === "published"
        ? (unseal(config.encryptionKey, `v1-code:${eventId}`, code.encrypted_code) as string)
        : null,
    codeExpiresAt: code?.expires_at.toISOString() ?? null,
    claim,
    roster: rows.map((row) => {
      const reg = storedV1Registration(config.encryptionKey, row);
      return {
        alias: `Attendee ${identityIndex(config.indexKey, "showup.v1.roster.v1", reg.id).slice(0, 8)}`,
        funded: funded.includes(reg.id),
        attended: checked.includes(reg.id),
        winner: snapshot.event!.winner === reg.id,
      };
    }),
    actions: actions.map((a) => ({
      id: a.id,
      kind: a.kind,
      state: a.state,
      transactionUrl: a.transaction_hash ? v1TransactionUrl(a.transaction_hash) : null,
    })),
  };
}
