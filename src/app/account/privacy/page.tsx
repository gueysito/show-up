import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import { findPrivacySession } from "../../../server/privacy/access";
import { ownDeletionRequest, type DeletionReceipt } from "../../../server/privacy/deletion";
import { DeletionRequest } from "../../../components/access/deletion-request";
import {
  deletionCompletionCookie,
  readCompletedDeletion,
} from "../../../server/privacy/completion";

export const dynamic = "force-dynamic";
export default async function PrivacyPage() {
  const config = authConfig();
  let session = null,
    available = Boolean(config);
  let deletion: DeletionReceipt | null = null;
  const completion = config
    ? readCompletedDeletion(config, (await cookies()).get(deletionCompletionCookie)?.value)
    : null;
  if (config) {
    const { pool } = createDatabase();
    try {
      session = await findPrivacySession(pool, (await cookies()).get(sessionCookie)?.value);
      if (session) deletion = await ownDeletionRequest(pool, session.tokenHash);
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
      {completion && !session && (
        <p role="status">{`Deletion completed at ${completion.completedAt}. Reference: ${completion.id}. Off-chain identity was removed and all sessions were signed out. On-chain records cannot be erased.`}</p>
      )}
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
          {deletion ? (
            <section aria-label="Deletion request status">
              <h2>Deletion requested</h2>
              <p>
                New account activity is disabled. Unneeded records were removed; original financial
                or published-event records and restricted access remain until obligations are safely
                reconciled. This does not erase debt or confirm a payment.
              </p>
              <p>{`Requested at ${deletion.requestedAt}. Reference: ${deletion.id}.`}</p>
              <p>
                Use the same linked provider to restore this restricted access after logout. New
                linking, roles, wallets, events and commitments are disabled.
              </p>
            </section>
          ) : (
            <DeletionRequest />
          )}
          <p>
            <Link href="/account/commitments" prefetch={false}>
              Review your financial authorizations
            </Link>
          </p>
          {session.state === "deletion_requested" && (
            <form method="post" action="/api/auth/logout">
              <button className="secondary-button">Log out</button>
            </form>
          )}
        </section>
      )}
    </main>
  );
}
