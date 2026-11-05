import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { hasRole, mutate } from "../auth/mutations";
import { seal, unseal } from "../auth/crypto";
import { transaction } from "../db/client";
import { requirePrivacyActor } from "../privacy/access";
import { AppFailure } from "../http/security";
import { canonicalHash } from "../protocol/canonical";
import { record } from "../protocol/quote-signature";
import { ReadOnlyRpc, unsigned } from "../protocol/rpc";
import { readV1Record } from "../protocol/v1-escrow";
import {
  readV1NftHolding,
  prepareV1NftTransfer,
  v1NftCustody,
  v1NftTransferData,
  v1NftGasBudget,
} from "../protocol/v1-nft";
import { v1NftMaximumGasWei } from "../../domain/v1-nft-budget";
import { enqueueV1Action, readV1ActionSnapshot } from "./v1-actions";
import { isUuid } from "./drafts";

async function owner(pool: pg.Pool, session: string, eventId: string) {
  if (!isUuid(eventId)) throw new AppFailure(404, "Private event unavailable.");
  return transaction(pool, async (client) => {
    const actor = await requirePrivacyActor(client, session),
      event = (
        await client.query("SELECT id FROM app_events WHERE id=$1 AND owner_id=$2", [
          eventId,
          actor.id,
        ])
      ).rows[0];
    if (!event) throw new AppFailure(404, "Private event unavailable.");
    return actor;
  });
}
export async function ownedV1Nft(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const actor = await owner(pool, session, eventId),
    context = await readV1ActionSnapshot(pool, config.encryptionKey, eventId, transport);
  if (!context.image.terms.nft) throw new AppFailure(404, "This event has no NFT prize.");
  return {
    ...context,
    actor,
    nft: context.image.terms.nft,
    live: record(context.snapshot.event!.nft),
  };
}
export async function readV1NftState(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const { nft, live, snapshot } = await ownedV1Nft(pool, config, session, eventId, transport),
    custody = live.custody ? v1NftCustody(live) : null,
    holding = await readV1NftHolding(nft, transport),
    delivery = (
      await pool.query(
        "SELECT state,transaction_hash FROM app_v1_nft_deliveries WHERE event_id=$1",
        [eventId],
      )
    ).rows[0],
    payments = (
      await pool.query(
        "SELECT purpose,source_hash FROM app_v1_nft_wallet_payments WHERE event_id=$1",
        [eventId],
      )
    ).rows;
  return {
    collection: nft.collection,
    tokenId: nft.token_id,
    contributor: nft.contributor,
    custody,
    owner: holding.owner,
    held: Boolean(custody && holding.owner === custody),
    status: String(snapshot.event!.status),
    signatureState: live.request ? String(record(live.request).state) : null,
    delivery: delivery?.state ?? null,
    transactionUrl: delivery ? `https://etherscan.io/tx/${delivery.transaction_hash}` : null,
    payments: payments.map((p) => ({
      purpose: p.purpose,
      transactionUrl: p.source_hash ? `https://etherscan.io/tx/${p.source_hash}` : null,
    })),
  };
}
export async function prepareV1NftWalletPayment(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  purpose: "nft" | "gas",
  transport?: typeof fetch,
) {
  const { actor, nft, live, snapshot } = await ownedV1Nft(
    pool,
    config,
    session,
    eventId,
    transport,
  );
  if (actor.state !== "active")
    throw new AppFailure(403, "Restricted accounts can recover fixed prizes only.");
  const custody = v1NftCustody(live);
  if (
    purpose === "nft" &&
    (snapshot.event!.status !== "draft" || Date.now() >= Number(snapshot.event!.start_ms))
  )
    throw new AppFailure(409, "Cancel the expired event; do not transfer the NFT to it.");
  const context = `v1-nft-wallet:${eventId}:${purpose}`;
  return transaction(pool, async (client) => {
    await client.query("SELECT id FROM app_events WHERE id=$1 FOR UPDATE", [eventId]);
    const previous = (
      await client.query(
        "SELECT * FROM app_v1_nft_wallet_payments WHERE event_id=$1 AND purpose=$2",
        [eventId, purpose],
      )
    ).rows[0];
    if (previous) {
      const payment = unseal(config.encryptionKey, context, previous.encrypted_payment) as {
        expiresAt: string;
      };
      if (canonicalHash(payment) !== previous.payment_hash)
        throw new Error("NFT wallet payment integrity");
      if (previous.source_hash || Date.parse(payment.expiresAt) <= Date.now() + 10000)
        throw new AppFailure(
          409,
          "Check the original Ethereum payment. Its frozen nonce is retained; do not pay twice.",
        );
      return payment;
    }
    let payment: unknown;
    if (purpose === "nft")
      payment = await prepareV1NftTransfer(nft, nft.contributor, custody, transport);
    else {
      if (!["draft", "published", "settled", "cancelled"].includes(String(snapshot.event!.status)))
        throw new AppFailure(409, "Event custody unavailable.");
      const holding = await readV1NftHolding(nft, transport);
      if (holding.owner !== nft.contributor && holding.owner !== custody)
        throw new AppFailure(
          409,
          "The NFT moved outside its fixed custody flow. Check its original transfer.",
        );
      const estimatedTransfer = {
        from: holding.owner,
        to: nft.collection,
        value: "0x0",
        data: v1NftTransferData(
          nft,
          holding.owner,
          holding.owner === custody ? nft.contributor : custody,
        ),
      };
      const facts = await Promise.all(
        ["ethereum-drpc", "ethereum-publicnode"].map(async (endpoint) => {
          const rpc = new ReadOnlyRpc(endpoint, transport),
            [chain, nonce, pending, price, balance, sourceBalance, gas] = await Promise.all([
              rpc.read("eth_chainId", []),
              rpc.read("eth_getTransactionCount", [nft.contributor, "latest"]),
              rpc.read("eth_getTransactionCount", [nft.contributor, "pending"]),
              rpc.read("eth_gasPrice", []),
              rpc.read("eth_getBalance", [custody, "latest"]),
              rpc.read("eth_getBalance", [nft.contributor, "latest"]),
              rpc.read("eth_estimateGas", [estimatedTransfer]),
            ]);
          if (unsigned(chain) !== 1n || unsigned(nonce, 64) !== unsigned(pending, 64))
            throw new AppFailure(409, "Wait for the original Ethereum transaction first.");
          return {
            nonce: unsigned(nonce, 64),
            price: unsigned(price, 128),
            balance: unsigned(balance),
            sourceBalance: unsigned(sourceBalance),
            gas: unsigned(gas, 64),
          };
        }),
      );
      if (facts[0].nonce !== facts[1].nonce || facts[0].balance !== facts[1].balance)
        throw new Error("NFT gas funding sources disagree");
      const { gas, fee: price } = v1NftGasBudget(
          facts.reduce((n, f) => (f.gas > n ? f.gas : n), 0n),
          facts.reduce((n, f) => (f.price > n ? f.price : n), 0n),
        ),
        reserve = gas * price,
        value = reserve > facts[0].balance ? reserve - facts[0].balance : 0n;
      if (price === 0n || reserve > v1NftMaximumGasWei)
        throw new AppFailure(
          422,
          "Ethereum gas exceeds the NFT's small-transfer budget. Check later.",
        );
      if (value === 0n)
        throw new AppFailure(409, "NFT custody already has its gas allowance. Do not fund again.");
      // The derived address must still be an ordinary Ethereum account.
      for (const endpoint of ["ethereum-drpc", "ethereum-publicnode"])
        if (
          (await new ReadOnlyRpc(endpoint, transport).read("eth_getCode", [custody, "latest"])) !==
          "0x"
        )
          throw new Error("NFT custody is not an ordinary Ethereum account");
      if (facts.some((f) => f.sourceBalance < value + 21000n * price))
        throw new AppFailure(
          422,
          "The contributor wallet needs ETH for custody gas and its funding fee.",
        );
      payment = {
        transaction: {
          from: nft.contributor,
          to: custody,
          value: "0x" + value.toString(16),
          data: "0x",
          chainId: "0x1",
          nonce: "0x" + facts[0].nonce.toString(16),
          gas: "0x5208",
          gasPrice: "0x" + price.toString(16),
        },
        maximumGasWei: (21000n * price).toString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    }
    await client.query(
      "INSERT INTO app_v1_nft_wallet_payments(event_id,purpose,payment_hash,encrypted_payment) VALUES($1,$2,$3,$4)",
      [eventId, purpose, canonicalHash(payment), seal(config.encryptionKey, context, payment)],
    );
    return payment;
  });
}
export async function recordV1NftWalletPayment(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  purpose: "nft" | "gas",
  sourceHash: string,
) {
  await owner(pool, session, eventId);
  if (!/^0x[0-9a-f]{64}$/.test(sourceHash))
    throw new AppFailure(400, "Use the original Ethereum transaction hash.");
  const result = await pool.query(
    "UPDATE app_v1_nft_wallet_payments SET source_hash=$3 WHERE event_id=$1 AND purpose=$2 AND (source_hash IS NULL OR source_hash=$3)",
    [eventId, purpose, sourceHash],
  );
  if (!result.rowCount)
    throw new AppFailure(409, "Original NFT payment unavailable or a different hash is retained.");
  return { recorded: true };
}
export async function requestV1NftAction(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  operationId: string,
  eventId: string,
  kind: "nft_release" | "nft_retry" | "nft_derive",
  transport?: typeof fetch,
) {
  const { actor, nft, live, snapshot } = await ownedV1Nft(
    pool,
    config,
    session,
    eventId,
    transport,
  );
  let release:
    | { envelope: Awaited<ReturnType<typeof prepareV1NftTransfer>>["envelope"]; recipient: string }
    | undefined;
  if (kind === "nft_release") {
    if (!["settled", "cancelled"].includes(String(snapshot.event!.status)) || live.request)
      throw new AppFailure(409, "Close or cancel the event, then check its original NFT release.");
    const winner = snapshot.event!.status === "settled" ? snapshot.event!.winner : null,
      recipient = winner
        ? String(
            (await readV1Record("get_registration", String(winner), snapshot.block, transport))
              ?.ethereum,
          )
        : nft.contributor,
      custody = v1NftCustody(live),
      prepared = await prepareV1NftTransfer(nft, custody, recipient, transport);
    release = { envelope: prepared.envelope, recipient };
  } else if (kind === "nft_retry") {
    const request = record(live.request);
    if (request.state !== "unresolved" || unsigned(request.attempt, 64) >= 3n)
      throw new AppFailure(409, "The original NFT signing request is not retryable.");
  } else if (snapshot.event!.status !== "draft" || live.custody || live.deriving === true)
    throw new AppFailure(409, "NFT custody derivation is already pending or ready.");
  if (actor.state !== "active") {
    if (kind === "nft_derive")
      throw new AppFailure(403, "Restricted accounts can recover fixed prizes only.");
    return transaction(pool, async (client) => {
      const current = await requirePrivacyActor(client, session);
      if (current.id !== actor.id) throw new AppFailure(404, "Private event unavailable.");
      await client.query("SELECT id FROM app_events WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
        eventId,
        current.id,
      ]);
      return enqueueV1Action(client, config.encryptionKey, {
        eventId,
        accountId: current.id,
        kind,
        target: kind === "nft_retry" ? `${eventId}:${record(live.request).attempt}` : eventId,
        minimumHeight: snapshot.block.height,
        ...(release && { nft: release }),
      });
    });
  }
  return mutate(
    pool,
    config.encryptionKey,
    session,
    operationId,
    { eventId, kind },
    "event.v1-nft-requested",
    async (client, current) => {
      hasRole(current, "host");
      if (current.id !== actor.id) throw new AppFailure(404, "Private event unavailable.");
      await client.query("SELECT id FROM app_events WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
        eventId,
        current.id,
      ]);
      return enqueueV1Action(client, config.encryptionKey, {
        eventId,
        accountId: current.id,
        kind,
        target: kind === "nft_retry" ? `${eventId}:${record(live.request).attempt}` : eventId,
        minimumHeight: snapshot.block.height,
        ...(release && { nft: release }),
      });
    },
  );
}
