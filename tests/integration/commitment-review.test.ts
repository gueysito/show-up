import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { authConfig } from "../../src/server/auth/config";
import { hash, seal } from "../../src/server/auth/crypto";
import { reviewCommitment } from "../../src/server/commitments/review";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { AppFailure } from "../../src/server/http/security";
import { requiredNetworks } from "../../src/server/protocol/manifest";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";

test("commitment review binds own wallets on all four networks to current rules, keeps unknown fees explicit and creates no consent or funding", async () => {
  const f = await accountFixtures([["host"], [], []]),
    id = randomUUID();
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: randomBytes(32).toString("hex"),
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  })!;
  try {
    await saveAccountDraft(f.pool, config.encryptionKey, hash(f.accounts[0].value), {
      id,
      revision: 0,
      operationId: randomUUID(),
      data: { ...validDraft(), access: "open" },
    });
    // Published and already-verified wallet records are engineering fixtures.
    await f.pool.query(
      "UPDATE app_events SET state='published',rules_hash=$2,published_at=clock_timestamp() WHERE id=$1",
      [id, "a".repeat(64)],
    );
    const wallets = [];
    for (const network of requiredNetworks) {
      const wallet = {
        id: randomUUID(),
        network,
        address:
          network === "near"
            ? "fictional.near"
            : network === "solana"
              ? encodeBase58(Buffer.alloc(32, 3))
              : `0x${"12".repeat(20)}`,
        verifiedAt: new Date().toISOString(),
      };
      await f.pool.query(
        "INSERT INTO app_wallets(id,account_id,wallet_index,network,encrypted_wallet,verified_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          wallet.id,
          f.accounts[1].id,
          wallet.id,
          network,
          seal(config.encryptionKey, `wallet:${f.accounts[1].id}:${wallet.id}`, wallet),
          wallet.verifiedAt,
        ],
      );
      wallets.push(wallet);
    }
    const input = {
      eventId: id,
      rulesHash: "a".repeat(64),
      wallets: { source: wallets[0].id, refund: wallets[0].id, payout: wallets[3].id },
    };
    for (const wallet of wallets) {
      const reviewed = await reviewCommitment(f.pool, config, hash(f.accounts[1].value), {
        ...input,
        wallets: { ...input.wallets, source: wallet.id, refund: wallet.id },
      });
      assert.deepEqual(reviewed.wallets.source, wallet);
      assert.equal(reviewed.wallets.payout.id, wallets[3].id);
      assert.equal(reviewed.quote.maximumInput, null);
      assert.deepEqual(Object.values(reviewed.fees), [null, null, null, null]);
      assert.equal(reviewed.approvalAllowed, false);
      assert.equal(reviewed.fundingAllowed, false);
    }
    const status = (code: number) => (error: unknown) =>
      error instanceof AppFailure && error.status === code;
    await assert.rejects(
      reviewCommitment(f.pool, config, hash(f.accounts[2].value), input),
      status(404),
    );
    await assert.rejects(
      reviewCommitment(f.pool, config, hash(f.accounts[1].value), {
        ...input,
        rulesHash: "b".repeat(64),
      }),
      status(409),
    );
    await assert.rejects(
      reviewCommitment(f.pool, config, hash(f.accounts[1].value), {
        ...input,
        wallets: { ...input.wallets, refund: wallets[1].id },
      }),
      status(422),
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM app_commitment_consents WHERE event_id=$1",
          [id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
