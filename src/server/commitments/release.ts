import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { seal, unseal } from "../auth/crypto";
import { databaseConfig } from "../config";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { participantCredential } from "../events/credentials";
import { AppFailure } from "../http/security";
import { canonicalHash, canonicalJson } from "../protocol/canonical";
import { record } from "../protocol/quote-signature";
import { settlementContextHash, validateSettlementState } from "../protocol/settlement-state";
import type { SandboxAttendanceObservation } from "../attendance/admission";
import type { WalletSignature } from "../wallets/proof";
import type { CommitmentConsent } from "./consent";
import { contractAuthorization, contractReference } from "./contract-authorization";

export type ReleaseAction = {
  domain: string;
  deployment: string;
  manifest: string;
  event: string;
  registration: string;
  participant: string;
  operation: "release";
  nonce: string;
  expires_ms: number;
};
type ReleaseImage = {
  format: "showup.commitment.release.v1";
  operationId: string;
  consentId: string;
  accountId: string;
  consentHash: string;
  contextHash: string;
  observedBlock: SandboxAttendanceObservation["block"];
  action: ReleaseAction;
};
function receipt(image: ReleaseImage) {
  return {
    operationId: image.operationId,
    consentId: image.consentId,
    imageHash: canonicalHash(image),
    action: image.action,
    state: "prepared" as const,
    releaseConfirmed: false as const,
    sourceQualified: false as const,
    liveSubmissionAllowed: false as const,
  };
}

// Original-obligation recovery allows a normal web session on an active OR
// deletion-requested account. It grants no new wallet, commitment or bot authority.
// Only an explicit backend source can exercise the disposable native route.
export async function prepareCommitmentRelease(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: { operationId: string; consentId: string; confirmRelease: boolean },
  engineeringSource?: SandboxAttendanceObservation,
) {
  input = structuredClone(input);
  const source = engineeringSource ? structuredClone(engineeringSource) : null;
  if (!isUuid(input.operationId) || !isUuid(input.consentId) || input.confirmRelease !== true)
    throw new AppFailure(400, "Confirm release of this original commitment.");
  return transaction(pool, async (client) => {
    const actor = (
      await client.query(
        `SELECT a.id FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
         WHERE s.token_hash=$1 AND a.state IN ('active','deletion_requested')
         AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR UPDATE OF a,s`,
        [session],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(401, "Sign in again to recover your original commitment.");
    const original = (
      await client.query(
        `SELECT c.*,e.rules_hash AS event_rules,e.data AS event_data,e.state AS event_state,clock_timestamp() AS checked_at
         FROM app_commitment_consents c JOIN app_events e ON e.id=c.event_id
         WHERE c.id=$1 AND c.account_id=$2 FOR SHARE OF c,e`,
        [input.consentId, actor.id],
      )
    ).rows[0];
    if (!original?.authorized_at || !original.encrypted_proof)
      throw new AppFailure(404, "Original approved commitment unavailable.");
    const previous = (
      await client.query("SELECT * FROM app_commitment_releases WHERE operation_id=$1 FOR UPDATE", [
        input.operationId,
      ])
    ).rows[0];
    if (previous) {
      if (previous.account_id !== actor.id || previous.consent_id !== input.consentId)
        throw new AppFailure(409, "This release reference belongs to another request.");
      const image = unseal(
        config.encryptionKey,
        `commitment-release:${actor.id}:${input.operationId}`,
        previous.encrypted_image,
      ) as ReleaseImage;
      if (
        canonicalHash(image) !== previous.image_hash ||
        image.operationId !== input.operationId ||
        image.consentId !== original.id ||
        image.accountId !== actor.id ||
        image.consentHash !== original.consent_hash
      )
        throw new Error("Original release image integrity failure");
      return receipt(image);
    }
    if (!source)
      throw new AppFailure(
        503,
        "Release submission is unavailable until the original funding and return route is qualified.",
      );
    if (
      databaseConfig().purpose !== "test" ||
      new URL(config.origin).hostname !== "localhost" ||
      source.context.environment !== "sandbox" ||
      source.context.domain !== "showup.sandbox.authorization.v1" ||
      !(await client.query("SELECT current_database()='showup_test' AS disposable")).rows[0]
        .disposable
    )
      throw new AppFailure(409, "Release engineering requires the localhost disposable sandbox.");
    const { consent } = unseal(
      config.encryptionKey,
      `commitment-consent:${actor.id}:${original.id}`,
      original.encrypted_consent,
    ) as { consent: CommitmentConsent };
    const { proof } = unseal(
      config.encryptionKey,
      `commitment-proof:${actor.id}:${original.id}`,
      original.encrypted_proof,
    ) as { proof: WalletSignature };
    if (
      canonicalHash(consent) !== original.consent_hash ||
      consent.id !== original.id ||
      consent.terms.event !== original.event_id ||
      consent.terms.participant !==
        (await participantCredential(client, config.encryptionKey, actor.id, original.event_id))
    )
      throw new Error("Original release consent integrity failure");
    const wire = contractAuthorization(
      config.origin,
      consent,
      proof,
      original.authorized_at.getTime(),
      { environment: "sandbox", manifest: source.context.manifest, token: source.context.token },
    );
    const facts = validateSettlementState(source.context, source.views, source.block);
    const terms = record(record(source.views.event).terms),
      start = Date.parse(original.event_data.startsAt),
      now = original.checked_at.getTime(),
      closesAt = start - 600_000,
      expiresAt = Math.min(now + 120_000, source.block.timestampMs + 120_000, closesAt);
    if (
      canonicalJson(wire.authorization) !== canonicalJson(source.context.authorization) ||
      source.context.event !== contractReference(original.event_id) ||
      source.context.rulesHash !== original.event_rules ||
      source.context.rulesHash !== consent.terms.rulesHash ||
      terms.start_ms !== start ||
      terms.wallet_consent_origin !== config.origin ||
      original.event_state !== "published" ||
      facts.eventState !== "published" ||
      !facts.registration?.booked ||
      facts.registration.state !== "funded" ||
      now >= closesAt ||
      source.block.timestampMs >= closesAt ||
      expiresAt <= Math.max(now, source.block.timestampMs)
    )
      throw new AppFailure(
        409,
        "Release requires the original funded commitment before its published deadline.",
      );
    const action: ReleaseAction = {
      domain: source.context.domain,
      deployment: source.context.deployment,
      manifest: source.context.manifest,
      event: source.context.event,
      registration: wire.authorization.registration,
      participant: wire.authorization.participant,
      operation: "release",
      nonce: canonicalHash({
        format: "showup.release.nonce.v1",
        operationId: input.operationId,
        consentId: original.id,
      }),
      expires_ms: expiresAt,
    };
    const image: ReleaseImage = {
      format: "showup.commitment.release.v1",
      operationId: input.operationId,
      consentId: original.id,
      accountId: actor.id,
      consentHash: original.consent_hash,
      contextHash: settlementContextHash(source.context),
      observedBlock: source.block,
      action,
    };
    const result = receipt(image);
    await client.query(
      "INSERT INTO app_commitment_releases(operation_id,consent_id,account_id,image_hash,encrypted_image,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        input.operationId,
        original.id,
        actor.id,
        result.imageHash,
        seal(config.encryptionKey, `commitment-release:${actor.id}:${input.operationId}`, image),
        new Date(expiresAt),
      ],
    );
    await client.query(
      "INSERT INTO app_audit(id,actor_id,action) VALUES($1,$2,'commitment.release-prepared')",
      [randomUUID(), actor.id],
    );
    return result;
  });
}
