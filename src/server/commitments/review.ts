import type pg from "pg";
import { usdcAtomic, type EventDraft } from "../../domain/event-draft";
import type { AuthConfig } from "../auth/config";
import { unseal } from "../auth/crypto";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import type { OwnWallet } from "../wallets/service";

export type CommitmentReview = {
  eventId: string;
  title: string;
  rulesHash: string;
  principal: string;
  registrationClosesAt: string;
  timeZone: string;
  wallets: { source: OwnWallet; refund: OwnWallet; payout: OwnWallet };
  quote: { state: "qualification_required"; maximumInput: null; expiresAt: null };
  fees: { sourceGasMaximum: null; routingMaximum: null; deliveryMaximum: null; minimumNet: null };
  fundingAllowed: false;
  approvalAllowed: false;
};

// A current, account-scoped review, not financial consent. No provider request,
// signature, reservation or payment instruction is made while routes are closed.
export async function reviewCommitment(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: {
    eventId: string;
    rulesHash: string;
    wallets: { source: string; refund: string; payout: string };
  },
): Promise<CommitmentReview> {
  input = structuredClone(input);
  if (
    !isUuid(input.eventId) ||
    !/^[0-9a-f]{64}$/.test(input.rulesHash) ||
    !input.wallets ||
    Object.keys(input.wallets).sort().join() !== "payout,refund,source" ||
    !Object.values(input.wallets).every(isUuid)
  )
    throw new AppFailure(400, "Choose this event and a verified wallet for each destination.");
  return transaction(pool, async (client) => {
    const actor = (
      await client.query(
        `SELECT a.id FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
         WHERE s.token_hash=$1 AND a.state='active' AND s.revoked_at IS NULL
         AND s.expires_at>clock_timestamp() FOR SHARE OF a,s`,
        [session],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(401, "Sign in again before reviewing a new commitment.");
    const event = (
      await client.query(
        `SELECT e.*,clock_timestamp() AS checked_at FROM app_events e WHERE e.id=$1
         AND (e.data->>'access'='open' OR e.owner_id=$2 OR EXISTS
         (SELECT 1 FROM app_event_access x WHERE x.event_id=e.id AND x.account_id=$2)) FOR SHARE OF e`,
        [input.eventId, actor.id],
      )
    ).rows[0];
    if (!event) throw new AppFailure(404, "Private event unavailable.");
    if (
      event.owner_id === actor.id ||
      (
        await client.query(
          "SELECT 1 FROM app_event_validators WHERE event_id=$1 AND account_id=$2 AND revoked_at IS NULL",
          [event.id, actor.id],
        )
      ).rowCount
    )
      throw new AppFailure(403, "Hosts and assigned validators cannot commit as attendees.");
    const data = event.data as EventDraft;
    if (
      event.state !== "published" ||
      event.rules_hash !== input.rulesHash ||
      event.registration_closes_at.getTime() !== Date.parse(data.startsAt) ||
      event.checked_at >= event.registration_closes_at
    )
      throw new AppFailure(409, "Registration or event terms changed. Reopen this event.");
    const wallets = {} as CommitmentReview["wallets"];
    for (const purpose of ["source", "refund", "payout"] as const) {
      const id = input.wallets[purpose];
      const row = (
        await client.query(
          "SELECT encrypted_wallet FROM app_wallets WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE",
          [id, actor.id],
        )
      ).rows[0];
      if (!row) throw new AppFailure(404, "Private wallet unavailable. Verify your own wallet.");
      const value = unseal(
        config.encryptionKey,
        `wallet:${actor.id}:${id}`,
        row.encrypted_wallet,
      ) as OwnWallet;
      wallets[purpose] = {
        id,
        network: value.network,
        address: value.address,
        verifiedAt: value.verifiedAt,
      };
    }
    if (wallets.source.network !== wallets.refund.network)
      throw new AppFailure(422, "Choose a source-refund wallet on the source network.");
    const principal = usdcAtomic(data.commitment);
    if (principal === null || principal < 2_500_000n)
      throw new AppFailure(409, "Reopen this event to review its commitment amount.");
    return {
      eventId: event.id,
      title: data.title,
      rulesHash: event.rules_hash,
      principal: principal.toString(),
      registrationClosesAt: event.registration_closes_at.toISOString(),
      timeZone: data.timeZone,
      wallets,
      quote: { state: "qualification_required", maximumInput: null, expiresAt: null },
      fees: {
        sourceGasMaximum: null,
        routingMaximum: null,
        deliveryMaximum: null,
        minimumNet: null,
      },
      approvalAllowed: false,
      fundingAllowed: false,
    };
  });
}
