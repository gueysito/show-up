import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { identityIndex, seal, unseal } from "../auth/crypto";
import { mutate } from "../auth/mutations";
import { isUuid } from "../events/drafts";
import { AppFailure, limit } from "../http/security";
import { NearFullAccessRequired, requireNearFullAccess } from "./near-access";
import {
  createWalletChallenge,
  verifyWalletSignature,
  walletNetworks,
  type WalletChallenge,
  type WalletSignature,
} from "./proof";

export type OwnWallet = {
  id: string;
  network: WalletChallenge["network"];
  address: string;
  verifiedAt: string;
};

async function rate(pool: pg.Pool, session: string, operation: string, maximum: number) {
  const result = await pool.query(
    `SELECT s.account_id FROM app_sessions s JOIN app_accounts a ON a.id=s.account_id
    WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.state='active'`,
    [session],
  );
  if (!result.rowCount) throw new AppFailure(401, "Sign in again to verify a wallet.");
  await limit(pool, `wallet:${operation}:${result.rows[0].account_id}`, maximum);
  await limit(pool, "wallet:global", 120);
}

export async function issueWalletChallenge(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: { operationId: string; network: string; address: string; returnEventId?: string },
) {
  if (!walletNetworks.some((network) => network === input.network))
    throw new AppFailure(400, "Choose NEAR, Base, Ethereum or Solana.");
  await rate(pool, session, "challenge", 6);
  return mutate(
    pool,
    config.encryptionKey,
    session,
    input.operationId,
    input,
    "wallet.challenge",
    async (client, actor) => {
      const time = (await client.query("SELECT clock_timestamp() AS current_time")).rows[0]
        .current_time as Date;
      let challenge: WalletChallenge;
      try {
        challenge = createWalletChallenge(
          config.origin,
          input.network as WalletChallenge["network"],
          input.address,
          time.getTime(),
          input.returnEventId,
        );
      } catch {
        throw new AppFailure(400, "Enter a valid address for the selected wallet network.");
      }
      await client.query(
        `INSERT INTO app_wallet_challenges (id,account_id,session_hash,encrypted_challenge,expires_at)
      VALUES ($1,$2,$3,$4,$5)`,
        [
          challenge.id,
          actor.id,
          session,
          seal(config.encryptionKey, `wallet-challenge:${actor.id}:${challenge.id}`, challenge),
          new Date(challenge.expiresAt),
        ],
      );
      return challenge;
    },
  );
}

export async function acceptWalletProof(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  input: { operationId: string; challengeId: string; proof: WalletSignature },
  transport: typeof fetch = fetch,
) {
  if (!isUuid(input.challengeId)) throw new AppFailure(400, "Start a new wallet verification.");
  await rate(pool, session, "proof", 12);
  return mutate(
    pool,
    config.encryptionKey,
    session,
    input.operationId,
    input,
    "wallet.verified",
    async (client, actor) => {
      const result = await client.query(
        `SELECT *,clock_timestamp() AS current_time FROM app_wallet_challenges
      WHERE id=$1 AND account_id=$2 AND session_hash=$3 FOR UPDATE`,
        [input.challengeId, actor.id, session],
      );
      const row = result.rows[0];
      if (!row) throw new AppFailure(404, "Private wallet verification unavailable.");
      if (row.consumed_at || row.expires_at <= row.current_time)
        throw new AppFailure(
          409,
          "This wallet challenge was used or expired. Start a new verification.",
        );
      const challenge = unseal(
        config.encryptionKey,
        `wallet-challenge:${actor.id}:${row.id}`,
        row.encrypted_challenge,
      ) as WalletChallenge;
      if (!verifyWalletSignature(challenge, input.proof, config.origin, row.current_time.getTime()))
        throw new AppFailure(
          400,
          "The signature does not match this wallet challenge. Start again in your wallet.",
        );
      let access: Awaited<ReturnType<typeof requireNearFullAccess>> | undefined;
      if (challenge.network === "near") {
        try {
          access = await requireNearFullAccess(challenge, input.proof, transport);
        } catch (error) {
          if (error instanceof NearFullAccessRequired)
            throw new AppFailure(
              403,
              "Choose a current full-access key for this NEAR account. A function-call key cannot prove wallet control.",
            );
          throw new AppFailure(
            503,
            "NEAR full-access control could not be confirmed from both sources. Wait and retry.",
          );
        }
      }
      const consumed = await client.query(
        `UPDATE app_wallet_challenges c SET consumed_at=clock_timestamp() WHERE c.id=$1
      AND c.consumed_at IS NULL AND c.expires_at>clock_timestamp()
      AND EXISTS (SELECT 1 FROM app_sessions s WHERE s.token_hash=c.session_hash
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) RETURNING consumed_at`,
        [challenge.id],
      );
      if (!consumed.rowCount)
        throw new AppFailure(
          409,
          "Verification expired. Sign in and start a fresh wallet challenge.",
        );
      const index = identityIndex(
        config.indexKey,
        `showup.wallet.v1:${challenge.network}`,
        challenge.address,
      );
      const previous = await client.query(
        "SELECT id FROM app_wallets WHERE account_id=$1 AND wallet_index=$2 FOR UPDATE",
        [actor.id, index],
      );
      const id = previous.rows[0]?.id ?? randomUUID();
      const verifiedAt = (consumed.rows[0].consumed_at as Date).toISOString();
      const wallet: OwnWallet = {
        id,
        network: challenge.network,
        address: challenge.address,
        verifiedAt,
      };
      const encrypted = seal(config.encryptionKey, `wallet:${actor.id}:${id}`, {
        ...wallet,
        challenge,
        proof: input.proof,
        access,
      });
      await client.query(
        `INSERT INTO app_wallets (id,account_id,wallet_index,network,encrypted_wallet,verified_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id,wallet_index) DO UPDATE
      SET encrypted_wallet=EXCLUDED.encrypted_wallet,verified_at=EXCLUDED.verified_at,revoked_at=NULL`,
        [id, actor.id, index, wallet.network, encrypted, verifiedAt],
      );
      return wallet;
    },
  );
}

export async function listOwnWallets(
  pool: pg.Pool,
  config: AuthConfig,
  accountId: string,
): Promise<OwnWallet[]> {
  const rows = (
    await pool.query(
      "SELECT id,encrypted_wallet FROM app_wallets WHERE account_id=$1 AND revoked_at IS NULL ORDER BY verified_at DESC LIMIT 50",
      [accountId],
    )
  ).rows;
  return rows.map((row) => {
    const value = unseal(
      config.encryptionKey,
      `wallet:${accountId}:${row.id}`,
      row.encrypted_wallet,
    ) as OwnWallet;
    return {
      id: row.id,
      network: value.network,
      address: value.address,
      verifiedAt: value.verifiedAt,
    };
  });
}
