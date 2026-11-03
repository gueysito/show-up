import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { hash, seal, unseal } from "../auth/crypto";
import { databaseConfig } from "../config";
import { transaction } from "../db/client";
import { contractReference } from "../commitments/contract-authorization";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { canonicalHash, canonicalJson } from "../protocol/canonical";
import { validateSettlementState } from "../protocol/settlement-state";
import { record } from "../protocol/quote-signature";
import type { SandboxAttendanceObservation } from "./admission";
import { attendanceCandidateMaterial } from "./attempts";
import { attendanceSchedule, verifyAttendancePacket } from "./evidence";
import { attendanceCheckpointWire, type AttendanceCheckpoint } from "./checkpoint-wire";

type Keys = Pick<AuthConfig, "encryptionKey" | "origin">;
type CandidateEntry = { id: string; hash: string; contextHash: string; receiptHash: string };
type FrozenManifest = {
  eventId: string;
  contextHash: string;
  evidencePublicKey: string;
  frozenFacts: Facts;
  items: CandidateEntry[];
};
type Facts = ReturnType<typeof validateSettlementState>;
type AcceptedEvidence = { candidateId: string; receipt: unknown; proof: string };
type CheckpointBundle = {
  eventId: string;
  manifestHash: string;
  packet: { checkpoint: AttendanceCheckpoint; wire: string };
  accepted: AcceptedEvidence[];
  observations: Facts[];
};

export function attendanceCheckpointMaterial(
  config: Keys,
  row: Record<string, unknown>,
  barrier: Record<string, unknown>,
) {
  const frozen = manifest(config, barrier),
    bundle = unseal(
      config.encryptionKey,
      `attendance-checkpoint:${row.event_id}:${row.id}`,
      row.encrypted_checkpoint as string,
    ) as CheckpointBundle;
  if (
    bundle.eventId !== row.event_id ||
    bundle.eventId !== barrier.event_id ||
    bundle.manifestHash !== barrier.manifest_hash ||
    bundle.packet.wire !== attendanceCheckpointWire(bundle.packet.checkpoint) ||
    hash(bundle.packet.wire) !== row.checkpoint_hash ||
    bundle.observations.length < 1 ||
    bundle.observations.length > 100 ||
    bundle.observations[0].block.height !== row.observed_height ||
    bundle.observations[0].block.hash !== row.observed_hash ||
    bundle.packet.checkpoint.ledger_version !== row.ledger_version ||
    bundle.packet.checkpoint.complete_through_ms !== Number(barrier.complete_through_ms)
  )
    throw new Error("Attendance checkpoint integrity failure");
  return { bundle, frozen };
}

// This private batch manifest is not a signed protocol attestation. Its 100
// bounded entries legitimately exceed the generic 32 KiB attestation limit.
export function attendanceManifestHash(value: FrozenManifest) {
  if (value.items.length > 100) throw new Error("Attendance manifest candidate limit");
  const bytes = canonicalJson(value);
  if (Buffer.byteLength(bytes) > 131072) throw new Error("Attendance manifest size limit");
  return hash(bytes);
}

function eventContext(source: SandboxAttendanceObservation, evidencePublicKey: string) {
  const context = Object.fromEntries(
    Object.entries(source.context).filter(([key]) => key !== "authorization"),
  );
  return canonicalHash({ context, evidencePublicKey });
}
async function sandboxDatabase(
  client: pg.PoolClient,
  config: Keys,
  source: SandboxAttendanceObservation,
) {
  if (
    databaseConfig().purpose !== "test" ||
    new URL(config.origin).hostname !== "localhost" ||
    source.context.environment !== "sandbox" ||
    source.context.domain !== "showup.sandbox.authorization.v1" ||
    !(await client.query("SELECT current_database()='showup_test' AS disposable")).rows[0]
      .disposable
  )
    throw new AppFailure(
      409,
      "Attendance journal engineering requires localhost and the disposable sandbox database.",
    );
}
async function lockedEvent(
  client: pg.PoolClient,
  eventId: string,
  source: SandboxAttendanceObservation,
) {
  if (!isUuid(eventId)) throw new AppFailure(400, "Choose the original event.");
  const facts = validateSettlementState(source.context, source.views, source.block),
    terms = record(record(source.views.event).terms);
  const event = (await client.query("SELECT * FROM app_events WHERE id=$1 FOR UPDATE", [eventId]))
    .rows[0];
  if (
    !event ||
    event.state !== "published" ||
    source.context.event !== contractReference(eventId) ||
    event.rules_hash !== source.context.rulesHash ||
    Date.parse(event.data.startsAt) !== terms.start_ms ||
    Date.parse(event.data.endsAt) !== terms.end_ms ||
    (event.data.mode === "digital" ? "online" : "physical") !== facts.mode ||
    facts.eventState !== "published"
  )
    throw new AppFailure(409, "The attendance journal differs from its published event.");
  if (terms.latest_quiz_close_ms !== 0)
    throw new AppFailure(
      409,
      "Complete quiz evidence is not yet integrated; normal closing is unavailable.",
    );
  return {
    facts,
    terms,
    schedule: attendanceSchedule(Number(terms.start_ms), Number(terms.end_ms)),
  };
}
function manifest(config: Keys, row: Record<string, unknown>): FrozenManifest {
  const value = unseal(
    config.encryptionKey,
    `attendance-barrier:${row.event_id}`,
    row.encrypted_manifest as string,
  ) as FrozenManifest;
  if (
    attendanceManifestHash(value) !== row.manifest_hash ||
    value.eventId !== row.event_id ||
    value.contextHash !== row.context_hash ||
    value.items.length !== row.candidate_count
  )
    throw new Error("Attendance barrier integrity failure");
  return value;
}
function barrierSummary(row: Record<string, unknown>) {
  return {
    eventId: row.event_id as string,
    completeThroughMs: Number(row.complete_through_ms),
    frozenAt: Number(row.frozen_at_ms),
    candidateCount: row.candidate_count as number,
    status: "frozen_sandbox_candidates" as const,
    sourceQualified: false as const,
    liveSubmissionAllowed: false as const,
  };
}

// Backend-only sandbox journal. The event lock drains committed candidate writers;
// all later admission paths reject the barrier. This freezes accepted candidates,
// not transport health or a live service's complete ingress/outage watermark.
export async function freezeAttendanceEvidence(
  pool: pg.Pool,
  config: Keys,
  eventId: string,
  sourceInput: SandboxAttendanceObservation,
  evidencePublicKey: string,
  now = Date.now(),
) {
  const source = structuredClone(sourceInput);
  if (
    Buffer.from(evidencePublicKey, "base64").length !== 32 ||
    Buffer.from(evidencePublicKey, "base64").toString("base64") !== evidencePublicKey
  )
    throw new AppFailure(400, "Use the frozen sandbox evidence authority.");
  return transaction(pool, async (client) => {
    await sandboxDatabase(client, config, source);
    const { facts, schedule } = await lockedEvent(client, eventId, source);
    if (
      !Number.isSafeInteger(now) ||
      now < schedule.evidenceThrough ||
      now < source.block.timestampMs
    )
      throw new AppFailure(409, "Attendance evidence grace has not completed.");
    const contextHash = eventContext(source, evidencePublicKey);
    const previous = (
      await client.query(
        "SELECT * FROM app_attendance_evidence_barriers WHERE event_id=$1 FOR UPDATE",
        [eventId],
      )
    ).rows[0];
    if (previous) {
      if (previous.context_hash !== contextHash)
        throw new AppFailure(409, "The frozen event evidence context cannot be replaced.");
      manifest(config, previous);
      return barrierSummary(previous);
    }
    const rows = (
      await client.query(
        "SELECT * FROM app_attendance_candidates WHERE event_id=$1 ORDER BY id FOR SHARE",
        [eventId],
      )
    ).rows;
    const items = rows.map((row) => {
      const value = attendanceCandidateMaterial(config, row),
        receipt = value.packet.receipt;
      if (
        value.binding.environment !== "sandbox" ||
        receipt.domain !== source.context.domain ||
        receipt.deployment !== source.context.deployment ||
        receipt.manifest !== source.context.manifest ||
        receipt.event !== source.context.event ||
        receipt.rules_hash !== source.context.rulesHash
      )
        throw new AppFailure(409, "A candidate belongs to a different evidence context.");
      return {
        id: row.id as string,
        hash: row.candidate_hash as string,
        contextHash: value.source.contextHash,
        receiptHash: canonicalHash(receipt),
      };
    });
    const value: FrozenManifest = {
      eventId,
      contextHash,
      evidencePublicKey,
      frozenFacts: facts,
      items,
    };
    const row = (
      await client.query(
        `INSERT INTO app_attendance_evidence_barriers(event_id,environment,context_hash,complete_through_ms,frozen_at_ms,candidate_count,manifest_hash,encrypted_manifest)
      VALUES($1,'sandbox',$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          eventId,
          contextHash,
          schedule.cutoff,
          now,
          items.length,
          attendanceManifestHash(value),
          seal(config.encryptionKey, `attendance-barrier:${eventId}`, value),
        ],
      )
    ).rows[0];
    return barrierSummary(row);
  });
}

function commonFacts(facts: Facts) {
  // Registration/return facts vary per attendee; the shared event ledger does not.
  return canonicalJson({
    event: facts.event,
    rulesHash: facts.rulesHash,
    eventState: facts.eventState,
    mode: facts.mode,
    capacity: facts.capacity,
    funded: facts.funded,
    reserved: facts.reserved,
    ledgerVersion: facts.ledgerVersion,
    attendance: facts.attendance,
    sponsorReceived: facts.sponsorReceived,
    accounting: facts.accounting,
    tokenBalance: facts.tokenBalance,
    block: facts.block,
  });
}

export async function prepareAttendanceCheckpoint(
  pool: pg.Pool,
  config: Keys,
  request: {
    eventId: string;
    sources: SandboxAttendanceObservation[];
    accepted: AcceptedEvidence[];
  },
  now = Date.now(),
) {
  const input = structuredClone(request);
  if (input.sources.length < 1 || input.sources.length > 100 || input.accepted.length > 100)
    throw new AppFailure(400, "Use bounded original event evidence.");
  const sources = input.sources,
    accepted = input.accepted;
  return transaction(pool, async (client) => {
    const anchor = sources[0];
    await sandboxDatabase(client, config, anchor);
    const { facts, schedule } = await lockedEvent(client, input.eventId, anchor);
    const barrier = (
      await client.query(
        "SELECT * FROM app_attendance_evidence_barriers WHERE event_id=$1 FOR UPDATE",
        [input.eventId],
      )
    ).rows[0];
    if (!barrier)
      throw new AppFailure(
        409,
        "Freeze accepted attendance candidates before preparing closing evidence.",
      );
    const frozen = manifest(config, barrier);
    if (frozen.contextHash !== eventContext(anchor, frozen.evidencePublicKey))
      throw new AppFailure(409, "The frozen evidence context changed.");
    const previous = frozen.frozenFacts;
    if (
      BigInt(facts.block.height) < BigInt(previous.block.height) ||
      facts.block.timestampMs < previous.block.timestampMs ||
      BigInt(facts.ledgerVersion) < BigInt(previous.ledgerVersion) ||
      canonicalJson(facts.funded) !== canonicalJson(previous.funded) ||
      (facts.block.height === previous.block.height &&
        (facts.block.hash !== previous.block.hash || commonFacts(facts) !== commonFacts(previous)))
    )
      throw new AppFailure(
        409,
        "The frozen source block or event ledger conflicts with closing evidence.",
      );
    if (
      !Number.isSafeInteger(now) ||
      now < schedule.evidenceThrough ||
      now < anchor.block.timestampMs ||
      anchor.block.timestampMs < Number(barrier.frozen_at_ms) ||
      (record(anchor.views.event).ended_ms === null && now < schedule.failNeutralAt)
    )
      throw new AppFailure(409, "Normal closing and complete source observations are not ready.");
    if (now > schedule.failNeutralAt)
      throw new AppFailure(
        410,
        "The complete evidence deadline passed; fail-neutral recovery is required.",
      );
    if (
      facts.attendance !== frozen.items.length ||
      accepted.length !== frozen.items.length ||
      sources.length !== Math.max(1, frozen.items.length) ||
      new Set(accepted.map((value) => value.candidateId)).size !== accepted.length
    )
      throw new AppFailure(
        409,
        "Every accepted candidate needs matching contract evidence before normal closing.",
      );
    const rows = (
      await client.query(
        `SELECT c.*,d.state AS delivery_state,d.signed_hash AS delivery_signed_hash,
        d.observed_height AS delivery_height,d.observed_hash AS delivery_hash,d.encrypted_observation AS delivery_observation
        FROM app_attendance_candidates c LEFT JOIN app_attendance_deliveries d ON d.candidate_id=c.id
        WHERE c.event_id=$1 ORDER BY c.id FOR SHARE OF c`,
        [input.eventId],
      )
    ).rows;
    if (rows.length !== frozen.items.length)
      throw new AppFailure(409, "The accepted candidate set changed after freezing.");
    const observations = sources.map((source) => ({
      source,
      facts: validateSettlementState(source.context, source.views, source.block),
    }));
    if (
      new Set(observations.map((value) => value.facts.registrationId)).size !==
        observations.length ||
      observations.some(
        (value) =>
          eventContext(value.source, frozen.evidencePublicKey) !== frozen.contextHash ||
          commonFacts(value.facts) !== commonFacts(facts),
      )
    )
      throw new AppFailure(
        409,
        "Closing observations must agree on one exact event ledger and block.",
      );
    for (const row of rows) {
      const original = frozen.items.find((value) => value.id === row.id),
        candidate = attendanceCandidateMaterial(config, row);
      const proof = accepted.find((value) => value.candidateId === row.id),
        observed = observations.find(
          (value) => value.facts.registrationId === candidate.packet.receipt.registration,
        );
      if (
        row.delivery_state !== "observed" ||
        row.delivery_signed_hash !== hash(proof?.proof ?? "") ||
        !original ||
        original.hash !== row.candidate_hash ||
        original.receiptHash !== canonicalHash(candidate.packet.receipt) ||
        !proof ||
        typeof proof.proof !== "string" ||
        proof.proof.length !== 88 ||
        !verifyAttendancePacket(
          candidate.packet,
          proof.receipt,
          proof.proof,
          frozen.evidencePublicKey,
        ) ||
        !observed ||
        candidate.source.contextHash !== original.contextHash ||
        // The original authorization is part of this exact context hash.
        candidate.source.contextHash !== canonicalHash(observed.source.context) ||
        observed.facts.registration?.attendance !== candidate.packet.classification ||
        !observed.facts.registration.booked ||
        observed.facts.block.timestampMs < candidate.packet.receipt.received_ms ||
        BigInt(observed.facts.ledgerVersion) <= BigInt(candidate.source.facts.ledgerVersion)
      )
        throw new AppFailure(
          409,
          "A frozen attendance candidate is missing its original accepted evidence.",
        );
      const delivered = unseal(
        config.encryptionKey,
        `attendance-delivery-observation:${row.id}`,
        row.delivery_observation,
      ) as Facts;
      if (
        delivered.block.height !== row.delivery_height ||
        delivered.block.hash !== row.delivery_hash
      )
        throw new Error("Attendance delivery observation integrity failure");
      if (
        BigInt(observed.facts.block.height) < BigInt(delivered.block.height) ||
        (observed.facts.block.height === delivered.block.height &&
          commonFacts(observed.facts) !== commonFacts(delivered))
      )
        throw new AppFailure(
          409,
          "Closing evidence conflicts with the recorded attendance delivery.",
        );
    }
    const checkpoint: AttendanceCheckpoint = {
      domain: anchor.context.domain,
      deployment: anchor.context.deployment,
      manifest: anchor.context.manifest,
      event: anchor.context.event,
      rules_hash: anchor.context.rulesHash,
      ledger_version: facts.ledgerVersion,
      complete_through_ms: schedule.cutoff,
      expires_ms: schedule.failNeutralAt,
    };
    const wire = attendanceCheckpointWire(checkpoint),
      checkpointHash = hash(wire),
      id = randomUUID();
    const packet = {
      checkpoint,
      wire,
      sourceQualified: false as const,
      liveSubmissionAllowed: false as const,
      status: "sandbox_checkpoint_prepared" as const,
    };
    const bundle = {
      eventId: input.eventId,
      manifestHash: barrier.manifest_hash,
      packet,
      accepted,
      observations: observations.map((value) => value.facts),
    };
    await client.query(
      `INSERT INTO app_attendance_checkpoints(id,event_id,checkpoint_hash,observed_height,observed_hash,ledger_version,encrypted_checkpoint)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(checkpoint_hash) DO NOTHING`,
      [
        id,
        input.eventId,
        checkpointHash,
        facts.block.height,
        facts.block.hash,
        facts.ledgerVersion,
        seal(config.encryptionKey, `attendance-checkpoint:${input.eventId}:${id}`, bundle),
      ],
    );
    const row = (
      await client.query("SELECT * FROM app_attendance_checkpoints WHERE checkpoint_hash=$1", [
        checkpointHash,
      ])
    ).rows[0];
    const stored = unseal(
      config.encryptionKey,
      `attendance-checkpoint:${input.eventId}:${row.id}`,
      row.encrypted_checkpoint,
    ) as typeof bundle;
    if (
      stored.eventId !== input.eventId ||
      stored.manifestHash !== barrier.manifest_hash ||
      hash(stored.packet.wire) !== row.checkpoint_hash ||
      row.event_id !== input.eventId ||
      stored.observations[0].block.height !== row.observed_height ||
      stored.observations[0].block.hash !== row.observed_hash ||
      stored.packet.checkpoint.ledger_version !== row.ledger_version
    )
      throw new Error("Attendance checkpoint integrity failure");
    return { id: row.id as string, ...stored.packet };
  });
}
