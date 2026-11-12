import {
  inspectInvitation,
  invitationCookie,
  pendingInvitation,
} from "../../server/invitations/pending";
import { AppHeader } from "../../components/app-header";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authConfig, providers } from "../../server/auth/config";
import { findSession, sessionCookie } from "../../server/auth/sessions";
import { createDatabase } from "../../server/db/client";
import { InvitationManager } from "../../components/access/invitation-manager";
import { findPrivacySession } from "../../server/privacy/access";
import { isUuid } from "../../server/events/drafts";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ auth?: string; walletEvent?: string }>;
}) {
  const query = await searchParams;
  const walletReturn = isUuid(query.walletEvent) ? `/events/${query.walletEvent}/commit` : null;
  const config = authConfig();
  let session = null;
  let savedInvitation: Awaited<ReturnType<typeof inspectInvitation>> | null = null;
  let recovery = false;
  let linked: string[] = [];
  let available = Boolean(config);
  if (config) {
    const { pool } = createDatabase();
    try {
      const jar = await cookies();
      session = await findSession(pool, jar.get(sessionCookie)?.value);
      const savedToken = pendingInvitation(config.encryptionKey, jar.get(invitationCookie)?.value);
      if (savedToken) savedInvitation = await inspectInvitation(pool, savedToken).catch(() => null);
      if (!session)
        recovery =
          (await findPrivacySession(pool, (await cookies()).get(sessionCookie)?.value))?.state ===
          "deletion_requested";
      if (session) {
        const result = await pool.query("SELECT provider FROM app_identities WHERE account_id=$1", [
          session.accountId,
        ]);
        linked = result.rows.map((row) => row.provider as string);
      }
    } catch {
      available = false;
    } finally {
      await pool.end();
    }
  }
  if (session && walletReturn) redirect(walletReturn);
  if (recovery)
    return (
      <>
        <AppHeader area={"account"} />
        <main>
          <h1>Restricted recovery access</h1>
          <p>
            Account deletion was requested. New linking, roles, wallets, events and commitments are
            disabled. Records needed to honor existing obligations remain available.
          </p>
          <p>
            <Link href="/account/privacy" prefetch={false}>
              Your data and deletion status
            </Link>
          </p>
          <p>
            <Link href="/account/commitments#event-receipts" prefetch={false}>
              View deposits and refunds
            </Link>
          </p>
          <p>
            <Link href="/account/commitments" prefetch={false}>
              Review your financial authorizations
            </Link>
          </p>
          <form method="post" action="/api/auth/logout">
            <button className="secondary-button">Log out</button>
          </form>
          <form method="post" action="/api/auth/logout?all=1">
            <button className="text-button">Log out all sessions</button>
          </form>
        </main>
      </>
    );
  return (
    <>
      <AppHeader area={"account"} />
      <main>
        <h1>{session ? "Your account" : "Sign in to Showup"}</h1>
        {query.auth === "failed" && (
          <p role="alert">
            Sign-in could not be completed. Start again. Your existing account was not merged or
            replaced.
          </p>
        )}
        {query.auth === "complete" && session && (
          <p role="status">Sign-in confirmed. Your session is restored on refresh.</p>
        )}
        {!available && (
          <p role="status">Live sign-in is unavailable until secure provider setup is complete.</p>
        )}
        {!session && <p>Sign in to host or join an event.</p>}
        {session ? (
          <section aria-label="Account access">
            <div className="account-areas">
              <section className="saved-panel">
                <h2>Attending</h2>
                <p>Find your funded events, check in, and see your refunds or payouts.</p>
                <Link className="primary-button" href="/account/commitments">
                  Deposits and refunds
                </Link>
                <p>
                  <Link href="/account/wallets">Your wallets</Link>
                </p>
              </section>
              <section className="saved-panel">
                <h2>Hosting</h2>
                {session.roles.includes("host") ? (
                  <>
                    <p>Create events, invite attendees, and manage check-in.</p>
                    <Link className="primary-button" href="/host">
                      Your events
                    </Link>
                    <p>
                      <Link href="/host#your-events">Attendee invitations for your events</Link>
                    </p>
                  </>
                ) : (
                  <>
                    <p>Want to host an event? Hosting currently requires an invitation.</p>
                    <Link href="/invite">Use a host invitation</Link>
                  </>
                )}
                {session.roles.includes("admin") && <InvitationManager canIssueHost />}
              </section>
            </div>
            <p>
              <Link href="/account/commitments#reviewed-terms">Review event terms</Link>
            </p>
            <h2>Sign-in and account settings</h2>
            <p>
              <Link href="/account/telegram">Optional Telegram messages</Link>
            </p>
            <p>{`Linked providers: ${linked.join(", ")}`}</p>
            <p>
              <Link href="/account/privacy" prefetch={false}>
                Your data and export
              </Link>
            </p>
            <p>
              <Link href="/account/attendance" prefetch={false}>
                Review your staff attendance assignments
              </Link>
            </p>
            <p>
              Linking verifies the second identity and keeps this account. Matching emails or
              usernames never merge accounts.
            </p>
            {providers
              .filter((provider) => !linked.includes(provider))
              .map((provider) => (
                <form key={provider} method="post" action={`/api/auth/start/${provider}?flow=link`}>
                  <button
                    className="secondary-button"
                    disabled={!available || !config?.clients[provider]}
                  >
                    {`Verify and link ${provider === "google" ? "Google" : "Telegram"}`}
                  </button>
                </form>
              ))}
            <form method="post" action="/api/auth/logout">
              <button className="secondary-button">Log out</button>
            </form>
            <form method="post" action="/api/auth/logout?all=1">
              <button className="text-button">Log out all sessions</button>
            </form>
          </section>
        ) : (
          <section aria-label="Sign in">
            {walletReturn && <p>Sign in with the same Showup account to return to your deposit.</p>}
            {providers.map((provider) => (
              <form
                key={provider}
                method="post"
                action={`/api/auth/start/${provider}${walletReturn ? `?returnTo=${encodeURIComponent(walletReturn)}` : ""}`}
              >
                <button
                  className="secondary-button"
                  disabled={!available || !config?.clients[provider]}
                >
                  {`Sign in with ${provider === "google" ? "Google" : "Telegram"}`}
                </button>
                {!config?.clients[provider] && (
                  <p>{`${provider === "google" ? "Google" : "Telegram"} is not configured.`}</p>
                )}
              </form>
            ))}
          </section>
        )}
        <details>
          <summary>Have an invitation?</summary>
          <p>Open the link you received, or continue reviewing an invitation you already opened.</p>
          {savedInvitation && (
            <Link href="/invite">
              {savedInvitation.kind === "host"
                ? "Review saved host invitation"
                : savedInvitation.kind === "validator"
                  ? "Review saved validator invitation"
                  : "Review saved attendee invitation"}
              {savedInvitation.eventTitle ? ` for ${savedInvitation.eventTitle}` : ""}
            </Link>
          )}
        </details>
      </main>
    </>
  );
}
