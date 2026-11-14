import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { accountFixtures } from "../fixtures/accounts";
import { validDraft } from "../fixtures/draft";
import { v1NftFixture } from "../fixtures/v1-nft";
import { verifyNearWallet } from "../fixtures/near-wallet";
import { nativeKey } from "../../scripts/lib/native-engineering-transaction";
import { authConfig } from "../../src/server/auth/config";
import { hash } from "../../src/server/auth/crypto";
import { canonicalHash } from "../../src/server/protocol/canonical";
import { encodeBase58 } from "../../src/server/protocol/encoding";
import { readV1Snapshot, v1Deployment, type V1Snapshot } from "../../src/server/protocol/v1-escrow";
import { v1NftReleaseTransaction } from "../../src/server/protocol/v1-nft";
import { saveAccountDraft } from "../../src/server/events/accounts";
import { prepareV1Publication } from "../../src/server/events/v1-publication";
import { confirmV1PrizeFunding } from "../../src/server/events/v1-prize-funding";
import {
  prepareV1NftWalletPayment,
  readV1NftState,
  recordV1NftWalletPayment,
  requestV1NftAction,
} from "../../src/server/events/v1-nft";
import {
  requestV1Close,
  storedV1Action,
  type V1ActionImage,
} from "../../src/server/events/v1-actions";
import {
  prepareV1Registration,
  matchesV1Registration,
} from "../../src/server/commitments/v1-registration";
import { issueWalletChallenge, acceptWalletProof } from "../../src/server/wallets/service";
import { runV1Publication } from "../../src/worker/v1-publication";
import { runV1Action, type V1ActionGateway } from "../../src/worker/v1-actions";
import { validateV1Action, observeV1Action } from "../../src/worker/v1-action-observation";
import { runV1Registration } from "../../src/worker/v1-registration";
import { runV1NftDelivery, v1NftDeliveryGateway } from "../../src/worker/v1-nft-delivery";

async function fixture() {
  const f = await accountFixtures([["host"], [], ["host"]]),
    n = v1NftFixture(),
    key = randomBytes(32).toString("hex"),
    config = authConfig({
      SHOWUP_AUTH: "1",
      SHOWUP_AUTH_ORIGIN: "https://localhost:3444",
      SHOWUP_IDENTITY_KEY: key,
      SHOWUP_IDENTITY_INDEX_KEY: randomBytes(32).toString("hex"),
    })!,
    sessions = f.accounts.map((a) => hash(a.value)),
    id = randomUUID(),
    blockHash = encodeBase58(Buffer.alloc(32, 9)),
    time = Date.now(),
    nearKey = nativeKey(randomBytes(32));
  let event: Record<string, unknown> | null = null;
  const registrations = new Map<string, Record<string, unknown>>();
  const snapshot = () =>
    ({ block: { height: "100", hash: blockHash, timestampMs: time }, event }) as V1Snapshot;
  const transport: typeof fetch = async (url, init) => {
    const input = JSON.parse(String(init?.body));
    if (input.method.startsWith("eth_")) return n.transport(url, init);
    const p = input.params,
      result =
        input.method === "status"
          ? { chain_id: "mainnet" }
          : input.method === "block"
            ? {
                header: {
                  height: 100,
                  hash: blockHash,
                  timestamp_nanosec: (BigInt(time) * 1000000n).toString(),
                },
              }
            : {
                block_hash: blockHash,
                block_height: 100,
                ...(p.request_type === "view_account"
                  ? { code_hash: v1Deployment.codeHash }
                  : p.request_type === "view_access_key_list"
                    ? {
                        keys: [
                          {
                            public_key: nearKey.publicKey,
                            access_key: { permission: "FullAccess" },
                          },
                        ],
                      }
                    : {
                        result: [
                          ...Buffer.from(
                            JSON.stringify(
                              p.method_name === "get_event"
                                ? event
                                : p.method_name === "get_registration"
                                  ? (registrations.get(
                                      JSON.parse(Buffer.from(p.args_base64, "base64").toString())
                                        .registration,
                                    ) ?? null)
                                  : null,
                            ),
                          ),
                        ],
                      }),
              };
    return Response.json({ jsonrpc: "2.0", id: input.id, result });
  };
  const signed = (semantic: string) => ({
    hash: blockHash,
    signedBase64: "isolated-original",
    semantic,
    validUntilMs: Date.now() + 120000,
  });
  try {
    await saveAccountDraft(
      f.pool,
      key,
      sessions[0],
      {
        id,
        revision: 0,
        operationId: randomUUID(),
        data: {
          ...validDraft(),
          capacity: 2,
          commitment: "1",
          sponsorBudget: "0",
          access: "open",
          nft: n.draft,
        },
      },
      "v1",
    );
    await prepareV1Publication(f.pool, key, sessions[0], randomUUID(), id, 1, undefined, transport);
    const publication = {
      async prepare(
        image: Parameters<Parameters<typeof runV1Publication>[2]["prepare"]>[0],
        phase?: "create" | "publish" | "atomic",
      ) {
        event = {
          ...image.terms,
          nft: { ...n.live, held: phase === "publish" },
          status: phase === "publish" ? "published" : "draft",
          funded: [],
          winner: null,
          prize_received: true,
        };
        return { ...signed(canonicalHash(image.terms)), phase };
      },
      async submit() {},
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
      },
      async snapshot() {
        return snapshot();
      },
    };
    await runV1Publication(f.pool, key, publication);
    return {
      ...f,
      ...n,
      key,
      config,
      sessions,
      id,
      transport,
      snapshot,
      signed,
      publication,
      registrations,
      nearKey,
      event: () => event!,
    };
  } catch (error) {
    await f.cleanup();
    throw error;
  }
}
test("NFT publication waits for actual custody; source hints cannot publish, and attendees bind only their owned immutable Ethereum recipient", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      readV1NftState(f.pool, f.config, f.sessions[2], f.id, f.transport),
      /unavailable/,
    );
    const payment = (await prepareV1NftWalletPayment(
      f.pool,
      f.config,
      f.sessions[0],
      f.id,
      "nft",
      f.transport,
    )) as { transaction: { nonce: string } };
    f.setNonce("0x1");
    assert.deepEqual(
      await prepareV1NftWalletPayment(f.pool, f.config, f.sessions[0], f.id, "nft", f.transport),
      payment,
      "retries retain the original nonce",
    );
    await recordV1NftWalletPayment(
      f.pool,
      f.config,
      f.sessions[0],
      f.id,
      "nft",
      "0x" + "01".repeat(32),
    );
    await assert.rejects(
      prepareV1NftWalletPayment(f.pool, f.config, f.sessions[0], f.id, "nft", f.transport),
      /original/,
    );
    let progress = { confirmations: 1, gasConfirmations: 2, gasShortfall: "0" };
    const confirm = () =>
      confirmV1PrizeFunding(
        f.pool,
        f.key,
        f.sessions[0],
        randomUUID(),
        f.id,
        1,
        async () => f.snapshot(),
        async () => progress,
      );
    await assert.rejects(confirm(), /two Ethereum confirmations/);
    f.setOwner(f.custody);
    f.setPrice("0x59682f00"); // Observed 1.5-gwei Ethereum price after mainnet deposit.
    const gasTransport: typeof fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "eth_getBalance" && request.params[0] === f.custody)
        return Response.json({ jsonrpc: "2.0", id: request.id, result: "0x0" });
      return f.transport(url, init);
    };
    const gasPayment = (await prepareV1NftWalletPayment(
      f.pool,
      f.config,
      f.sessions[0],
      f.id,
      "gas",
      gasTransport,
    )) as { transaction: { to: string; value: string; data: string } };
    assert.equal(gasPayment.transaction.to, f.custody);
    assert.equal(gasPayment.transaction.data, "0x");
    assert(BigInt(gasPayment.transaction.value) > 100000000000000n);
    assert(BigInt(gasPayment.transaction.value) <= 400000000000000n);
    assert.deepEqual(
      await prepareV1NftWalletPayment(f.pool, f.config, f.sessions[0], f.id, "gas", gasTransport),
      gasPayment,
      "a second click retains the original allowance and nonce",
    );
    progress = { confirmations: 2, gasConfirmations: 1, gasShortfall: "0" };
    await assert.rejects(confirm(), /two Ethereum confirmations/);
    progress = { ...progress, gasConfirmations: 2 };
    await confirm();
    let prepared = 0;
    const waiting = {
      ...f.publication,
      async prepare() {
        prepared++;
        return null;
      },
    };
    assert.equal((await runV1Publication(f.pool, f.key, waiting)).state, "waiting");
    assert.equal((await runV1Publication(f.pool, f.key, waiting)).state, "idle");
    assert.equal(prepared, 1);
    await f.pool.query(
      "UPDATE app_publication_images SET nft_publication_check_after=clock_timestamp() WHERE event_id=$1",
      [f.id],
    );
    await runV1Publication(f.pool, f.key, f.publication);
    const payout = await verifyNearWallet(
        f.pool,
        f.config,
        f.sessions[1],
        { address: "attendee.near", ...f.nearKey },
        f.transport,
      ),
      challenge = await issueWalletChallenge(f.pool, f.config, f.sessions[1], {
        operationId: randomUUID(),
        network: "ethereum",
        address: f.recipient.address,
      }),
      eth = await acceptWalletProof(f.pool, f.config, f.sessions[1], {
        operationId: randomUUID(),
        challengeId: challenge.id,
        proof: { signature: await f.recipient.signMessage(challenge.message) },
      }),
      rules = (await f.pool.query("SELECT rules_hash FROM app_events WHERE id=$1", [f.id])).rows[0]
        .rules_hash;
    const register = (wallet?: string) =>
      prepareV1Registration(
        f.pool,
        f.config,
        f.sessions[1],
        randomUUID(),
        f.id,
        rules,
        payout.id,
        f.transport,
        undefined,
        wallet,
      );
    await assert.rejects(register(), /Ethereum/);
    await assert.rejects(register(payout.id), /unavailable/);
    await register(eth.id);
    let original: unknown;
    await runV1Registration(f.pool, f.key, {
      async prepare(image) {
        original = image;
        return f.signed(canonicalHash(image));
      },
      async submit() {},
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
      },
      async observe(image) {
        const reg = {
          id: image.id,
          event: image.eventId,
          sender: image.sender,
          payout: image.payout,
          ethereum: image.ethereum!.address,
          funded: false,
        };
        assert.equal(matchesV1Registration(reg, image), true);
        assert.equal(matchesV1Registration({ ...reg, ethereum: f.contributor }, image), false);
        return { snapshot: f.snapshot(), registration: reg };
      },
    });
    assert.equal(
      (original as { ethereum: { address: string } }).ethereum.address,
      f.recipient.address.toLowerCase(),
    );
    await assert.rejects(register(), /locked/);
  } finally {
    await f.cleanup();
  }
});
test("an unpublished NFT event cancels privately, signs only its fixed contributor return and recovers a lost Ethereum write without resending", async () => {
  const f = await fixture();
  try {
    f.setOwner(f.custody);
    await requestV1Close(
      f.pool,
      f.config,
      f.sessions[0],
      randomUUID(),
      f.id,
      "cancel",
      f.transport,
    );
    let current!: V1ActionImage;
    const gateway: V1ActionGateway = {
      async prepare(image) {
        await validateV1Action(image, await readV1Snapshot(f.id, f.transport), f.transport);
        current = image;
        return f.signed(canonicalHash(image));
      },
      async submit() {
        if (current.kind === "cancel") f.event().status = "cancelled";
        else if (current.kind === "nft_release") {
          const live = f.event().nft as Record<string, unknown>,
            { recipient, envelope } = current.nft!,
            tx = v1NftReleaseTransaction(f.nft, f.custody, recipient, envelope),
            signature = f.signer.signingKey.sign(tx.unsignedHash);
          live.held = true;
          live.request = {
            state: "signed",
            recipient,
            payload: tx.unsignedHash.slice(2),
            unsigned_transaction: Buffer.from(tx.unsignedSerialized.slice(2), "hex").toString(
              "base64",
            ),
            attempt: 1,
            signature: JSON.stringify({
              scheme: "Secp256k1",
              big_r: {
                affine_point: (signature.yParity === 0 ? "02" : "03") + signature.r.slice(2),
              },
              s: { scalar: signature.s.slice(2) },
              recovery_id: signature.yParity,
            }),
          };
        }
      },
      async final() {
        return { success: true, minimumHeight: "100", gasYoctoNear: "0" };
      },
      async observe(image, min) {
        return observeV1Action(image, f.snapshot(), min, f.transport);
      },
    };
    assert.equal((await runV1Action(f.pool, f.key, gateway)).state, "verified");
    assert.equal(
      (await f.pool.query("SELECT state FROM app_events WHERE id=$1", [f.id])).rows[0].state,
      "draft",
      "a cancelled private draft must not expose its venue",
    );
    await requestV1NftAction(
      f.pool,
      f.config,
      f.sessions[0],
      randomUUID(),
      f.id,
      "nft_release",
      f.transport,
    );
    const row = (
      await f.pool.query(
        "SELECT * FROM app_v1_event_actions WHERE event_id=$1 AND kind='nft_release'",
        [f.id],
      )
    ).rows[0];
    assert.equal(storedV1Action(f.key, row).nft!.recipient, f.contributor);
    const failed = await runV1Action(f.pool, f.key, {
      ...gateway,
      submit: async () => {},
      final: async () => ({ success: false, minimumHeight: "100", gasYoctoNear: "0" }),
    });
    assert.equal(failed.state, "failed");
    f.setPrice("0x1312d00");
    await requestV1NftAction(
      f.pool,
      f.config,
      f.sessions[0],
      randomUUID(),
      f.id,
      "nft_release",
      f.transport,
    );
    assert.equal((await runV1Action(f.pool, f.key, gateway)).state, "verified");
    const real = v1NftDeliveryGateway(f.pool, f.key, f.transport);
    const recovered = await real.prepare(f.id);
    assert.notEqual(recovered!.envelope.max_fee, storedV1Action(f.key, row).nft!.envelope.max_fee);
    assert.equal(recovered!.recipient, f.contributor);
    let prepares = 0,
      sends = 0;
    const delivery = {
      async prepare(id: string) {
        prepares++;
        return real.prepare(id);
      },
      async submit() {
        sends++;
        throw new Error("accepted response lost");
      },
      async observe() {
        return { state: "delivered" as const, height: "100", fee: "680000000000" };
      },
    };
    await assert.rejects(runV1NftDelivery(f.pool, f.key, delivery), /response lost/);
    assert.equal((await runV1NftDelivery(f.pool, f.key, delivery)).state, "delivered");
    assert.deepEqual([prepares, sends], [1, 1]);
    assert.equal(
      (await readV1NftState(f.pool, f.config, f.sessions[0], f.id, f.transport)).delivery,
      "delivered",
    );
  } finally {
    await f.cleanup();
  }
});
