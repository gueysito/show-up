import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { Wallet } from "ethers";
import { consentTerms } from "../fixtures/consent";
import { emptyDraft } from "../../src/domain/event-draft";
import { authConfig, issuers } from "../../src/server/auth/config";
import { hash, seal, unseal } from "../../src/server/auth/crypto";
import { establishIdentity } from "../../src/server/auth/identities";
import { revokeSession } from "../../src/server/auth/sessions";
import {
  createCommitmentConsent,
  consentWalletMessage,
  type CommitmentConsent,
} from "../../src/server/commitments/consent";
import { contractAuthorization } from "../../src/server/commitments/contract-authorization";
import { listOwnFinancialRecords } from "../../src/server/commitments/records";
import { canonicalHash } from "../../src/server/protocol/canonical";
import {
  acceptCommitmentConsent,
  bindOwnSettlementWatch,
  prepareCommitmentConsent,
  prepareOwnContractAuthorization,
} from "../../src/server/commitments/service";
import { createDatabase } from "../../src/server/db/client";
import { migrate } from "../../src/server/db/migrations";
import { AppFailure } from "../../src/server/http/security";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { requireFundingRoute } from "../../src/server/protocol/manifest";
import { networkManifest } from "../../src/server/protocol/manifest";
import { refreshSettlementWatch } from "../../src/server/commitments/reconciliation";
import { nearMessageDigest } from "../../src/server/wallets/proof";
import { acceptWalletProof, issueWalletChallenge } from "../../src/server/wallets/service";

if (process.env.SHOWUP_ENV !== "test")
  throw new Error("Consent checks require the disposable test database");
const { pool } = createDatabase();
const config = authConfig({
  SHOWUP_AUTH: "1",
  SHOWUP_AUTH_ORIGIN: "https://localhost:3443",
  SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
  SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
})!;
const accounts = new Set<string>(),
  events = new Set<string>();
const status = (code: number) => (error: unknown) =>
  error instanceof AppFailure && error.status === code;
before(() => migrate(pool));
test("financial history and accepted contract preparation stay account scoped across re-sign-in", async () => {
  const f = await fixture(),
    consent = await f.prepare(),
    stranger = await login();
  const input = { operationId: randomUUID(), consentId: consent.id };
  await assert.rejects(
    prepareOwnContractAuthorization(pool, config, f.actor.session, input),
    status(409),
  );
  await assert.rejects(
    prepareOwnContractAuthorization(pool, config, stranger.session, input),
    status(404),
  );
  assert.deepEqual((await listOwnFinancialRecords(pool, config, stranger.session)).records, []);
  await assert.rejects(
    listOwnFinancialRecords(pool, config, stranger.session, consent.id),
    status(404),
  );
  const accepted = await f.accept(consent);
  const proof = { signature: await f.wallet.signMessage(consent.message) };
  const expected = {
    consentId: consent.id,
    ...contractAuthorization(config.origin, consent, proof, Date.parse(accepted.authorizedAt)),
  };
  assert.deepEqual(
    await prepareOwnContractAuthorization(pool, config, f.actor.session, input),
    expected,
  );
  const auth = expected.authorization;
  await assert.rejects(
    bindOwnSettlementWatch(pool, config, f.actor.session, {
      operationId: randomUUID(),
      consentId: consent.id,
      context: {
        environment: "mainnet",
        deployment: auth.deployment,
        token: networkManifest.settlement.contract,
        domain: auth.domain,
        manifest: auth.manifest,
        event: auth.event,
        rulesHash: auth.rules_hash,
        escrowCodeHash: encodeBase58(Buffer.alloc(32, 3)),
        tokenCodeHash: encodeBase58(Buffer.alloc(32, 4)),
        authorization: auth,
      },
    }),
    status(409),
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM app_commitment_settlement_links WHERE consent_id=$1", [
        consent.id,
      ])
    ).rows[0].count,
    "0",
  );
  assert.deepEqual(
    await prepareOwnContractAuthorization(pool, config, f.actor.session, input),
    expected,
  );
  const fresh = await login(f.actor.subject);
  assert.deepEqual(
    await prepareOwnContractAuthorization(pool, config, fresh.session, {
      ...input,
      operationId: randomUUID(),
    }),
    expected,
  );
  const history = await listOwnFinancialRecords(pool, config, fresh.session);
  assert.equal(history.records.length, 1);
  assert.deepEqual(history.records[0].terms, consent.terms);
  assert.equal(history.records[0].escrowState, "not_confirmed");
  assert.equal(history.records[0].fundingAllowed, false);
  for (const key of ["proof", "message", "nonce", "accountId", "wallets"])
    assert.equal(Object.hasOwn(history.records[0], key), false);
  await pool.query("UPDATE app_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1", [
    fresh.session,
  ]);
  await assert.rejects(listOwnFinancialRecords(pool, config, fresh.session), status(401));
  await assert.rejects(
    prepareOwnContractAuthorization(pool, config, fresh.session, {
      ...input,
      operationId: randomUUID(),
    }),
    status(401),
  );
});

test("financial history pagination preserves PostgreSQL sub-millisecond ordering without leaking another account cursor", async () => {
  const f = await fixture(),
    original = await f.prepare();
  await pool.query(
    "UPDATE app_commitment_consents SET created_at='2026-11-02 00:00:00.123999+00' WHERE id=$1",
    [original.id],
  );
  for (let index = 0; index < 51; index++) {
    const consent = createCommitmentConsent(config.origin, original.terms, original.issuedAt);
    await pool.query(
      `INSERT INTO app_commitment_consents
      (id,account_id,event_id,session_hash,consent_hash,encrypted_consent,signing_expires_at,authorization_expires_at,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        consent.id,
        f.actor.accountId,
        consent.terms.event,
        f.actor.session,
        canonicalHash(consent),
        seal(config.encryptionKey, `commitment-consent:${f.actor.accountId}:${consent.id}`, {
          consent,
          wallets: f.input.wallets,
        }),
        new Date(consent.signingExpiresAt),
        new Date(consent.terms.authorizationExpiresAt),
        `2026-11-02 00:00:00.123${String(index).padStart(3, "0")}+00`,
      ],
    );
  }
  const first = await listOwnFinancialRecords(pool, config, f.actor.session);
  assert.equal(first.records.length, 50);
  assert.equal(first.records[0].id, original.id);
  const second = await listOwnFinancialRecords(pool, config, f.actor.session, first.nextCursor!);
  assert.equal(second.records.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.records, ...second.records].map((r) => r.id)).size, 52);
});
after(async () => {
  const ids = [...accounts];
  const watches = await pool.query(
    `DELETE FROM app_commitment_settlement_links WHERE consent_id IN
    (SELECT id FROM app_commitment_consents WHERE account_id=ANY($1::uuid[])) RETURNING watch_id`,
    [ids],
  );
  await pool.query("DELETE FROM app_settlement_watches WHERE id=ANY($1::uuid[])", [
    watches.rows.map((row) => row.watch_id),
  ]);
  await pool.query("DELETE FROM app_commitment_consents WHERE account_id=ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM app_event_access WHERE event_id=ANY($1::uuid[])", [[...events]]);
  await pool.query("DELETE FROM app_event_credentials WHERE event_id=ANY($1::uuid[])", [
    [...events],
  ]);
  await pool.query("DELETE FROM app_events WHERE id=ANY($1::uuid[])", [[...events]]);
  for (const table of [
    "app_wallet_challenges",
    "app_wallets",
    "app_mutations",
    "app_audit",
    "app_roles",
    "app_identities",
    "app_sessions",
  ])
    await pool.query(
      `DELETE FROM ${table} WHERE ${table === "app_mutations" || table === "app_audit" ? "actor_id" : "account_id"}=ANY($1::uuid[])`,
      [ids],
    );
  await pool.query("DELETE FROM app_accounts WHERE id=ANY($1::uuid[])", [ids]);
  await pool.end();
});
async function login(subject = randomUUID()) {
  const result = await establishIdentity(pool, config, "telegram", {
    issuer: issuers.telegram,
    subject,
  });
  accounts.add(result.accountId);
  return { ...result, subject, session: hash(result.value) };
}
async function fixture() {
  const actor = await login(),
    host = await login(),
    wallet = Wallet.createRandom();
  const challenge = await issueWalletChallenge(pool, config, actor.session, {
    operationId: randomUUID(),
    network: "base",
    address: wallet.address,
  });
  const saved = await acceptWalletProof(pool, config, actor.session, {
    operationId: randomUUID(),
    challengeId: challenge.id,
    proof: { signature: await wallet.signMessage(challenge.message) },
  });
  const terms = consentTerms("base", wallet.address, Date.now());
  const data = {
    ...emptyDraft,
    title: "Fictional consent event",
    access: "open",
    startsAt: new Date(terms.registrationClosesAt).toISOString(),
    endsAt: new Date(terms.registrationClosesAt + 3_600_000).toISOString(),
    sponsorBudget: "0",
  };
  // Explicit engineering published-state fixture. Normal publication is disabled.
  await pool.query(
    `INSERT INTO app_events (id,owner_id,revision,data,state,rules_hash,registration_closes_at,published_at)
    VALUES ($1,$2,1,$3,'published',$4,$5,clock_timestamp())`,
    [terms.event, host.accountId, data, terms.rulesHash, new Date(terms.registrationClosesAt)],
  );
  events.add(terms.event);
  const input = {
    operationId: randomUUID(),
    wallets: { source: saved.id, refund: saved.id, payout: saved.id },
    terms,
  };
  return {
    actor,
    host,
    wallet,
    saved,
    input,
    prepare: () => prepareCommitmentConsent(pool, config, actor.session, input),
    async accept(consent: CommitmentConsent, operationId = randomUUID()) {
      const proof = { signature: await wallet.signMessage(consent.message) };
      return acceptCommitmentConsent(pool, config, actor.session, {
        operationId,
        consentId: consent.id,
        proof,
      });
    },
  };
}

test("immutable encrypted consent survives lost acknowledgments without creating capacity or a funded seat", async () => {
  const f = await fixture(),
    consent = await f.prepare();
  assert.deepEqual(
    await f.prepare(),
    consent,
    "prepare replay returns the original nonce and registration",
  );
  assert.notEqual(consent.terms.registration, f.input.terms.registration);
  assert.notEqual(consent.terms.participant, f.actor.accountId);
  const before = (
    await pool.query("SELECT * FROM app_commitment_consents WHERE id=$1", [consent.id])
  ).rows[0];
  assert.equal(before.authorized_at, null);
  assert.equal(before.encrypted_consent.includes(consent.terms.source.address), false);
  const operationId = randomUUID(),
    receipt = await f.accept(consent, operationId);
  assert.equal(receipt.state, "user_authorized");
  assert.deepEqual(
    await f.accept(consent, operationId),
    receipt,
    "lost response recovers the same completed receipt",
  );
  const stored = (
    await pool.query("SELECT * FROM app_commitment_consents WHERE id=$1", [consent.id])
  ).rows[0];
  assert.equal(stored.encrypted_consent, before.encrypted_consent);
  assert.equal(stored.encrypted_proof.includes(consent.terms.source.address), false);
  const envelope = unseal(
    config.encryptionKey,
    `commitment-consent:${f.actor.accountId}:${consent.id}`,
    stored.encrypted_consent,
  ) as { consent: CommitmentConsent };
  assert.deepEqual(envelope.consent, consent);
  assert.equal(Object.hasOwn(receipt, "funded"), false);
  assert.equal(Object.hasOwn(receipt, "reserved"), false);
  assert.equal(
    (await pool.query("SELECT count(*) FROM app_commitment_consents WHERE id=$1", [consent.id]))
      .rows[0].count,
    "1",
  );
  assert.throws(() => requireFundingRoute("base"), /Funding disabled/);
  await assert.rejects(() => f.accept(consent), status(409));
});

test("fresh consents keep one encrypted participant credential per account and event", async () => {
  const f = await fixture();
  const [first, next] = await Promise.all([
    f.prepare(),
    prepareCommitmentConsent(pool, config, f.actor.session, {
      ...f.input,
      operationId: randomUUID(),
    }),
  ]);
  assert.equal(next.terms.participant, first.terms.participant);
  assert.notEqual(next.terms.registration, first.terms.registration);
  assert.notEqual(next.nonce, first.nonce);
  const rows = (
    await pool.query(
      "SELECT encrypted_credential FROM app_event_credentials WHERE event_id=$1 AND account_id=$2",
      [first.terms.event, f.actor.accountId],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].encrypted_credential.includes(first.terms.participant), false);
  assert.equal(
    unseal(
      config.encryptionKey,
      `event-credential:${f.actor.accountId}:${first.terms.event}`,
      rows[0].encrypted_credential,
    ),
    first.terms.participant,
  );
});

test("first existing consent credentials survive journal backfill without rewriting the original authorization", async () => {
  const f = await fixture(),
    first = await f.prepare();
  const before = (
    await pool.query("SELECT encrypted_consent FROM app_commitment_consents WHERE id=$1", [
      first.id,
    ])
  ).rows[0].encrypted_consent;
  // Controlled fixture of a consent created before the credential-table migration.
  await pool.query("DELETE FROM app_event_credentials WHERE event_id=$1 AND account_id=$2", [
    first.terms.event,
    f.actor.accountId,
  ]);
  const next = await prepareCommitmentConsent(pool, config, f.actor.session, {
    ...f.input,
    operationId: randomUUID(),
  });
  assert.equal(next.terms.participant, first.terms.participant);
  assert.equal(
    (
      await pool.query("SELECT encrypted_consent FROM app_commitment_consents WHERE id=$1", [
        first.id,
      ])
    ).rows[0].encrypted_consent,
    before,
  );
});

test("account, session, wallet and operation ID swaps cannot consume another consent", async () => {
  const f = await fixture(),
    consent = await f.prepare(),
    stranger = await login(),
    otherSession = await login(f.actor.subject);
  const input = {
    operationId: randomUUID(),
    consentId: consent.id,
    proof: { signature: await f.wallet.signMessage(consent.message) },
  };
  for (const session of [stranger.session, otherSession.session])
    await assert.rejects(() => acceptCommitmentConsent(pool, config, session, input), status(404));
  await assert.rejects(
    () =>
      prepareCommitmentConsent(pool, config, stranger.session, {
        ...f.input,
        operationId: randomUUID(),
      }),
    status(404),
  );
  const changed = { ...f.input, terms: { ...f.input.terms, withdrawalFeeMaximum: "60000" } };
  await assert.rejects(
    () => prepareCommitmentConsent(pool, config, f.actor.session, changed),
    status(409),
  );
  await assert.rejects(
    async () =>
      acceptCommitmentConsent(pool, config, f.actor.session, {
        ...input,
        proof: { signature: await Wallet.createRandom().signMessage(consent.message) },
      }),
    status(400),
  );
  assert.equal(
    (
      await pool.query("SELECT authorized_at FROM app_commitment_consents WHERE id=$1", [
        consent.id,
      ])
    ).rows[0].authorized_at,
    null,
  );
  await acceptCommitmentConsent(pool, config, f.actor.session, input);
});

test("concurrent signatures consume one consent exactly once and preserve its original terms", async () => {
  const f = await fixture(),
    consent = await f.prepare();
  const results = await Promise.allSettled([f.accept(consent), f.accept(consent)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert(status(409)(failed.reason));
  const records = await pool.query(
    "SELECT count(*) FROM app_audit WHERE actor_id=$1 AND action='commitment.consent-authorized'",
    [f.actor.accountId],
  );
  assert.equal(records.rows[0].count, "1");
});

test("event locks, private access and proved destination checks precede consent persistence", async () => {
  const f = await fixture();
  await assert.rejects(
    () =>
      prepareCommitmentConsent(pool, config, f.host.session, {
        ...f.input,
        operationId: randomUUID(),
      }),
    status(403),
  );
  await assert.rejects(
    () =>
      prepareCommitmentConsent(pool, config, f.actor.session, {
        ...f.input,
        operationId: randomUUID(),
        terms: {
          ...f.input.terms,
          payout: { ...f.input.terms.payout, address: Wallet.createRandom().address.toLowerCase() },
        },
      }),
    status(409),
  );
  await pool.query(
    "UPDATE app_events SET data=jsonb_set(data,'{access}','\"invitation\"'::jsonb) WHERE id=$1",
    [f.input.terms.event],
  );
  await assert.rejects(() => f.prepare(), status(404));
  await pool.query(
    "UPDATE app_events SET data=jsonb_set(data,'{access}','\"open\"'::jsonb),rules_hash=$2 WHERE id=$1",
    [f.input.terms.event, "c".repeat(64)],
  );
  await assert.rejects(() => f.prepare(), status(409));
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM app_commitment_consents WHERE account_id=$1", [
        f.actor.accountId,
      ])
    ).rows[0].count,
    "0",
  );
});

test("expired, revoked-wallet, cancelled-event and revoked-session consent stays unconsumed", async () => {
  const f = await fixture(),
    consent = await f.prepare();
  await pool.query("UPDATE app_wallets SET revoked_at=clock_timestamp() WHERE id=$1", [f.saved.id]);
  await assert.rejects(() => f.accept(consent), status(404));
  await pool.query("UPDATE app_wallets SET revoked_at=NULL WHERE id=$1", [f.saved.id]);
  await pool.query("UPDATE app_events SET state='cancelled' WHERE id=$1", [consent.terms.event]);
  await assert.rejects(() => f.accept(consent), status(409));
  await pool.query("UPDATE app_events SET state='published' WHERE id=$1", [consent.terms.event]);
  await pool.query(
    "UPDATE app_commitment_consents SET signing_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [consent.id],
  );
  await assert.rejects(() => f.accept(consent), status(409));
  await revokeSession(pool, {
    accountId: f.actor.accountId,
    tokenHash: f.actor.session,
    roles: [],
  });
  await assert.rejects(() => f.accept(consent), status(401));
  assert.equal(
    (
      await pool.query("SELECT authorized_at FROM app_commitment_consents WHERE id=$1", [
        consent.id,
      ])
    ).rows[0].authorized_at,
    null,
  );
});

test("NEAR financial consent independently rechecks current full-access membership and remains retryable after source disagreement", async () => {
  const f = await fixture(),
    keys = generateKeyPairSync("ed25519");
  const address = "fictional-consent.near",
    publicKey = encodeBase58(Buffer.from(keys.publicKey.export({ format: "jwk" }).x!, "base64url"));
  let mode = "valid",
    reads = 0;
  const block = encodeBase58(Buffer.alloc(32, 7)),
    timestamp = Date.now() - 1000;
  const transport: typeof fetch = async (url, options) => {
    const second = new URL(String(url)).hostname.includes("fastnear"),
      input = JSON.parse(String(options?.body));
    if (input.method === "query") reads++;
    const result =
      input.method === "status"
        ? { chain_id: "mainnet" }
        : input.method === "block"
          ? {
              header: {
                hash: block,
                height: 100,
                timestamp_nanosec: (BigInt(timestamp) * 1_000_000n).toString(),
              },
            }
          : {
              block_hash: block,
              block_height: 100,
              keys:
                mode === "disagree" && second
                  ? []
                  : [
                      {
                        public_key: `ed25519:${publicKey}`,
                        access_key: {
                          permission:
                            mode === "restricted"
                              ? { FunctionCall: { receiver_id: "fictional.near" } }
                              : "FullAccess",
                        },
                      },
                    ],
            };
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  const challenge = await issueWalletChallenge(pool, config, f.actor.session, {
    operationId: randomUUID(),
    network: "near",
    address,
  });
  const proof = {
    accountId: address,
    publicKey: `ed25519:${publicKey}`,
    signature: sign(null, nearMessageDigest(challenge), keys.privateKey).toString("base64"),
  };
  const wallet = await acceptWalletProof(
    pool,
    config,
    f.actor.session,
    { operationId: randomUUID(), challengeId: challenge.id, proof },
    transport,
  );
  const terms = {
    ...consentTerms("near", address, Date.now()),
    event: f.input.terms.event,
    registrationClosesAt: f.input.terms.registrationClosesAt,
  };
  const consent = await prepareCommitmentConsent(pool, config, f.actor.session, {
    operationId: randomUUID(),
    wallets: { source: wallet.id, refund: wallet.id, payout: wallet.id },
    terms,
  });
  const input = {
    operationId: randomUUID(),
    consentId: consent.id,
    proof: {
      ...proof,
      signature: sign(
        null,
        nearMessageDigest(consentWalletMessage(consent)),
        keys.privateKey,
      ).toString("base64"),
    },
  };
  mode = "restricted";
  await assert.rejects(
    () => acceptCommitmentConsent(pool, config, f.actor.session, input, transport),
    status(403),
  );
  mode = "disagree";
  await assert.rejects(
    () => acceptCommitmentConsent(pool, config, f.actor.session, input, transport),
    status(503),
  );
  assert.equal(
    (
      await pool.query("SELECT authorized_at FROM app_commitment_consents WHERE id=$1", [
        consent.id,
      ])
    ).rows[0].authorized_at,
    null,
  );
  mode = "valid";
  assert.equal(
    (await acceptCommitmentConsent(pool, config, f.actor.session, input, transport)).state,
    "user_authorized",
  );
  assert.equal(
    reads,
    8,
    "control binding and every financial attempt independently read both sources",
  );
  const wire = await prepareOwnContractAuthorization(pool, config, f.actor.session, {
    operationId: randomUUID(),
    consentId: consent.id,
  });
  const context = {
    environment: "mainnet" as const,
    deployment: wire.authorization.deployment,
    token: networkManifest.settlement.contract,
    domain: wire.authorization.domain,
    manifest: wire.authorization.manifest,
    event: wire.authorization.event,
    rulesHash: wire.authorization.rules_hash,
    escrowCodeHash: encodeBase58(Buffer.alloc(32, 3)),
    tokenCodeHash: encodeBase58(Buffer.alloc(32, 4)),
    authorization: wire.authorization,
  };
  const binding = { operationId: randomUUID(), consentId: consent.id, context };
  await assert.rejects(bindOwnSettlementWatch(pool, config, f.host.session, binding), status(404));
  const linked = await bindOwnSettlementWatch(pool, config, f.actor.session, binding);
  assert.deepEqual(await bindOwnSettlementWatch(pool, config, f.actor.session, binding), linked);
  assert.deepEqual(
    await bindOwnSettlementWatch(pool, config, f.actor.session, {
      ...binding,
      operationId: randomUUID(),
    }),
    linked,
  );
  const history = await listOwnFinancialRecords(pool, config, f.actor.session);
  assert.equal(
    history.records.find((row) => row.id === consent.id)!.reconciliation.status,
    "awaiting_observation",
  );
  assert.equal(history.records[0].fundingAllowed, false);
  for (const changed of [
    {
      ...context,
      authorization: {
        ...context.authorization,
        payout: { ...context.authorization.payout, address: "attacker.near" },
      },
    },
    { ...context, escrowCodeHash: encodeBase58(Buffer.alloc(32, 9)) },
    { ...context, environment: "sandbox" as const },
  ])
    await assert.rejects(
      bindOwnSettlementWatch(pool, config, f.actor.session, {
        ...binding,
        operationId: randomUUID(),
        context: changed,
      }),
      status(409),
    );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM app_commitment_settlement_links WHERE consent_id=$1", [
        consent.id,
      ])
    ).rows[0].count,
    "1",
  );
  const offline: typeof fetch = async () => {
    throw new Error("Controlled unavailable source");
  };
  await refreshSettlementWatch(pool, config, linked.watchId, offline);
  const unavailable = (await listOwnFinancialRecords(pool, config, f.actor.session)).records.find(
    (row) => row.id === consent.id,
  )!;
  assert.equal(unavailable.reconciliation.status, "source_unavailable");
  assert.equal(unavailable.escrowState, "not_confirmed");
  assert.equal(unavailable.reconciliation.sourceQualified, false);
  assert.equal(Object.hasOwn(unavailable.reconciliation, "context"), false);
});

test("consent migration rolls back without erasing existing accounts or events", async () => {
  const client = await pool.connect(),
    schema = `consent_rollback_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema},public`);
    await client.query(await readFile("migrations/006-commitment-consent.sql", "utf8"));
    await client.query(await readFile("migrations/009-event-participant-credentials.sql", "utf8"));
    await client.query(await readFile("migrations/010-commitment-settlement-links.sql", "utf8"));
    assert(
      (
        await client.query("SELECT to_regclass($1) AS relation", [
          `${schema}.app_commitment_consents`,
        ])
      ).rows[0].relation,
    );
    await client.query("ROLLBACK");
    assert.equal(
      (await client.query("SELECT to_regnamespace($1) AS schema", [schema])).rows[0].schema,
      null,
    );
    assert(
      (await client.query("SELECT to_regclass('public.app_events') AS relation")).rows[0].relation,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
