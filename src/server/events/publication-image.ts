import type pg from "pg";
import { token, seal, unseal } from "../auth/crypto";
import type { AuthConfig } from "../auth/config";
import { hasRole, mutate } from "../auth/mutations";
import { usdcAtomic, validateDraft, type EventDraft } from "../../domain/event-draft";
import { databaseConfig } from "../config";
import { transaction } from "../db/client";
import { AppFailure } from "../http/security";
import { canonicalHash, canonicalJson } from "../protocol/canonical";
import { decodeBase58 } from "../protocol/encoding";
import { unsigned } from "../protocol/rpc";
import { record } from "../protocol/quote-signature";
import { contractReference } from "../commitments/contract-authorization";
import { walletAddress } from "../wallets/proof";
import { participantCredential } from "./credentials";
import { isUuid } from "./drafts";

export type SandboxPublicationProfile = {
  environment: "sandbox";
  domain: "showup.sandbox.authorization.v1";
  deployment: string;
  token: string;
  manifest: string;
  escrowCodeHash: string;
  tokenCodeHash: string;
};
export type SandboxPublicationSource = {
  profile: SandboxPublicationProfile;
  block: { height: string; hash: string; timestampMs: number };
  event: Record<string, unknown>;
};
type Image = {
  format: "showup.publication.image.v1";
  eventId: string;
  ownerId: string;
  revision: number;
  profile: SandboxPublicationProfile;
  salt: string;
  materialHash: string;
  terms: Record<string, unknown>;
};
function material(data: EventDraft, salt: string) {
  const { description: _copy, ...fixed } = data;
  void _copy;
  return canonicalHash({ format: "showup.event.app-material.v1", salt, fixed });
}
function rulesHash(profile: SandboxPublicationProfile, terms: Record<string, unknown>) {
  const value = { ...terms };
  delete value.rules_hash;
  return canonicalHash({
    format: "showup.event.rules.v1",
    authorization_domain: profile.domain,
    deployment: profile.deployment,
    manifest: profile.manifest,
    settlement_token: profile.token,
    terms: value,
  });
}
function validateProfile(config: AuthConfig, profile: SandboxPublicationProfile) {
  if (
    databaseConfig().purpose !== "test" ||
    new URL(config.origin).hostname !== "localhost" ||
    profile.environment !== "sandbox" ||
    profile.domain !== "showup.sandbox.authorization.v1" ||
    !profile.manifest ||
    profile.manifest.length > 128 ||
    walletAddress("near", profile.deployment) !== profile.deployment ||
    walletAddress("near", profile.token) !== profile.token
  )
    throw new AppFailure(409, "Publication engineering requires the localhost disposable sandbox.");
  decodeBase58(profile.escrowCodeHash, 32);
  decodeBase58(profile.tokenCodeHash, 32);
}
async function disposable(client: pg.PoolClient) {
  if (
    !(await client.query("SELECT current_database()='showup_test' AS disposable")).rows[0]
      .disposable
  )
    throw new AppFailure(409, "Publication engineering requires the disposable test database.");
}
function storedImage(
  config: AuthConfig,
  event: { id: string; owner_id: string },
  row: Record<string, unknown>,
): Image {
  const image = unseal(
    config.encryptionKey,
    `publication-image:${event.owner_id}:${event.id}`,
    row.encrypted_image as string,
  ) as Image;
  if (
    canonicalHash(image) !== row.image_hash ||
    image.eventId !== event.id ||
    image.ownerId !== event.owner_id ||
    image.revision !== row.draft_revision
  )
    throw new Error("Publication image integrity failure");
  return image;
}

// Backend-only native prototype integration. There is no HTTP/environment switch
// that constructs this profile or turns it into qualified live publication.
export async function prepareSandboxPublication(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: {
    operationId: string;
    eventId: string;
    revision: number;
    profile: SandboxPublicationProfile;
    template: Record<string, unknown>;
  },
) {
  input = structuredClone(input);
  validateProfile(config, input.profile);
  if (
    !isUuid(input.eventId) ||
    !Number.isInteger(input.revision) ||
    input.revision < 1 ||
    Buffer.byteLength(canonicalJson(input.template)) > 16384
  )
    throw new AppFailure(400, "Choose a saved publication revision.");
  return mutate(
    pool,
    config.encryptionKey,
    session,
    input.operationId,
    input,
    "event.publication-image",
    async (client, actor) => {
      await disposable(client);
      hasRole(actor, "host");
      const event = (
        await client.query("SELECT * FROM app_events WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
          input.eventId,
          actor.id,
        ])
      ).rows[0];
      if (!event) throw new AppFailure(404, "Private event unavailable.");
      if (event.state !== "draft" || event.revision !== input.revision)
        throw new AppFailure(409, "Reload the saved draft before preparing publication.");
      const data = event.data as EventDraft;
      if (!validateDraft(data).ok)
        throw new AppFailure(422, "Save valid future event rules before publication.");
      // Real prize/quiz/execution qualification remains separate. This exercised
      // native principal path cannot claim those unimplemented integrations.
      if (usdcAtomic(data.sponsorBudget) !== 0n || data.nft || data.quizzes.length)
        throw new AppFailure(
          409,
          "This native publication integration covers principal-only events; prize and quiz qualification remains incomplete.",
        );
      const previous = (
        await client.query("SELECT * FROM app_publication_images WHERE event_id=$1", [event.id])
      ).rows[0];
      const salt = previous ? storedImage(config, event, previous).salt : token(),
        materialHash = material(data, salt);
      const assignments = await client.query(
        "SELECT v.account_id FROM app_event_validators v JOIN app_accounts a ON a.id=v.account_id WHERE v.event_id=$1 AND v.revoked_at IS NULL AND a.state='active' ORDER BY v.account_id",
        [event.id],
      );
      const excluded: string[] = [];
      for (const id of [actor.id, ...assignments.rows.map((row) => row.account_id as string)])
        excluded.push(
          contractReference(
            await participantCredential(client, config.encryptionKey, id, event.id),
          ),
        );
      const terms = {
        ...input.template,
        event: contractReference(event.id),
        mode: data.mode === "digital" ? "online" : "physical",
        capacity: data.capacity,
        principal: usdcAtomic(data.commitment)!.toString(),
        sponsor_budget: "0",
        start_ms: Date.parse(data.startsAt),
        end_ms: Date.parse(data.endsAt),
        latest_quiz_close_ms: 0,
        excluded: [...new Set(excluded)].sort(),
        wallet_consent_origin: config.origin,
        app_rules_hash: materialHash,
      };
      if (
        record(terms).draw_policy !== null ||
        record(terms).custody_proof_policy !== null ||
        record(terms).native_nft !== null ||
        record(terms).observer_policy !== null
      )
        throw new AppFailure(409, "Unsupported publication policy in this native integration.");
      walletAddress("near", String(record(terms).host));
      record(terms).rules_hash = rulesHash(input.profile, terms);
      const image: Image = {
        format: "showup.publication.image.v1",
        eventId: event.id,
        ownerId: actor.id,
        revision: event.revision,
        profile: input.profile,
        salt,
        materialHash,
        terms,
      };
      const digest = canonicalHash(image);
      if (previous) {
        if (previous.image_hash !== digest)
          throw new AppFailure(
            409,
            "The original publication image cannot be replaced. Reconcile it before changing terms.",
          );
      } else
        await client.query(
          "INSERT INTO app_publication_images(event_id,draft_revision,image_hash,encrypted_image) VALUES($1,$2,$3,$4)",
          [
            event.id,
            event.revision,
            digest,
            seal(config.encryptionKey, `publication-image:${actor.id}:${event.id}`, image),
          ],
        );
      return {
        eventId: event.id as string,
        revision: event.revision as number,
        imageHash: digest,
        appRulesHash: materialHash,
        rulesHash: record(terms).rules_hash as string,
        terms,
        sourceQualified: false as const,
        liveSubmissionAllowed: false as const,
      };
    },
  );
}
export async function observeSandboxPublication(
  pool: pg.Pool,
  config: AuthConfig,
  eventId: string,
  imageHash: string,
  source: SandboxPublicationSource,
) {
  source = structuredClone(source);
  validateProfile(config, source.profile);
  if (
    !isUuid(eventId) ||
    !/^[0-9a-f]{64}$/.test(imageHash) ||
    !Number.isSafeInteger(source.block.timestampMs) ||
    source.block.timestampMs < 0
  )
    throw new AppFailure(400, "Invalid publication observation.");
  const height = unsigned(source.block.height, 64).toString();
  decodeBase58(source.block.hash, 32);
  return transaction(pool, async (client) => {
    await disposable(client);
    const ref = (await client.query("SELECT owner_id FROM app_events WHERE id=$1", [eventId]))
      .rows[0];
    if (!ref) throw new AppFailure(404, "Private publication unavailable.");
    await client.query("SELECT id FROM app_accounts WHERE id=$1 FOR UPDATE", [ref.owner_id]);
    const event = (await client.query("SELECT * FROM app_events WHERE id=$1 FOR UPDATE", [eventId]))
        .rows[0],
      row = (
        await client.query("SELECT * FROM app_publication_images WHERE event_id=$1 FOR UPDATE", [
          eventId,
        ])
      ).rows[0];
    if (!row || row.image_hash !== imageHash)
      throw new AppFailure(409, "Reconcile the original publication image.");
    const image = storedImage(config, event, row),
      observed = record(source.event),
      terms = record(observed.terms);
    if (
      canonicalJson(image.profile) !== canonicalJson(source.profile) ||
      canonicalJson(image.terms) !== canonicalJson(terms) ||
      rulesHash(source.profile, terms) !== terms.rules_hash ||
      terms.app_rules_hash !== image.materialHash ||
      material(event.data, image.salt) !== image.materialHash ||
      (row.observed_source_hash
        ? event.revision < image.revision
        : event.revision !== image.revision) ||
      observed.status !== "published" ||
      observed.sponsor_received !== "0" ||
      !Array.isArray(observed.funded) ||
      observed.funded.length ||
      !Array.isArray(observed.reserved) ||
      observed.reserved.length ||
      source.block.timestampMs >= Number(terms.start_ms)
    )
      throw new AppFailure(409, "Contract publication differs from the frozen application rules.");
    const sourceHash = canonicalHash(source);
    if (row.observed_source_hash) {
      if (
        row.observed_source_hash !== sourceHash ||
        event.state !== "published" ||
        event.rules_hash !== terms.rules_hash
      )
        throw new AppFailure(409, "The original publication observation cannot be replaced.");
      return { eventId, state: "published" as const, sourceQualified: false as const };
    }
    if (event.state !== "draft")
      throw new AppFailure(409, "Reconcile this event's existing publication.");
    await client.query(
      "UPDATE app_events SET state='published',rules_hash=$2,published_at=$3,updated_at=clock_timestamp() WHERE id=$1",
      [eventId, terms.rules_hash, new Date(source.block.timestampMs)],
    );
    await client.query(
      "UPDATE app_publication_images SET observed_source_hash=$2,source_height=$3,source_block=$4,observed_at=$5 WHERE event_id=$1",
      [eventId, sourceHash, height, source.block.hash, new Date(source.block.timestampMs)],
    );
    return { eventId, state: "published" as const, sourceQualified: false as const };
  });
}
