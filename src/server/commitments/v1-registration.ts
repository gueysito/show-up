import { randomUUID } from "node:crypto";
import type { OwnWallet } from "../wallets/service";
import { walletAddress } from "../wallets/proof";
import { usdcAtomic } from "../../domain/event-draft";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { identityIndex, seal, unseal } from "../auth/crypto";
import { mutate } from "../auth/mutations";
import { AppFailure } from "../http/security";
import { isUuid } from "../events/drafts";
import { readEventEntry } from "../events/entry";
import { ownedV1Sponsor } from "../events/v1-publication";
import { canonicalHash } from "../protocol/canonical";
import {
  readV1Record,
  readV1Snapshot,
  v1TransactionUrl,
  type V1Snapshot,
} from "../protocol/v1-escrow";
import { prepareV1WalletPayment } from "../protocol/v1-wallet-payment";
import { requireV1PayoutStorage, v1PayoutStorageReady } from "../protocol/v1-payout-storage";

export type V1RegistrationImage = {
  ethereum?: { walletId: string; address: string };
  source?: { network: "base" | "ethereum" | "solana"; walletId: string; address: string };
  format: "showup.v1.registration.v1";
  id: string;
  eventId: string;
  accountId: string;
  rulesHash: string;
  walletId: string;
  sender: string;
  payout: string;
  amount: string;
  startMs: number;
};
export type V1RegistrationRow = {
  id: string;
  event_id: string;
  account_id: string;
  image_hash: string;
  encrypted_image: string;
  state: string;
  transaction_hash: string | null;
  encrypted_transaction: string | null;
  source_height: string | null;
  funding_height: string | null;
};
export function storedV1Registration(key: string, row: V1RegistrationRow): V1RegistrationImage {
  const image = unseal(
    key,
    `v1-registration:${row.account_id}:${row.id}`,
    row.encrypted_image,
  ) as V1RegistrationImage;
  if (
    image.format !== "showup.v1.registration.v1" ||
    image.id !== row.id ||
    image.eventId !== row.event_id ||
    image.accountId !== row.account_id ||
    canonicalHash(image) !== row.image_hash
  )
    throw new Error("V1 registration integrity");
  return image;
}
export async function ownedV1Registration(
  pool: pg.Pool,
  key: string,
  session: string,
  eventId: string,
  recovery = false,
) {
  if (!isUuid(eventId)) throw new AppFailure(400, "Choose a saved event.");
  const actor = (
    await pool.query(
      `SELECT a.id FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id WHERE s.token_hash=$1 AND a.state=ANY($2::text[]) AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,
      [session, recovery ? ["active", "deletion_requested"] : ["active"]],
    )
  ).rows[0];
  if (!actor) throw new AppFailure(401, "Sign in again to review your deposit.");
  const row = (
    await pool.query("SELECT * FROM app_v1_registrations WHERE event_id=$1 AND account_id=$2", [
      eventId,
      actor.id,
    ])
  ).rows[0] as V1RegistrationRow | undefined;
  return row ? { row, image: storedV1Registration(key, row) } : null;
}
export function matchesV1Registration(
  value: Record<string, unknown> | null,
  image: V1RegistrationImage,
) {
  return (
    value !== null &&
    value.id === image.id &&
    value.event === image.eventId &&
    value.sender === image.sender &&
    value.payout === image.payout &&
    value.ethereum === (image.ethereum?.address ?? null)
  );
}
export async function prepareV1Registration(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  operationId: string,
  eventId: string,
  rulesHash: string,
  walletId: string,
  transport?: typeof fetch,
  sourceWalletId?: string,
  ethereumWalletId?: string,
) {
  const entry = await readEventEntry(pool, config, eventId, session, transport);
  if (entry.viewer !== "attendee")
    throw new AppFailure(403, "Only an attendee can prepare this deposit.");
  if (!entry.escrow || entry.registration === "closed" || entry.rulesHash !== rulesHash)
    throw new AppFailure(409, "Reopen the live event before preparing a deposit.");
  if (sourceWalletId && sourceWalletId !== walletId) {
    const wallet = await activePayoutWallet(pool, config, session, walletId);
    await requireV1PayoutStorage(
      wallet.address,
      { block: entry.escrow.block, event: null },
      transport,
    );
  }
  return mutate(
    pool,
    config.encryptionKey,
    session,
    operationId,
    {
      eventId,
      rulesHash,
      walletId,
      ...(sourceWalletId && { sourceWalletId }),
      ...(ethereumWalletId && { ethereumWalletId }),
    },
    "event.v1-registration-requested",
    async (client, actor) => {
      const event = (
        await client.query("SELECT * FROM app_events WHERE id=$1 FOR UPDATE", [eventId])
      ).rows[0];
      if (
        event.state !== "published" ||
        event.owner_id === actor.id ||
        event.rules_hash !== rulesHash ||
        event.registration_closes_at.getTime() <= Date.now() ||
        (
          await client.query(
            "SELECT 1 FROM app_event_validators WHERE event_id=$1 AND account_id=$2 AND revoked_at IS NULL",
            [eventId, actor.id],
          )
        ).rowCount
      )
        throw new AppFailure(409, "Registration changed. Reopen this event.");
      const previous = (
        await client.query(
          "SELECT * FROM app_v1_registrations WHERE event_id=$1 AND account_id=$2",
          [eventId, actor.id],
        )
      ).rows[0];
      if (previous) {
        const image = storedV1Registration(config.encryptionKey, previous);
        if (
          image.walletId !== walletId ||
          (image.source?.walletId ?? image.walletId) !== (sourceWalletId ?? walletId) ||
          image.ethereum?.walletId !== ethereumWalletId
        )
          throw new AppFailure(409, "The original deposit wallet is locked. Check its status.");
        return { eventId, registrationId: previous.id, state: previous.state as string };
      }
      const wallet = await ownedV1Sponsor(client, config.encryptionKey, actor.id, walletId);
      let ethereum: V1RegistrationImage["ethereum"];
      if (entry.escrow!.nft) {
        if (!ethereumWalletId || !isUuid(ethereumWalletId))
          throw new AppFailure(
            422,
            "Choose your verified Ethereum wallet to receive the NFT if you win.",
          );
        const ethRow = (
          await client.query(
            "SELECT encrypted_wallet FROM app_wallets WHERE id=$1 AND account_id=$2 AND network='ethereum' AND revoked_at IS NULL",
            [ethereumWalletId, actor.id],
          )
        ).rows[0];
        if (!ethRow)
          throw new AppFailure(404, "Your verified Ethereum recipient wallet is unavailable.");
        const own = unseal(
          config.encryptionKey,
          `wallet:${actor.id}:${ethereumWalletId}`,
          ethRow.encrypted_wallet,
        ) as OwnWallet;
        if (own.id !== ethereumWalletId || own.network !== "ethereum")
          throw new Error("NFT recipient wallet integrity");
        const address = walletAddress("ethereum", own.address);
        const contributor = (
          event.data as { nft?: { contributorReturnAddress: string } }
        ).nft?.contributorReturnAddress.toLowerCase();
        if (address === contributor)
          throw new AppFailure(403, "The NFT contributor cannot receive attendee prizes.");
        ethereum = { walletId: ethereumWalletId, address };
      } else if (ethereumWalletId)
        throw new AppFailure(422, "This event has no NFT recipient selection.");
      let source: V1RegistrationImage["source"];
      if (sourceWalletId && sourceWalletId !== walletId) {
        if (!isUuid(sourceWalletId))
          throw new AppFailure(400, "Choose your verified source wallet.");
        const row = (
          await client.query(
            "SELECT encrypted_wallet FROM app_wallets WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL",
            [sourceWalletId, actor.id],
          )
        ).rows[0];
        if (!row) throw new AppFailure(404, "Your source wallet is unavailable.");
        const own = unseal(
          config.encryptionKey,
          `wallet:${actor.id}:${sourceWalletId}`,
          row.encrypted_wallet,
        ) as OwnWallet;
        if (!["base", "ethereum", "solana"].includes(own.network))
          throw new AppFailure(
            422,
            "For a direct NEAR deposit choose the same NEAR wallet for deposit and payout.",
          );
        walletAddress(own.network, own.address);
        source = {
          network: own.network as "base" | "ethereum" | "solana",
          walletId: sourceWalletId,
          address: own.address,
        };
      }
      if (wallet.address === entry.escrow!.sponsor)
        throw new AppFailure(403, "The prize funding wallet cannot receive attendee payouts.");
      const payoutIndex = identityIndex(
        config.indexKey,
        "showup.v1.payout.v1",
        `${eventId}:${wallet.address}`,
      );
      if (
        (
          await client.query(
            "SELECT 1 FROM app_v1_registrations WHERE event_id=$1 AND payout_index=$2",
            [eventId, payoutIndex],
          )
        ).rowCount
      )
        throw new AppFailure(409, "This wallet already has a registration for this event.");
      if (
        Number(
          (
            await client.query("SELECT count(*) FROM app_v1_registrations WHERE event_id=$1", [
              eventId,
            ])
          ).rows[0].count,
        ) >= 64
      )
        throw new AppFailure(409, "This event's registration limit has been reached.");
      const id = randomUUID(),
        amount = entry.escrow!.commitment;
      const image: V1RegistrationImage = {
        format: "showup.v1.registration.v1",
        id,
        eventId,
        accountId: actor.id,
        rulesHash,
        walletId,
        sender: source ? "intents.near" : wallet.address,
        payout: wallet.address,
        amount: usdcAtomic(amount)!.toString(),
        startMs: Date.parse(entry.escrow!.startsAt),
        ...(source && { source }),
        ...(ethereum && { ethereum }),
      };
      await client.query(
        "INSERT INTO app_v1_registrations(id,event_id,account_id,payout_index,image_hash,encrypted_image) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          eventId,
          actor.id,
          payoutIndex,
          canonicalHash(image),
          seal(config.encryptionKey, `v1-registration:${actor.id}:${id}`, image),
        ],
      );
      if (source)
        await client.query("INSERT INTO app_v1_route_accounts(registration_id) VALUES($1)", [id]);
      return { eventId, registrationId: id, state: "requested" };
    },
  );
}
function requireLiveEvent(snapshot: V1Snapshot, image: V1RegistrationImage) {
  if (
    !snapshot.event ||
    snapshot.event.status !== "published" ||
    snapshot.event.id !== image.eventId ||
    snapshot.event.deposit !== image.amount ||
    snapshot.event.start_ms !== image.startMs ||
    snapshot.block.timestampMs >= image.startMs ||
    Date.now() >= image.startMs
  )
    throw new AppFailure(409, "This event is closed or its live terms changed.");
}
export async function readV1RegistrationState(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const saved = await ownedV1Registration(pool, config.encryptionKey, session, eventId, true);
  if (!saved) return { state: "none", funded: false };
  const { row, image } = saved;
  let funded = false,
    attended = false,
    recovery = "0";
  if (["registered", "funded"].includes(row.state)) {
    const snapshot = await readV1Snapshot(eventId, transport),
      record = await readV1Record("get_registration", image.id, snapshot.block, transport);
    if (
      !matchesV1Registration(record, image) ||
      !row.source_height ||
      BigInt(snapshot.block.height) < BigInt(row.funding_height ?? row.source_height)
    )
      throw new Error("V1 registration source mismatch");
    funded = record!.funded === true;
    attended = record!.attended === true;
    // Cache only a verified on-chain observation. This never authorizes or sends
    // a payment; callback parameters and client flags are not consulted.
    if (funded && row.state === "registered") {
      await pool.query(
        "UPDATE app_v1_registrations SET state='funded',funding_height=$2 WHERE id=$1 AND account_id=$3 AND state='registered'",
        [row.id, snapshot.block.height, row.account_id],
      );
      row.state = "funded";
    }
    const claim = await readV1Record(
      "get_claim",
      `recovery:${image.id}`,
      snapshot.block,
      transport,
    );
    if (claim) {
      if (claim.recipient !== image.payout) throw new Error("Recovery beneficiary mismatch");
      recovery = String(claim.remaining);
    }
  }
  return {
    state: row.state,
    registrationId: row.id,
    funded,
    attended,
    recovery,
    wallet: image.sender,
    payout: image.payout,
    walletId: image.walletId,
    amountAtomic: image.amount,
    sourceNetwork: image.source?.network ?? "near",
    sourceAddress: image.source?.address ?? image.sender,
    transactionUrl: row.transaction_hash ? v1TransactionUrl(row.transaction_hash) : null,
  };
}
async function activePayoutWallet(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  walletId: string,
) {
  const actor = (
    await pool.query(
      "SELECT a.id FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id WHERE s.token_hash=$1 AND a.state='active' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()",
      [session],
    )
  ).rows[0];
  if (!actor) throw new AppFailure(401, "Sign in again to prepare your receiving account.");
  return ownedV1Sponsor(pool, config.encryptionKey, actor.id, walletId);
}
export async function prepareV1ReceivingAccount(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  walletId: string,
  transport?: typeof fetch,
) {
  const entry = await readEventEntry(pool, config, eventId, session, transport);
  if (!entry.escrow || entry.viewer !== "attendee")
    throw new AppFailure(403, "Open your attendee event before setting up USDC receiving.");
  const wallet = await activePayoutWallet(pool, config, session, walletId),
    saved = await ownedV1Registration(pool, config.encryptionKey, session, eventId);
  if (saved && saved.image.walletId !== walletId)
    throw new AppFailure(409, "Use the original locked NEAR payout wallet.");
  if (!saved && entry.registration === "closed")
    throw new AppFailure(409, "New receiving-account setup for this event is closed.");
  const snapshot: V1Snapshot = { block: entry.escrow.block, event: null };
  if (await v1PayoutStorageReady(wallet.address, snapshot, transport)) return { ready: true };
  return prepareV1WalletPayment(
    config,
    snapshot,
    wallet,
    eventId,
    eventId,
    "0",
    "storage",
    transport,
  );
}
export async function requireV1UnfundedRegistration(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const saved = await ownedV1Registration(pool, config.encryptionKey, session, eventId);
  if (saved?.row.state === "funded")
    throw new AppFailure(409, "Your deposit has arrived. Do not pay again.");
  if (!saved || saved.row.state !== "registered")
    throw new AppFailure(409, "Check your original registration status before paying.");
  const { row, image } = saved,
    snapshot = await readV1Snapshot(eventId, transport);
  requireLiveEvent(snapshot, image);
  const record = await readV1Record("get_registration", image.id, snapshot.block, transport);
  if (
    !matchesV1Registration(record, image) ||
    !row.source_height ||
    BigInt(snapshot.block.height) < BigInt(row.source_height)
  )
    throw new Error("V1 registration source mismatch");
  if (record!.funded === true)
    throw new AppFailure(409, "Your deposit has arrived. Check deposit status; do not pay again.");
  if (
    !Array.isArray(snapshot.event!.funded) ||
    snapshot.event!.funded.length >= Number(snapshot.event!.capacity)
  )
    throw new AppFailure(409, "The event is full. Do not send a deposit.");
  return { row, image, snapshot };
}
export async function prepareV1Deposit(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const { row, image, snapshot } = await requireV1UnfundedRegistration(
    pool,
    config,
    session,
    eventId,
    transport,
  );
  if (image.source)
    throw new AppFailure(
      422,
      "Review the cross-chain quote before paying from your source wallet.",
    );
  const wallet = await ownedV1Sponsor(pool, config.encryptionKey, row.account_id, image.walletId);
  if (wallet.address !== image.sender) throw new Error("Frozen deposit wallet mismatch");
  return prepareV1WalletPayment(
    config,
    snapshot,
    wallet,
    eventId,
    image.id,
    image.amount,
    "deposit",
    transport,
  );
}
export async function confirmV1Deposit(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const saved = await ownedV1Registration(pool, config.encryptionKey, session, eventId);
  if (!saved || !["registered", "funded"].includes(saved.row.state))
    throw new AppFailure(409, "Check your original registration status first.");
  const snapshot = await readV1Snapshot(eventId, transport),
    record = await readV1Record("get_registration", saved.image.id, snapshot.block, transport);
  if (
    !matchesV1Registration(record, saved.image) ||
    !saved.row.source_height ||
    BigInt(snapshot.block.height) < BigInt(saved.row.source_height)
  )
    throw new Error("V1 funding source mismatch");
  if (record!.funded !== true)
    throw new AppFailure(
      409,
      "Escrow has not confirmed this deposit. Wait and check again; do not pay twice.",
    );
  await pool.query(
    "UPDATE app_v1_registrations SET state='funded',funding_height=GREATEST(funding_height,$2::numeric) WHERE id=$1 AND account_id=$3 AND state IN ('registered','funded')",
    [saved.row.id, snapshot.block.height, saved.row.account_id],
  );
  return { state: "funded", funded: true, registrationId: saved.row.id };
}
