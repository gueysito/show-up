import type pg from "pg";
import { validateDraft, usdcAtomic, formatUsdc, type EventDraft } from "../../domain/event-draft";
import { hasRole, mutate } from "../auth/mutations";
import { seal, unseal, token } from "../auth/crypto";
import { transaction } from "../db/client";
import { AppFailure } from "../http/security";
import { canonicalHash } from "../protocol/canonical";
import {
  matchesV1Terms,
  readV1Snapshot,
  v1Deployment,
  v1PreviousCodeHashes,
  v1TransactionUrl,
  type V1Terms,
} from "../protocol/v1-escrow";
import { isUuid } from "./drafts";
import type { OwnWallet } from "../wallets/service";
import { walletAddress } from "../wallets/proof";
import { v1NftTerms, readV1NftHolding } from "../protocol/v1-nft";

export type V1PublicationPhase = "atomic" | "create" | "publish";

export type V1PublicationImage = {
  deployment: { account: string; owner: string; token: string; codeHash: string };
  format: "showup.v1.mainnet-publication.v1";
  eventId: string;
  ownerId: string;
  revision: number;
  salt: string;
  materialHash: string;
  terms: V1Terms;
  sponsorWalletId?: string;
};
const publicationProfile = {
  account: v1Deployment.account,
  owner: v1Deployment.owner,
  token: v1Deployment.token,
  codeHash: v1Deployment.codeHash,
};
export type V1PublicationState = {
  eventId: string;
  revision: number;
  state:
    | "draft"
    | "requested"
    | "prepared"
    | "submitted"
    | "awaiting_prize"
    | "verified"
    | "failed"
    | "cancelled";
  canPublish: boolean;
  message: string;
  transactionUrl: string | null;
  fundingWallets?: OwnWallet[];
  canFund?: boolean;
  prizeUsdc?: string;
  fundingAddress?: string;
  nftPublicationQueued?: boolean;
  nft?: { collection: string; tokenId: string; contributor: string } | null;
};
export type V1PublicationRow = {
  event_id: string;
  owner_id: string;
  data: EventDraft;
  revision: number;
  draft_revision: number;
  image_hash: string;
  encrypted_image: string;
  transaction_state: V1PublicationState["state"];
  transaction_hash: string | null;
  encrypted_transaction: string | null;
  execution_phase?: V1PublicationPhase;
  creation_source_height?: string | null;
};

function material(data: EventDraft, salt: string) {
  const { description: _copy, ...fixed } = data;
  void _copy;
  return canonicalHash({ format: "showup.v1.app-material.v1", salt, fixed });
}
export function v1DraftTerms(
  id: string,
  data: EventDraft,
  now = Date.now(),
  sponsor?: string,
): V1Terms {
  if (!isUuid(id) || !validateDraft(data, now, "v1").ok)
    throw new AppFailure(422, "Save valid future event rules before publishing.");
  if (Buffer.byteLength(data.title) > 160)
    throw new AppFailure(422, "Shorten the event name to fit the on-chain title limit.");
  if (data.quizzes.length) throw new AppFailure(422, "Remove optional questions for this event.");
  const prize = usdcAtomic(data.sponsorBudget)!;
  if (prize > 100_000_000n) throw new AppFailure(422, "Use a prize of at most 100 USDC.");
  if (prize > 0n && !sponsor)
    throw new AppFailure(422, "Choose your verified NEAR wallet to fund the prize.");
  if (sponsor) walletAddress("near", sponsor);
  return {
    id,
    title: data.title,
    start_ms: Date.parse(data.startsAt),
    end_ms: Date.parse(data.endsAt),
    capacity: data.capacity,
    deposit: usdcAtomic(data.commitment)!.toString(),
    prize: prize.toString(),
    sponsor: prize > 0n ? sponsor! : v1Deployment.account,
    nft: data.nft ? v1NftTerms(data.nft) : null,
  };
}

export async function ownedV1Sponsor(
  client: Pick<pg.PoolClient, "query">,
  key: string,
  accountId: string,
  walletId: string,
) {
  if (!isUuid(walletId)) throw new AppFailure(422, "Choose your verified NEAR wallet.");
  const row = (
    await client.query(
      "SELECT id,encrypted_wallet FROM app_wallets WHERE id=$1 AND account_id=$2 AND network='near' AND revoked_at IS NULL",
      [walletId, accountId],
    )
  ).rows[0];
  if (!row) throw new AppFailure(404, "Your verified NEAR wallet is unavailable.");
  const wallet = unseal(key, `wallet:${accountId}:${row.id}`, row.encrypted_wallet) as OwnWallet & {
    proof: { publicKey?: string };
  };
  if (
    wallet.id !== walletId ||
    wallet.network !== "near" ||
    !wallet.proof.publicKey?.startsWith("ed25519:")
  )
    throw new Error("V1 sponsor wallet integrity");
  walletAddress("near", wallet.address);
  return { id: row.id as string, address: wallet.address, publicKey: wallet.proof.publicKey };
}
export function storedV1Publication(key: string, row: V1PublicationRow): V1PublicationImage {
  const image = unseal(
    key,
    `publication-image:${row.owner_id}:${row.event_id}`,
    row.encrypted_image,
  ) as V1PublicationImage;
  if (
    image.format !== "showup.v1.mainnet-publication.v1" ||
    ![v1Deployment.codeHash, ...v1PreviousCodeHashes].some(
      (codeHash) =>
        canonicalHash(image.deployment) === canonicalHash({ ...publicationProfile, codeHash }),
    ) ||
    canonicalHash(image) !== row.image_hash ||
    image.ownerId !== row.owner_id ||
    image.eventId !== row.event_id ||
    image.revision !== row.draft_revision ||
    material(row.data, image.salt) !== image.materialHash
  )
    throw new Error("V1 publication integrity failure");
  return image;
}
export async function prepareV1Publication(
  pool: pg.Pool,
  key: string,
  session: string,
  operationId: string,
  eventId: string,
  revision: number,
  sponsorWalletId?: string,
  transport?: typeof fetch,
) {
  if (!isUuid(eventId) || !Number.isSafeInteger(revision) || revision < 1)
    throw new AppFailure(400, "Choose a saved event revision.");
  return mutate(
    pool,
    key,
    session,
    operationId,
    { eventId, revision, ...(sponsorWalletId && { sponsorWalletId }) },
    "event.v1-publication-requested",
    async (client, actor) => {
      hasRole(actor, "host");
      const event = (
        await client.query("SELECT * FROM app_events WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
          eventId,
          actor.id,
        ])
      ).rows[0];
      if (!event) throw new AppFailure(404, "Private event unavailable.");
      if (event.state !== "draft" || event.revision !== revision)
        throw new AppFailure(409, "Reload the saved draft before publishing.");
      const previous = (
        await client.query("SELECT * FROM app_publication_images WHERE event_id=$1", [eventId])
      ).rows[0];
      if (previous) {
        if (previous.environment !== "near-mainnet-v1")
          throw new AppFailure(
            409,
            "This draft has an existing publication request. Reconcile it first.",
          );
        const stored = storedV1Publication(key, { ...event, ...previous });
        if (stored.sponsorWalletId !== sponsorWalletId)
          throw new AppFailure(409, "The prize funding wallet is locked with the original terms.");
        return { eventId, revision, state: previous.transaction_state as string };
      }
      const salt = token();
      const prize = usdcAtomic((event.data as EventDraft).sponsorBudget)!;
      const sponsor =
        prize > 0n ? await ownedV1Sponsor(client, key, actor.id, sponsorWalletId ?? "") : undefined;
      const image: V1PublicationImage = {
        deployment: publicationProfile,
        format: "showup.v1.mainnet-publication.v1",
        eventId,
        ownerId: actor.id,
        revision,
        salt,
        materialHash: material(event.data, salt),
        terms: v1DraftTerms(eventId, event.data, Date.now(), sponsor?.address),
        ...(sponsor && { sponsorWalletId: sponsor.id }),
      };
      if (image.terms.nft) {
        const holding = await readV1NftHolding(image.terms.nft, transport);
        if (holding.owner !== image.terms.nft.contributor)
          throw new AppFailure(422, "The NFT return address must be its current Ethereum owner.");
      }
      await client.query(
        `INSERT INTO app_publication_images(event_id,draft_revision,image_hash,encrypted_image,environment,execution_phase)
      VALUES($1,$2,$3,$4,'near-mainnet-v1',$5)`,
        [
          eventId,
          revision,
          canonicalHash(image),
          seal(key, `publication-image:${actor.id}:${eventId}`, image),
          prize > 0n || image.terms.nft ? "create" : "atomic",
        ],
      );
      return { eventId, revision, state: "requested" };
    },
  );
}
export async function readV1PublicationState(
  pool: pg.Pool,
  session: string,
  eventId: string,
  revision: number,
  key?: string,
): Promise<V1PublicationState> {
  if (!isUuid(eventId) || !Number.isSafeInteger(revision) || revision < 1)
    throw new AppFailure(400, "Choose a saved event revision.");
  return transaction(pool, async (client) => {
    const actor = (
      await client.query(
        `SELECT a.id FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
      JOIN app_roles r ON r.account_id=a.id AND r.role='host'
      WHERE s.token_hash=$1 AND a.state='active' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,
        [session],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(403, "Host access required.");
    const event = (
      await client.query("SELECT * FROM app_events WHERE id=$1 AND owner_id=$2", [
        eventId,
        actor.id,
      ])
    ).rows[0];
    if (!event) throw new AppFailure(404, "Private event unavailable.");
    if (event.revision !== revision)
      throw new AppFailure(409, "Reload the current saved revision.");
    const row = (
      await client.query("SELECT * FROM app_publication_images WHERE event_id=$1", [eventId])
    ).rows[0];
    const fundingWallets: OwnWallet[] = [];
    if (key) {
      const wallets = (
        await client.query(
          "SELECT id,encrypted_wallet FROM app_wallets WHERE account_id=$1 AND network='near' AND revoked_at IS NULL ORDER BY verified_at DESC LIMIT 50",
          [actor.id],
        )
      ).rows;
      for (const wallet of wallets) {
        const value = unseal(
          key,
          `wallet:${actor.id}:${wallet.id}`,
          wallet.encrypted_wallet,
        ) as OwnWallet;
        fundingWallets.push({
          id: wallet.id,
          network: "near",
          address: value.address,
          verifiedAt: value.verifiedAt,
        });
      }
    }
    let message = "Ready to publish on NEAR mainnet. The project pays network gas.";
    let canPublish = event.state === "draft" && !row;
    if (canPublish) {
      try {
        const prize = usdcAtomic((event.data as EventDraft).sponsorBudget)!;
        if (prize > 0n) {
          // A wallet is selected explicitly in the publication request.
          v1DraftTerms(eventId, event.data, Date.now(), fundingWallets[0]?.address);
        } else v1DraftTerms(eventId, event.data);
      } catch (error) {
        if (!(error instanceof AppFailure)) throw error;
        canPublish = false;
        message = error.message;
      }
    }
    const state = row?.environment === "near-mainnet-v1" ? row.transaction_state : "draft";
    if (row)
      message =
        state === "verified"
          ? "Published and verified on NEAR mainnet."
          : state === "awaiting_prize"
            ? "Event escrow created. Fund the saved prizes, then confirm custody to publish."
            : state === "cancelled"
              ? "Unpublished event cancelled. Recover its funded prizes from the event controls."
              : state === "failed"
                ? "Publication failed. The frozen request is retained; duplicate this event to start again."
                : state === "requested" &&
                    row.execution_phase === "publish" &&
                    (event.data as EventDraft).nft
                  ? "Showup will publish on NEAR once Ethereum finality and return gas are verified. You can leave this page."
                  : "Publication is queued or awaiting its original transaction. Check status without creating another request.";
    return {
      eventId,
      revision,
      state,
      canPublish,
      message,
      nftPublicationQueued:
        state === "requested" &&
        row?.execution_phase === "publish" &&
        Boolean((event.data as EventDraft).nft),
      transactionUrl: row?.transaction_hash ? v1TransactionUrl(row.transaction_hash) : null,
      fundingWallets,
      canFund:
        state === "awaiting_prize" &&
        (usdcAtomic((event.data as EventDraft).sponsorBudget) ?? 0n) > 0n,
      nft: (event.data as EventDraft).nft
        ? {
            collection: (event.data as EventDraft).nft!.collection,
            tokenId: (event.data as EventDraft).nft!.assetId,
            contributor: (event.data as EventDraft).nft!.contributorReturnAddress,
          }
        : null,
      prizeUsdc: formatUsdc(usdcAtomic((event.data as EventDraft).sponsorBudget)!),
      ...(key &&
        row?.environment === "near-mainnet-v1" && {
          fundingAddress: storedV1Publication(key, { ...event, ...row }).terms.sponsor,
        }),
    };
  });
}

export type V1PublicEscrow = {
  block: Awaited<ReturnType<typeof readV1Snapshot>>["block"];
  sponsor: string;
  account: string;
  transactionUrl: string;
  height: string;
  status: string;
  title: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  commitment: string;
  sponsorBudget: string;
  nft?: { collection: string; tokenId: string } | null;
};
export async function readV1PublishedTerms(
  pool: pg.Pool,
  key: string,
  eventId: string,
  transport?: typeof fetch,
): Promise<V1PublicEscrow | null> {
  const row = (
    await pool.query(
      `SELECT p.*,e.owner_id,e.data,e.revision FROM app_publication_images p
    JOIN app_events e ON e.id=p.event_id WHERE p.event_id=$1 AND p.environment='near-mainnet-v1'
    AND p.transaction_state='verified'`,
      [eventId],
    )
  ).rows[0] as V1PublicationRow | undefined;
  if (!row) return null;
  const image = storedV1Publication(key, row);
  const snapshot = await readV1Snapshot(eventId, transport);
  if (
    !snapshot.event ||
    !["published", "cancelled", "settled"].includes(String(snapshot.event.status)) ||
    !matchesV1Terms(snapshot.event, image.terms)
  )
    throw new AppFailure(503, "Live event temporarily unavailable. Retry shortly.");
  const terms = image.terms;
  return {
    block: snapshot.block,
    sponsor: terms.sponsor,
    account: v1Deployment.account,
    transactionUrl: v1TransactionUrl(row.transaction_hash!),
    height: snapshot.block.height,
    status: String(snapshot.event.status),
    title: terms.title,
    startsAt: new Date(terms.start_ms).toISOString(),
    endsAt: new Date(terms.end_ms).toISOString(),
    capacity: terms.capacity,
    commitment: formatUsdc(BigInt(terms.deposit)),
    sponsorBudget: formatUsdc(BigInt(terms.prize)),
    nft: terms.nft ? { collection: terms.nft.collection, tokenId: terms.nft.token_id } : null,
  };
}

export async function observeV1Publication(
  pool: pg.Pool,
  key: string,
  eventId: string,
  snapshot: Awaited<ReturnType<typeof readV1Snapshot>>,
) {
  return transaction(pool, async (client) => {
    const row = (
      await client.query(
        `SELECT p.*,e.owner_id,e.data,e.revision FROM app_publication_images p
      JOIN app_events e ON e.id=p.event_id WHERE p.event_id=$1 AND p.environment='near-mainnet-v1' FOR UPDATE OF p,e`,
        [eventId],
      )
    ).rows[0] as V1PublicationRow | undefined;
    if (!row || !row.transaction_hash || row.transaction_state !== "submitted")
      throw new Error("V1 original transaction missing");
    const image = storedV1Publication(key, row);
    if (
      !snapshot.event ||
      snapshot.event.status !== "published" ||
      !matchesV1Terms(snapshot.event, image.terms)
    )
      throw new Error("V1 on-chain publication differs");
    const rulesHash = canonicalHash({
      deployment: v1Deployment,
      terms: image.terms,
      materialHash: image.materialHash,
    });
    await client.query(
      "UPDATE app_events SET state='published',rules_hash=$2,published_at=$3,updated_at=clock_timestamp() WHERE id=$1",
      [eventId, rulesHash, new Date(snapshot.block.timestampMs)],
    );
    await client.query(
      `UPDATE app_publication_images SET transaction_state='verified',observed_source_hash=$2,
      source_height=$3,source_block=$4,observed_at=$5 WHERE event_id=$1`,
      [
        eventId,
        canonicalHash(snapshot),
        snapshot.block.height,
        snapshot.block.hash,
        new Date(snapshot.block.timestampMs),
      ],
    );
    return { eventId, transactionHash: row.transaction_hash };
  });
}
