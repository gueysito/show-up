import type pg from "pg";
import type { EventDraft } from "../../domain/event-draft";
import type { AuthConfig } from "../auth/config";
import { identityIndex } from "../auth/crypto";
import { transaction } from "../db/client";
import { AppFailure } from "../http/security";
import { isUuid } from "./drafts";

export type EventEntry = {
  id: string;
  state: string;
  rulesHash: string;
  hostAlias: string;
  viewer: "anonymous" | "attendee" | "staff" | "recovery";
  registration: "verification_required" | "closed";
  data: Pick<
    EventDraft,
    | "title"
    | "description"
    | "mode"
    | "sessionReference"
    | "venue"
    | "timeZone"
    | "startsAt"
    | "endsAt"
    | "capacity"
    | "commitment"
    | "sponsorBudget"
    | "rewardPreset"
    | "access"
  >;
  quizCount: number;
  nft: { network: string; collection: string; assetId: string } | null;
};
export function eventHostAlias(
  config: Pick<AuthConfig, "indexKey">,
  eventId: string,
  ownerId: string,
) {
  return `Host ${identityIndex(config.indexKey, "showup.event.host-alias.v1", `${eventId}:${ownerId}`).slice(0, 10)}`;
}
export async function readEventEntry(
  pool: pg.Pool,
  config: AuthConfig,
  eventId: string,
  sessionHash?: string,
): Promise<EventEntry> {
  if (!isUuid(eventId)) throw new AppFailure(404, "Event unavailable.");
  return transaction(pool, async (client) => {
    const actor = sessionHash
      ? (
          await client.query(
            `SELECT a.id,a.state FROM app_sessions s JOIN app_accounts a ON a.id=s.account_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
       AND a.state IN ('active','deletion_requested') FOR SHARE OF a,s`,
            [sessionHash],
          )
        ).rows[0]
      : undefined;
    const row = (
      await client.query(
        `SELECT e.*,EXISTS(SELECT 1 FROM app_event_validators v WHERE v.event_id=e.id AND v.account_id=$2
       AND v.revoked_at IS NULL AND v.assigned_at<=e.published_at) AS assigned
       FROM app_events e WHERE e.id=$1 AND e.state<>'draft'
       AND (e.data->>'access'='open' OR e.owner_id=$2
         OR EXISTS(SELECT 1 FROM app_event_access x WHERE x.event_id=e.id AND x.account_id=$2)
         OR EXISTS(SELECT 1 FROM app_commitment_consents c WHERE c.event_id=e.id AND c.account_id=$2)
         OR EXISTS(SELECT 1 FROM app_event_validators v WHERE v.event_id=e.id AND v.account_id=$2 AND v.revoked_at IS NULL)) FOR SHARE OF e`,
        [eventId, actor?.id ?? null],
      )
    ).rows[0];
    if (!row) throw new AppFailure(404, "Event unavailable.");
    const data = row.data as EventDraft;
    if (row.registration_closes_at.getTime() !== Date.parse(data.startsAt))
      throw new Error("Event registration bounds differ");
    return {
      id: row.id,
      state: row.state,
      rulesHash: row.rules_hash,
      hostAlias: eventHostAlias(config, row.id, row.owner_id),
      viewer: !actor
        ? "anonymous"
        : actor.state === "deletion_requested"
          ? "recovery"
          : row.owner_id === actor.id || row.assigned
            ? "staff"
            : "attendee",
      registration:
        row.state !== "published" || row.registration_closes_at.getTime() <= Date.now()
          ? "closed"
          : "verification_required",
      data: {
        title: data.title,
        description: data.description,
        mode: data.mode,
        sessionReference: data.sessionReference,
        venue: data.venue,
        timeZone: data.timeZone,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        capacity: data.capacity,
        commitment: data.commitment,
        sponsorBudget: data.sponsorBudget,
        rewardPreset: data.rewardPreset,
        access: data.access,
      },
      quizCount: data.quizzes.length,
      nft: data.nft
        ? { network: data.nft.network, collection: data.nft.collection, assetId: data.nft.assetId }
        : null,
    };
  });
}
