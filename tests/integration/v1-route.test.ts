import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import test from "node:test";
import { accountFixtures } from "../fixtures/accounts";
import { verifyNearWallet } from "../fixtures/near-wallet";
import { validDraft } from "../fixtures/draft";
import { nativeKey } from "../../scripts/lib/native-engineering-transaction";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import {
  prepareV1Registration,
  readV1RegistrationState,
} from "../../src/server/commitments/v1-registration";
import {
  prepareV1Route,
  prepareV1RoutePayment,
  readV1RouteState,
  recordV1SourceTransaction,
  ownedV1Route,
} from "../../src/server/commitments/v1-route";
import { runV1Publication } from "../../src/worker/v1-publication";
import { runV1Registration } from "../../src/worker/v1-registration";
import { issueWalletChallenge, acceptWalletProof } from "../../src/server/wallets/service";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { quoteMessage } from "../../src/server/protocol/quote-signature";
import { networkManifest } from "../../src/server/protocol/manifest";
import { v1Deployment, type V1Snapshot } from "../../src/server/protocol/v1-escrow";

test("cross-chain registration freezes owned wallets and quotes; provider success or a source hash cannot create a funded seat", async () => {
  const f = await accountFixtures([["host"], [], []]),
    key = randomBytes(32).toString("hex");
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: key,
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  })!;
  const session = hash(f.accounts[1].value),
    other = hash(f.accounts[2].value),
    host = hash(f.accounts[0].value),
    eventId = randomUUID();
  const signer = nativeKey(randomBytes(32)),
    issuer = nativeKey(randomBytes(32)),
    block = encodeBase58(Buffer.alloc(32, 7)),
    time = Date.now() - 1000;
  const originalIssuer = networkManifest.providers.oneClick.quotePublicKey;
  let snapshot!: V1Snapshot,
    registration: Record<string, unknown> | null = null,
    quote: Record<string, unknown> | null = null;
  const transport: typeof fetch = async (url, init) => {
    const input = JSON.parse(String(init?.body ?? "{}"));
    if (String(url).includes("1click.chaindefuser.com")) {
      if (String(url).includes("/status"))
        return Response.json({ status: "SUCCESS", quoteResponse: quote });
      const unsigned = {
        timestamp: new Date().toISOString(),
        quoteRequest: input,
        quote: {
          amountIn: "1100000",
          minAmountIn: "1090000",
          amountOut: "1000000",
          minAmountOut: "1000000",
          depositAddress: "0x2222222222222222222222222222222222222222",
          deadline: input.deadline,
        },
      };
      quote = {
        ...unsigned,
        signature: `ed25519:${encodeBase58(issuer.sign(quoteMessage(unsigned)))}`,
      };
      return Response.json(quote);
    }
    const params = input.params;
    const result =
      input.method === "status"
        ? { chain_id: "mainnet" }
        : input.method === "block"
          ? {
              header: {
                height: 100,
                hash: block,
                timestamp_nanosec: (BigInt(time) * 1000000n).toString(),
              },
            }
          : {
              block_hash: block,
              block_height: 100,
              ...(params.request_type === "view_access_key_list"
                ? {
                    keys: [
                      { public_key: signer.publicKey, access_key: { permission: "FullAccess" } },
                    ],
                  }
                : params.request_type === "view_account"
                  ? { code_hash: v1Deployment.codeHash }
                  : {
                      result: [
                        ...Buffer.from(
                          JSON.stringify(
                            params.method_name === "get_event"
                              ? snapshot.event
                              : params.method_name === "get_registration"
                                ? registration
                                : null,
                          ),
                        ),
                      ],
                    }),
            };
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  try {
    const payout = await verifyNearWallet(
      f.pool,
      config,
      session,
      { address: "payout.near", ...signer },
      transport,
    );
    const otherPayout = await verifyNearWallet(
      f.pool,
      config,
      other,
      { address: "other-payout.near", ...signer },
      transport,
    );
    const evm = Wallet.createRandom(),
      challenge = await issueWalletChallenge(f.pool, config, session, {
        operationId: randomUUID(),
        network: "base",
        address: evm.address,
      });
    const source = await acceptWalletProof(f.pool, config, session, {
      operationId: randomUUID(),
      challengeId: challenge.id,
      proof: { signature: await evm.signMessage(challenge.message) },
    });
    await saveAccountDraft(
      f.pool,
      key,
      host,
      {
        id: eventId,
        operationId: randomUUID(),
        revision: 0,
        data: { ...validDraft(), capacity: 2, commitment: "1", sponsorBudget: "0", access: "open" },
      },
      "v1",
    );
    await prepareV1Publication(f.pool, key, host, randomUUID(), eventId, 1);
    await runV1Publication(f.pool, key, {
      async prepare(image) {
        snapshot = {
          block: { height: "100", hash: block, timestampMs: time },
          event: { ...image.terms, status: "published", funded: [], prize_received: true },
        };
        return {
          hash: block,
          signedBase64: "local-only-publication",
          semantic: canonicalHash(image.terms),
          validUntilMs: Date.now() + 120000,
        };
      },
      async submit() {},
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
      },
      async snapshot() {
        return snapshot;
      },
    });
    const rules = (await f.pool.query("SELECT rules_hash FROM app_events WHERE id=$1", [eventId]))
      .rows[0].rules_hash;
    await assert.rejects(
      prepareV1Registration(
        f.pool,
        config,
        other,
        randomUUID(),
        eventId,
        rules,
        otherPayout.id,
        transport,
        source.id,
      ),
      /source wallet.*unavailable/,
    );
    const prepared = await prepareV1Registration(
      f.pool,
      config,
      session,
      randomUUID(),
      eventId,
      rules,
      payout.id,
      transport,
      source.id,
    );
    await runV1Registration(f.pool, key, {
      async prepare(image) {
        assert.equal(image.sender, "intents.near");
        assert.equal(image.payout, "payout.near");
        assert.equal(image.source?.address, source.address);
        registration = {
          id: image.id,
          event: eventId,
          sender: image.sender,
          payout: image.payout,
          ethereum: null,
          funded: false,
          attended: false,
        };
        return {
          hash: block,
          signedBase64: "local-only-registration",
          semantic: canonicalHash(image),
          validUntilMs: Date.now() + 120000,
        };
      },
      async submit() {},
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
      },
      async observe() {
        return { snapshot, registration };
      },
    });
    // Only this isolated test process substitutes its issuer. Runtime APIs have
    // no environment flag or request field that can change the pinned quote key.
    networkManifest.providers.oneClick.quotePublicKey = issuer.publicKey;
    const price = await prepareV1Route(f.pool, config, session, eventId, transport);
    assert.equal(price.inputAtomic, "1100000");
    assert.equal(price.routingCostAtomic, "100000");
    await assert.rejects(ownedV1Route(f.pool, config, other, eventId), /unavailable/);
    assert.equal(
      (await readV1RouteState(f.pool, config, session, eventId, transport))?.hint,
      "SUCCESS",
    );
    assert.equal(
      (await readV1RegistrationState(f.pool, config, session, eventId, transport)).funded,
      false,
    );
    const sourceHash = "0x" + "33".repeat(32);
    await recordV1SourceTransaction(f.pool, config, session, randomUUID(), eventId, sourceHash);
    await assert.rejects(
      recordV1SourceTransaction(
        f.pool,
        config,
        session,
        randomUUID(),
        eventId,
        "0x" + "44".repeat(32),
      ),
      /original source hash/,
    );
    await assert.rejects(
      prepareV1RoutePayment(f.pool, config, session, eventId, transport),
      /do not pay again/,
    );
    assert.equal(
      (await readV1RegistrationState(f.pool, config, session, eventId, transport)).funded,
      false,
    );
    const row = (
      await f.pool.query(
        "SELECT encrypted_quote FROM app_v1_route_quotes WHERE registration_id=$1",
        [prepared.registrationId],
      )
    ).rows[0];
    assert.equal(row.encrypted_quote.includes(source.address), false);
  } finally {
    networkManifest.providers.oneClick.quotePublicKey = originalIssuer;
    await f.cleanup();
  }
});
