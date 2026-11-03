import type pg from "pg";
import { hasRole, mutate, type Actor } from "../auth/mutations";
import { transaction } from "../db/client";
import { isUuid } from "./drafts";
import { AppFailure } from "../http/security";
import { requireUnfrozenPublication } from "./publication-lock";

export type EventValidator = {
  id: string;
  alias: string;
  assignedAt: string;
  revokedAt: string | null;
  available: boolean;
};
export type ValidatorRoster = {
  eventId: string;
  revision: number;
  frozen: boolean;
  validators: EventValidator[];
};

async function eventAuthority(
  client: pg.PoolClient,
  actor: Actor,
  eventId: string,
  lock: "SHARE" | "UPDATE",
) {
  hasRole(actor, "host", "admin");
  const row = (
    await client.query(
      `SELECT e.id,e.owner_id,e.state,e.revision,EXISTS(SELECT 1 FROM app_publication_images p WHERE p.event_id=e.id) AS publication_pending FROM app_events e WHERE e.id=$1 FOR ${lock} OF e`,
      [eventId],
    )
  ).rows[0];
  if (!row || (row.owner_id !== actor.id && !actor.roles.includes("admin")))
    throw new AppFailure(404, "Private event unavailable.");
  return row;
}

export async function readEventValidators(
  pool: pg.Pool,
  sessionHash: string,
  eventId: string,
): Promise<ValidatorRoster> {
  if (!isUuid(eventId)) throw new AppFailure(400, "Choose a saved event.");
  return transaction(pool, async (client) => {
    const actor = (
      await client.query(
        `SELECT a.id FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
      WHERE s.token_hash=$1 AND a.state='active' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF a,s`,
        [sessionHash],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(401, "Sign in again to review validators.");
    const roles = await client.query("SELECT role FROM app_roles WHERE account_id=$1", [actor.id]);
    const event = await eventAuthority(
      client,
      { id: actor.id, roles: roles.rows.map((row) => row.role as string) },
      eventId,
      "SHARE",
    );
    const validators = await client.query(
      `SELECT v.id,v.alias,v.assigned_at AS "assignedAt",v.revoked_at AS "revokedAt",(a.state='active') AS available
      FROM app_event_validators v JOIN app_accounts a ON a.id=v.account_id WHERE v.event_id=$1 ORDER BY v.assigned_at,v.id`,
      [eventId],
    );
    return {
      eventId,
      revision: event.revision,
      frozen: event.state !== "draft" || event.publication_pending,
      validators: validators.rows.map((row) => ({
        ...row,
        assignedAt: row.assignedAt.toISOString(),
        revokedAt: row.revokedAt?.toISOString() ?? null,
      })),
    };
  });
}

export async function removeEventValidator(
  pool: pg.Pool,
  encryptionKey: string,
  sessionHash: string,
  input: { eventId: string; validatorId: string; operationId: string },
) {
  if (!isUuid(input.eventId) || !isUuid(input.validatorId))
    throw new AppFailure(400, "Choose a saved validator assignment.");
  return mutate(
    pool,
    encryptionKey,
    sessionHash,
    input.operationId,
    input,
    "event.validator-removed",
    async (client, actor) => {
      const event = await eventAuthority(client, actor, input.eventId, "UPDATE");
      if (event.state !== "draft")
        throw new AppFailure(409, "Validator assignments are fixed at publication.");
      await requireUnfrozenPublication(client, input.eventId);
      const validator = (
        await client.query(
          "SELECT id,revoked_at FROM app_event_validators WHERE id=$1 AND event_id=$2 FOR UPDATE",
          [input.validatorId, input.eventId],
        )
      ).rows[0];
      if (!validator) throw new AppFailure(404, "Validator assignment unavailable.");
      let revision = event.revision as number;
      if (!validator.revoked_at) {
        await client.query(
          "UPDATE app_event_validators SET revoked_at=clock_timestamp() WHERE id=$1",
          [validator.id],
        );
        revision = (
          await client.query(
            "UPDATE app_events SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING revision",
            [input.eventId],
          )
        ).rows[0].revision;
      }
      return { id: validator.id, eventId: input.eventId, removed: true, revision };
    },
  );
}
