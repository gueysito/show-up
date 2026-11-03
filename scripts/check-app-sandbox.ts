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
async function receive<T>(mode: string, stage: string): Promise<T> {
  phase = `${mode}/${stage}`;
  const path = `${directory}/${mode}.${stage}.request.json`,
    deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
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
};
const results: {
  mode: string;
  attendance: string;
  principalPaid: string;
  liveSubmissionAllowed: false;
}[] = [];
try {
  for (const mode of ["online", "physical"] as const) {
    await receive(mode, "setup");
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
          sponsorBudget: "0",
          access: "open" as const,
        };
      await f.pool.query(
        "INSERT INTO app_events(id,owner_id,revision,data,registration_closes_at) VALUES($1,$2,1,$3,$4)",
        [eventId, f.accounts[1].id, draft, new Date(draft.startsAt)],
      );
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
      await send(mode, "setup", {
        event: contractReference(eventId),
        excluded: credentials.map(contractReference),
      });
      const published = await receive<Published>(mode, "consent"),
        material = published.terms;
      draft.startsAt = new Date(material.start_ms).toISOString();
      draft.endsAt = new Date(material.end_ms).toISOString();
      await f.pool.query(
        `UPDATE app_events SET data=$2,state='published',rules_hash=$3,registration_closes_at=$4,published_at=$5 WHERE id=$1`,
        [
          eventId,
          draft,
          material.rules_hash,
          new Date(material.start_ms),
          new Date(published.publishedAt),
        ],
      );
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
      await send(mode, "consent", {
        digest: nearMessageDigest(consentWalletMessage(consent)).toString("base64"),
      });
      const walletProof = await receive<WalletSignature>(mode, "signature");
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
      await send(mode, "signature", { authorization: wire.authorization });
      const source = await receive<Snapshot>(mode, "funded");
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
      await send(mode, "funded", { receipt: candidate.packet.receipt });
      const returned = await receive<{
        receipt: unknown;
        proof: string;
        evidencePublicKey: string;
        returned: Snapshot;
      }>(mode, "returned");
      assert.equal(
        verifyAttendancePacket(
          candidate.packet,
          returned.receipt,
          returned.proof,
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
      results.push({
        mode,
        attendance: "on_time",
        principalPaid: "5000000",
        liveSubmissionAllowed: false,
      });
      await send(mode, "returned", { verified: true });
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
