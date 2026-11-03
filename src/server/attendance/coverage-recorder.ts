import { randomUUID } from "node:crypto";
import type pg from "pg";
import { databaseConfig } from "../config";
import { transaction } from "../db/client";
import { AppFailure } from "../http/security";
import { canonicalHash } from "../protocol/canonical";
import { isUuid } from "../events/drafts";

export const coverageChannels = [
  "admission",
  "host_code",
  "code_entry",
  "qr_issue",
  "qr_scan",
  "presence_confirmation",
  "unknown",
] as const;
export type CoverageChannel = (typeof coverageChannels)[number];
const zero = "0".repeat(64),
  maximumRecords = 250000;
type Frame = {
  format: "showup.loopback.coverage.record.v1";
  epochId: string;
  sequence: number;
  previousHash: string;
  observedMs: number;
  kind: "start" | "begin" | "classify" | "complete" | "probe" | "stop";
  state: "active" | "gap" | "stopped";
  hasGap: boolean;
  throughMs: number;
  inventoryHash?: string;
  maxGapMs?: number;
  startedMs?: number;
  abandoned?: true;
  requestId?: string;
  channel?: CoverageChannel;
  status?: number;
};
type Epoch = {
  id: string;
  sequence: number;
  head_hash: string;
  last_ms: string;
  through_ms: string;
  state: string;
  had_gap: boolean;
  inventory_hash: string;
  max_gap_ms: number;
  started_ms: string;
};
async function validateEpoch(client: pg.PoolClient, epoch: Epoch) {
  const first = (
    await client.query("SELECT * FROM service_coverage_records WHERE epoch_id=$1 AND sequence=1", [
      epoch.id,
    ])
  ).rows[0];
  if (
    !first ||
    canonicalHash(first.payload) !== first.record_hash ||
    first.payload.kind !== "start" ||
    first.payload.epochId !== epoch.id ||
    first.payload.inventoryHash !== epoch.inventory_hash ||
    first.payload.maxGapMs !== epoch.max_gap_ms ||
    first.payload.startedMs !== Number(epoch.started_ms) ||
    first.payload.previousHash !== zero
  )
    throw new AppFailure(409, "Measurement genesis integrity failure.");
  const last =
    epoch.sequence === 1
      ? first
      : (
          await client.query(
            "SELECT * FROM service_coverage_records WHERE epoch_id=$1 AND sequence=$2",
            [epoch.id, epoch.sequence],
          )
        ).rows[0];
  if (
    !last ||
    canonicalHash(last.payload) !== last.record_hash ||
    last.record_hash !== epoch.head_hash ||
    last.payload.observedMs !== Number(epoch.last_ms) ||
    last.payload.throughMs !== Number(epoch.through_ms) ||
    last.payload.state !== epoch.state ||
    last.payload.hasGap !== epoch.had_gap
  )
    throw new AppFailure(409, "Measurement head integrity failure.");
}
async function clock(client: pg.PoolClient) {
  const now = Number(
    (await client.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms"))
      .rows[0].ms,
  );
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid measurement clock");
  return now;
}
async function disposable(client: pg.PoolClient) {
  if (
    databaseConfig().purpose !== "test" ||
    !(await client.query("SELECT current_database()='showup_test' AS disposable")).rows[0]
      .disposable
  )
    throw new AppFailure(409, "Loopback measurements require the disposable test database.");
}
function channel(value: unknown): asserts value is CoverageChannel {
  if (!coverageChannels.includes(value as CoverageChannel))
    throw new AppFailure(400, "Unknown measurement channel.");
}
function status(value: number) {
  if (!Number.isInteger(value) || (value !== 0 && (value < 100 || value > 599)))
    throw new AppFailure(400, "Invalid measured response.");
}
// Operational metadata only. There is no signature/qualification method or HTTP
// input that turns these measured local traces into a live health certificate.
export async function createLoopbackCoverageRecorder(
  pool: pg.Pool,
  inventoryHash: string,
  maxGapMs = 2000,
) {
  if (
    !/^[0-9a-f]{64}$/.test(inventoryHash) ||
    !Number.isInteger(maxGapMs) ||
    maxGapMs < 100 ||
    maxGapMs > 10000
  )
    throw new AppFailure(400, "Invalid bounded measurement policy.");
  const epochId = randomUUID();
  await transaction(pool, async (client) => {
    await disposable(client);
    const now = await clock(client);
    const first: Frame = {
      format: "showup.loopback.coverage.record.v1",
      epochId,
      sequence: 1,
      previousHash: zero,
      observedMs: now,
      kind: "start",
      state: "active",
      hasGap: false,
      throughMs: now,
      inventoryHash,
      maxGapMs,
      startedMs: now,
    };
    const digest = canonicalHash(first);
    await client.query(
      `INSERT INTO service_coverage_epochs(id,inventory_hash,started_ms,through_ms,last_ms,head_hash,max_gap_ms,sequence)
      VALUES($1,$2,$3,$3,$3,$4,$5,1)`,
      [epochId, inventoryHash, now, digest, maxGapMs],
    );
    await client.query(
      "INSERT INTO service_coverage_records(epoch_id,sequence,record_hash,payload) VALUES($1,1,$2,$3)",
      [epochId, digest, first],
    );
  });
  async function append<T>(
    kind: Frame["kind"],
    work: (
      client: pg.PoolClient,
      now: number,
    ) => Promise<{
      data: Partial<Pick<Frame, "requestId" | "channel" | "status">>;
      value: T;
      skip?: boolean;
    }>,
  ) {
    return transaction(pool, async (client) => {
      await disposable(client);
      const epoch = (
        await client.query("SELECT * FROM service_coverage_epochs WHERE id=$1 FOR UPDATE", [
          epochId,
        ])
      ).rows[0];
      if (
        !epoch ||
        epoch.state === "stopped" ||
        epoch.sequence >= maximumRecords - (kind === "stop" ? 0 : 1)
      )
        throw new AppFailure(409, "This measurement epoch is closed or full.");
      if (epoch.inventory_hash !== inventoryHash || epoch.max_gap_ms !== maxGapMs)
        throw new AppFailure(409, "Measurement policy changed.");
      await validateEpoch(client, epoch);
      const now = await clock(client),
        gap =
          epoch.had_gap || now < Number(epoch.last_ms) || now - Number(epoch.through_ms) > maxGapMs,
        result = await work(client, now),
        sequence = epoch.sequence + 1;
      if (result.skip) return result.value;
      const state = kind === "stop" ? "stopped" : gap ? "gap" : "active";
      // Only an actually observed successful probe advances the horizon. Neither
      // a later heartbeat nor a new process can fill an earlier observation gap.
      const through =
        kind === "probe" && result.data.status === 200 && !gap ? now : Number(epoch.through_ms);
      const frame: Frame = {
        format: "showup.loopback.coverage.record.v1",
        epochId,
        sequence,
        previousHash: epoch.head_hash,
        observedMs: now,
        kind,
        state,
        hasGap: gap,
        throughMs: through,
        ...result.data,
      };
      const hash = canonicalHash(frame);
      await client.query(
        "INSERT INTO service_coverage_records(epoch_id,sequence,record_hash,payload) VALUES($1,$2,$3,$4)",
        [epochId, sequence, hash, frame],
      );
      await client.query(
        "UPDATE service_coverage_epochs SET sequence=$2,head_hash=$3,last_ms=$4,through_ms=$5,state=$6,had_gap=$7 WHERE id=$1",
        [epochId, sequence, hash, now, through, state, gap],
      );
      return result.value;
    });
  }
  return {
    epochId,
    begin: async (value: CoverageChannel) => {
      channel(value);
      const id = randomUUID();
      return append("begin", async (client, now) => {
        await client.query(
          "INSERT INTO service_coverage_requests(id,epoch_id,channel,received_ms) VALUES($1,$2,$3,$4)",
          [id, epochId, value, now],
        );
        return { data: { requestId: id, channel: value }, value: id };
      });
    },
    classify: async (id: string, value: CoverageChannel) => {
      if (!isUuid(id)) throw new AppFailure(400, "Invalid local request reference.");
      channel(value);
      return append("classify", async (client) => {
        const row = (
          await client.query(
            "SELECT channel,completed_ms FROM service_coverage_requests WHERE id=$1 AND epoch_id=$2 FOR UPDATE",
            [id, epochId],
          )
        ).rows[0];
        if (
          !row ||
          row.completed_ms !== null ||
          (row.channel !== "unknown" && row.channel !== value)
        )
          throw new AppFailure(409, "This request cannot be reclassified.");
        await client.query("UPDATE service_coverage_requests SET channel=$2 WHERE id=$1", [
          id,
          value,
        ]);
        return { data: { requestId: id, channel: value }, value: undefined };
      });
    },
    complete: async (id: string, code: number) => {
      if (!isUuid(id)) throw new AppFailure(400, "Invalid local request reference.");
      status(code);
      return append("complete", async (client, now) => {
        const row = (
          await client.query(
            "SELECT * FROM service_coverage_requests WHERE id=$1 AND epoch_id=$2 FOR UPDATE",
            [id, epochId],
          )
        ).rows[0];
        if (!row || (row.status !== null && row.status !== code))
          throw new AppFailure(409, "This measured response cannot be replaced.");
        if (row.status === null)
          await client.query(
            "UPDATE service_coverage_requests SET completed_ms=$2,status=$3 WHERE id=$1",
            [id, now, code],
          );
        return {
          data: { requestId: id, channel: row.channel as CoverageChannel, status: code },
          value: undefined,
          skip: row.status !== null,
        };
      });
    },
    probe: async (code: number) => {
      status(code);
      return append("probe", async () => ({ data: { status: code }, value: undefined }));
    },
    stop: async () => append("stop", async () => ({ data: {}, value: undefined })),
  };
}
export async function fenceAbandonedLoopbackCoverage(pool: pg.Pool, epochId: string) {
  if (!isUuid(epochId)) throw new AppFailure(400, "Invalid local epoch reference.");
  await transaction(pool, async (client) => {
    await disposable(client);
    const epoch = (
      await client.query("SELECT * FROM service_coverage_epochs WHERE id=$1 FOR UPDATE", [epochId])
    ).rows[0];
    if (!epoch) throw new AppFailure(404, "Local measurement epoch unavailable.");
    await validateEpoch(client, epoch);
    if (epoch.state === "stopped") return;
    const now = await clock(client);
    if (now - Number(epoch.last_ms) <= epoch.max_gap_ms)
      throw new AppFailure(409, "The measurement process still has a current epoch.");
    if (epoch.sequence >= maximumRecords)
      throw new AppFailure(409, "The measurement trace has no closing slot.");
    const sequence = epoch.sequence + 1;
    const frame: Frame = {
      format: "showup.loopback.coverage.record.v1",
      epochId,
      sequence,
      previousHash: epoch.head_hash,
      observedMs: now,
      kind: "stop",
      state: "stopped",
      hasGap: true,
      throughMs: Number(epoch.through_ms),
      abandoned: true,
    };
    const hash = canonicalHash(frame);
    await client.query(
      "INSERT INTO service_coverage_records(epoch_id,sequence,record_hash,payload) VALUES($1,$2,$3,$4)",
      [epochId, sequence, hash, frame],
    );
    await client.query(
      "UPDATE service_coverage_epochs SET sequence=$2,head_hash=$3,last_ms=$4,state='stopped',had_gap=true WHERE id=$1",
      [epochId, sequence, hash, now],
    );
  });
}
export async function readLoopbackCoverage(pool: pg.Pool, epochId: string, after = 0, limit = 100) {
  if (
    !isUuid(epochId) ||
    !Number.isInteger(after) ||
    after < 0 ||
    after > maximumRecords ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    throw new AppFailure(400, "Invalid measurement page.");
  return transaction(pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await disposable(client);
    const epoch = (
      await client.query("SELECT * FROM service_coverage_epochs WHERE id=$1", [epochId])
    ).rows[0];
    if (!epoch) throw new AppFailure(404, "Local measurement epoch unavailable.");
    if (epoch.state !== "stopped")
      throw new AppFailure(409, "Stop or fence this epoch before reading its immutable trace.");
    await validateEpoch(client, epoch);
    const prior = after
      ? (
          await client.query(
            "SELECT * FROM service_coverage_records WHERE epoch_id=$1 AND sequence=$2",
            [epochId, after],
          )
        ).rows[0]
      : null;
    if (after && (!prior || canonicalHash(prior.payload) !== prior.record_hash))
      throw new AppFailure(409, "Measurement cursor integrity failure.");
    const rows = (
      await client.query(
        "SELECT * FROM service_coverage_records WHERE epoch_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3",
        [epochId, after, limit + 1],
      )
    ).rows;
    let previous = prior?.record_hash ?? zero,
      sequence = after;
    const records = rows.slice(0, limit).map((row) => {
      const frame = row.payload as Frame;
      if (
        row.sequence !== ++sequence ||
        frame.sequence !== row.sequence ||
        frame.epochId !== epochId ||
        frame.previousHash !== previous ||
        canonicalHash(frame) !== row.record_hash
      )
        throw new AppFailure(409, "Measurement trace integrity failure.");
      previous = row.record_hash;
      return { hash: row.record_hash, frame };
    });
    if (rows.length <= limit && (sequence !== epoch.sequence || previous !== epoch.head_hash))
      throw new AppFailure(409, "Measurement head integrity failure.");
    const counts =
      after === 0
        ? (
            await client.query(
              `SELECT channel,count(*)::text AS received,
      count(*) FILTER(WHERE status IS NOT NULL)::text AS completed,
      count(*) FILTER(WHERE status=0 OR status>=500 OR status=408)::text AS unavailable
      FROM service_coverage_requests WHERE epoch_id=$1 GROUP BY channel ORDER BY channel`,
              [epochId],
            )
          ).rows
        : null;
    const probes =
      after === 0
        ? (
            await client.query(
              `SELECT count(*)::text AS received,
      count(*) FILTER(WHERE (payload->>'status')::int<>200)::text AS unavailable
      FROM service_coverage_records WHERE epoch_id=$1 AND payload->>'kind'='probe'`,
              [epochId],
            )
          ).rows[0]
        : null;
    return {
      format: "showup.loopback.coverage.trace.v1" as const,
      epochId,
      inventoryHash: epoch.inventory_hash,
      maxGapMs: epoch.max_gap_ms as number,
      hadGap: epoch.had_gap as boolean,
      startedMs: Number(epoch.started_ms),
      throughMs: Number(epoch.through_ms),
      state: epoch.state as "active" | "gap" | "stopped",
      head: epoch.head_hash as string,
      records,
      counts,
      probes,
      next: rows.length > limit ? sequence : null,
      sourceQualified: false as const,
      liveSubmissionAllowed: false as const,
    };
  });
}
