import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { authConfig } from "../../src/server/auth/config";
import { hash, seal } from "../../src/server/auth/crypto";
import { activateHostCodeWindow } from "../../src/server/attendance/codes";
import type { AttendanceEngineeringInput } from "../../src/server/attendance/admission";
import { attemptAttendanceCode } from "../../src/server/attendance/attempts";
import {
  createCommitmentConsent,
  consentWalletMessage,
} from "../../src/server/commitments/consent";
import {
  contractAuthorization,
  contractReference,
} from "../../src/server/commitments/contract-authorization";
import { participantCredential } from "../../src/server/events/credentials";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { nearMessageDigest } from "../../src/server/wallets/proof";
import { accountFixtures } from "./accounts";
import { consentTerms } from "./consent";
import { settlementFixture } from "./settlement";
import { validDraft } from "./draft";

// Synthetic funded-state fixtures and real disposable signatures. These are not
// an actual funding/deployment proof, live identity or a runtime qualification.
export async function attendanceFixtures(mode: "digital" | "physical" = "digital") {
  const f = await accountFixtures([[], ["host"], []]);
  try {
    const config = authConfig({
      SHOWUP_AUTH: "1",
      SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
      SHOWUP_IDENTITY_KEY: process.env.SHOWUP_E2E_ENCRYPTION_KEY ?? randomBytes(32).toString("hex"),
      SHOWUP_IDENTITY_INDEX_KEY:
        process.env.SHOWUP_E2E_INDEX_KEY ?? randomBytes(32).toString("hex"),
    })!;
    const now = Date.now(),
      issued = now - 1_800_000,
      acceptedAt = issued + 1000,
      start = now - 60_000,
      end = start + 3_600_000,
      eventId = randomUUID(),
      hostCredential = randomUUID(),
      staffCredential = randomUUID();
    const source = settlementFixture(now),
      event = source.views.event as Record<string, unknown>;
    const material: Record<string, unknown> = {
      ...(event.terms as Record<string, unknown>),
      event: eventId.replaceAll("-", "").padStart(64, "0"),
      start_ms: start,
      end_ms: end,
      mode: mode === "digital" ? "online" : "physical",
      excluded: mode === "physical" ? [hostCredential, staffCredential].map(contractReference) : [],
      wallet_consent_origin: config.origin,
    };
    delete material.rules_hash;
    const rulesHash = canonicalHash({
      format: "showup.event.rules.v1",
      authorization_domain: source.context.domain,
      deployment: source.context.deployment,
      manifest: source.context.manifest,
      settlement_token: source.context.token,
      terms: material,
    });
    const draft = {
      ...validDraft(),
      mode,
      title: `Fictional attendance ${randomUUID()}`,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      sponsorBudget: "0",
      access: "open" as const,
    };
    await f.pool.query(
      `INSERT INTO app_events(id,owner_id,revision,data,state,rules_hash,registration_closes_at,published_at)
      VALUES($1,$2,1,$3,'published',$4,$5,$6)`,
      [eventId, f.accounts[1].id, draft, rulesHash, new Date(start), new Date(issued - 60_000)],
    );
    if (mode === "physical") {
      for (const [index, credential] of [
        [1, hostCredential],
        [2, staffCredential],
      ] as const)
        await f.pool.query(
          `INSERT INTO app_event_credentials(event_id,account_id,encrypted_credential,created_at)
          VALUES($1,$2,$3,$4)`,
          [
            eventId,
            f.accounts[index].id,
            seal(
              config.encryptionKey,
              `event-credential:${f.accounts[index].id}:${eventId}`,
              credential,
            ),
            new Date(issued - 120_000),
          ],
        );
      const invitation = randomUUID();
      await f.pool.query(
        `INSERT INTO app_invitations(id,token_hash,issuer_id,kind,event_id,expires_at,redeemed_by,redeemed_at,created_at)
        VALUES($1,$2,$3,'validator',$4,$5,$6,$7,$8)`,
        [
          invitation,
          hash(randomUUID()),
          f.accounts[1].id,
          eventId,
          new Date(start),
          f.accounts[2].id,
          new Date(issued - 120_000),
          new Date(issued - 180_000),
        ],
      );
      await f.pool.query(
        `INSERT INTO app_event_validators(id,event_id,account_id,invitation_id,alias,assigned_at)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          eventId,
          f.accounts[2].id,
          invitation,
          `Validator ${randomBytes(8).toString("hex")}`,
          new Date(issued - 120_000),
        ],
      );
    }
    const client = await f.pool.connect();
    let participant: string;
    try {
      participant = await participantCredential(
        client,
        config.encryptionKey,
        f.accounts[0].id,
        eventId,
      );
    } finally {
      client.release();
    }
    const terms = consentTerms("near", "fictional-wallet.near", issued),
      profile = {
        environment: "sandbox" as const,
        manifest: source.context.manifest,
        token: source.context.token,
      };
    terms.environment = "sandbox";
    terms.manifest = profile.manifest;
    terms.event = eventId;
    terms.rulesHash = rulesHash;
    terms.participant = participant;
    terms.timeZone = draft.timeZone;
    terms.inputAsset = { contract: profile.token, decimals: 6 };
    terms.registrationClosesAt = start;
    for (const destination of [terms.source, terms.refund, terms.payout])
      destination.chainId = "sandbox";
    const consent = createCommitmentConsent(config.origin, terms, issued, profile),
      key = generateKeyPairSync("ed25519");
    const publicKey = `ed25519:${encodeBase58(Buffer.from(key.publicKey.export({ format: "jwk" }).x!, "base64url"))}`;
    const proof = {
      accountId: terms.source.address,
      publicKey,
      signature: sign(
        null,
        nearMessageDigest(consentWalletMessage(consent)),
        key.privateKey,
      ).toString("base64"),
    };
    const wire = contractAuthorization(config.origin, consent, proof, acceptedAt, profile),
      session = hash(f.accounts[0].value);
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
        new Date(acceptedAt),
        seal(config.encryptionKey, `commitment-proof:${f.accounts[0].id}:${consent.id}`, { proof }),
        new Date(issued),
      ],
    );
    source.context = {
      ...source.context,
      event: wire.authorization.event,
      rulesHash,
      authorization: wire.authorization,
    };
    event.terms = { ...material, rules_hash: rulesHash };
    event.funded = [wire.authorization.registration];
    (source.views.registration as Record<string, unknown>).authorization = structuredClone(
      wire.authorization,
    );
    const window =
      mode === "digital"
        ? await activateHostCodeWindow(f.pool, config, hash(f.accounts[1].value), {
            eventId,
            operationId: randomUUID(),
            phrase: "Fresh attendance phrase",
          })
        : {
            id: randomUUID(),
            openedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 180_000).toISOString(),
          };
    const received = Date.parse(window.openedAt) + 1;
    const engineering: AttendanceEngineeringInput = { source, testClock: received };
    const input = (phrase: unknown = "Fresh attendance phrase", operationId = randomUUID()) => ({
      eventId,
      consentId: consent.id,
      operationId,
      phrase,
    });
    return {
      ...f,
      config,
      eventId,
      consent,
      source,
      engineering,
      session,
      window,
      received,
      input,
      attempt: (
        phrase: unknown = "Fresh attendance phrase",
        operationId = randomUUID(),
        options: AttendanceEngineeringInput = engineering,
      ) => attemptAttendanceCode(f.pool, config, session, input(phrase, operationId), options),
    };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}
