import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AuthConfig } from "../../src/server/auth/config";
import { nearMessageDigest } from "../../src/server/wallets/proof";
import { issueWalletChallenge, acceptWalletProof } from "../../src/server/wallets/service";

// Uses the actual control-proof service. Signing stays in the Node test process.
export async function verifyNearWallet(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  wallet: { address: string; publicKey: string; sign: (digest: Buffer) => Buffer },
  transport: typeof fetch = fetch,
) {
  const challenge = await issueWalletChallenge(pool, config, session, {
    operationId: randomUUID(),
    network: "near",
    address: wallet.address,
  });
  return acceptWalletProof(
    pool,
    config,
    session,
    {
      operationId: randomUUID(),
      challengeId: challenge.id,
      proof: {
        accountId: wallet.address,
        publicKey: wallet.publicKey,
        signature: wallet.sign(nearMessageDigest(challenge)).toString("base64"),
      },
    },
    transport,
  );
}
