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
  prepareV1ReceivingAccount,
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
import {
  runV1IntentsQueue,
  enqueueV1IntentsWithdrawal,
  type V1IntentsWithdrawal,
} from "../../src/worker/v1-intents";
import { v1Intents } from "../../src/server/protocol/v1-intents";
import { v1IntentsGateway } from "../../scripts/lib/v1-intents-gateway";

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
  let intentsBalance = "0",
    recoveryTotal = "0";
  let sourceNonce = "0x0",
    nonceReads = 0,
    storageReady = true;
  let snapshot!: V1Snapshot,
    registration: Record<string, unknown> | null = null,
    quote: Record<string, unknown> | null = null;
  const transport: typeof fetch = async (url, init) => {
    const input = JSON.parse(String(init?.body ?? "{}"));
    if (String(input.method).startsWith("eth_")) {
      if (input.method === "eth_getTransactionCount") nonceReads++;
      const result =
        input.method === "eth_chainId"
          ? "0x2105"
          : input.method === "eth_getBalance"
            ? "0x5af3107a4000"
            : input.method === "eth_call"
              ? input.params[0].data.startsWith("0xa9059cbb")
                ? "0x" + "0".repeat(63) + "1"
                : "0x" + "16e360".padStart(64, "0")
              : input.method === "eth_gasPrice"
                ? "0xf4240"
                : sourceNonce;
      return Response.json({ jsonrpc: "2.0", id: input.id, result });
    }
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
                      {
                        public_key: String(params.account_id).startsWith("r")
                          ? v1Deployment.publicKey
                          : signer.publicKey,
                        access_key: { permission: "FullAccess", nonce: 1 },
                      },
                    ],
                  }
                : params.request_type === "view_account"
                  ? {
                      code_hash:
                        params.account_id === "intents.near"
                          ? v1Intents.codeHash
                          : String(params.account_id).startsWith("r")
                            ? "1".repeat(32)
                            : v1Deployment.codeHash,
                      amount: "20000000000000000000000",
                      storage_usage: 182,
                    }
                  : {
                      result: [
                        ...Buffer.from(
                          JSON.stringify(
                            params.method_name === "mt_balance_of"
                              ? intentsBalance
                              : params.method_name === "get_claim"
                                ? recoveryTotal === "0"
                                  ? null
                                  : {
                                      recipient: "payout.near",
                                      remaining: recoveryTotal,
                                      paid: "0",
                                      pending: false,
                                      in_flight: "0",
                                    }
                                : params.method_name === "get_event"
                                  ? snapshot.event
                                  : params.method_name === "get_registration"
                                    ? registration
                                    : params.method_name === "storage_balance_of"
                                      ? storageReady
                                        ? { total: "1250000000000000000000", available: "0" }
                                        : null
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
      prepareV1ReceivingAccount(f.pool, config, other, eventId, payout.id, transport),
      /unavailable/,
    );
    assert.deepEqual(
      await prepareV1ReceivingAccount(f.pool, config, session, eventId, payout.id, transport),
      { ready: true },
    );
    storageReady = false;
    await assert.rejects(
      prepareV1Registration(
        f.pool,
        config,
        session,
        randomUUID(),
        eventId,
        rules,
        payout.id,
        transport,
        source.id,
      ),
      /Enable USDC receiving/,
    );
    assert.equal(
      (await f.pool.query("SELECT 1 FROM app_v1_registrations WHERE event_id=$1", [eventId]))
        .rowCount,
      0,
    );
    storageReady = true;
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
    let accountPrepares = 0,
      accountSends = 0;
    const accountGateway = {
      async prepare(image: Parameters<Parameters<typeof runV1IntentsQueue>[3]["prepare"]>[0]) {
        accountPrepares++;
        return {
          hash: block,
          signedBase64: "isolated-route-account",
          semantic: canonicalHash(image),
          validUntilMs: Date.now() + 120000,
        };
      },
      async submit() {
        accountSends++;
        throw new Error("route account response lost");
      },
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
      },
      async observe() {
        return { confirmed: true, height: "100" };
      },
    };
    await assert.rejects(
      runV1IntentsQueue(f.pool, key, "route_account", accountGateway),
      /response lost/,
    );
    assert.equal(
      (await runV1IntentsQueue(f.pool, key, "route_account", accountGateway)).state,
      "verified",
    );
    assert.deepEqual([accountPrepares, accountSends], [1, 1]);
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
    const payment = await prepareV1RoutePayment(f.pool, config, session, eventId, transport);
    assert.equal("transaction" in payment && payment.transaction.nonce, "0x0");
    assert.equal(nonceReads, 4);
    sourceNonce = "0x1";
    assert.deepEqual(
      await prepareV1RoutePayment(f.pool, config, session, eventId, transport),
      payment,
    );
    assert.equal(
      nonceReads,
      4,
      "A retry must return the stored original, without assigning a new nonce",
    );
    const frozen = (
      await f.pool.query(
        "SELECT payment_hash,encrypted_payment FROM app_v1_route_quotes WHERE registration_id=$1",
        [prepared.registrationId],
      )
    ).rows[0];
    assert.equal(frozen.encrypted_payment.includes(source.address), false);
    await f.pool.query("UPDATE app_v1_route_quotes SET payment_hash=$2 WHERE registration_id=$1", [
      prepared.registrationId,
      "0".repeat(64),
    ]);
    await assert.rejects(
      prepareV1RoutePayment(f.pool, config, session, eventId, transport),
      /integrity/,
    );
    await f.pool.query("UPDATE app_v1_route_quotes SET payment_hash=$2 WHERE registration_id=$1", [
      prepared.registrationId,
      frozen.payment_hash,
    ]);
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
    assert.equal(
      await enqueueV1IntentsWithdrawal(f.pool, key, transport),
      undefined,
      "provider success with no actual token balance cannot forward or fund",
    );
    intentsBalance = "1000000";
    assert.ok(await enqueueV1IntentsWithdrawal(f.pool, key, transport));
    const native = {
        async submit() {},
        async final() {
          return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
        },
      },
      observation = v1IntentsGateway("route_withdrawal", native, transport);
    let withdrawalPrepares = 0,
      withdrawalSends = 0,
      currentWithdrawal!: V1IntentsWithdrawal;
    const forward = {
      async prepare(image: Parameters<Parameters<typeof runV1IntentsQueue>[3]["prepare"]>[0]) {
        if (image.format !== "showup.v1.intents-withdrawal.v1")
          throw new Error("Wrong test withdrawal");
        currentWithdrawal = image;
        withdrawalPrepares++;
        return {
          hash: block,
          signedBase64: "isolated-original-withdrawal",
          semantic: canonicalHash(image),
          validUntilMs: Date.now() + 120000,
        };
      },
      async submit() {
        withdrawalSends++;
        intentsBalance = "0";
        if (withdrawalSends === 1) throw new Error("withdrawal response lost");
        recoveryTotal = (BigInt(recoveryTotal) + BigInt(currentWithdrawal.amount)).toString();
      },
      final: native.final,
      observe: observation.observe,
    };
    await assert.rejects(
      runV1IntentsQueue(f.pool, key, "route_withdrawal", forward),
      /response lost/,
    );
    await assert.rejects(
      runV1IntentsQueue(f.pool, key, "route_withdrawal", forward),
      /not yet confirmed/,
    );
    assert.deepEqual([withdrawalPrepares, withdrawalSends], [1, 1]);
    registration!.funded = true;
    snapshot.event!.funded = [prepared.registrationId];
    assert.equal(
      (await runV1IntentsQueue(f.pool, key, "route_withdrawal", forward)).state,
      "verified",
    );
    assert.equal(
      (await readV1RegistrationState(f.pool, config, session, eventId, transport)).funded,
      true,
    );
    intentsBalance = "500000";
    assert.equal(
      await enqueueV1IntentsWithdrawal(f.pool, key, transport),
      undefined,
      "an incomplete credit waits for the original deadline",
    );
    assert.ok(
      await enqueueV1IntentsWithdrawal(f.pool, key, transport, Date.parse(price.expiresAt) + 1),
    );
    assert.equal(
      (await runV1IntentsQueue(f.pool, key, "route_withdrawal", forward)).state,
      "verified",
    );
    assert.deepEqual([withdrawalPrepares, withdrawalSends], [2, 2]);
    assert.equal(
      recoveryTotal,
      "500000",
      "extra or partial credit goes to the fixed recovery claim, never another registration",
    );
  } finally {
    networkManifest.providers.oneClick.quotePublicKey = originalIssuer;
    await f.cleanup();
  }
});
