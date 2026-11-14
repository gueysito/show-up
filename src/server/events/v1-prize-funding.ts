import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { hasRole, mutate } from "../auth/mutations";
import { AppFailure } from "../http/security";
import { matchesV1Terms, readV1Snapshot, type V1Snapshot } from "../protocol/v1-escrow";
import { prepareV1WalletPayment } from "../protocol/v1-wallet-payment";
import { readV1NftCustodyProgress, v1NftCustody } from "../protocol/v1-nft";
import { record } from "../protocol/quote-signature";
import {
  ownedV1Sponsor,
  readV1PublicationState,
  storedV1Publication,
  type V1PublicationRow,
} from "./v1-publication";

export async function prepareV1PrizeFunding(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  revision: number,
  transport?: typeof fetch,
) {
  const state = await readV1PublicationState(
    pool,
    session,
    eventId,
    revision,
    config.encryptionKey,
  );
  if (state.state !== "awaiting_prize")
    throw new AppFailure(
      409,
      "Check publication status and wait for the event escrow before funding.",
    );
  const row = (
    await pool.query(
      `SELECT p.*,e.owner_id,e.data,e.revision FROM app_publication_images p
    JOIN app_events e ON e.id=p.event_id WHERE p.event_id=$1`,
      [eventId],
    )
  ).rows[0] as V1PublicationRow;
  const image = storedV1Publication(config.encryptionKey, row);
  const wallet = await ownedV1Sponsor(
    pool,
    config.encryptionKey,
    row.owner_id,
    image.sponsorWalletId ?? "",
  );
  if (wallet.address !== image.terms.sponsor) throw new Error("V1 frozen sponsor mismatch");
  const snapshot = await readV1Snapshot(eventId, transport);
  requirePrizeEvent(snapshot, row, image.terms);
  if (snapshot.event!.prize_received === true)
    throw new AppFailure(
      409,
      "The prize has arrived. Confirm prize funding to publish; do not pay again.",
    );
  return prepareV1WalletPayment(
    config,
    snapshot,
    wallet,
    eventId,
    eventId,
    image.terms.prize,
    "prize",
    transport,
  );
}

function requirePrizeEvent(
  snapshot: V1Snapshot,
  row: V1PublicationRow,
  terms: Parameters<typeof matchesV1Terms>[1],
) {
  if (
    !snapshot.event ||
    snapshot.event.status !== "draft" ||
    !matchesV1Terms(snapshot.event, terms) ||
    snapshot.block.timestampMs >= terms.start_ms ||
    Date.now() >= terms.start_ms ||
    !row.creation_source_height ||
    BigInt(snapshot.block.height) < BigInt(row.creation_source_height)
  )
    throw new AppFailure(
      409,
      "The live escrow does not yet match the frozen prize event. Check status again.",
    );
}

export async function confirmV1PrizeFunding(
  pool: pg.Pool,
  key: string,
  session: string,
  operationId: string,
  eventId: string,
  revision: number,
  read: typeof readV1Snapshot = readV1Snapshot,
  progress: typeof readV1NftCustodyProgress = readV1NftCustodyProgress,
) {
  const state = await readV1PublicationState(pool, session, eventId, revision, key);
  if (state.state !== "awaiting_prize") return { eventId, state: state.state };
  const source = await read(eventId);
  return mutate(
    pool,
    key,
    session,
    operationId,
    { eventId, revision },
    "event.v1-prize-confirmed",
    async (client, actor) => {
      hasRole(actor, "host");
      const event = (
        await client.query("SELECT * FROM app_events WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
          eventId,
          actor.id,
        ])
      ).rows[0];
      if (!event || event.revision !== revision)
        throw new AppFailure(409, "Reload the owned saved event.");
      const row = (
        await client.query("SELECT * FROM app_publication_images WHERE event_id=$1 FOR UPDATE", [
          eventId,
        ])
      ).rows[0];
      if (row.transaction_state !== "awaiting_prize")
        return { eventId, state: row.transaction_state as string };
      if (
        (
          await client.query(
            "SELECT 1 FROM app_v1_event_actions WHERE event_id=$1 AND kind='cancel' AND state<>'failed'",
            [eventId],
          )
        ).rowCount
      )
        throw new AppFailure(409, "This event is being cancelled. Check its original status.");
      const full = { ...event, ...row } as V1PublicationRow;
      const image = storedV1Publication(key, full);
      requirePrizeEvent(source, full, image.terms);
      if (source.event!.prize_received !== true)
        throw new AppFailure(
          409,
          "The exact USDC prize has not been confirmed yet. Wait and check again; do not pay twice.",
        );
      if (image.terms.nft) {
        const custody = v1NftCustody(record(source.event!.nft));
        const observed = await progress(image.terms.nft, custody).catch(() => null);
        if (!observed)
          throw new AppFailure(
            503,
            "Ethereum custody status is unavailable. Check NFT custody and delivery again in a moment.",
          );
        if (observed.confirmations < 2 || observed.gasConfirmations < 2)
          throw new AppFailure(
            409,
            "Wait for two Ethereum confirmations of the NFT and return gas, then check NFT custody and delivery. You can track the original transfers in your wallet.",
          );
      }
      await client.query(
        `UPDATE app_publication_images SET execution_phase='publish',transaction_state='requested',
      transaction_hash=NULL,encrypted_transaction=NULL,gas_yocto_near=NULL WHERE event_id=$1`,
        [eventId],
      );
      return { eventId, state: "requested" };
    },
  );
}
