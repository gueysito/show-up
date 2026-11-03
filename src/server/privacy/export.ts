import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { unseal } from "../auth/crypto";
import { transaction } from "../db/client";
import { canonicalHash } from "../protocol/canonical";
import type { CommitmentConsent } from "../commitments/consent";
import type { WalletSignature } from "../wallets/proof";
import type { OwnWallet } from "../wallets/service";
import { requirePrivacyActor } from "./access";
import { settlementWatchSnapshot } from "../commitments/reconciliation";
import { attendanceCandidateRecord } from "../attendance/attempts";

// Export owned product data, excluding security tokens, blind indexes and challenges.
export async function exportOwnData(pool: pg.Pool, config: AuthConfig, sessionHash: string) {
  return transaction(pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const actor = await requirePrivacyActor(client, sessionHash);
    const [
      identities,
      roles,
      wallets,
      consents,
      events,
      issued,
      redeemed,
      access,
      audit,
      watches,
      deletion,
      codeWindows,
      validatorAssignments,
      hostedValidators,
      attendanceCandidates,
      attendanceQrWindows,
      validatorScans,
      hostedEvidenceBarriers,
      hostedAttendanceCheckpoints,
      attendanceDeliveries,
    ] = [
      await client.query(
        "SELECT provider,identity_hash,encrypted_identity,created_at FROM app_identities WHERE account_id=$1 ORDER BY provider",
        [actor.id],
      ),
      await client.query("SELECT role FROM app_roles WHERE account_id=$1 ORDER BY role", [
        actor.id,
      ]),
      await client.query(
        "SELECT id,encrypted_wallet,revoked_at FROM app_wallets WHERE account_id=$1 ORDER BY created_at,id",
        [actor.id],
      ),
      await client.query(
        "SELECT * FROM app_commitment_consents WHERE account_id=$1 ORDER BY created_at,id",
        [actor.id],
      ),
      await client.query(
        "SELECT id,revision,data,state,rules_hash,published_at,updated_at FROM app_events WHERE owner_id=$1 ORDER BY updated_at,id",
        [actor.id],
      ),
      await client.query(
        "SELECT id,kind,event_id,expires_at,revoked_at,redeemed_at,created_at FROM app_invitations WHERE issuer_id=$1 ORDER BY created_at,id",
        [actor.id],
      ),
      await client.query(
        "SELECT id,kind,event_id,redeemed_at FROM app_invitations WHERE redeemed_by=$1 ORDER BY redeemed_at,id",
        [actor.id],
      ),
      await client.query(
        "SELECT event_id,granted_at FROM app_event_access WHERE account_id=$1 ORDER BY granted_at,event_id",
        [actor.id],
      ),
      await client.query(
        "SELECT id,action,entity_id,created_at FROM app_audit WHERE actor_id=$1 ORDER BY created_at,id",
        [actor.id],
      ),
      await client.query(
        `SELECT l.consent_id,w.* FROM app_commitment_settlement_links l
          JOIN app_commitment_consents c ON c.id=l.consent_id JOIN app_settlement_watches w ON w.id=l.watch_id
          WHERE c.account_id=$1`,
        [actor.id],
      ),
      await client.query(
        "SELECT id,requested_at,completed_at,hold_reasons FROM app_deletion_requests WHERE account_id=$1",
        [actor.id],
      ),
      await client.query(
        `SELECT w.id,w.event_id,w.opened_at,w.expires_at,w.retired_at FROM app_attendance_code_windows w
        JOIN app_events e ON e.id=w.event_id WHERE e.owner_id=$1 ORDER BY w.opened_at,w.id`,
        [actor.id],
      ),
      await client.query(
        "SELECT id,event_id,alias,assigned_at,revoked_at FROM app_event_validators WHERE account_id=$1 ORDER BY assigned_at,id",
        [actor.id],
      ),
      await client.query(
        `SELECT v.id,v.event_id,v.alias,v.assigned_at,v.revoked_at FROM app_event_validators v
        JOIN app_events e ON e.id=v.event_id WHERE e.owner_id=$1 ORDER BY v.assigned_at,v.id`,
        [actor.id],
      ),
      await client.query(
        "SELECT * FROM app_attendance_candidates WHERE account_id=$1 ORDER BY received_at,id",
        [actor.id],
      ),
      await client.query(
        "SELECT id,event_id,issued_at,expires_at,retired_at,consumed_at FROM app_attendance_qr WHERE account_id=$1 ORDER BY issued_at,id",
        [actor.id],
      ),
      await client.query(
        `SELECT s.id,q.event_id,s.scanned_at,s.confirmed_at FROM app_attendance_qr_scans s
        JOIN app_attendance_qr q ON q.id=s.qr_id WHERE s.validator_id=$1 ORDER BY s.scanned_at,s.id`,
        [actor.id],
      ),
      await client.query(
        `SELECT b.event_id,b.complete_through_ms,b.frozen_at_ms,b.candidate_count FROM app_attendance_evidence_barriers b
        JOIN app_events e ON e.id=b.event_id WHERE e.owner_id=$1 ORDER BY b.frozen_at_ms,b.event_id`,
        [actor.id],
      ),
      await client.query(
        `SELECT c.id,c.event_id,c.checkpoint_hash,c.observed_height,c.observed_hash,c.ledger_version FROM app_attendance_checkpoints c
        JOIN app_events e ON e.id=c.event_id WHERE e.owner_id=$1 ORDER BY c.observed_height,c.id`,
        [actor.id],
      ),
      await client.query(
        `SELECT d.candidate_id,c.event_id,d.state,d.attempts,d.observed_height,d.observed_hash,d.last_error
        FROM app_attendance_deliveries d JOIN app_attendance_candidates c ON c.id=d.candidate_id
        WHERE c.account_id=$1 ORDER BY c.received_at,c.id`,
        [actor.id],
      ),
    ];
    return {
      format: "showup.own-data.v1",
      exportedAt: new Date().toISOString(),
      account: { id: actor.id, state: actor.state, createdAt: actor.createdAt.toISOString() },
      linkedIdentities: identities.rows.map((row) => {
        const identity = unseal(
          config.encryptionKey,
          `identity:${row.identity_hash}`,
          row.encrypted_identity,
        ) as { issuer: string; subject: string };
        return {
          provider: row.provider,
          issuer: identity.issuer,
          subject: identity.subject,
          linkedAt: row.created_at.toISOString(),
        };
      }),
      roles: roles.rows.map((row) => row.role as string),
      wallets: wallets.rows.map((row) => {
        const wallet = unseal(
          config.encryptionKey,
          `wallet:${actor.id}:${row.id}`,
          row.encrypted_wallet,
        ) as OwnWallet;
        return {
          id: row.id,
          network: wallet.network,
          address: wallet.address,
          verifiedAt: wallet.verifiedAt,
          revokedAt: row.revoked_at?.toISOString() ?? null,
        };
      }),
      financialAuthorizations: consents.rows.map((row) => {
        const { consent } = unseal(
          config.encryptionKey,
          `commitment-consent:${actor.id}:${row.id}`,
          row.encrypted_consent,
        ) as { consent: CommitmentConsent };
        if (canonicalHash(consent) !== row.consent_hash)
          throw new Error("Financial export integrity failure");
        const approved = row.encrypted_proof
          ? (unseal(
              config.encryptionKey,
              `commitment-proof:${actor.id}:${row.id}`,
              row.encrypted_proof,
            ) as { proof: WalletSignature })
          : null;
        return {
          consent,
          proof: approved?.proof ?? null,
          preparedAt: row.created_at.toISOString(),
          approvedAt: row.authorized_at?.toISOString() ?? null,
          escrowConfirmed: false,
          fundingAllowed: false,
        };
      }),
      reconciliation: watches.rows.map((row) => {
        const snapshot = settlementWatchSnapshot(config, row),
          facts = snapshot.facts;
        return {
          consentId: row.consent_id,
          available: snapshot.available,
          paused: snapshot.paused,
          lastAttemptAt: row.last_attempt_at,
          lastSuccessAt: row.last_success_at,
          block: facts?.block ?? null,
          registrationState: facts?.registration?.state ?? null,
          principal: facts?.principal ?? null,
          returned: facts?.returned ?? null,
          sourceQualified: false,
          escrowConfirmed: false,
        };
      }),
      hostedEvents: events.rows,
      hostedCodeWindows: codeWindows.rows,
      validatorAssignments: validatorAssignments.rows,
      hostedValidators: hostedValidators.rows,
      attendanceCandidates: attendanceCandidates.rows.map((row) =>
        attendanceCandidateRecord(config, row),
      ),
      attendanceQrWindows: attendanceQrWindows.rows,
      validatorScans: validatorScans.rows,
      hostedEvidenceBarriers: hostedEvidenceBarriers.rows,
      hostedAttendanceCheckpoints: hostedAttendanceCheckpoints.rows,
      attendanceDeliveries: attendanceDeliveries.rows,
      invitationsIssued: issued.rows,
      invitationsRedeemed: redeemed.rows,
      eventAccess: access.rows,
      audit: audit.rows,
      deletionRequest: deletion.rows[0] ?? null,
      excludedSecurityMaterial: [
        "Session and capability tokens",
        "OAuth credentials and login attempts",
        "Blind identity/wallet indexes",
        "Ephemeral control challenges",
        "Attendance code phrases and keyed indexes",
      ],
      notice:
        "This export contains private identity, wallet and event data. On-chain records cannot be erased. Approved terms do not confirm escrow or a funded seat.",
    };
  });
}
