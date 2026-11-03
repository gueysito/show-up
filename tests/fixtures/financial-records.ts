import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { emptyDraft } from "../../src/domain/event-draft";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import {
  acceptCommitmentConsent,
  prepareCommitmentConsent,
} from "../../src/server/commitments/service";
import { acceptWalletProof, issueWalletChallenge } from "../../src/server/wallets/service";
import { accountFixtures } from "./accounts";
import { consentTerms } from "./consent";

export async function financialFixtures() {
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
    const wallet = Wallet.createRandom(),
      session = hash(fixtures.accounts[0].value);
    const challenge = await issueWalletChallenge(fixtures.pool, config, session, {
      operationId: randomUUID(),
      network: "base",
      address: wallet.address,
    });
    const saved = await acceptWalletProof(fixtures.pool, config, session, {
      operationId: randomUUID(),
      challengeId: challenge.id,
      proof: { signature: await wallet.signMessage(challenge.message) },
    });
    const terms = consentTerms("base", wallet.address, Date.now());
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
    await acceptCommitmentConsent(fixtures.pool, config, session, {
      operationId: randomUUID(),
      consentId: consent.id,
      proof: { signature: await wallet.signMessage(consent.message) },
    });
    return { ...fixtures, title, consent };
  } catch (error) {
    await fixtures.cleanup();
    throw error;
  }
}
