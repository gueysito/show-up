import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { authConfig, providers } from "../../../server/auth/config";
import { sessionCookie } from "../../../server/auth/sessions";
import { hash } from "../../../server/auth/crypto";
import { createDatabase } from "../../../server/db/client";
import { AppFailure } from "../../../server/http/security";
import { readEventEntry, type EventEntry } from "../../../server/events/entry";
import { telegramBotConfig } from "../../../server/telegram/config";
import { telegramEventDeepLink } from "../../../server/telegram/connection";
import { EventTime } from "../../../components/access/event-time";

export const dynamic = "force-dynamic";
export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    config = authConfig();
  if (!config) notFound();
  let bot = null;
  try {
    bot = telegramBotConfig();
  } catch {
    /* Optional bot setup never blocks event access. */
  }
  const { pool } = createDatabase();
  let event: EventEntry | null = null;
  try {
    const value = (await cookies()).get(sessionCookie)?.value;
    event = await readEventEntry(pool, config, id, value ? hash(value) : undefined);
  } catch (error) {
    if (error instanceof AppFailure && error.status === 404) notFound();
  } finally {
    await pool.end();
  }
  if (!event)
    return (
      <main>
        <h1>Event temporarily unavailable</h1>
        <p>Reload to review the saved event. Deposits remain closed.</p>
      </main>
    );
  return (
    <main>
      <Link href="/account" prefetch={false}>
        Your account
      </Link>
      <h1>{event.data.title}</h1>
      <p>{event.hostAlias}</p>
      {bot && (
        <p>
          <a
            href={telegramEventDeepLink(bot.username, event.id)}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            Open this event in the optional Telegram bot
          </a>
        </p>
      )}
      <p>{event.data.description}</p>
      {event.escrow && (
        <section className="saved-panel" aria-label="Verified mainnet event">
          <h2>Verified on NEAR mainnet</h2>
          <p>{`The escrow confirms these terms at finalized block ${event.escrow.height}.`}</p>
          <p>
            <a href={event.escrow.transactionUrl} target="_blank" rel="noopener noreferrer">
              View publication transaction
            </a>
          </p>
          <p>{`Escrow: ${event.escrow.account}`}</p>
        </section>
      )}
      <dl>
        <dt>Mode</dt>
        <dd>{event.data.mode === "digital" ? "Online" : "In person"}</dd>
        <dt>Starts</dt>
        <dd>
          <EventTime instant={event.data.startsAt} timeZone={event.data.timeZone} />
        </dd>
        <dt>Ends</dt>
        <dd>
          <EventTime instant={event.data.endsAt} timeZone={event.data.timeZone} />
        </dd>
        <dt>Event timezone</dt>
        <dd>{event.data.timeZone}</dd>
        <dt>Maximum attendance</dt>
        <dd>
          {event.escrow
            ? event.data.capacity
            : `${event.data.capacity}. Funded capacity has not been verified here.`}
        </dd>
        <dt>Commitment</dt>
        <dd>{`${event.data.commitment} USDC`}</dd>
        <dt>Sponsor budget</dt>
        <dd>{`${event.data.sponsorBudget} USDC`}</dd>
        <dt>Reward rules</dt>
        <dd>
          {event.escrow
            ? `No-show deposits split equally among checked-in attendees.${Number(event.data.sponsorBudget) > 0 ? " One checked-in attendee also receives the funded USDC prize." : ""}`
            : event.data.rewardPreset === "equal"
              ? "Equal split"
              : event.data.rewardPreset === "draw"
                ? "Draw"
                : "Equal split and draw"}
        </dd>
        <dt>Optional quizzes</dt>
        <dd>{`${event.quizCount}. Missing a quiz never prevents principal return.`}</dd>
      </dl>
      {event.data.mode === "physical" && <p>{`Venue: ${event.data.venue}`}</p>}
      {event.data.sessionReference && (
        <p>
          <a
            href={event.data.sessionReference}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            Open the host&apos;s session
          </a>
        </p>
      )}
      {event.nft && (
        <section aria-label="Published NFT prize">
          <h2>Published NFT prize</h2>
          <p>{`${event.nft.network}: ${event.nft.collection} · ${event.nft.assetId}`}</p>
          <p>Custody and delivery are not confirmed here.</p>
        </section>
      )}
      <section aria-label="Event participation" className="saved-panel">
        <h2>{event.registration === "closed" ? "Registration closed" : "Review participation"}</h2>
        <p role="status">
          {event.escrow && event.registration !== "closed"
            ? "USDC deposits on NEAR are open. Review your wallet, deposit and gas before approving payment."
            : event.registration === "closed"
              ? "Deposits are closed. Existing authorizations and recovery remain available."
              : "Deposits are closed while attributable escrow, authorized returns and route qualification remain unverified. No seat is reserved by this page."}
        </p>
        {event.escrow && event.viewer === "attendee" && event.registration !== "closed" ? (
          <Link className="primary-button" href={`/events/${id}/commit`} prefetch={false}>
            Deposit USDC on NEAR
          </Link>
        ) : (
          <button type="button" className="primary-button" disabled>
            Deposits closed
          </button>
        )}
        {event.viewer === "anonymous" ? (
          <>
            <p>
              Sign in to the account you want to use. Telegram messages and PWA installation are
              optional.
            </p>
            {providers.map((provider) => (
              <form
                key={provider}
                method="post"
                action={`/api/auth/start/${provider}?returnTo=${encodeURIComponent(`/events/${id}`)}`}
              >
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={!config.clients[provider]}
                >
                  {`Sign in with ${provider === "google" ? "Google" : "Telegram"} and return to this event`}
                </button>
              </form>
            ))}
          </>
        ) : event.viewer === "staff" ? (
          <p>
            Hosts and assigned validators cannot join as eligible attendees. Your staff controls
            remain in your account.
          </p>
        ) : (
          <>
            {event.viewer === "recovery" ? (
              <p>Your account has restricted recovery access; new commitments remain disabled.</p>
            ) : (
              <p>
                {event.registration !== "closed" && (
                  <>
                    <Link href={`/events/${id}/commit`} prefetch={false}>
                      Review wallets and commitment destinations
                    </Link>
                    <br />
                  </>
                )}
                <Link href="/account/wallets" prefetch={false}>
                  Verify and review wallets before financial approval
                </Link>
              </p>
            )}
            <p>
              <Link href={`/account/commitments?event=${id}`} prefetch={false}>
                Review this event&apos;s authorizations and recovery
              </Link>
            </p>
          </>
        )}
      </section>
      <details>
        <summary>Published rules reference</summary>
        <p style={{ overflowWrap: "anywhere" }}>{event.rulesHash}</p>
      </details>
    </main>
  );
}
