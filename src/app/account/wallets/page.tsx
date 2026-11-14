import { AppHeader } from "../../../components/app-header";
import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { findSession, sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import { listOwnWallets, type OwnWallet } from "../../../server/wallets/service";
import { WalletManager } from "../../../components/access/wallet-manager";
import { isUuid } from "../../../server/events/drafts";
import { walletNetworks } from "../../../server/wallets/proof";

export const dynamic = "force-dynamic";
export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ challenge?: string; event?: string; network?: string; app?: string }>;
}) {
  const query = await searchParams;
  const returnEventId =
    typeof query.event === "string" && isUuid(query.event) ? query.event : undefined;
  const returnChallengeId =
    typeof query.challenge === "string" && isUuid(query.challenge) ? query.challenge : undefined;
  const initialNetwork = walletNetworks.find((network) => network === query.network);
  const openedWallet =
    initialNetwork === "solana" && query.app === "phantom"
      ? "phantom"
      : (initialNetwork === "base" || initialNetwork === "ethereum") && query.app === "rabby"
        ? query.app
        : undefined;
  const config = authConfig();
  const projectId = process.env.SHOWUP_WALLETCONNECT_PROJECT_ID;
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
    <>
      <AppHeader area={"account"} />
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
        <p>Verify a wallet with a message signature. Event payments require separate approval.</p>
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
            initialNetwork={initialNetwork}
            openedWallet={openedWallet}
            walletConnectProjectId={
              projectId && /^[0-9a-f]{32}$/i.test(projectId) ? projectId : undefined
            }
          />
        )}
      </main>
    </>
  );
}
