import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { CommitmentWalletReview } from "../../../../components/access/commitment-review";
import { authConfig } from "../../../../server/auth/config";
import { findSession, sessionCookie } from "../../../../server/auth/sessions";
import { hash, identityIndex } from "../../../../server/auth/crypto";
import { createDatabase } from "../../../../server/db/client";
import { readEventEntry, type EventEntry } from "../../../../server/events/entry";
import { AppFailure } from "../../../../server/http/security";
import { listOwnWallets, type OwnWallet } from "../../../../server/wallets/service";

export const dynamic = "force-dynamic";
export default async function CommitmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    config = authConfig();
  if (!config) notFound();
  const { pool } = createDatabase();
  let event: EventEntry | null = null,
    wallets: OwnWallet[] = [],
    selectionScope: string | undefined;
  try {
    const value = (await cookies()).get(sessionCookie)?.value;
    event = await readEventEntry(pool, config, id, value ? hash(value) : undefined);
    const session = await findSession(pool, value);
    if (session && event.viewer === "attendee" && event.registration !== "closed") {
      wallets = await listOwnWallets(pool, config, session.accountId);
      // A private form namespace only, never an authentication/funding capability.
      selectionScope = identityIndex(
        config.indexKey,
        "showup.commitment-review.form.v1",
        JSON.stringify([session.accountId, id, event.rulesHash]),
      );
    }
  } catch (failure) {
    if (failure instanceof AppFailure && failure.status === 404) notFound();
    event = null;
  } finally {
    await pool.end();
  }
  return (
    <main>
      <Link href={`/events/${id}`} prefetch={false}>
        Back to event
      </Link>
      <h1>
        {event ? `Review commitment for ${event.data.title}` : "Commitment review unavailable"}
      </h1>
      {!event ? (
        <p role="alert">Reload to try again. No financial action was taken.</p>
      ) : event.viewer === "anonymous" ? (
        <p>
          <Link href={`/events/${id}`} prefetch={false}>
            Sign in from the event page before selecting wallets
          </Link>
        </p>
      ) : event.viewer === "staff" ? (
        <p>Hosts and assigned validators cannot commit as attendees.</p>
      ) : event.viewer === "recovery" || event.registration === "closed" ? (
        <>
          <p>New commitments are closed. Original authorizations and recovery remain available.</p>
          <Link href={`/account/commitments?event=${id}`} prefetch={false}>
            Review existing authorizations and recovery
          </Link>
        </>
      ) : (
        <>
          <p>{`${event.data.commitment} USDC principal · ${event.data.mode === "digital" ? "Online" : "In person"} · registration closes at the event start.`}</p>
          <p>
            Review wallet destinations first. A separately verified quote must disclose amounts,
            fees and expiry before financial approval. Deposits are currently closed.
          </p>
          <CommitmentWalletReview
            key={selectionScope}
            eventId={id}
            rulesHash={event.rulesHash}
            wallets={wallets}
            selectionScope={selectionScope}
          />
        </>
      )}
    </main>
  );
}
