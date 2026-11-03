import { AppFailure } from "../src/server/http/security";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { accountFixtures } from "../tests/fixtures/accounts";
import { validDraft } from "../tests/fixtures/draft";
import { consentTerms } from "../tests/fixtures/consent";
import { authConfig } from "../src/server/auth/config";
import { hash, seal, unseal } from "../src/server/auth/crypto";
import { participantCredential } from "../src/server/events/credentials";
import { saveAccountDraft } from "../src/server/events/accounts";
import {
  prepareSandboxPublication,
  observeSandboxPublication,
  type SandboxPublicationProfile,
  type SandboxPublicationSource,
} from "../src/server/events/publication-image";
import { issueInvitation, redeemInvitation } from "../src/server/invitations/service";
import { createCommitmentConsent, consentWalletMessage } from "../src/server/commitments/consent";
import {
  contractAuthorization,
  contractReference,
} from "../src/server/commitments/contract-authorization";
import { nearMessageDigest, type WalletSignature } from "../src/server/wallets/proof";
import { canonicalHash, canonicalJson } from "../src/server/protocol/canonical";
import {
  validateSettlementState,
  type SettlementContext,
  type SettlementViews,
} from "../src/server/protocol/settlement-state";
import type { FinalizedHeader } from "../src/server/protocol/finalized-heads";
import { activateHostCodeWindow } from "../src/server/attendance/codes";
import {
  attemptAttendanceCode,
  type AttendanceCandidateInput,
} from "../src/server/attendance/attempts";
import {
  issueAttendanceQr,
  scanAttendanceQr,
  confirmAttendanceQr,
} from "../src/server/attendance/qr";
import { verifyAttendancePacket } from "../src/server/attendance/evidence";
import {
  freezeAttendanceEvidence,
  prepareAttendanceCheckpoint,
} from "../src/server/attendance/journal";
import {
  attendanceCheckpointWire,
  verifyAttendanceCheckpoint,
} from "../src/server/attendance/checkpoint-wire";
import { deliveryProcess, closingProcess, principalProcess } from "./attendance-delivery-peer";
import type { SandboxPrincipalGateway } from "../src/worker/principal-recovery";
import type { SandboxClosingGateway } from "../src/worker/attendance-closing";
import type { SandboxAttendanceGateway } from "../src/worker/attendance";

if (
  process.env.SHOWUP_ENV !== "test" ||
  process.env.DATABASE_URL !== "postgresql://showup@127.0.0.1:55433/showup_test"
)
  throw new Error("Application bridge requires the fixed disposable test database.");
const id = randomBytes(16).toString("hex"),
  directory = `contracts/.cache/app-bridge/${id}`;
await mkdir(directory, { recursive: true, mode: 0o700 });
const log = await open(`${directory}/runner.log`, "wx", 0o600);
const runner = spawn("sh", ["scripts/contracts.sh", "app-bridge", id], {
  stdio: ["ignore", log.fd, log.fd],
});
let exitCode: number | null | undefined,
  runnerError = false;
const finished = new Promise<void>((resolve) => {
  runner.once("error", () => {
    runnerError = true;
    exitCode = -1;
    resolve();
  });
  runner.once("close", (code) => {
    exitCode = code;
    resolve();
  });
});
let phase = "startup";
async function receive<T>(mode: string, stage: string, signal?: AbortSignal): Promise<T> {
  phase = `${mode}/${stage}`;
  const path = `${directory}/${mode}.${stage}.request.json`,
    deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (exitCode !== undefined || runnerError)
      throw new Error("Sandbox peer exited before exchange.");
    try {
      const info = await stat(path);
      if (info.size > 262144) throw new Error("Bridge frame size limit.");
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error("Sandbox peer exchange timed out.");
}
async function send(mode: string, stage: string, value: unknown) {
  const path = `${directory}/${mode}.${stage}.response.json`,
    temporary = `${path}.tmp`;
  const bytes = canonicalJson(value);
  if (Buffer.byteLength(bytes) > 262144) throw new Error("Bridge frame size limit.");
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}
type Snapshot = { context: SettlementContext; views: SettlementViews; block: FinalizedHeader };
type Published = {
  terms: Record<string, unknown> & { start_ms: number; end_ms: number; rules_hash: string };
  deployment: string;
  token: string;
  wallet: string;
  issuedAt: number;
  publishedAt: number;
  evidencePublicKey: string;
  publication: SandboxPublicationSource;
};
const results: {
  mode: string;
  scenario: "attended" | "outage";
  attendance: string;
  principalPaid: string;
  liveSubmissionAllowed: false;
  principalRecovery: {
    signal: "SIGKILL";
    attempts: number;
    submissions: number;
    originalRequestPreserved: true;
  };
  neutralRecovery?: {
    signal: "SIGKILL";
    attempts: number;
    abortSubmissions: number;
    principalSubmissions: number;
    originalRequestPreserved: true;
    neutralRequestPreserved: true;
  };
  closingRecovery?: {
    signal: "SIGKILL";
    attempts: number;
    signatureRequests: number;
    submissions: number;
    signedEnvelopePreserved: true;
  };
  workerRecovery?: {
    signal: "SIGKILL";
    attempts: number;
    signatureRequests: number;
    submissions: number;
    signedEnvelopePreserved: true;
  };
}[] = [];
try {
  const cases = (["attended", "outage"] as const).flatMap((scenario) =>
    (["online", "physical"] as const).map((mode) => ({ scenario, mode })),
  );
  for (const { scenario, mode } of cases) {
    const channel = scenario === "outage" ? `${mode}-outage` : mode;
    const opening = await receive<{
      mode: string;
      profile: SandboxPublicationProfile;
      template: { start_ms: number; end_ms: number } & Record<string, unknown>;
    }>(channel, "setup");
    const f = await accountFixtures([[], ["host"], []]);
    try {
      // Generated test keys encrypt only this run's disposable PostgreSQL records.
      // The operator credential file is neither read nor changed.
      const config = authConfig({
        SHOWUP_AUTH: "1",
        SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
        SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
        SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
      })!;
      const eventId = randomUUID(),
        draft = {
          ...validDraft(),
          mode: mode === "online" ? ("digital" as const) : ("physical" as const),
          title: `Fictional application sandbox ${mode}`,
          commitment: "5.00",
          capacity: 1,
          venue: mode === "physical" ? "Fictional sandbox venue" : "",
          sponsorBudget: "0",
          access: "open" as const,
          startsAt: new Date(opening.template.start_ms).toISOString(),
          endsAt: new Date(opening.template.end_ms).toISOString(),
        };
      await saveAccountDraft(f.pool, config.encryptionKey, hash(f.accounts[1].value), {
        id: eventId,
        revision: 0,
        operationId: randomUUID(),
        data: draft,
      });
      const credentials: string[] = [];
      const client = await f.pool.connect();
      let attendee: string;
      try {
        credentials.push(
          await participantCredential(client, config.encryptionKey, f.accounts[1].id, eventId),
        );
        attendee = await participantCredential(
          client,
          config.encryptionKey,
          f.accounts[0].id,
          eventId,
        );
      } finally {
        client.release();
      }
      if (mode === "physical") {
        const invitation = await issueInvitation(
          f.pool,
          config,
          hash(f.accounts[1].value),
          randomUUID(),
          { kind: "validator", eventId },
        );
        await redeemInvitation(
          f.pool,
          config,
          hash(f.accounts[2].value),
          randomUUID(),
          new URL(invitation.url).hash.slice(1),
          true,
        );
        const staffClient = await f.pool.connect();
        try {
          credentials.push(
            await participantCredential(
              staffClient,
              config.encryptionKey,
              f.accounts[2].id,
              eventId,
            ),
          );
        } finally {
          staffClient.release();
        }
      }
      const revision = (
        await f.pool.query("SELECT revision FROM app_events WHERE id=$1", [eventId])
      ).rows[0].revision;
      const publication = await prepareSandboxPublication(
        f.pool,
        config,
        hash(f.accounts[1].value),
        {
          operationId: randomUUID(),
          eventId,
          revision,
          profile: opening.profile,
          template: opening.template,
        },
      );
      assert.deepEqual(
        publication.terms.excluded as string[],
        credentials.map(contractReference).sort(),
      );
      await send(channel, "setup", { terms: publication.terms, imageHash: publication.imageHash });
      const published = await receive<Published>(channel, "consent"),
        material = published.terms;
      await observeSandboxPublication(
        f.pool,
        config,
        eventId,
        publication.imageHash,
        published.publication,
      );
      const publishedRow = (
        await f.pool.query("SELECT state,rules_hash FROM app_events WHERE id=$1", [eventId])
      ).rows[0];
      assert.equal(publishedRow.state, "published");
      assert.equal(publishedRow.rules_hash, material.rules_hash);
      const terms = consentTerms("near", published.wallet, published.issuedAt),
        profile = { environment: "sandbox" as const, manifest: "local-v1", token: published.token };
      Object.assign(terms, {
        environment: "sandbox",
        manifest: profile.manifest,
        deployment: published.deployment,
        event: eventId,
        rulesHash: material.rules_hash,
        participant: attendee,
        inputAsset: { contract: published.token, decimals: 6 },
        sourceGasMaximum: "1000000000000000000000000",
        routingFeeMaximum: "0",
        withdrawalFeeMaximum: "100000",
        registrationClosesAt: material.start_ms,
        authorizationExpiresAt: Math.min(published.issuedAt + 900_000, material.start_ms),
        reservationExpiresAt: Math.min(published.issuedAt + 300_000, material.start_ms),
      });
      for (const selected of [terms.source, terms.refund, terms.payout])
        selected.chainId = "sandbox";
      const consent = createCommitmentConsent(config.origin, terms, published.issuedAt, profile),
        session = hash(f.accounts[0].value);
      await send(channel, "consent", {
        digest: nearMessageDigest(consentWalletMessage(consent)).toString("base64"),
      });
      const walletProof = await receive<WalletSignature>(channel, "signature");
      const wire = contractAuthorization(
        config.origin,
        consent,
        walletProof,
        published.issuedAt,
        profile,
      );
      await f.pool.query(
        `INSERT INTO app_commitment_consents(id,account_id,event_id,session_hash,consent_hash,encrypted_consent,signing_expires_at,authorization_expires_at,authorized_at,encrypted_proof,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          consent.id,
          f.accounts[0].id,
          eventId,
          session,
          canonicalHash(consent),
          seal(config.encryptionKey, `commitment-consent:${f.accounts[0].id}:${consent.id}`, {
            consent,
          }),
          new Date(consent.signingExpiresAt),
          new Date(terms.authorizationExpiresAt),
          new Date(published.issuedAt),
          seal(config.encryptionKey, `commitment-proof:${f.accounts[0].id}:${consent.id}`, {
            proof: walletProof,
          }),
          new Date(published.issuedAt),
        ],
      );
      const originalApproval = (
        await f.pool.query(
          "SELECT consent_hash,encrypted_consent,encrypted_proof FROM app_commitment_consents WHERE id=$1",
          [consent.id],
        )
      ).rows[0];
      await send(channel, "signature", { authorization: wire.authorization });
      const source = await receive<Snapshot>(channel, "funded");
      assert.equal(
        validateSettlementState(source.context, source.views, source.block).registration?.booked,
        true,
      );
      assert.equal(canonicalJson(wire.authorization), canonicalJson(source.context.authorization));
      const received = Math.max(Date.now(), source.block.timestampMs),
        engineering = { source, testClock: received };
      if (mode === "online") {
        const window = await activateHostCodeWindow(f.pool, config, hash(f.accounts[1].value), {
          eventId,
          operationId: randomUUID(),
          phrase: "Sandbox application round trip",
        });
        engineering.testClock = Math.max(
          Date.now(),
          source.block.timestampMs,
          Date.parse(window.openedAt),
        );
        await attemptAttendanceCode(
          f.pool,
          config,
          session,
          {
            eventId,
            consentId: consent.id,
            operationId: randomUUID(),
            phrase: "sandbox APPLICATION round trip",
          },
          engineering,
        );
      } else {
        const qr = await issueAttendanceQr(
          f.pool,
          config,
          session,
          { eventId, consentId: consent.id, operationId: randomUUID() },
          engineering,
        );
        const scan = await scanAttendanceQr(
          f.pool,
          config,
          hash(f.accounts[2].value),
          { eventId, operationId: randomUUID(), payload: qr.payload },
          { source, testClock: received + 1 },
        );
        assert.equal(scan.attendanceConfirmed, false);
        await confirmAttendanceQr(
          f.pool,
          config,
          hash(f.accounts[2].value),
          { eventId, operationId: randomUUID(), scanId: scan.scanId, confirmPresence: true },
          { source, testClock: received + 2 },
        );
      }
      const row = (
        await f.pool.query(
          "SELECT * FROM app_attendance_candidates WHERE event_id=$1 AND account_id=$2",
          [eventId, f.accounts[0].id],
        )
      ).rows[0];
      assert(row);
      const candidate = unseal(
        config.encryptionKey,
        `attendance-candidate:${f.accounts[0].id}:${row.id}`,
        row.encrypted_candidate,
      ) as AttendanceCandidateInput;
      assert.equal(candidate.packet.classification, "on_time");
      async function verifyOriginals() {
        const unchanged = (
          await f.pool.query(
            "SELECT candidate_hash,encrypted_candidate FROM app_attendance_candidates WHERE id=$1",
            [row.id],
          )
        ).rows[0];
        assert.equal(unchanged.candidate_hash, row.candidate_hash);
        assert.equal(unchanged.encrypted_candidate, row.encrypted_candidate);
        assert.deepEqual(
          (
            await f.pool.query(
              "SELECT consent_hash,encrypted_consent,encrypted_proof FROM app_commitment_consents WHERE id=$1",
              [consent.id],
            )
          ).rows[0],
          originalApproval,
        );
      }
      if (scenario === "outage") {
        await send(channel, "funded", { receipt: candidate.packet.receipt, outage: true });
        const evidence = await receive<Snapshot>(channel, "outage_evidence");
        assert.equal(
          (
            await deliveryProcess(config, row.id, {
              context: source.context,
              evidencePublicKey: published.evidencePublicKey,
              read: async () => structuredClone(evidence),
              sign: async () => {
                throw new Error("Expired evidence cannot be newly signed");
              },
              submit: async () => {
                throw new Error("Expired evidence cannot be submitted");
              },
            })
          ).status,
          "awaiting_reconciliation",
        );
        const barrier = await freezeAttendanceEvidence(
          f.pool,
          config,
          eventId,
          evidence,
          published.evidencePublicKey,
          evidence.block.timestampMs,
        );
        assert.equal(barrier.candidateCount, 1);
        await assert.rejects(
          prepareAttendanceCheckpoint(
            f.pool,
            config,
            { eventId, sources: [evidence], accepted: [] },
            evidence.block.timestampMs,
          ),
          (error) => error instanceof AppFailure && error.status === 409,
        );
        assert.equal(
          (
            await f.pool.query("SELECT 1 FROM app_attendance_checkpoints WHERE event_id=$1", [
              eventId,
            ])
          ).rowCount,
          0,
        );
        await send(channel, "outage_evidence", { unreconciled: true });
        let latest = await receive<Snapshot>(channel, "outage_ready"),
          aborts = 0,
          withdrawals = 0;
        const gateway: SandboxPrincipalGateway = {
          context: source.context,
          read: async () => structuredClone(latest),
          failNeutral: async (event, signal) => {
            aborts++;
            assert.equal(event, source.context.event);
            await send(channel, "outage_ready", { event });
            latest = await receive<Snapshot>(channel, "outage_aborted", signal);
          },
          submit: async (liabilityId, signal) => {
            withdrawals++;
            assert.equal(liabilityId, `${source.context.authorization.registration}:principal`);
            await send(channel, "outage_aborted", { liabilityId });
            latest = await receive<Snapshot>(channel, "outage_paid", signal);
          },
        };
        assert.equal((await principalProcess(config, consent.id, gateway, true)).killed, true);
        const before = (
          await f.pool.query("SELECT * FROM app_principal_recoveries WHERE consent_id=$1", [
            consent.id,
          ])
        ).rows[0];
        assert.equal(before.last_effect, "fail_neutral");
        assert(before.encrypted_neutral_request);
        await f.pool.query(
          "UPDATE app_principal_recoveries SET claim_until=clock_timestamp()-interval '1 second' WHERE consent_id=$1",
          [consent.id],
        );
        assert.equal(
          (
            await principalProcess(
              config,
              consent.id,
              {
                ...gateway,
                failNeutral: async () => {
                  throw new Error("No repeated abort");
                },
              },
              true,
            )
          ).killed,
          true,
        );
        const paid = (
          await f.pool.query("SELECT * FROM app_principal_recoveries WHERE consent_id=$1", [
            consent.id,
          ])
        ).rows[0];
        assert.equal(paid.last_effect, "withdraw");
        await f.pool.query(
          "UPDATE app_principal_recoveries SET claim_until=clock_timestamp()-interval '1 second' WHERE consent_id=$1",
          [consent.id],
        );
        assert.equal(
          (
            await principalProcess(config, consent.id, {
              ...gateway,
              failNeutral: async () => {
                throw new Error("No repeated abort");
              },
              submit: async () => {
                throw new Error("No repeated withdrawal");
              },
            })
          ).status,
          "observed",
        );
        const recovered = (
          await f.pool.query("SELECT * FROM app_principal_recoveries WHERE consent_id=$1", [
            consent.id,
          ])
        ).rows[0];
        assert.equal(recovered.attempts, 3);
        assert.equal(aborts, 1);
        assert.equal(withdrawals, 1);
        assert.equal(recovered.encrypted_request, before.encrypted_request);
        assert.equal(recovered.encrypted_neutral_request, before.encrypted_neutral_request);
        assert.equal(recovered.neutral_hash, before.neutral_hash);
        const facts = validateSettlementState(source.context, latest.views, latest.block);
        assert.equal(facts.eventState, "aborted");
        assert.equal(facts.registration?.attendance, null);
        assert.equal(facts.principal?.gross, "5000000");
        assert.equal(facts.principal?.remaining, "0");
        assert.equal(facts.accounting.unallocated, "0");
        assert.equal(
          (
            await f.pool.query(
              "SELECT state,signed_hash FROM app_attendance_deliveries WHERE candidate_id=$1",
              [row.id],
            )
          ).rows[0].state,
          "awaiting_reconciliation",
        );
        await verifyOriginals();
        results.push({
          mode,
          scenario,
          attendance: "pending_then_aborted",
          principalPaid: "5000000",
          liveSubmissionAllowed: false,
          principalRecovery: {
            signal: "SIGKILL",
            attempts: 3,
            submissions: 1,
            originalRequestPreserved: true,
          },
          neutralRecovery: {
            signal: "SIGKILL",
            attempts: 3,
            abortSubmissions: aborts,
            principalSubmissions: withdrawals,
            originalRequestPreserved: true,
            neutralRequestPreserved: true,
          },
        });
        await send(channel, "outage_paid", { recovered: true });
        console.log(
          `PASS: ${mode} unreconciled candidate fails neutral in actual sandbox; principal paid 5000000; live route disabled`,
        );
        continue;
      }
      let latest = source,
        signatureRequests = 0,
        submissions = 0;
      const gateway: SandboxAttendanceGateway = {
        context: source.context,
        evidencePublicKey: published.evidencePublicKey,
        read: async () => structuredClone(latest),
        sign: async (receipt, signal) => {
          signatureRequests++;
          await send(channel, "funded", { receipt });
          const signed = await receive<{
            source: Snapshot;
            proof: string;
            evidencePublicKey: string;
          }>(channel, "signed", signal);
          assert.equal(signed.evidencePublicKey, published.evidencePublicKey);
          latest = signed.source;
          return signed.proof;
        },
        submit: async (receipt, signature, signal) => {
          submissions++;
          assert.equal(canonicalJson(receipt), candidate.packet.canonical);
          assert.equal(
            verifyAttendancePacket(
              candidate.packet,
              receipt,
              signature,
              published.evidencePublicKey,
            ),
            true,
          );
          await send(channel, "signed", { submit: true });
          latest = (await receive<{ source: Snapshot }>(channel, "accepted", signal)).source;
        },
      };
      const killed = await deliveryProcess(config, row.id, gateway, true);
      assert.equal(killed.killed, true);
      const preparedDelivery = (
        await f.pool.query("SELECT * FROM app_attendance_deliveries WHERE candidate_id=$1", [
          row.id,
        ])
      ).rows[0];
      assert.equal(preparedDelivery.state, "broadcast_unknown");
      assert(preparedDelivery.encrypted_signed);
      // Only the test fixture advances the abandoned lease; production recovery
      // waits for the worker's bounded lease rather than bypassing its fencing.
      await f.pool.query(
        "UPDATE app_attendance_deliveries SET claim_until=clock_timestamp()-interval '1 second' WHERE candidate_id=$1",
        [row.id],
      );
      const resumed = await deliveryProcess(config, row.id, {
        ...gateway,
        sign: async () => {
          throw new Error("Recovery must reuse the stored signature");
        },
        submit: async () => {
          throw new Error("Recovery must observe the actual effect before another submission");
        },
      });
      assert.equal(resumed.status, "observed");
      assert.equal(signatureRequests, 1);
      assert.equal(submissions, 1);
      const recoveredDelivery = (
        await f.pool.query("SELECT * FROM app_attendance_deliveries WHERE candidate_id=$1", [
          row.id,
        ])
      ).rows[0];
      assert.equal(recoveredDelivery.encrypted_signed, preparedDelivery.encrypted_signed);
      assert.equal(recoveredDelivery.signed_hash, preparedDelivery.signed_hash);
      assert.equal(recoveredDelivery.attempts, 2);
      await send(channel, "accepted", { recovered: true });
      const reconciliation = await receive<{
        source: Snapshot;
        receipt: unknown;
        proof: string;
        evidencePublicKey: string;
        u64BoundaryProof: string;
        coverage: unknown;
      }>(channel, "reconcile");
      assert.equal(canonicalJson(reconciliation.source.context), canonicalJson(source.context));
      const closingAt = reconciliation.source.block.timestampMs;
      const barrier = await freezeAttendanceEvidence(
        f.pool,
        config,
        eventId,
        reconciliation.source,
        reconciliation.evidencePublicKey,
        closingAt,
      );
      assert.equal(barrier.candidateCount, 1);
      const prepared = await prepareAttendanceCheckpoint(
        f.pool,
        config,
        {
          eventId,
          sources: [reconciliation.source],
          coverage: reconciliation.coverage,
          accepted: [
            { candidateId: row.id, receipt: reconciliation.receipt, proof: reconciliation.proof },
          ],
        },
        closingAt,
      );
      assert.equal(prepared.liveSubmissionAllowed, false);
      const restarted = await prepareAttendanceCheckpoint(
        f.pool,
        config,
        {
          eventId,
          sources: [reconciliation.source],
          coverage: reconciliation.coverage,
          accepted: [
            { candidateId: row.id, receipt: reconciliation.receipt, proof: reconciliation.proof },
          ],
        },
        closingAt,
      );
      assert.equal(restarted.id, prepared.id);
      assert.equal(restarted.wire, prepared.wire);
      // Independent Rust serde/signing evidence for the full u64 range. This
      // boundary vector is never presented as an accepted contract ledger.
      assert.equal(
        verifyAttendanceCheckpoint(
          { ...prepared.checkpoint, ledger_version: "18446744073709551615" },
          reconciliation.u64BoundaryProof,
          reconciliation.evidencePublicKey,
        ),
        true,
      );
      assert.equal(
        verifyAttendanceCheckpoint(
          { ...prepared.checkpoint, ledger_version: "18446744073709551614" },
          reconciliation.u64BoundaryProof,
          reconciliation.evidencePublicKey,
        ),
        false,
      );
      let closingSource = reconciliation.source,
        closingSignatures = 0,
        closingSubmissions = 0;
      const closingGateway: SandboxClosingGateway = {
        context: source.context,
        evidencePublicKey: reconciliation.evidencePublicKey,
        read: async () => structuredClone(closingSource),
        sign: async (checkpoint, signal) => {
          closingSignatures++;
          assert.equal(attendanceCheckpointWire(checkpoint), prepared.wire);
          await send(channel, "reconcile", { checkpointWire: prepared.wire });
          const signed = await receive<{ source: Snapshot; checkpointProof: string }>(
            channel,
            "closing_signed",
            signal,
          );
          closingSource = signed.source;
          return signed.checkpointProof;
        },
        submit: async (checkpoint, signature, signal) => {
          closingSubmissions++;
          assert.equal(attendanceCheckpointWire(checkpoint), prepared.wire);
          assert(
            verifyAttendanceCheckpoint(checkpoint, signature, reconciliation.evidencePublicKey),
          );
          await send(channel, "closing_signed", { submit: true });
          closingSource = (await receive<{ source: Snapshot }>(channel, "closed", signal)).source;
        },
      };
      assert.equal((await closingProcess(config, prepared.id, closingGateway, true)).killed, true);
      const beforeClosingRecovery = (
        await f.pool.query("SELECT * FROM app_attendance_closings WHERE checkpoint_id=$1", [
          prepared.id,
        ])
      ).rows[0];
      assert.equal(beforeClosingRecovery.state, "broadcast_unknown");
      assert(beforeClosingRecovery.encrypted_signed);
      await f.pool.query(
        "UPDATE app_attendance_closings SET claim_until=clock_timestamp()-interval '1 second' WHERE checkpoint_id=$1",
        [prepared.id],
      );
      assert.equal(
        (
          await closingProcess(config, prepared.id, {
            ...closingGateway,
            sign: async () => {
              throw new Error("Closing recovery must reuse the original signature");
            },
            submit: async () => {
              throw new Error("Closing recovery must observe the actual outcome");
            },
          })
        ).status,
        "observed",
      );
      const recoveredClosing = (
        await f.pool.query("SELECT * FROM app_attendance_closings WHERE checkpoint_id=$1", [
          prepared.id,
        ])
      ).rows[0];
      assert.equal(recoveredClosing.attempts, 2);
      assert.equal(recoveredClosing.encrypted_signed, beforeClosingRecovery.encrypted_signed);
      assert.equal(recoveredClosing.signed_hash, beforeClosingRecovery.signed_hash);
      assert.equal(closingSignatures, 1);
      assert.equal(closingSubmissions, 1);
      await send(channel, "closed", { recovered: true });
      let principalSource = (await receive<{ source: Snapshot }>(channel, "principal_ready"))
          .source,
        principalSubmissions = 0;
      const principalGateway: SandboxPrincipalGateway = {
        context: source.context,
        read: async () => structuredClone(principalSource),
        submit: async (liabilityId, signal) => {
          principalSubmissions++;
          assert.equal(liabilityId, `${source.context.authorization.registration}:principal`);
          await send(channel, "principal_ready", { liabilityId });
          principalSource = (await receive<{ source: Snapshot }>(channel, "principal_paid", signal))
            .source;
        },
      };
      assert.equal(
        (await principalProcess(config, consent.id, principalGateway, true)).killed,
        true,
      );
      const beforePrincipalRecovery = (
        await f.pool.query("SELECT * FROM app_principal_recoveries WHERE consent_id=$1", [
          consent.id,
        ])
      ).rows[0];
      assert.equal(beforePrincipalRecovery.state, "broadcast_unknown");
      assert.equal(beforePrincipalRecovery.submitted_attempt, "1");
      await f.pool.query(
        "UPDATE app_principal_recoveries SET claim_until=clock_timestamp()-interval '1 second' WHERE consent_id=$1",
        [consent.id],
      );
      assert.equal(
        (
          await principalProcess(config, consent.id, {
            ...principalGateway,
            submit: async () => {
              throw new Error("Principal recovery must observe payment before another withdrawal");
            },
          })
        ).status,
        "observed",
      );
      const recoveredPrincipal = (
        await f.pool.query("SELECT * FROM app_principal_recoveries WHERE consent_id=$1", [
          consent.id,
        ])
      ).rows[0];
      assert.equal(recoveredPrincipal.attempts, 2);
      assert.equal(recoveredPrincipal.encrypted_request, beforePrincipalRecovery.encrypted_request);
      assert.equal(recoveredPrincipal.request_hash, beforePrincipalRecovery.request_hash);
      assert.equal(principalSubmissions, 1);
      await send(channel, "principal_paid", { recovered: true });
      const returned = await receive<{
        receipt: unknown;
        proof: string;
        evidencePublicKey: string;
        checkpointProof: string;
        returned: Snapshot;
      }>(channel, "returned");
      assert.equal(
        verifyAttendancePacket(
          candidate.packet,
          returned.receipt,
          returned.proof,
          returned.evidencePublicKey,
        ),
        true,
      );
      assert.equal(
        verifyAttendanceCheckpoint(
          prepared.checkpoint,
          returned.checkpointProof,
          returned.evidencePublicKey,
        ),
        true,
      );
      assert.equal(canonicalJson(returned.returned.context), canonicalJson(source.context));
      const settled = validateSettlementState(
        source.context,
        returned.returned.views,
        returned.returned.block,
      );
      assert.equal(settled.registration?.attendance, "on_time");
      assert.equal(settled.registration?.state, "refund_owed");
      assert.equal(settled.principal?.gross, "5000000");
      assert.equal(settled.principal?.remaining, "0");
      assert.equal(settled.sourceQualified, false);
      await verifyOriginals();
      results.push({
        mode,
        scenario,
        attendance: "on_time",
        principalPaid: "5000000",
        liveSubmissionAllowed: false,
        principalRecovery: {
          signal: "SIGKILL",
          attempts: recoveredPrincipal.attempts,
          submissions: principalSubmissions,
          originalRequestPreserved: true,
        },
        closingRecovery: {
          signal: "SIGKILL",
          attempts: recoveredClosing.attempts,
          signatureRequests: closingSignatures,
          submissions: closingSubmissions,
          signedEnvelopePreserved: true,
        },
        workerRecovery: {
          signal: "SIGKILL",
          attempts: recoveredDelivery.attempts,
          signatureRequests,
          submissions,
          signedEnvelopePreserved: true,
        },
      });
      await send(channel, "returned", { verified: true });
      console.log(
        `PASS: ${mode} PostgreSQL candidate accepted in actual sandbox; principal paid 5000000; live route disabled`,
      );
    } finally {
      await f.cleanup();
    }
  }
  await Promise.race([
    finished,
    delay(15_000).then(() => {
      throw new Error("Sandbox peer exit timed out.");
    }),
  ]);
  assert.equal(exitCode, 0);
  await writeFile(
    `${directory}/result.json`,
    JSON.stringify({ format: "showup.application.sandbox.v1", results }, null, 2),
    { flag: "wx", mode: 0o600 },
  );
} catch (error) {
  await writeFile(
    `${directory}/application-error.log`,
    error instanceof Error ? (error.stack ?? error.name) : "Bridge failure",
    { flag: "wx", mode: 0o600 },
  );
  console.error(
    `Application sandbox bridge failed at ${phase}; private diagnostics retained in its project cache.`,
  );
  process.exitCode = 1;
} finally {
  if (exitCode === undefined) {
    runner.kill("SIGTERM");
    await Promise.race([finished, delay(5000)]);
  }
  await log.close();
}
