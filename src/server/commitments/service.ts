import { randomUUID } from "node:crypto";
import type pg from "pg";
import { usdcAtomic, type EventDraft } from "../../domain/event-draft";
import type { AuthConfig } from "../auth/config";
import { seal, unseal } from "../auth/crypto";
import { mutate } from "../auth/mutations";
import { isUuid } from "../events/drafts";
import { AppFailure, limit } from "../http/security";
import { canonicalHash, canonicalJson } from "../protocol/canonical";
import type { SettlementContext } from "../protocol/settlement-state";
import { participantCredential } from "../events/credentials";
import { createSettlementWatchInTransaction } from "./reconciliation";
import { requireNearFullAccess, NearFullAccessRequired } from "../wallets/near-access";
import type { OwnWallet } from "../wallets/service";
import type { WalletSignature } from "../wallets/proof";
import {
  createCommitmentConsent,
  consentWalletMessage,
  verifyCommitmentConsent,
  validateConsentTerms,
  type CommitmentConsent,
  type ConsentTerms,
} from "./consent";
import { contractAuthorization } from "./contract-authorization";

type PreparedTerms = Omit<ConsentTerms, "registration" | "participant" | "reservationExpiresAt">;
type WalletSelection = { source: string; refund: string; payout: string };

type ConsentReceipt = {
  id: string;
  eventId: string;
  termsHash: string;
  state: "user_authorized";
  authorizedAt: string;
};
async function rate(pool: pg.Pool, session: string) {
  const account = await pool.query(
    `SELECT a.id FROM app_sessions s JOIN app_accounts a ON a.id=s.account_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.state='active'`,
    [session],
  );
  if (!account.rowCount) throw new AppFailure(401, "Sign in again to review event consent.");
  await limit(pool, `commitment-consent:${account.rows[0].id}`, 12);
  await limit(pool, "commitment-consent:global", 120);
}
async function eligibleEvent(
  client: pg.PoolClient,
  actor: string,
  terms: ConsentTerms,
  now: number,
) {
  const result = await client.query(
    `SELECT e.*, EXISTS(SELECT 1 FROM app_event_access a WHERE a.event_id=e.id AND a.account_id=$2) AS invited
    FROM app_events e WHERE e.id=$1 FOR SHARE`,
    [terms.event, actor],
  );
  const event = result.rows[0];
  if (!event || (event.data.access === "invitation" && !event.invited && event.owner_id !== actor))
    throw new AppFailure(404, "Private event unavailable.");
  const data = event.data as EventDraft;
  if (event.owner_id === actor)
    throw new AppFailure(403, "The host cannot join this event as an eligible attendee.");
  if (
    (
      await client.query(
        "SELECT 1 FROM app_event_validators WHERE event_id=$1 AND account_id=$2 AND revoked_at IS NULL",
        [terms.event, actor],
      )
    ).rowCount
  )
    throw new AppFailure(
      403,
      "An assigned validator cannot join this event as an eligible attendee.",
    );
  if (
    event.state !== "published" ||
    event.rules_hash !== terms.rulesHash ||
    usdcAtomic(data.commitment)?.toString() !== terms.principal ||
    Date.parse(data.startsAt) !== terms.registrationClosesAt ||
    event.registration_closes_at.getTime() !== terms.registrationClosesAt ||
    now >= terms.registrationClosesAt
  )
    throw new AppFailure(409, "Registration or event terms changed. Review the event again.");
}

async function requireOwnedWallets(
  client: pg.PoolClient,
  config: AuthConfig,
  actor: string,
  wallets: WalletSelection,
  terms: ConsentTerms,
) {
  for (const purpose of ["source", "refund", "payout"] as const) {
    const id = wallets[purpose];
    if (!isUuid(id)) throw new AppFailure(400, "Choose a verified wallet for every destination.");
    const selected = await client.query(
      "SELECT encrypted_wallet FROM app_wallets WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE",
      [id, actor],
    );
    if (!selected.rowCount) throw new AppFailure(404, "Private wallet unavailable.");
    const wallet = unseal(
      config.encryptionKey,
      `wallet:${actor}:${id}`,
      selected.rows[0].encrypted_wallet,
    ) as OwnWallet;
    if (wallet.network !== terms[purpose].network || wallet.address !== terms[purpose].address)
      throw new AppFailure(409, "A destination differs from the wallet you verified.");
  }
}

// Internal preparation seam for a future qualified quote/escrow adapter. It has
// no HTTP endpoint and never calls a provider, reserves a seat or enables funding.
// Caller-supplied quote hashes and limits are NOT evidence of route qualification.
export async function prepareCommitmentConsent(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: {
    operationId: string;
    wallets: WalletSelection;
    terms: PreparedTerms;
  },
) {
  await rate(pool, session);
  return mutate(
    pool,
    config.encryptionKey,
    session,
    input.operationId,
    input,
    "commitment.consent-prepared",
    async (client, actor) => {
      const now = (
        await client.query("SELECT clock_timestamp() AS time")
      ).rows[0].time.getTime() as number;
      const terms: ConsentTerms = {
        ...input.terms,
        registration: randomUUID(),
        participant: randomUUID(),
        reservationExpiresAt: Math.min(
          now + 300_000,
          input.terms.registrationClosesAt,
          input.terms.authorizationExpiresAt,
        ),
      };
      try {
        validateConsentTerms(terms, now);
      } catch {
        throw new AppFailure(
          400,
          "Review the event, wallet destinations, amounts, fees and expiry.",
        );
      }
      await eligibleEvent(client, actor.id, terms, now);
      await requireOwnedWallets(client, config, actor.id, input.wallets, terms);
      terms.participant = await participantCredential(
        client,
        config.encryptionKey,
        actor.id,
        terms.event,
      );
      const consent = createCommitmentConsent(config.origin, terms, now);
      await client.query(
        `INSERT INTO app_commitment_consents (id,account_id,event_id,session_hash,consent_hash,encrypted_consent,signing_expires_at,authorization_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          consent.id,
          actor.id,
          terms.event,
          session,
          canonicalHash(consent),
          seal(config.encryptionKey, `commitment-consent:${actor.id}:${consent.id}`, {
            consent,
            wallets: input.wallets,
          }),
          new Date(consent.signingExpiresAt),
          new Date(terms.authorizationExpiresAt),
        ],
      );
      return consent;
    },
  );
}

export async function acceptCommitmentConsent(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: { operationId: string; consentId: string; proof: WalletSignature },
  transport: typeof fetch = fetch,
): Promise<ConsentReceipt> {
  if (!isUuid(input.consentId)) throw new AppFailure(400, "Review a fresh event consent.");
  await rate(pool, session);
  return mutate(
    pool,
    config.encryptionKey,
    session,
    input.operationId,
    input,
    "commitment.consent-authorized",
    async (client, actor) => {
      const selected = await client.query(
        `SELECT *,clock_timestamp() AS time FROM app_commitment_consents
      WHERE id=$1 AND account_id=$2 AND session_hash=$3 FOR UPDATE`,
        [input.consentId, actor.id, session],
      );
      const row = selected.rows[0];
      if (!row) throw new AppFailure(404, "Private event consent unavailable.");
      if (row.authorized_at || row.signing_expires_at <= row.time)
        throw new AppFailure(409, "Consent was already used or expired. Review a fresh consent.");
      const { consent, wallets } = unseal(
        config.encryptionKey,
        `commitment-consent:${actor.id}:${row.id}`,
        row.encrypted_consent,
      ) as { consent: CommitmentConsent; wallets: WalletSelection };
      if (
        canonicalHash(consent) !== row.consent_hash ||
        !verifyCommitmentConsent(consent, input.proof, config.origin, row.time.getTime())
      )
        throw new AppFailure(400, "The signature does not match the original event consent.");
      await eligibleEvent(client, actor.id, consent.terms, row.time.getTime());
      await requireOwnedWallets(client, config, actor.id, wallets, consent.terms);
      if (
        (await participantCredential(
          client,
          config.encryptionKey,
          actor.id,
          consent.terms.event,
        )) !== consent.terms.participant
      )
        throw new AppFailure(409, "Review a fresh consent for this account's event credential.");
      let access: Awaited<ReturnType<typeof requireNearFullAccess>> | undefined;
      if (consent.terms.source.network === "near") {
        try {
          access = await requireNearFullAccess(
            consentWalletMessage(consent),
            input.proof,
            transport,
          );
        } catch (error) {
          if (error instanceof NearFullAccessRequired)
            throw new AppFailure(403, "A current full-access NEAR key is required.");
          throw new AppFailure(503, "NEAR wallet control could not be confirmed. Wait and retry.");
        }
      }
      const accepted = await client.query(
        `UPDATE app_commitment_consents c SET authorized_at=clock_timestamp(),encrypted_proof=$2
      WHERE c.id=$1 AND c.authorized_at IS NULL AND c.signing_expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM app_sessions s WHERE s.token_hash=c.session_hash AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp())
      RETURNING authorized_at`,
        [
          consent.id,
          seal(config.encryptionKey, `commitment-proof:${actor.id}:${consent.id}`, {
            proof: input.proof,
            access,
          }),
        ],
      );
      if (!accepted.rowCount)
        throw new AppFailure(409, "Consent expired. Review and sign a fresh consent.");
      return {
        id: consent.id,
        eventId: consent.terms.event,
        termsHash: consent.termsHash,
        state: "user_authorized",
        authorizedAt: accepted.rows[0].authorized_at.toISOString(),
      };
    },
  );
}

// Restricted backend preparation from the immutable accepted record. Callers
// cannot supply replacement destinations, fees, signer proof or acceptance time.
export async function prepareOwnContractAuthorization(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: { operationId: string; consentId: string },
) {
  if (!isUuid(input.consentId)) throw new AppFailure(400, "Invalid financial authorization.");
  await rate(pool, session);
  return mutate(
    pool,
    config.encryptionKey,
    session,
    input.operationId,
    input,
    "commitment.contract-wire-prepared",
    (client, actor) => loadAcceptedContractWire(client, config, actor.id, input.consentId),
  );
}

async function loadAcceptedContractWire(
  client: pg.PoolClient,
  config: AuthConfig,
  accountId: string,
  consentId: string,
) {
  const row = (
    await client.query(
      "SELECT * FROM app_commitment_consents WHERE id=$1 AND account_id=$2 FOR SHARE",
      [consentId, accountId],
    )
  ).rows[0];
  if (!row) throw new AppFailure(404, "Private financial authorization unavailable.");
  if (!row.authorized_at || !row.encrypted_proof)
    throw new AppFailure(409, "Review and sign the original financial terms first.");
  const { consent } = unseal(
    config.encryptionKey,
    `commitment-consent:${accountId}:${row.id}`,
    row.encrypted_consent,
  ) as { consent: CommitmentConsent };
  if (
    canonicalHash(consent) !== row.consent_hash ||
    (await participantCredential(client, config.encryptionKey, accountId, consent.terms.event)) !==
      consent.terms.participant
  )
    throw new AppFailure(409, "This financial authorization needs review.");
  const { proof } = unseal(
    config.encryptionKey,
    `commitment-proof:${accountId}:${row.id}`,
    row.encrypted_proof,
  ) as { proof: WalletSignature };
  return {
    consentId: consent.id,
    ...contractAuthorization(config.origin, consent, proof, row.authorized_at.getTime()),
  };
}

// Backend-only binding; no browser route accepts a watch or finalized-state claim.
// The original approval and watch are linked atomically under the account lock.
export async function bindOwnSettlementWatch(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: { operationId: string; consentId: string; context: SettlementContext },
) {
  if (!isUuid(input.consentId)) throw new AppFailure(400, "Invalid financial authorization.");
  await rate(pool, session);
  return mutate(
    pool,
    config.encryptionKey,
    session,
    input.operationId,
    input,
    "commitment.settlement-linked",
    async (client, actor) => {
      const wire = await loadAcceptedContractWire(client, config, actor.id, input.consentId);
      if (wire.authorization.source.network !== "near")
        throw new AppFailure(409, "External-source escrow attribution remains unqualified.");
      if (
        input.context.environment !== "mainnet" ||
        canonicalJson(input.context.authorization) !== canonicalJson(wire.authorization)
      )
        throw new AppFailure(
          409,
          "Reconciliation must use the exact original financial authorization.",
        );
      const watchId = await createSettlementWatchInTransaction(client, config, input.context);
      await client.query(
        "INSERT INTO app_commitment_settlement_links(consent_id,watch_id) VALUES ($1,$2) ON CONFLICT (consent_id) DO NOTHING",
        [input.consentId, watchId],
      );
      const link = (
        await client.query(
          "SELECT watch_id FROM app_commitment_settlement_links WHERE consent_id=$1 FOR SHARE",
          [input.consentId],
        )
      ).rows[0];
      if (link.watch_id !== watchId)
        throw new AppFailure(409, "The original reconciliation binding cannot be replaced.");
      return { consentId: input.consentId, watchId, fundingAllowed: false as const };
    },
  );
}
