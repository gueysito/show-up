import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { findSession, sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import { listOwnWallets, type OwnWallet } from "../../../server/wallets/service";
import { WalletManager } from "../../../components/access/wallet-manager";
import { isUuid } from "../../../server/events/drafts";

export const dynamic = "force-dynamic";
export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ challenge?: string; event?: string }>;
}) {
  const query = await searchParams;
  const returnEventId =
    typeof query.event === "string" && isUuid(query.event) ? query.event : undefined;
  const returnChallengeId =
    typeof query.challenge === "string" && isUuid(query.challenge) ? query.challenge : undefined;
  const config = authConfig();
  let signedIn = false,
    available = Boolean(config);
  let wallets: OwnWallet[] = [];
  if (config) {
    const { pool } = createDatabase();
    try {
      const session = await findSession(pool, (await cookies()).get(sessionCookie)?.value);
      signedIn = Boolean(session);
      if (session) wallets = await listOwnWallets(pool, config, session.accountId);
    } catch {
      available = false;
    } finally {
      await pool.end();
    }
  }
  return (
    <main>
      <Link href="/account">Back to your account</Link>
      <h1>Your wallets</h1>
      {returnEventId && (
        <p>
          <Link href={`/events/${returnEventId}/commit`} prefetch={false}>
            Return to this event&apos;s commitment review
          </Link>
        </p>
      )}
      <p>
        Prove wallet control separately from social sign-in. Your wallet will show a message to
        review and sign.
      </p>
      <p>
        Verification moves no money and creates no event registration. Event funding requires
        separate rules, destination and fee approval.
      </p>
      {!available ? (
        <p role="alert">Wallet verification is unavailable. Retry when the service is ready.</p>
      ) : !signedIn ? (
        <p>
          <Link href="/account">Sign in before verifying a wallet</Link>
        </p>
      ) : (
        <WalletManager
          initialWallets={wallets}
          returnChallengeId={returnChallengeId}
          returnEventId={returnEventId}
        />
      )}
    </main>
  );
}
