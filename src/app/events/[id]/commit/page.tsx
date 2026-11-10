import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { CommitmentWalletReview } from "../../../../components/access/commitment-review";
import { V1Deposit } from "../../../../components/access/v1-deposit";
import { V1EventConsole } from "../../../../components/access/v1-event-console";
import { authConfig } from "../../../../server/auth/config";
import { findSession, sessionCookie } from "../../../../server/auth/sessions";
import { hash, identityIndex } from "../../../../server/auth/crypto";
import { createDatabase } from "../../../../server/db/client";
import { readEventEntry, type EventEntry } from "../../../../server/events/entry";
import { readV1PaidRefund } from "../../../../server/events/v1-actions";
import { AppFailure } from "../../../../server/http/security";
import { findPrivacySession } from "../../../../server/privacy/access";
import { listOwnWallets, type OwnWallet } from "../../../../server/wallets/service";
import { formatUsdc } from "../../../../domain/event-draft";

export const dynamic = "force-dynamic";
export default async function CommitmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const { id } = await params,
    config = authConfig();
  if (!config) notFound();
  const { pool } = createDatabase();
  let event: EventEntry | null = null,
    refund: Awaited<ReturnType<typeof readV1PaidRefund>> = null,
    wallets: OwnWallet[] = [],
    selectionScope: string | undefined;
  try {
    const value = (await cookies()).get(sessionCookie)?.value;
    if ((await searchParams).view !== "activity") {
      const viewer = await findPrivacySession(pool, value);
      if (viewer) refund = await readV1PaidRefund(pool, config, viewer.tokenHash, id);
    }
    if (!refund) {
      event = await readEventEntry(pool, config, id, value ? hash(value) : undefined);
      if (event.viewer === "attendee" && event.registration !== "closed") {
        const session = await findSession(pool, value);
        if (session) {
          wallets = await listOwnWallets(pool, config, session.accountId);
          // A private form namespace only, never an authentication/funding capability.
          selectionScope = identityIndex(
            config.indexKey,
            "showup.commitment-review.form.v1",
            JSON.stringify([session.accountId, id, event.rulesHash]),
          );
        }
      }
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
        {refund
          ? `Refund receipt for ${refund.title}`
          : event
            ? `Review commitment for ${event.data.title}`
            : "Commitment review unavailable"}
      </h1>
      {refund ? (
        <section id="refund" className="saved-panel" aria-label="Refund receipt">
          <p className="refund-status">{`${formatUsdc(refund.amount)} USDC refunded`}</p>
          <p>{`Paid to ${refund.payout} on NEAR.`}</p>
          <p>
            <a href={refund.transactionUrl} target="_blank" rel="noopener noreferrer">
              View refund transaction
            </a>
          </p>
          <Link href={`/events/${id}/commit?view=activity`} prefetch={false}>
            View other deposit activity
          </Link>
        </section>
      ) : !event ? (
        <p role="alert">Reload to try again. No financial action was taken.</p>
      ) : event.viewer === "anonymous" ? (
        <p>
          <Link href={`/events/${id}`} prefetch={false}>
            Sign in from the event page before selecting wallets
          </Link>
        </p>
      ) : event.viewer === "staff" ? (
        <p>Hosts and assigned validators cannot commit as attendees.</p>
      ) : event.escrow ? (
        <>
          {event.registration !== "closed" && event.viewer !== "recovery" && (
            <V1Deposit
              key={id}
              eventId={id}
              rulesHash={event.rulesHash}
              amount={event.data.commitment}
              wallets={wallets}
              nft={Boolean(event.escrow.nft)}
            />
          )}
          {(event.registration === "closed" || event.viewer === "recovery") && (
            <V1EventConsole eventId={id} active={event.viewer !== "recovery"} />
          )}
        </>
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
