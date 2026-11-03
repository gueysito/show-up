import { randomUUID } from "node:crypto";
import type pg from "pg";
import { seal, unseal } from "../auth/crypto";
import type { CommitmentConsent } from "../commitments/consent";
import { isUuid } from "./drafts";

export async function participantCredential(
  client: pg.PoolClient,
  encryptionKey: string,
  actor: string,
  event: string,
) {
  const context = `event-credential:${actor}:${event}`;
  const existing = (
    await client.query(
      "SELECT encrypted_credential FROM app_event_credentials WHERE event_id=$1 AND account_id=$2 FOR UPDATE",
      [event, actor],
    )
  ).rows[0];
  if (existing) {
    const value = unseal(encryptionKey, context, existing.encrypted_credential);
    if (typeof value !== "string" || !isUuid(value))
      throw new Error("Event credential integrity failure");
    return value;
  }
  // Preserve the first pre-migration consent's opaque credential when present.
  const previous = (
    await client.query(
      "SELECT id,encrypted_consent FROM app_commitment_consents WHERE event_id=$1 AND account_id=$2 ORDER BY created_at,id LIMIT 1",
      [event, actor],
    )
  ).rows[0];
  let credential: string = randomUUID();
  if (previous) {
    const stored = unseal(
      encryptionKey,
      `commitment-consent:${actor}:${previous.id}`,
      previous.encrypted_consent,
    ) as { consent: CommitmentConsent };
    if (!isUuid(stored.consent.terms.participant))
      throw new Error("Event credential integrity failure");
    credential = stored.consent.terms.participant;
  }
  await client.query(
    "INSERT INTO app_event_credentials (event_id,account_id,encrypted_credential) VALUES ($1,$2,$3)",
    [event, actor, seal(encryptionKey, context, credential)],
  );
  return credential;
}
