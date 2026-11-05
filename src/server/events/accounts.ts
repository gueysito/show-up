import { randomUUID } from "node:crypto";
import type pg from "pg";
import { validateDraft, type EventDraft } from "../../domain/event-draft";
import { hasRole, mutate, type Actor } from "../auth/mutations";
import { isUuid, type DraftSave } from "./drafts";
import { AppFailure } from "../http/security";
import { participantCredential } from "./credentials";
import { requireUnfrozenPublication } from "./publication-lock";

type AccountEvent = {
  id: string;
  revision: number;
  data: EventDraft;
  updatedAt: string;
  state: string;
};

async function ownedEvent(client: pg.PoolClient, actor: Actor, id: string) {
  if (!isUuid(id)) throw new AppFailure(400, "Invalid event reference.");
  const result = await client.query(
    "SELECT * FROM app_events WHERE id=$1 AND owner_id=$2 FOR UPDATE",
    [id, actor.id],
  );
  const row = result.rows[0];
  if (!row) throw new AppFailure(404, "Private event unavailable.");
  return row as { id: string; revision: number; data: EventDraft; state: string };
}

async function savedOutbox(
  client: pg.PoolClient,
  operationId: string,
  id: string,
  revision: number,
) {
  await client.query(
    "INSERT INTO outbox (operation_id,topic,payload) VALUES ($1,'draft.saved',$2)",
    [operationId, { eventId: id, revision }],
  );
}

export async function saveAccountDraft(
  pool: pg.Pool,
  key: string,
  session: string,
  input: DraftSave,
  version: "v1" | "v2" = "v2",
) {
  if (!isUuid(input.id) || !Number.isInteger(input.revision) || input.revision < 0)
    throw new AppFailure(400, "Invalid draft operation.");
  return mutate(
    pool,
    key,
    session,
    input.operationId,
    { ...input, validationVersion: version },
    "event.saved",
    async (client, actor) => {
      hasRole(actor, "host");
      const validated = validateDraft(input.data, Date.now(), version);
      if (!validated.ok) throw new AppFailure(422, "Review the event rules.", validated.errors);
      const existing = await client.query(
        "SELECT owner_id,revision,state FROM app_events WHERE id=$1 FOR UPDATE",
        [input.id],
      );
      const row = existing.rows[0];
      if (row && row.owner_id !== actor.id) throw new AppFailure(404, "Private event unavailable.");
      if (row && row.state !== "draft")
        throw new AppFailure(
          409,
          "Published material terms are locked. Duplicate this event to change them.",
        );
      if (row) await requireUnfrozenPublication(client, input.id);
      if ((row?.revision ?? 0) !== input.revision)
        throw new AppFailure(
          409,
          "This draft changed in another tab. Reload the saved version before editing.",
        );
      const revision = input.revision + 1;
      if (row) {
        await client.query(
          `UPDATE app_events SET revision=$2,data=$3,registration_closes_at=$4,updated_at=clock_timestamp()
        WHERE id=$1`,
          [input.id, revision, validated.value, validated.value.startsAt],
        );
      } else {
        await client.query(
          `INSERT INTO app_events (id,owner_id,revision,data,registration_closes_at)
        VALUES ($1,$2,$3,$4,$5)`,
          [input.id, actor.id, revision, validated.value, validated.value.startsAt],
        );
      }
      await participantCredential(client, key, actor.id, input.id);
      await savedOutbox(client, input.operationId, input.id, revision);
      return { id: input.id, revision, operationId: input.operationId };
    },
  );
}

export async function listAccountEvents(pool: pg.Pool, accountId: string): Promise<AccountEvent[]> {
  return (
    await pool.query(
      `SELECT id,revision,data,CASE WHEN state='draft' AND EXISTS
       (SELECT 1 FROM app_publication_images p WHERE p.event_id=app_events.id AND p.environment='near-mainnet-v1')
       THEN 'publication_pending' ELSE state END AS state,updated_at AS "updatedAt"
    FROM app_events WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 50`,
      [accountId],
    )
  ).rows;
}

export async function duplicateAccountEvent(
  pool: pg.Pool,
  key: string,
  session: string,
  operationId: string,
  sourceId: string,
) {
  return mutate(
    pool,
    key,
    session,
    operationId,
    { sourceId },
    "event.duplicated",
    async (client, actor) => {
      hasRole(actor, "host");
      const original = await ownedEvent(client, actor, sourceId);
      const id = randomUUID();
      const data = { ...original.data, title: `${original.data.title.slice(0, 113)} (copy)` };
      const result = await client.query(
        `INSERT INTO app_events (id,owner_id,revision,data,registration_closes_at)
      VALUES ($1,$2,1,$3,$4) RETURNING updated_at`,
        [id, actor.id, data, data.startsAt],
      );
      await participantCredential(client, key, actor.id, id);
      await savedOutbox(client, operationId, id, 1);
      return {
        id,
        revision: 1,
        data,
        state: "draft",
        updatedAt: result.rows[0].updated_at.toISOString(),
      } as AccountEvent;
    },
  );
}

export async function correctPublishedDescription(
  pool: pg.Pool,
  key: string,
  session: string,
  operationId: string,
  id: string,
  revision: number,
  description: string,
) {
  if (!Number.isInteger(revision) || typeof description !== "string" || description.length > 2000)
    throw new AppFailure(400, "Enter a description of at most 2000 characters.");
  return mutate(
    pool,
    key,
    session,
    operationId,
    { id, revision, description },
    "event.copy-corrected",
    async (client, actor) => {
      hasRole(actor, "host");
      const event = await ownedEvent(client, actor, id);
      if (event.state !== "published")
        throw new AppFailure(409, "Use draft editing before publication.");
      if (event.revision !== revision)
        throw new AppFailure(409, "This event changed. Reload before correcting its description.");
      await client.query(
        `UPDATE app_events SET data=jsonb_set(data,'{description}',to_jsonb($2::text)),
      revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,
        [id, description],
      );
      return { id, revision: revision + 1, operationId };
    },
  );
}

// Retained V2 prototype guard. The V1 HTTP route uses prepareV1Publication.
export async function requestPublication(
  pool: pg.Pool,
  key: string,
  session: string,
  operationId: string,
  id: string,
) {
  return mutate(
    pool,
    key,
    session,
    operationId,
    { id },
    "event.publication-requested",
    async (client, actor) => {
      hasRole(actor, "host");
      await ownedEvent(client, actor, id);
      throw new AppFailure(
        409,
        "Publication is disabled: attributable escrow, authorized returns and protocol prerequisites are not verified.",
      );
    },
  );
}
