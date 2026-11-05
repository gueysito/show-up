import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { seal, unseal } from "../auth/crypto";
import { transaction } from "../db/client";
import { AppFailure } from "../http/security";
import { canonicalHash } from "../protocol/canonical";
import {
  requestV1Route,
  validateV1Route,
  v1RouteRequest,
  v1RouteStatus,
  type V1Route,
} from "../protocol/v1-routing";
import {
  ownedV1Registration,
  requireV1UnfundedRegistration,
  type V1RegistrationImage,
} from "./v1-registration";
import type { OwnWallet } from "../wallets/service";
import { prepareV1EvmPayment } from "../protocol/v1-evm-payment";
import { prepareV1SolanaPayment } from "../protocol/v1-solana-payment";
import { mutate } from "../auth/mutations";
import { decodeBase58 } from "../protocol/encoding";
import { requireV1PayoutStorage } from "../protocol/v1-payout-storage";
import { readV1RouteAccount } from "../protocol/v1-intents";

// An owned transaction hint prevents repeat prompts. It never establishes a
// funded seat; only the contract registration observation can do that.
export async function recordV1SourceTransaction(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  operationId: string,
  eventId: string,
  sourceHash: string,
) {
  const saved = await ownedV1Route(pool, config, session, eventId);
  if (!saved) throw new AppFailure(404, "Your original routing quote is unavailable.");
  if (saved.route.network === "solana") decodeBase58(sourceHash, 64);
  else if (!/^0x[0-9a-f]{64}$/.test(sourceHash))
    throw new AppFailure(400, "Use the original source transaction hash.");
  return mutate(
    pool,
    config.encryptionKey,
    session,
    operationId,
    { eventId, sourceHash },
    "event.v1-source-recorded",
    async (client, actor) => {
      if (actor.id !== saved.image.accountId)
        throw new AppFailure(404, "Your routing quote is unavailable.");
      const row = (
        await client.query(
          "SELECT source_transaction_hash FROM app_v1_route_quotes WHERE registration_id=$1 FOR UPDATE",
          [saved.image.id],
        )
      ).rows[0];
      if (row.source_transaction_hash && row.source_transaction_hash !== sourceHash)
        throw new AppFailure(
          409,
          "A different original source hash is retained. Reconcile it first.",
        );
      await client.query(
        "UPDATE app_v1_route_quotes SET source_transaction_hash=$2 WHERE registration_id=$1",
        [saved.image.id, sourceHash],
      );
      return { eventId, sourceHash, state: "routing" };
    },
  );
}

function storedRoute(
  config: AuthConfig,
  row: { encrypted_quote: string; quote_hash: string },
  image: V1RegistrationImage,
) {
  const route = unseal(
    config.encryptionKey,
    `v1-route:${image.id}`,
    row.encrypted_quote,
  ) as V1Route;
  if (
    !image.source ||
    canonicalHash(route) !== row.quote_hash ||
    route.network !== image.source.network ||
    route.request.customRecipientMsg !== `deposit:${image.id}` ||
    route.request.refundTo !== image.source.address ||
    route.request.amount !== image.amount
  )
    throw new Error("Frozen routing quote integrity");
  return validateV1Route(route.network, route.request, route.response, Date.now(), true);
}
function summary(route: V1Route) {
  return {
    network: route.network,
    inputAtomic: route.input,
    principalAtomic: route.principal,
    routingCostAtomic: (BigInt(route.input) > BigInt(route.principal)
      ? BigInt(route.input) - BigInt(route.principal)
      : 0n
    ).toString(),
    expiresAt: route.expiresAt,
    providerDeadline: String((route.response.quote as Record<string, unknown>).deadline),
    depositAddress: route.depositAddress,
  };
}
async function currentSource(pool: pg.Pool, config: AuthConfig, image: V1RegistrationImage) {
  const source = image.source;
  if (!source) throw new AppFailure(422, "This registration uses a direct NEAR deposit.");
  const row = (
    await pool.query(
      "SELECT encrypted_wallet FROM app_wallets WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL",
      [source.walletId, image.accountId],
    )
  ).rows[0];
  if (!row) throw new AppFailure(403, "Your original source wallet is no longer verified.");
  const wallet = unseal(
    config.encryptionKey,
    `wallet:${image.accountId}:${source.walletId}`,
    row.encrypted_wallet,
  ) as OwnWallet;
  if (wallet.network !== source.network || wallet.address !== source.address)
    throw new Error("Frozen route source differs");
  return source;
}
export async function prepareV1Route(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const { image, snapshot } = await requireV1UnfundedRegistration(
    pool,
    config,
    session,
    eventId,
    transport,
  );
  const account = await readV1RouteAccount(image.id, snapshot, transport);
  if (!account || BigInt(account.liquid) < 12000000000000000000000n)
    throw new AppFailure(
      409,
      "Your registration's receiving account is still preparing. Check status before requesting a source payment.",
    );
  const source = await currentSource(pool, config, image);
  const previous = (
    await pool.query("SELECT * FROM app_v1_route_quotes WHERE registration_id=$1", [image.id])
  ).rows[0];
  if (previous) {
    const route = storedRoute(config, previous, image);
    if (Date.parse(route.expiresAt) <= Date.now() + 30000)
      throw new AppFailure(
        409,
        "The original quote expired. Reconcile its source payment before preparing another route.",
      );
    return summary(route);
  }
  const route = await requestV1Route(
    source.network,
    v1RouteRequest(source.network, source.address, image.id, image.amount),
    transport,
  );
  return transaction(pool, async (client) => {
    await client.query("SELECT id FROM app_v1_registrations WHERE id=$1 FOR UPDATE", [image.id]);
    const existing = (
      await client.query("SELECT * FROM app_v1_route_quotes WHERE registration_id=$1", [image.id])
    ).rows[0];
    if (existing) return summary(storedRoute(config, existing, image));
    await client.query(
      "INSERT INTO app_v1_route_quotes(registration_id,quote_hash,encrypted_quote,expires_at) VALUES($1,$2,$3,$4)",
      [
        image.id,
        canonicalHash(route),
        seal(config.encryptionKey, `v1-route:${image.id}`, route),
        route.expiresAt,
      ],
    );
    return summary(route);
  });
}
export async function ownedV1Route(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  recovery = false,
) {
  const saved = await ownedV1Registration(pool, config.encryptionKey, session, eventId, recovery);
  if (!saved) throw new AppFailure(404, "Your event registration is unavailable.");
  const row = (
    await pool.query("SELECT * FROM app_v1_route_quotes WHERE registration_id=$1", [saved.image.id])
  ).rows[0];
  return row
    ? {
        ...saved,
        route: storedRoute(config, row, saved.image),
        sourceHash: row.source_transaction_hash as string | null,
        paymentHash: row.payment_hash as string | null,
        encryptedPayment: row.encrypted_payment as string | null,
      }
    : null;
}
export async function readV1RouteState(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const saved = await ownedV1Route(pool, config, session, eventId, true);
  if (!saved) return null;
  let hint = "UNAVAILABLE";
  try {
    hint = await v1RouteStatus(saved.route, transport);
  } catch {
    /* Provider hints never override the contract's funded flag. */
  }
  return { ...summary(saved.route), hint, sourceHash: saved.sourceHash };
}
export async function requireV1RoutePayment(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const current = await requireV1UnfundedRegistration(pool, config, session, eventId, transport);
  await requireV1PayoutStorage(current.image.payout, current.snapshot, transport);
  await currentSource(pool, config, current.image);
  const saved = await ownedV1Route(pool, config, session, eventId);
  if (!saved) throw new AppFailure(409, "Review a signed route quote first.");
  if (saved.route.request.recipientType === "INTENTS") {
    const account = await readV1RouteAccount(current.image.id, current.snapshot, transport);
    if (!account || BigInt(account.liquid) < 12000000000000000000000n)
      throw new AppFailure(
        409,
        "The original receiving account's gas reserve is unavailable. No source payment was requested.",
      );
  }
  if (saved.sourceHash)
    throw new AppFailure(
      409,
      "Your original source transaction is retained. Check routing; do not pay again.",
    );
  if (Date.parse(saved.route.expiresAt) <= Date.now() + 30000)
    throw new AppFailure(
      409,
      "The route quote expired. Check the original payment before retrying.",
    );
  return saved;
}
export async function prepareV1RoutePayment(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  eventId: string,
  transport?: typeof fetch,
) {
  const saved = await requireV1RoutePayment(pool, config, session, eventId, transport);
  type Payment =
    | Awaited<ReturnType<typeof prepareV1EvmPayment>>
    | Awaited<ReturnType<typeof prepareV1SolanaPayment>>;
  const context = `v1-route-payment:${saved.image.id}`;
  function original(row: {
    payment_hash: string | null;
    encrypted_payment: string | null;
  }): Payment | null {
    if (!row.payment_hash && !row.encrypted_payment) return null;
    if (!row.payment_hash || !row.encrypted_payment)
      throw new Error("Original source payment pair mismatch");
    const payment = unseal(config.encryptionKey, context, row.encrypted_payment) as Payment;
    if (
      canonicalHash(payment) !== row.payment_hash ||
      payment.network !== saved!.route.network ||
      payment.inputAtomic !== saved!.route.input
    )
      throw new Error("Original source payment integrity");
    if (Date.parse(payment.expiresAt) <= Date.now() + 5000)
      throw new AppFailure(
        409,
        "The original source payment expired. Check its wallet activity and routing status before any replacement.",
      );
    return payment;
  }
  const stored = original({
    payment_hash: saved.paymentHash,
    encrypted_payment: saved.encryptedPayment,
  });
  if (stored) return stored;
  const payment =
    saved.route.network === "solana"
      ? await prepareV1SolanaPayment(saved.route, saved.image.source!.address, transport)
      : await prepareV1EvmPayment(saved.route, saved.image.source!.address, transport);
  return transaction(pool, async (client) => {
    const row = (
      await client.query(
        "SELECT payment_hash,encrypted_payment,source_transaction_hash FROM app_v1_route_quotes WHERE registration_id=$1 FOR UPDATE",
        [saved.image.id],
      )
    ).rows[0];
    if (row.source_transaction_hash)
      throw new AppFailure(
        409,
        "The original source payment is already recorded. Do not pay again.",
      );
    const existing = original(row);
    if (existing) return existing;
    await client.query(
      "UPDATE app_v1_route_quotes SET payment_hash=$2,encrypted_payment=$3 WHERE registration_id=$1",
      [saved.image.id, canonicalHash(payment), seal(config.encryptionKey, context, payment)],
    );
    return payment;
  });
}
