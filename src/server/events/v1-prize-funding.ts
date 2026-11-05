import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { hasRole, mutate } from "../auth/mutations";
import { AppFailure } from "../http/security";
import { canonicalJson } from "../protocol/canonical";
import { record } from "../protocol/quote-signature";
import { ReadOnlyRpc, unsigned } from "../protocol/rpc";
import {
  matchesV1Terms,
  readV1Snapshot,
  v1Deployment,
  type V1Snapshot,
} from "../protocol/v1-escrow";
import { v1PrizeFundingTransaction } from "../../../scripts/lib/native-engineering-transaction";
import {
  ownedV1Sponsor,
  readV1PublicationState,
  storedV1Publication,
  type V1PublicationRow,
} from "./v1-publication";

export async function prepareV1PrizeFunding(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  revision: number,
  transport: typeof fetch = fetch,
) {
  const state = await readV1PublicationState(
    pool,
    session,
    eventId,
    revision,
    config.encryptionKey,
  );
  if (state.state !== "awaiting_prize")
    throw new AppFailure(
      409,
      "Check publication status and wait for the event escrow before funding.",
    );
  const row = (
    await pool.query(
      `SELECT p.*,e.owner_id,e.data,e.revision FROM app_publication_images p
    JOIN app_events e ON e.id=p.event_id WHERE p.event_id=$1`,
      [eventId],
    )
  ).rows[0] as V1PublicationRow;
  const image = storedV1Publication(config.encryptionKey, row);
  const wallet = await ownedV1Sponsor(
    pool,
    config.encryptionKey,
    row.owner_id,
    image.sponsorWalletId ?? "",
  );
  if (wallet.address !== image.terms.sponsor) throw new Error("V1 frozen sponsor mismatch");
  const snapshot = await readV1Snapshot(eventId, transport);
  requirePrizeEvent(snapshot, row, image.terms);
  if (snapshot.event!.prize_received === true)
    throw new AppFailure(
      409,
      "The prize has arrived. Confirm prize funding to publish; do not pay again.",
    );
  const facts = await Promise.all(
    ["near-fastnear", "near-drpc"].map(async (id) => {
      const client = new ReadOnlyRpc(id, transport),
        signal = AbortSignal.timeout(20_000);
      async function query(account_id: string, request_type: string, extra: object = {}) {
        const value = record(
          await client.read(
            "query",
            { account_id, request_type, block_id: snapshot.block.hash, ...extra },
            signal,
          ),
        );
        if (
          value.block_hash !== snapshot.block.hash ||
          String(value.block_height) !== snapshot.block.height
        )
          throw new Error("Prize wallet query block mismatch");
        return value;
      }
      const [account, access, balance, protocol] = await Promise.all([
        query(wallet.address, "view_account"),
        query(wallet.address, "view_access_key", { public_key: wallet.publicKey }),
        query(v1Deployment.token, "call_function", {
          method_name: "ft_balance_of",
          args_base64: Buffer.from(canonicalJson({ account_id: wallet.address })).toString(
            "base64",
          ),
        }),
        client.read("EXPERIMENTAL_protocol_config", { block_id: snapshot.block.hash }, signal),
      ]);
      const bytes = balance.result;
      if (
        !Array.isArray(bytes) ||
        bytes.length > 128 ||
        bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
      )
        throw new Error("Prize balance encoding");
      const usdc: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (access.permission !== "FullAccess")
        throw new AppFailure(403, "Reverify a current full-access key for your funding wallet.");
      if (
        unsigned(account.amount, 128) < 160_000_000_000_000_000_000_000n ||
        unsigned(usdc, 128) < BigInt(image.terms.prize)
      )
        throw new AppFailure(
          422,
          "Your funding wallet needs the exact USDC prize and a separate NEAR gas reserve.",
        );
      if (
        record(protocol).chain_id !== "mainnet" ||
        record(protocol).protocol_version !== 87 ||
        unsigned(record(record(protocol).runtime_config).min_gas_purchase_price) > 1_000_000_000n
      )
        throw new Error("Prize gas purchase policy changed");
      return unsigned(access.nonce, 64).toString();
    }),
  );
  if (facts[0] !== facts[1]) throw new Error("Prize wallet sources disagree");
  const tx = v1PrizeFundingTransaction({
    signer: wallet.address,
    publicKey: wallet.publicKey,
    nonce: (BigInt(facts[0]) + 1n).toString(),
    blockHash: snapshot.block.hash,
    eventId,
    amount: image.terms.prize,
  });
  const callback = new URL("/host", config.origin);
  callback.searchParams.set("event", eventId);
  const url = new URL("https://app.mynearwallet.com/sign");
  url.searchParams.set("transactions", tx.bytes.toString("base64"));
  url.searchParams.set("callbackUrl", callback.href);
  return {
    eventId,
    signer: wallet.address,
    amountAtomic: image.terms.prize,
    token: v1Deployment.token,
    unsignedBase64: tx.bytes.toString("base64"),
    hash: tx.hash,
    walletUrl: url.href,
    maximumGasYoctoNear: "160000000000000000000000",
    attachedYoctoNear: "1",
  };
}

function requirePrizeEvent(
  snapshot: V1Snapshot,
  row: V1PublicationRow,
  terms: Parameters<typeof matchesV1Terms>[1],
) {
  if (
    !snapshot.event ||
    snapshot.event.status !== "draft" ||
    !matchesV1Terms(snapshot.event, terms) ||
    BigInt(terms.prize) <= 0n ||
    snapshot.block.timestampMs >= terms.start_ms ||
    Date.now() >= terms.start_ms ||
    !row.creation_source_height ||
    BigInt(snapshot.block.height) < BigInt(row.creation_source_height)
  )
    throw new AppFailure(
      409,
      "The live escrow does not yet match the frozen prize event. Check status again.",
    );
}

export async function confirmV1PrizeFunding(
  pool: pg.Pool,
  key: string,
  session: string,
  operationId: string,
  eventId: string,
  revision: number,
  read: typeof readV1Snapshot = readV1Snapshot,
) {
  const state = await readV1PublicationState(pool, session, eventId, revision, key);
  if (state.state !== "awaiting_prize") return { eventId, state: state.state };
  const source = await read(eventId);
  return mutate(
    pool,
    key,
    session,
    operationId,
    { eventId, revision },
    "event.v1-prize-confirmed",
    async (client, actor) => {
      hasRole(actor, "host");
      const event = (
        await client.query("SELECT * FROM app_events WHERE id=$1 AND owner_id=$2 FOR UPDATE", [
          eventId,
          actor.id,
        ])
      ).rows[0];
      if (!event || event.revision !== revision)
        throw new AppFailure(409, "Reload the owned saved event.");
      const row = (
        await client.query("SELECT * FROM app_publication_images WHERE event_id=$1 FOR UPDATE", [
          eventId,
        ])
      ).rows[0];
      if (row.transaction_state !== "awaiting_prize")
        return { eventId, state: row.transaction_state as string };
      const full = { ...event, ...row } as V1PublicationRow;
      const image = storedV1Publication(key, full);
      requirePrizeEvent(source, full, image.terms);
      if (source.event!.prize_received !== true)
        throw new AppFailure(
          409,
          "The exact USDC prize has not been confirmed yet. Wait and check again; do not pay twice.",
        );
      await client.query(
        `UPDATE app_publication_images SET execution_phase='publish',transaction_state='requested',
      transaction_hash=NULL,encrypted_transaction=NULL,gas_yocto_near=NULL WHERE event_id=$1`,
        [eventId],
      );
      return { eventId, state: "requested" };
    },
  );
}
