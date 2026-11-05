import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { saveAccountDraft } from "../../src/server/events/accounts";
import {
  prepareV1Publication,
  readV1PublicationState,
  storedV1Publication,
} from "../../src/server/events/v1-publication";
import {
  confirmV1PrizeFunding,
  prepareV1PrizeFunding,
} from "../../src/server/events/v1-prize-funding";
import { runV1Publication, type V1PublicationGateway } from "../../src/worker/v1-publication";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { type V1Snapshot, v1Deployment } from "../../src/server/protocol/v1-escrow";
import { nativeKey } from "../../scripts/lib/native-engineering-transaction";
import { accountFixtures } from "../fixtures/accounts";
import { verifyNearWallet } from "../fixtures/near-wallet";
import { validDraft } from "../fixtures/draft";

test("prize publication freezes an owned sponsor, confirms real funding and recovers original phase images", async () => {
  const f = await accountFixtures([["host"], ["host"]]);
  const key = randomBytes(32).toString("hex"),
    session = hash(f.accounts[0].value),
    id = randomUUID();
  const config = authConfig({
    SHOWUP_AUTH: "1",
    SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
    SHOWUP_IDENTITY_KEY: key,
    SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
  })!;
  const signer = nativeKey(randomBytes(32)),
    address = "host.near",
    blockHash = encodeBase58(Buffer.alloc(32, 7));
  const source: typeof fetch = async (_url, options) => {
    const input = JSON.parse(String(options?.body));
    const result =
      input.method === "status"
        ? { chain_id: "mainnet" }
        : input.method === "block"
          ? {
              header: {
                height: 100,
                hash: blockHash,
                timestamp_nanosec: (BigInt(Date.now() - 1000) * 1000000n).toString(),
              },
            }
          : {
              block_hash: blockHash,
              block_height: 100,
              keys: [{ public_key: signer.publicKey, access_key: { permission: "FullAccess" } }],
            };
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  try {
    const data = { ...validDraft(), capacity: 2, commitment: "1", sponsorBudget: "1.25" };
    await saveAccountDraft(
      f.pool,
      key,
      session,
      { id, revision: 0, operationId: randomUUID(), data },
      "v1",
    );
    await assert.rejects(
      prepareV1Publication(f.pool, key, session, randomUUID(), id, 1),
      /verified NEAR/,
    );
    const other = await verifyNearWallet(
      f.pool,
      config,
      hash(f.accounts[1].value),
      { address, ...signer },
      source,
    );
    await assert.rejects(
      prepareV1Publication(f.pool, key, session, randomUUID(), id, 1, other.id),
      /unavailable/,
    );
    const wallet = await verifyNearWallet(f.pool, config, session, { address, ...signer }, source);
    await prepareV1Publication(f.pool, key, session, randomUUID(), id, 1, wallet.id);
    await assert.rejects(
      prepareV1Publication(f.pool, key, session, randomUUID(), id, 1, other.id),
      /locked/,
    );
    let snapshot!: V1Snapshot,
      prepares = 0,
      sends = 0;
    let loseResponse = true;
    const phases: string[] = [];
    const gateway: V1PublicationGateway = {
      async prepare(image, phase) {
        prepares++;
        phases.push(phase!);
        snapshot = {
          block: { height: "100", hash: blockHash, timestampMs: Date.now() },
          event: {
            ...image.terms,
            status: phase === "create" ? "draft" : "published",
            funded: [],
            winner: null,
            prize_received: phase === "publish",
          },
        };
        return {
          hash: blockHash,
          signedBase64: `original-${phase}`,
          semantic: canonicalHash(image.terms),
          validUntilMs: Date.now() + 120000,
          phase,
        };
      },
      async submit() {
        sends++;
        if (loseResponse) throw new Error("response lost");
      },
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "123" };
      },
      async snapshot() {
        return snapshot;
      },
    };
    await assert.rejects(runV1Publication(f.pool, key, gateway), /response lost/);
    assert.equal((await runV1Publication(f.pool, key, gateway)).state, "awaiting_prize");
    assert.deepEqual([prepares, sends], [1, 1]);
    const row = async () =>
      (
        await f.pool.query(
          "SELECT p.*,e.owner_id,e.data,e.revision FROM app_publication_images p JOIN app_events e ON e.id=p.event_id WHERE p.event_id=$1",
          [id],
        )
      ).rows[0];
    const created = await row();
    assert.equal(created.creation_transaction_hash, blockHash);
    assert.equal(created.creation_encrypted_transaction, created.encrypted_transaction);
    assert.equal(storedV1Publication(key, created).terms.sponsor, address);
    assert.equal((await runV1Publication(f.pool, key, gateway)).state, "idle");
    let balance = "1250000",
      permission = "FullAccess",
      disagreeNonce = false;
    const fundingSource: typeof fetch = async (url, options) => {
      const input = JSON.parse(String(options?.body));
      if (input.method === "status" || input.method === "block") return source(url, options);
      const params = input.params;
      const result =
        input.method === "EXPERIMENTAL_protocol_config"
          ? {
              chain_id: "mainnet",
              protocol_version: 87,
              runtime_config: { min_gas_purchase_price: "1000000000" },
            }
          : {
              block_hash: blockHash,
              block_height: 100,
              ...(params.request_type === "view_access_key"
                ? { permission, nonce: disagreeNonce && String(url).includes("drpc") ? "2" : "1" }
                : params.request_type === "view_account"
                  ? { code_hash: v1Deployment.codeHash, amount: "200000000000000000000000" }
                  : {
                      result: [
                        ...Buffer.from(
                          JSON.stringify(
                            params.method_name === "get_event" ? snapshot.event : balance,
                          ),
                        ),
                      ],
                    }),
            };
      return Response.json({ jsonrpc: "2.0", id: input.id, result });
    };
    const payment = await prepareV1PrizeFunding(f.pool, config, session, id, 1, fundingSource);
    assert.equal(payment.signer, address);
    assert.equal(payment.amountAtomic, "1250000");
    assert.equal(payment.token, v1Deployment.token);
    const walletUrl = new URL(payment.walletUrl);
    assert.equal(walletUrl.origin, "https://app.mynearwallet.com");
    assert.equal(walletUrl.searchParams.get("transactions"), payment.unsignedBase64);
    assert.equal(walletUrl.searchParams.get("callbackUrl"), `${config.origin}/host?event=${id}`);
    balance = "1249999";
    await assert.rejects(
      prepareV1PrizeFunding(f.pool, config, session, id, 1, fundingSource),
      /gas reserve/,
    );
    balance = "1250000";
    permission = "FunctionCall";
    await assert.rejects(
      prepareV1PrizeFunding(f.pool, config, session, id, 1, fundingSource),
      /full-access/,
    );
    permission = "FullAccess";
    disagreeNonce = true;
    await assert.rejects(
      prepareV1PrizeFunding(f.pool, config, session, id, 1, fundingSource),
      /sources disagree/,
    );
    disagreeNonce = false;
    const timestamp = snapshot.block.timestampMs;
    snapshot.block.timestampMs = snapshot.event!.start_ms as number;
    // Both sources can agree on an expired draft; it still must not solicit funds.
    // Confirmation uses that same finalized source-time boundary.
    await assert.rejects(
      confirmV1PrizeFunding(f.pool, key, session, randomUUID(), id, 1, async () => snapshot),
      /does not yet match/,
    );
    snapshot.block.timestampMs = timestamp;
    const operation = randomUUID();
    await assert.rejects(
      confirmV1PrizeFunding(
        f.pool,
        key,
        hash(f.accounts[1].value),
        operation,
        id,
        1,
        async () => snapshot,
      ),
      /unavailable/,
    );
    await assert.rejects(
      confirmV1PrizeFunding(f.pool, key, session, operation, id, 1, async () => snapshot),
      /not been confirmed/,
    );
    snapshot.event!.prize_received = true;
    await assert.rejects(
      prepareV1PrizeFunding(f.pool, config, session, id, 1, fundingSource),
      /do not pay again/,
    );
    snapshot.block.height = "99";
    await assert.rejects(
      confirmV1PrizeFunding(f.pool, key, session, operation, id, 1, async () => snapshot),
      /does not yet match/,
    );
    snapshot.block.height = "100";
    const amount = snapshot.event!.prize;
    snapshot.event!.prize = "1";
    await assert.rejects(
      confirmV1PrizeFunding(f.pool, key, session, operation, id, 1, async () => snapshot),
      /does not yet match/,
    );
    snapshot.event!.prize = amount;
    await confirmV1PrizeFunding(f.pool, key, session, operation, id, 1, async () => snapshot);
    const queued = await row();
    assert.equal(queued.execution_phase, "publish");
    assert.equal(queued.transaction_hash, null);
    assert.equal(queued.creation_encrypted_transaction, created.encrypted_transaction);
    await assert.rejects(runV1Publication(f.pool, key, gateway), /response lost/);
    loseResponse = false;
    assert.equal((await runV1Publication(f.pool, key, gateway)).state, "verified");
    assert.deepEqual([prepares, sends], [2, 2]);
    assert.deepEqual(phases, ["create", "publish"]);
    assert.equal((await readV1PublicationState(f.pool, session, id, 1, key)).state, "verified");
    await assert.rejects(
      prepareV1PrizeFunding(f.pool, config, session, id, 1, source),
      /Check publication status/,
    );
  } finally {
    await f.cleanup();
  }
});
