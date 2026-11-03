import type pg from "pg";
import type { EventDraft } from "../../domain/event-draft";
import type { AuthConfig } from "../auth/config";
import { unseal } from "../auth/crypto";
import { databaseConfig } from "../config";
import { contractAuthorization, contractReference } from "../commitments/contract-authorization";
import type { CommitmentConsent } from "../commitments/consent";
import { participantCredential } from "../events/credentials";
import { AppFailure } from "../http/security";
import { canonicalHash, canonicalJson } from "../protocol/canonical";
import type { FinalizedHeader } from "../protocol/finalized-heads";
import { record } from "../protocol/quote-signature";
import {
  settlementContextHash,
  validateSettlementState,
  type SettlementContext,
  type SettlementViews,
} from "../protocol/settlement-state";
import type { WalletSignature } from "../wallets/proof";
import { attendanceSchedule, sandboxAttendancePacket, type AttendanceProof } from "./evidence";

export type SandboxAttendanceObservation = {
  context: SettlementContext;
  views: SettlementViews;
  block: FinalizedHeader;
};
// Explicit backend-only engineering input. No HTTP handler or environment flag
// constructs it. It cannot authorize live attendance and requires the test DB.
export type AttendanceEngineeringInput = {
  source: SandboxAttendanceObservation;
  testClock?: number;
};

export function receivedAttendanceTime(
  engineering?: AttendanceEngineeringInput,
  serverReceivedMs?: number,
) {
  const now = engineering?.testClock ?? serverReceivedMs ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0)
    throw new AppFailure(400, "Invalid server receipt time.");
  if (
    engineering &&
    (databaseConfig().purpose !== "test" || engineering.source.context.environment !== "sandbox")
  )
    throw new AppFailure(
      409,
      "Engineering attendance requires disposable sandbox context and the test database.",
    );
  return now;
}

// The caller holds the active attendee account lock before this event/consent
// lookup. Returning a sandbox packet never confirms attendance or qualifies a
// route. Real admission remains disabled until an actual qualified source exists.
export async function loadAttendanceAdmission(
  client: pg.PoolClient,
  config: AuthConfig,
  accountId: string,
  eventId: string,
  consentId: string,
  receivedMs: number,
  nonce: string,
  proofClass: AttendanceProof,
  engineering?: AttendanceEngineeringInput,
) {
  const source = engineering ? structuredClone(engineering.source) : null;
  const event = (
    await client.query(
      `SELECT e.* FROM app_events e WHERE e.id=$1 AND EXISTS
    (SELECT 1 FROM app_commitment_consents c WHERE c.id=$2 AND c.event_id=e.id AND c.account_id=$3) FOR SHARE`,
      [eventId, consentId, accountId],
    )
  ).rows[0];
  if (!event) throw new AppFailure(404, "Private event authorization unavailable.");
  if (
    event.owner_id === accountId ||
    (
      await client.query(
        "SELECT 1 FROM app_event_validators WHERE event_id=$1 AND account_id=$2 AND revoked_at IS NULL",
        [eventId, accountId],
      )
    ).rowCount
  )
    throw new AppFailure(
      403,
      "Hosts and assigned validators cannot check in as eligible attendees.",
    );
  const row = (
    await client.query(
      "SELECT * FROM app_commitment_consents WHERE id=$1 AND account_id=$2 AND event_id=$3 FOR SHARE",
      [consentId, accountId, eventId],
    )
  ).rows[0];
  if (!row?.authorized_at || !row.encrypted_proof)
    throw new AppFailure(409, "Approve the original event financial terms before check-in.");
  if (event.state !== "published")
    throw new AppFailure(409, "This event is not accepting check-in.");
  if (!source)
    throw new AppFailure(
      503,
      "Check-in is unavailable until attributable escrow and attendance evidence are qualified.",
    );
  if (
    new URL(config.origin).hostname !== "localhost" ||
    !(await client.query("SELECT current_database()='showup_test' AS disposable")).rows[0]
      .disposable
  )
    throw new AppFailure(
      409,
      "Sandbox attendance cannot use the development account database or a public origin.",
    );
  const { consent } = unseal(
    config.encryptionKey,
    `commitment-consent:${accountId}:${consentId}`,
    row.encrypted_consent,
  ) as { consent: CommitmentConsent };
  const { proof } = unseal(
    config.encryptionKey,
    `commitment-proof:${accountId}:${consentId}`,
    row.encrypted_proof,
  ) as { proof: WalletSignature };
  if (
    canonicalHash(consent) !== row.consent_hash ||
    consent.terms.event !== eventId ||
    consent.id !== consentId ||
    consent.terms.participant !==
      (await participantCredential(client, config.encryptionKey, accountId, eventId))
  )
    throw new Error("Attendance authorization integrity failure");
  const profile = {
    environment: "sandbox" as const,
    manifest: source.context.manifest,
    token: source.context.token,
  };
  const wire = contractAuthorization(
    config.origin,
    consent,
    proof,
    row.authorized_at.getTime(),
    profile,
  );
  const terms = record(record(source.views.event).terms),
    data = event.data as EventDraft;
  if (
    canonicalJson(wire.authorization) !== canonicalJson(source.context.authorization) ||
    source.context.event !== contractReference(eventId) ||
    event.rules_hash !== source.context.rulesHash ||
    Date.parse(data.startsAt) !== terms.start_ms ||
    Date.parse(data.endsAt) !== terms.end_ms ||
    (data.mode === "digital" ? "online" : "physical") !== terms.mode
  )
    throw new AppFailure(409, "The funded observation differs from the original event approval.");
  const schedule = attendanceSchedule(Date.parse(data.startsAt), Date.parse(data.endsAt));
  if (receivedMs < schedule.opensAt || receivedMs > schedule.cutoff)
    throw new AppFailure(409, "The published attendance window is closed.");
  const packet = sandboxAttendancePacket(
    source.context,
    source.views,
    source.block,
    proofClass,
    receivedMs,
    nonce,
  );
  const facts = validateSettlementState(source.context, source.views, source.block);
  return {
    packet,
    source: { contextHash: settlementContextHash(source.context), facts },
    binding: { accountId, eventId, consentId, environment: "sandbox" as const },
  };
}
