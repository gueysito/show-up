import { randomUUID } from "node:crypto";
import type pg from "pg";
import { transaction } from "../db/client";
import { AppFailure } from "../http/security";
import { issuers, type AuthConfig, type Provider } from "./config";
import { identityIndex, seal, unseal } from "./crypto";
import { newSession } from "./sessions";
import { telegramUserId, type ProviderIdentity } from "./provider-identity";

export async function establishIdentity(
  pool: pg.Pool,
  config: AuthConfig,
  provider: Provider,
  identity: ProviderIdentity,
  previousHash?: string,
  linkingHash?: string,
) {
  if (identity.issuer !== issuers[provider] || !identity.subject || identity.subject.length > 512)
    throw new AppFailure(401, "Provider identity could not be verified.");
  if (
    identity.telegramUserId !== undefined &&
    (provider !== "telegram" || telegramUserId(identity.telegramUserId) !== identity.telegramUserId)
  )
    throw new AppFailure(401, "Provider identity could not be verified.");
  const identityHash = identityIndex(config.indexKey, identity.issuer, identity.subject);
  return transaction(pool, async (client) => {
    // Serializes first-login/link races for this exact verified identity.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identityHash]);
    let linkAccount: string | undefined;
    if (linkingHash) {
      if (linkingHash !== previousHash)
        throw new AppFailure(401, "Restart linking from your account.");
      const linked = await client.query(
        `SELECT s.account_id FROM app_sessions s
        JOIN app_accounts a ON a.id=s.account_id WHERE s.token_hash=$1
        AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND a.state='active'
        FOR UPDATE OF s,a`,
        [linkingHash],
      );
      if (!linked.rowCount)
        throw new AppFailure(401, "Your linking session expired. Sign in again.");
      linkAccount = linked.rows[0].account_id as string;
    }
    const existing = await client.query(
      "SELECT account_id,encrypted_identity FROM app_identities WHERE identity_hash=$1",
      [identityHash],
    );
    let accountId = existing.rows[0]?.account_id as string | undefined;
    if (linkAccount && accountId && accountId !== linkAccount)
      throw new AppFailure(
        409,
        "That identity belongs to another account. Accounts were not merged.",
      );
    if (!accountId) {
      accountId = linkAccount ?? randomUUID();
      if (!linkAccount)
        await client.query("INSERT INTO app_accounts (id) VALUES ($1)", [accountId]);
      const alreadyLinked = await client.query(
        "SELECT 1 FROM app_identities WHERE account_id=$1 AND provider=$2",
        [accountId, provider],
      );
      if (alreadyLinked.rowCount)
        throw new AppFailure(409, "This provider is already linked to your account.");
      await client.query(
        `INSERT INTO app_identities (identity_hash, account_id, provider, encrypted_identity)
        VALUES ($1,$2,$3,$4)`,
        [
          identityHash,
          accountId,
          provider,
          seal(config.encryptionKey, `identity:${identityHash}`, identity),
        ],
      );
    }
    const active = await client.query("SELECT state FROM app_accounts WHERE id=$1 FOR UPDATE", [
      accountId,
    ]);
    // A known identity may restore restricted recovery access after deletion was
    // requested. Normal account/money/role guards still require state='active'.
    if (!["active", "deletion_requested"].includes(active.rows[0]?.state))
      throw new AppFailure(403, "Account access is unavailable.");
    if (existing.rowCount && identity.telegramUserId && active.rows[0].state === "active") {
      const original = unseal(
        config.encryptionKey,
        `identity:${identityHash}`,
        existing.rows[0].encrypted_identity,
      ) as ProviderIdentity;
      if (
        original.issuer !== identity.issuer ||
        original.subject !== identity.subject ||
        (original.telegramUserId !== undefined &&
          original.telegramUserId !== identity.telegramUserId)
      )
        throw new AppFailure(409, "Telegram profile changed. Account linking was preserved.");
      // Returning verified login may add a missing profile ID to a legacy record.
      // An absent profile claim never erases it; restricted recovery adds no data.
      if (!original.telegramUserId)
        await client.query(
          "UPDATE app_identities SET encrypted_identity=$2 WHERE identity_hash=$1",
          [identityHash, seal(config.encryptionKey, `identity:${identityHash}`, identity)],
        );
    }
    const value = await newSession(client, accountId, previousHash);
    await client.query("INSERT INTO app_audit (id,actor_id,action) VALUES ($1,$2,$3)", [
      randomUUID(),
      accountId,
      linkingHash ? "identity.linked" : "identity.login",
    ]);
    return { accountId, value, recoveryOnly: active.rows[0].state === "deletion_requested" };
  });
}
