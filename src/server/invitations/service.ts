import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { hash, token } from "../auth/crypto";
import { hasRole, mutate, type Actor } from "../auth/mutations";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";

type InvitationInput = { kind: "host" | "event"; eventId?: string };

async function databaseNow(client: pg.PoolClient) {
  return (await client.query("SELECT clock_timestamp() AS now")).rows[0].now.getTime() as number;
}

async function eventAuthority(client: pg.PoolClient, actor: Actor, eventId: string) {
  const event = await client.query(
    "SELECT owner_id,state,registration_closes_at FROM app_events WHERE id=$1 FOR UPDATE",
    [eventId],
  );
  const row = event.rows[0];
  if (!row || (row.owner_id !== actor.id && !actor.roles.includes("admin")))
    throw new AppFailure(404, "Event unavailable.");
  return row as { owner_id: string; state: string; registration_closes_at: Date };
}

export async function issueInvitation(
  pool: pg.Pool,
  config: AuthConfig,
  sessionHash: string,
  operationId: string,
  input: InvitationInput,
) {
  if (
    !["host", "event"].includes(input.kind) ||
    (input.kind === "event" && !isUuid(input.eventId)) ||
    (input.kind === "host" && input.eventId !== undefined)
  )
    throw new AppFailure(400, "Choose a valid invitation scope.");
  return mutate(
    pool,
    config.encryptionKey,
    sessionHash,
    operationId,
    input,
    "invitation.issued",
    async (client, actor) => {
      let expiry: Date;
      if (input.kind === "host") {
        hasRole(actor, "admin");
        expiry = (await client.query("SELECT clock_timestamp()+interval '15 days' AS expiry"))
          .rows[0].expiry;
      } else {
        hasRole(actor, "host", "admin");
        const event = await eventAuthority(client, actor, input.eventId!);
        if (
          event.state !== "published" ||
          event.registration_closes_at.getTime() <= (await databaseNow(client))
        )
          throw new AppFailure(
            409,
            "Event invitations require a published event with open registration.",
          );
        expiry = event.registration_closes_at;
      }
      const value = token();
      const id = randomUUID();
      await client.query(
        `INSERT INTO app_invitations (id,token_hash,issuer_id,kind,event_id,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, hash(value), actor.id, input.kind, input.eventId ?? null, expiry],
      );
      return {
        id,
        kind: input.kind,
        eventId: input.eventId ?? null,
        expiresAt: expiry.toISOString(),
        url: `${config.origin}/invite#${value}`,
      };
    },
  );
}

export async function redeemInvitation(
  pool: pg.Pool,
  config: AuthConfig,
  sessionHash: string,
  operationId: string,
  value: string,
  consent: boolean,
) {
  if (!/^[\w-]{43}$/.test(value) || consent !== true)
    throw new AppFailure(400, "Open a valid invitation and explicitly accept its access grant.");
  // Hash the high-entropy capability; raw tokens never enter audit rows or logs.
  return mutate(
    pool,
    config.encryptionKey,
    sessionHash,
    operationId,
    { tokenHash: hash(value), consent },
    "invitation.redeemed",
    async (client, actor) => {
      const invitation = await client.query(
        "SELECT * FROM app_invitations WHERE token_hash=$1 FOR UPDATE",
        [hash(value)],
      );
      const row = invitation.rows[0];
      if (!row) throw new AppFailure(404, "Invitation unavailable.");
      if (row.redeemed_by) {
        if (row.redeemed_by !== actor.id)
          throw new AppFailure(409, "This invitation was already redeemed by another account.");
        return { kind: row.kind as string, eventId: row.event_id as string | null, granted: true };
      }
      if (row.revoked_at || row.expires_at.getTime() <= (await databaseNow(client)))
        throw new AppFailure(410, "This unused invitation expired or was revoked.");
      if (row.kind === "event") {
        const event = await client.query(
          "SELECT state,registration_closes_at FROM app_events WHERE id=$1 FOR UPDATE",
          [row.event_id],
        );
        if (
          event.rows[0]?.state !== "published" ||
          event.rows[0].registration_closes_at.getTime() <= (await databaseNow(client))
        )
          throw new AppFailure(
            410,
            "Registration closed. This invitation can no longer grant access.",
          );
        await client.query(
          `INSERT INTO app_event_access (event_id,account_id,invitation_id)
          VALUES ($1,$2,$3) ON CONFLICT (event_id,account_id) DO NOTHING`,
          [row.event_id, actor.id, row.id],
        );
      } else {
        await client.query(
          "INSERT INTO app_roles (account_id,role) VALUES ($1,'host') ON CONFLICT DO NOTHING",
          [actor.id],
        );
      }
      await client.query(
        "UPDATE app_invitations SET redeemed_by=$1,redeemed_at=clock_timestamp() WHERE id=$2",
        [actor.id, row.id],
      );
      return { kind: row.kind as string, eventId: row.event_id as string | null, granted: true };
    },
  );
}

export async function revokeInvitation(
  pool: pg.Pool,
  config: AuthConfig,
  sessionHash: string,
  operationId: string,
  id: string,
) {
  if (!isUuid(id)) throw new AppFailure(400, "Invalid invitation reference.");
  return mutate(
    pool,
    config.encryptionKey,
    sessionHash,
    operationId,
    { id },
    "invitation.revoked",
    async (client, actor) => {
      const result = await client.query(
        "SELECT kind,event_id,redeemed_by FROM app_invitations WHERE id=$1 FOR UPDATE",
        [id],
      );
      const row = result.rows[0];
      if (!row) throw new AppFailure(404, "Invitation unavailable.");
      if (row.kind === "host") hasRole(actor, "admin");
      else {
        hasRole(actor, "host", "admin");
        await eventAuthority(client, actor, row.event_id);
      }
      if (row.redeemed_by)
        throw new AppFailure(
          409,
          "Already redeemed. Revoking an unused link cannot remove existing access or obligations.",
        );
      await client.query("UPDATE app_invitations SET revoked_at=clock_timestamp() WHERE id=$1", [
        id,
      ]);
      return { id, revoked: true };
    },
  );
}

export async function listInvitations(pool: pg.Pool, actorId: string) {
  return (
    await pool.query(
      `SELECT i.id,i.kind,i.event_id AS "eventId",i.expires_at AS "expiresAt",
    i.revoked_at AS "revokedAt",(i.redeemed_at IS NOT NULL) AS redeemed
    FROM app_invitations i LEFT JOIN app_events e ON e.id=i.event_id
    WHERE i.issuer_id=$1 OR e.owner_id=$1 OR EXISTS
      (SELECT 1 FROM app_roles WHERE account_id=$1 AND role='admin')
    ORDER BY i.created_at DESC LIMIT 100`,
      [actorId],
    )
  ).rows;
}
