import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Wallet } from "ethers";
import { emptyDraft } from "../../src/domain/event-draft";
import { authConfig, issuers } from "../../src/server/auth/config";
import { establishIdentity } from "../../src/server/auth/identities";
import { hash } from "../../src/server/auth/crypto";
import {
  acceptCommitmentConsent,
  bindOwnSettlementWatch,
  prepareOwnContractAuthorization,
  prepareCommitmentConsent,
} from "../../src/server/commitments/service";
import { acceptWalletProof, issueWalletChallenge } from "../../src/server/wallets/service";
import { accountFixtures } from "./accounts";
import { consentTerms } from "./consent";
import { consentWalletMessage } from "../../src/server/commitments/consent";
import { nearMessageDigest, type WalletMessage } from "../../src/server/wallets/proof";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { networkManifest } from "../../src/server/protocol/manifest";
import { refreshSettlementWatch } from "../../src/server/commitments/reconciliation";

export async function financialFixtures(network: "base" | "near" = "base") {
  const fixtures = await accountFixtures([[], ["host"], []]);
  try {
    if (
      process.env.SHOWUP_ENV !== "test" ||
      process.env.DATABASE_URL !== "postgresql://showup@127.0.0.1:55433/showup_test"
    )
      throw new Error("Financial fixtures require the isolated browser-test database");
    const config = authConfig({
      SHOWUP_AUTH: "1",
      SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
      SHOWUP_IDENTITY_KEY: process.env.SHOWUP_E2E_ENCRYPTION_KEY,
      SHOWUP_IDENTITY_INDEX_KEY: process.env.SHOWUP_E2E_INDEX_KEY,
    })!;
    const wallet = Wallet.createRandom();
    let session = hash(fixtures.accounts[0].value);
    const near = generateKeyPairSync("ed25519"),
      publicKey = `ed25519:${encodeBase58(Buffer.from(near.publicKey.export({ format: "jwk" }).x!, "base64url"))}`;
    const address = network === "near" ? "fictional-wallet.near" : wallet.address;
    const proof = async (message: WalletMessage) =>
      network === "near"
        ? {
            accountId: address,
            publicKey,
            signature: sign(null, nearMessageDigest(message), near.privateKey).toString("base64"),
          }
        : { signature: await wallet.signMessage(message.message) };
    const timestamp = Date.now(),
      block = encodeBase58(Buffer.alloc(32, 7));
    const membership: typeof fetch = async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      const result =
        body.method === "status"
          ? { chain_id: "mainnet" }
          : body.method === "block"
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
                keys: [{ public_key: publicKey, access_key: { permission: "FullAccess" } }],
              };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    };
    const challenge = await issueWalletChallenge(fixtures.pool, config, session, {
      operationId: randomUUID(),
      network,
      address,
    });
    const saved = await acceptWalletProof(
      fixtures.pool,
      config,
      session,
      {
        operationId: randomUUID(),
        challengeId: challenge.id,
        proof: await proof(challenge),
      },
      membership,
    );
    const terms = consentTerms(network, address, Date.now());
    const title = `Fictional private financial event ${randomUUID()}`;
    // Published engineering fixture only; normal publication and funding remain disabled.
    await fixtures.pool.query(
      `INSERT INTO app_events (id,owner_id,revision,data,state,rules_hash,registration_closes_at,published_at)
      VALUES ($1,$2,1,$3,'published',$4,$5,clock_timestamp())`,
      [
        terms.event,
        fixtures.accounts[1].id,
        {
          ...emptyDraft,
          title,
          access: "open",
          startsAt: new Date(terms.registrationClosesAt).toISOString(),
          endsAt: new Date(terms.registrationClosesAt + 3_600_000).toISOString(),
          sponsorBudget: "0",
        },
        terms.rulesHash,
        new Date(terms.registrationClosesAt),
      ],
    );
    const consent = await prepareCommitmentConsent(fixtures.pool, config, session, {
      operationId: randomUUID(),
      terms,
      wallets: { source: saved.id, refund: saved.id, payout: saved.id },
    });
    await acceptCommitmentConsent(
      fixtures.pool,
      config,
      session,
      {
        operationId: randomUUID(),
        consentId: consent.id,
        proof: await proof(consentWalletMessage(consent)),
      },
      membership,
    );
    let watchId: string | undefined;
    async function watch(mode: "awaiting" | "unavailable" | "conflict") {
      if (network !== "near") throw new Error("Only native reconciliation is implemented");
      if (!watchId) {
        const wire = await prepareOwnContractAuthorization(fixtures.pool, config, session, {
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
        watchId = (
          await bindOwnSettlementWatch(fixtures.pool, config, session, {
            operationId: randomUUID(),
            consentId: consent.id,
            context,
          })
        ).watchId;
      }
      if (mode === "awaiting") return;
      const transport: typeof fetch = async (url, request) => {
        if (mode === "unavailable") throw new Error("Controlled unavailable source");
        const body = JSON.parse(String(request?.body));
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "status"
              ? { chain_id: "mainnet" }
              : {
                  header: {
                    height: 100,
                    hash: encodeBase58(
                      Buffer.alloc(32, new URL(String(url)).hostname.includes("fastnear") ? 8 : 7),
                    ),
                    timestamp_nanosec: (BigInt(timestamp) * 1_000_000n).toString(),
                  },
                },
        });
      };
      await refreshSettlementWatch(fixtures.pool, config, watchId, transport);
    }
    async function linkFictionalIdentity(subject: string) {
      const result = await establishIdentity(
        fixtures.pool,
        config,
        "telegram",
        { issuer: issuers.telegram, subject },
        session,
        session,
      );
      fixtures.accounts[0].value = result.value;
      session = hash(result.value);
    }
    return { ...fixtures, title, consent, watch, linkFictionalIdentity };
  } catch (error) {
    await fixtures.cleanup();
    throw error;
  }
}
