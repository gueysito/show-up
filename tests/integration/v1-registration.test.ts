import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { accountFixtures } from "../fixtures/accounts";
import { verifyNearWallet } from "../fixtures/near-wallet";
import { validDraft } from "../fixtures/draft";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import {
  prepareV1Registration,
  prepareV1Deposit,
  confirmV1Deposit,
  readV1RegistrationState,
} from "../../src/server/commitments/v1-registration";
import { runV1Publication } from "../../src/worker/v1-publication";
import { runV1Registration, type V1RegistrationGateway } from "../../src/worker/v1-registration";
import { v1Deployment, type V1Snapshot } from "../../src/server/protocol/v1-escrow";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { nativeKey } from "../../scripts/lib/native-engineering-transaction";
import { exportOwnData } from "../../src/server/privacy/export";
import { requestAccountDeletion } from "../../src/server/privacy/deletion";
import { createDeletionConfirmation } from "../../src/server/privacy/confirmation";

test("native V1 deposit binds the owning attendee wallet, reconciles one registration image and confirms only actual escrow funding", async () => {
  const f = await accountFixtures([["host"], [], []]);
  const key = randomBytes(32).toString("hex"),
    config = authConfig({
      SHOWUP_AUTH: "1",
      SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
      SHOWUP_IDENTITY_KEY: key,
      SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
    })!;
  const session = hash(f.accounts[1].value),
    hostSession = hash(f.accounts[0].value),
    other = hash(f.accounts[2].value),
    eventId = randomUUID();
  const signer = nativeKey(randomBytes(32)),
    block = encodeBase58(Buffer.alloc(32, 7)),
    originalFetch = globalThis.fetch;
  let snapshot!: V1Snapshot,
    registration: Record<string, unknown> | null = null;
  const blockTime = Date.now() - 1000;
  const transport: typeof fetch = async (_url, options) => {
    const input = JSON.parse(String(options?.body)),
      params = input.params;
    const result =
      input.method === "status"
        ? { chain_id: "mainnet" }
        : input.method === "block"
          ? {
              header: {
                height: 100,
                hash: block,
                timestamp_nanosec: (BigInt(blockTime) * 1000000n).toString(),
              },
            }
          : input.method === "EXPERIMENTAL_protocol_config"
            ? {
                chain_id: "mainnet",
                protocol_version: 87,
                runtime_config: {
                  min_gas_purchase_price: "1000000000",
                  storage_amount_per_byte: "10000000000000000000",
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
                  : params.request_type === "view_access_key"
                    ? { permission: "FullAccess", nonce: 1 }
                    : params.request_type === "view_account"
                      ? {
                          code_hash: v1Deployment.codeHash,
                          amount: "200000000000000000000000",
                          storage_usage: 182,
                        }
                      : {
                          result: [
                            ...Buffer.from(
                              JSON.stringify(
                                params.method_name === "get_event"
                                  ? snapshot.event
                                  : params.method_name === "get_registration"
                                    ? registration
                                    : params.method_name === "get_claim"
                                      ? null
                                      : "2000000",
                              ),
                            ),
                          ],
                        }),
              };
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  try {
    const wallet = await verifyNearWallet(
      f.pool,
      config,
      session,
      { address: "attendee.near", ...signer },
      transport,
    );
    const otherWallet = await verifyNearWallet(
      f.pool,
      config,
      other,
      { address: "other.near", ...signer },
      transport,
    );
    await saveAccountDraft(
      f.pool,
      key,
      hostSession,
      {
        id: eventId,
        revision: 0,
        operationId: randomUUID(),
        data: { ...validDraft(), capacity: 2, commitment: "1", sponsorBudget: "0", access: "open" },
      },
      "v1",
    );
    await prepareV1Publication(f.pool, key, hostSession, randomUUID(), eventId, 1);
    await runV1Publication(f.pool, key, {
      async prepare(image) {
        snapshot = {
          block: { height: "100", hash: block, timestampMs: Date.now() },
          event: { ...image.terms, status: "published", funded: [], prize_received: true },
        };
        return {
          hash: block,
          signedBase64: "local-publication",
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
    globalThis.fetch = transport;
    const rules = (await f.pool.query("SELECT rules_hash FROM app_events WHERE id=$1", [eventId]))
      .rows[0].rules_hash;
    await assert.rejects(
      prepareV1Registration(
        f.pool,
        config,
        hostSession,
        randomUUID(),
        eventId,
        rules,
        wallet.id,
        transport,
      ),
      /Only an attendee/,
    );
    await assert.rejects(
      prepareV1Registration(
        f.pool,
        config,
        session,
        randomUUID(),
        eventId,
        rules,
        otherWallet.id,
        transport,
      ),
      /unavailable/,
    );
    await assert.rejects(
      prepareV1Registration(
        f.pool,
        config,
        session,
        randomUUID(),
        eventId,
        "0".repeat(64),
        wallet.id,
        transport,
      ),
      /Reopen/,
    );
    const operation = randomUUID(),
      first = await prepareV1Registration(
        f.pool,
        config,
        session,
        operation,
        eventId,
        rules,
        wallet.id,
        transport,
      );
    assert.deepEqual(
      await prepareV1Registration(
        f.pool,
        config,
        session,
        operation,
        eventId,
        rules,
        wallet.id,
        transport,
      ),
      first,
    );
    let prepares = 0,
      sends = 0;
    const gateway: V1RegistrationGateway = {
      async prepare(image) {
        prepares++;
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
          signedBase64: "only-original-registration",
          semantic: canonicalHash(image),
          validUntilMs: Date.now() + 120000,
        };
      },
      async submit() {
        sends++;
        throw new Error("Accepted but response lost");
      },
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "12" };
      },
      async observe() {
        return { snapshot, registration };
      },
    };
    await assert.rejects(runV1Registration(f.pool, key, gateway), /response lost/);
    assert.equal((await runV1Registration(f.pool, key, gateway)).state, "registered");
    assert.deepEqual([prepares, sends], [1, 1]);
    assert.equal(
      (await readV1RegistrationState(f.pool, config, other, eventId, transport)).state,
      "none",
    );
    assert.equal(
      (await readV1RegistrationState(f.pool, config, session, eventId, transport)).funded,
      false,
    );
    const payment = await prepareV1Deposit(f.pool, config, session, eventId, transport);
    assert.equal(payment.amountAtomic, "1000000");
    assert.equal(payment.signer, "attendee.near");
    assert.equal(
      new URL(payment.walletUrl).searchParams.get("callbackUrl"),
      `${config.origin}/events/${eventId}/commit`,
    );
    await assert.rejects(
      confirmV1Deposit(f.pool, config, session, eventId, transport),
      /not confirmed/,
    );
    registration!.sender = "attacker.near";
    await assert.rejects(
      prepareV1Deposit(f.pool, config, session, eventId, transport),
      /source mismatch/,
    );
    registration!.sender = "attendee.near";
    registration!.funded = true;
    await f.pool.query("UPDATE app_v1_registrations SET funding_height=101 WHERE id=$1", [
      first.registrationId,
    ]);
    await assert.rejects(
      readV1RegistrationState(f.pool, config, session, eventId, transport),
      /source mismatch/,
    );
    await f.pool.query("UPDATE app_v1_registrations SET funding_height=NULL WHERE id=$1", [
      first.registrationId,
    ]);
    assert.equal(
      (await readV1RegistrationState(f.pool, config, session, eventId, transport)).funded,
      true,
    );
    assert.equal(
      (
        await f.pool.query("SELECT state FROM app_v1_registrations WHERE id=$1", [
          first.registrationId,
        ])
      ).rows[0].state,
      "funded",
    );
    await assert.rejects(
      prepareV1Deposit(f.pool, config, session, eventId, transport),
      /do not pay again/i,
    );
    assert.equal(
      (await confirmV1Deposit(f.pool, config, session, eventId, transport)).funded,
      true,
    );
    assert.equal(
      (await readV1RegistrationState(f.pool, config, session, eventId, transport)).funded,
      true,
    );
    const exported = await exportOwnData(f.pool, config, session);
    assert.equal(exported.mainnetRegistrations[0].id, first.registrationId);
    assert.equal((await exportOwnData(f.pool, config, other)).mainnetRegistrations.length, 0);
    const deletionOperation = randomUUID();
    const deletion = await requestAccountDeletion(f.pool, config, session, {
      operationId: deletionOperation,
      confirmation: "DELETE",
      acknowledgeOnChain: true,
      intent: createDeletionConfirmation(config, f.accounts[1].id, session, deletionOperation),
    });
    assert(deletion.holdReasons.includes("financial_reconciliation"));
    const restricted = hash(deletion.sessionValue!);
    assert.equal(
      (await readV1RegistrationState(f.pool, config, restricted, eventId, transport)).funded,
      true,
    );
    await assert.rejects(
      prepareV1Deposit(f.pool, config, restricted, eventId, transport),
      /Sign in again/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await f.cleanup();
  }
});
