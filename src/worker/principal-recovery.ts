import { monotonicSettlementFacts } from "../server/commitments/reconciliation";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../server/auth/config";
import { seal, unseal } from "../server/auth/crypto";
import { databaseConfig } from "../server/config";
import { transaction } from "../server/db/client";
import { isUuid } from "../server/events/drafts";
import { AppFailure } from "../server/http/security";
import { canonicalHash, canonicalJson } from "../server/protocol/canonical";
import { record } from "../server/protocol/quote-signature";
import {
  settlementContextHash,
  validateSettlementState,
  type SettlementContext,
} from "../server/protocol/settlement-state";
import type { SandboxAttendanceObservation } from "../server/attendance/admission";
import {
  contractAuthorization,
  contractReference,
} from "../server/commitments/contract-authorization";
import type { CommitmentConsent } from "../server/commitments/consent";
import type { WalletSignature } from "../server/wallets/proof";

export type SandboxPrincipalGateway = {
  context: SettlementContext;
  read: (signal: AbortSignal) => Promise<SandboxAttendanceObservation>;
  // No recipient, amount, asset or arbitrary contract method is accepted.
  submit: (liabilityId: string, signal: AbortSignal) => Promise<void>;
};
type Keys = Pick<AuthConfig, "encryptionKey" | "origin">;
type Facts = ReturnType<typeof validateSettlementState>;
class SourceConflict extends Error {}
function summary(row: Record<string, unknown>) {
  return {
    consentId: row.consent_id as string,
    status: row.state as string,
    attempts: row.attempts as number,
    sourceQualified: false as const,
    paymentConfirmed: false as const,
    liveSubmissionAllowed: false as const,
  };
}
async function bounded<T>(work: (signal: AbortSignal) => Promise<T>) {
  const signal = AbortSignal.timeout(10_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Principal gateway deadline")), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Explicit disposable-sandbox engine, never constructed by a runtime flag or
// ordinary worker startup. Recovery honors previously approved obligations even
// after an account requests deletion; it grants no new attendee authority.
export async function runSandboxPrincipalRecovery(
  pool: pg.Pool,
  config: Keys,
  consentId: string,
  gateway: SandboxPrincipalGateway,
) {
  const context = structuredClone(gateway.context);
  if (
    !isUuid(consentId) ||
    databaseConfig().purpose !== "test" ||
    new URL(config.origin).hostname !== "localhost" ||
    context.environment !== "sandbox" ||
    context.domain !== "showup.sandbox.authorization.v1" ||
    !(await pool.query("SELECT current_database()='showup_test' AS disposable")).rows[0].disposable
  )
    throw new AppFailure(409, "Principal recovery requires localhost/disposable sandbox context.");
  const original = (
    await pool.query("SELECT * FROM app_commitment_consents WHERE id=$1", [consentId])
  ).rows[0];
  if (!original?.authorized_at || !original.encrypted_proof)
    throw new AppFailure(404, "Original approved principal consent unavailable.");
  const { consent } = unseal(
    config.encryptionKey,
    `commitment-consent:${original.account_id}:${consentId}`,
    original.encrypted_consent,
  ) as { consent: CommitmentConsent };
  const { proof } = unseal(
    config.encryptionKey,
    `commitment-proof:${original.account_id}:${consentId}`,
    original.encrypted_proof,
  ) as { proof: WalletSignature };
  const expected = contractAuthorization(
    config.origin,
    consent,
    proof,
    original.authorized_at.getTime(),
    {
      environment: "sandbox",
      manifest: context.manifest,
      token: context.token,
    },
  ).authorization;
  const contextHash = settlementContextHash(context);
  if (
    canonicalHash(consent) !== original.consent_hash ||
    consent.id !== consentId ||
    consent.terms.event !== original.event_id ||
    context.event !== contractReference(original.event_id) ||
    canonicalJson(context.authorization) !== canonicalJson(expected) ||
    record(context.authorization.payout).network !== "near" ||
    record(context.authorization.payout).asset !== context.token
  )
    throw new AppFailure(
      409,
      "The principal recovery profile differs from the original approved native payout.",
    );
  const request = {
      contextHash,
      consentHash: original.consent_hash,
      liabilityId: `${expected.registration}:principal`,
    },
    requestHash = canonicalHash(request),
    claimToken = randomUUID();
  function observation(row: Record<string, unknown>) {
    if (!row.encrypted_observation) return null;
    const value = unseal(
      config.encryptionKey,
      `principal-recovery-observation:${consentId}`,
      row.encrypted_observation as string,
    ) as Facts;
    if (
      value.block.height !== row.observed_height ||
      value.block.hash !== row.observed_hash ||
      value.event !== context.event ||
      value.rulesHash !== context.rulesHash ||
      value.registrationId !== expected.registration ||
      (value.registration && value.registration.authorizationHash !== canonicalHash(expected))
    )
      throw new SourceConflict("Stored principal observation binding differs");
    return value;
  }
  const claimed = await transaction(pool, async (client) => {
    await client.query(
      `INSERT INTO app_principal_recoveries(consent_id,request_hash,encrypted_request) VALUES($1,$2,$3) ON CONFLICT(consent_id) DO NOTHING`,
      [
        consentId,
        requestHash,
        seal(config.encryptionKey, `principal-recovery:${consentId}`, request),
      ],
    );
    const row = (
      await client.query("SELECT * FROM app_principal_recoveries WHERE consent_id=$1 FOR UPDATE", [
        consentId,
      ])
    ).rows[0];
    const stored = unseal(
      config.encryptionKey,
      `principal-recovery:${consentId}`,
      row.encrypted_request,
    );
    if (row.request_hash !== requestHash || canonicalHash(stored) !== requestHash)
      throw new AppFailure(409, "The original principal recovery request cannot be replaced.");
    if (row.state === "observed" && observation(row)?.principal?.remaining !== "0")
      throw new SourceConflict("Completed principal recovery lacks observed payment");
    if (["observed", "conflict"].includes(row.state)) return { row, claimed: false };
    if (
      (await client.query("SELECT $1::timestamptz>clock_timestamp() AS held", [row.claim_until]))
        .rows[0].held
    )
      return { row, claimed: false };
    return {
      row: (
        await client.query(
          `UPDATE app_principal_recoveries SET state='processing',claim_token=$2,claim_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1,updated_at=clock_timestamp() WHERE consent_id=$1 RETURNING *`,
          [consentId, claimToken],
        )
      ).rows[0],
      claimed: true,
    };
  });
  if (!claimed.claimed) return summary(claimed.row);
  let submitted = false;
  let previous = observation(claimed.row);
  async function finish(state: string, error: string | null, facts?: Facts) {
    return transaction(pool, async (client) => {
      await client.query(
        `UPDATE app_principal_recoveries SET state=$3,last_error=$4,claim_token=NULL,claim_until=NULL,
        observed_height=COALESCE($5,observed_height),observed_hash=COALESCE($6,observed_hash),encrypted_observation=COALESCE($7,encrypted_observation),updated_at=clock_timestamp()
        WHERE consent_id=$1 AND claim_token=$2`,
        [
          consentId,
          claimToken,
          state,
          error,
          facts?.block.height ?? null,
          facts?.block.hash ?? null,
          facts
            ? seal(config.encryptionKey, `principal-recovery-observation:${consentId}`, facts)
            : null,
        ],
      );
      return summary(
        (
          await client.query("SELECT * FROM app_principal_recoveries WHERE consent_id=$1", [
            consentId,
          ])
        ).rows[0],
      );
    });
  }
  async function read() {
    const source = structuredClone(await bounded((signal) => gateway.read(signal)));
    let facts: Facts;
    try {
      if (settlementContextHash(source.context) !== contextHash) throw new SourceConflict();
      facts = validateSettlementState(context, source.views, source.block);
    } catch {
      throw new SourceConflict("Principal source facts or context differ");
    }
    if (
      previous &&
      (BigInt(facts.block.height) < BigInt(previous.block.height) ||
        !monotonicSettlementFacts(previous, facts) ||
        (facts.block.height === previous.block.height &&
          canonicalHash(facts) !== canonicalHash(previous)))
    )
      throw new SourceConflict("Principal observation regressed or conflicted");
    previous = facts;
    return facts;
  }
  function outcome(facts: Facts) {
    if (!facts.principal) return "awaiting_liability";
    if (facts.principal.remaining === "0") return "observed";
    if (facts.principal.pending) return "pending_transfer";
    // An unchanged source does not prove a submitted transaction was dropped.
    // A newer settled attempt with remaining debt proves a failed callback and
    // permits the next attempt at the same contract-owned liability.
    if (
      claimed.row.submitted_attempt &&
      BigInt(facts.principal.attempts) < BigInt(claimed.row.submitted_attempt)
    )
      return "broadcast_unknown";
    return null;
  }
  try {
    let facts = await read();
    let state = outcome(facts);
    if (state)
      return finish(state, state === "broadcast_unknown" ? "submission_unknown" : null, facts);
    facts = await read();
    state = outcome(facts);
    if (state)
      return finish(state, state === "broadcast_unknown" ? "submission_unknown" : null, facts);
    const attempt = BigInt(facts.principal!.attempts) + 1n;
    if (attempt > 18446744073709551615n) return finish("conflict", "attempt_limit", facts);
    const ready = await pool.query(
      `UPDATE app_principal_recoveries SET state='broadcast_unknown',submitted_attempt=$3,
      observed_height=$4,observed_hash=$5,encrypted_observation=$6,updated_at=clock_timestamp()
      WHERE consent_id=$1 AND claim_token=$2`,
      [
        consentId,
        claimToken,
        attempt.toString(),
        facts.block.height,
        facts.block.hash,
        seal(config.encryptionKey, `principal-recovery-observation:${consentId}`, facts),
      ],
    );
    if (!ready.rowCount) return finish("unavailable", "source_unavailable");
    submitted = true;
    await bounded((signal) => gateway.submit(request.liabilityId, signal));
    // Account for this attempt as well as any prior persisted one.
    claimed.row.submitted_attempt = attempt.toString();
    facts = await read();
    state = outcome(facts);
    return finish(
      state ?? "broadcast_unknown",
      state === "observed" || state === "pending_transfer" ? null : "submission_unknown",
      facts,
    );
  } catch (error) {
    if (error instanceof SourceConflict) return finish("conflict", "source_conflict");
    return finish(
      submitted ? "broadcast_unknown" : "unavailable",
      submitted ? "submission_unknown" : "source_unavailable",
    );
  }
}
