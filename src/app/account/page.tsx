import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig, providers } from "../../server/auth/config";
import { findSession, sessionCookie } from "../../server/auth/sessions";
import { createDatabase } from "../../server/db/client";
import { InvitationManager } from "../../components/access/invitation-manager";
import { findPrivacySession } from "../../server/privacy/access";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ auth?: string }>;
}) {
  const query = await searchParams;
  const config = authConfig();
  let session = null;
  let recovery = false;
  let linked: string[] = [];
  let available = Boolean(config);
  if (config) {
    const { pool } = createDatabase();
    try {
      session = await findSession(pool, (await cookies()).get(sessionCookie)?.value);
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
  if (recovery)
    return (
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
    );
  return (
    <main>
      <Link href="/" className="brand">
        showup.
      </Link>
      <h1>Your account</h1>
      {session && (
        <p>
          <Link href="/account/telegram" prefetch={false}>
            Optional Telegram messages
          </Link>
        </p>
      )}
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
      <p>Social sign-in does not prove wallet control, fund a seat or enable publication.</p>
      {session ? (
        <section aria-label="Account access">
          <p>{`Account reference: ${session.accountId}`}</p>
          <p>{`Access: ${session.roles.join(", ") || "attendee"}`}</p>
          <p>{`Linked providers: ${linked.join(", ")}`}</p>
          <p>
            <Link href="/account/wallets">Verify and review your wallets</Link>
          </p>
          <p>
            <Link href="/account/commitments" prefetch={false}>
              Review your financial authorizations
            </Link>
          </p>
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
          {providers.map((provider) => (
            <form key={provider} method="post" action={`/api/auth/start/${provider}`}>
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
      <p>Telegram sign-in requires no email. Optional bot messages need separate consent.</p>
      <p>
        The anonymous development workspace remains separate. Its drafts are never imported into
        accounts.
      </p>
      <p>
        <Link href="/invite">Return to a saved invitation</Link>
      </p>
      <p>
        <Link href="/host">Host workspace</Link>
      </p>
      {session?.roles.includes("admin") && <InvitationManager canIssueHost />}
    </main>
  );
}
