import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import { findPrivacySession } from "../../../server/privacy/access";

export const dynamic = "force-dynamic";
export default async function PrivacyPage() {
  const config = authConfig();
  let session = null,
    available = Boolean(config);
  if (config) {
    const { pool } = createDatabase();
    try {
      session = await findPrivacySession(pool, (await cookies()).get(sessionCookie)?.value);
    } catch {
      available = false;
    } finally {
      await pool.end();
    }
  }
  return (
    <main>
      <Link href="/account" prefetch={false}>
        Back to your account
      </Link>
      <h1>Your data</h1>
      {!available ? (
        <p role="alert">Private data access is temporarily unavailable. Reload to try again.</p>
      ) : !session ? (
        <p>
          <Link href="/account" prefetch={false}>
            Sign in to access your data
          </Link>
        </p>
      ) : (
        <section aria-label="Private account export">
          <h2>Download your account data</h2>
          <p>
            Your JSON export includes your linked identities, wallet addresses, financial approvals,
            hosted event rules and answers, invitations, access grants and account audit records. It
            contains only your own data.
          </p>
          <p>
            The file is private. Session tokens, invitation capabilities, OAuth credentials and
            ephemeral challenges are excluded.
          </p>
          <p>
            <a href="/api/account/export" download>
              Download your data as JSON
            </a>
          </p>
          <p>
            On-chain records cannot be erased. Any future deletion must preserve the records and
            access needed to reconcile outstanding payments.
          </p>
          <p>
            <Link href="/account/commitments" prefetch={false}>
              Review your financial authorizations
            </Link>
          </p>
        </section>
      )}
    </main>
  );
}
