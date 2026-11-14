import { AppHeader } from "../../../components/app-header";
import { JourneyStatus } from "../../../components/access/journey-status";
import { JourneyStrip, attendeeJourney } from "../../../components/access/journey-strip";
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
    event = await readEventEntry(
      pool,
      config,
      id,
      value ? hash(value) : undefined,
      undefined,
      true,
    );
  } catch (error) {
    if (error instanceof AppFailure && error.status === 404) notFound();
  } finally {
    await pool.end();
  }
  if (!event)
    return (
      <>
        <AppHeader area="attend" />
        <main>
          <h1>Event temporarily unavailable</h1>
          <p>Reload to review the saved event. Deposits remain closed.</p>
        </main>
      </>
    );
  return (
    <>
      <AppHeader area={event?.canManage ? "host" : "attend"} />
      <main>
        <section className="saved-panel event-summary">
          <h1>{event.data.title}</h1>
          <p>{`Hosted by ${event.hostAlias} · ${event.data.mode === "digital" ? "Online" : "In person"}`}</p>
          <EventTime instant={event.data.startsAt} timeZone={event.data.timeZone} />
          <p>{`${event.data.commitment} USDC deposit. Check in to get your deposit back.`}</p>
        </section>
        {event.progress && <JourneyStrip steps={attendeeJourney(event.progress)} />}
        {event.escrow && event.canManage && (
          <section className="saved-panel">
            <JourneyStatus
              tone="confirmed"
              title={
                event.escrow.status === "published"
                  ? "Event published"
                  : event.escrow.status === "cancelled"
                    ? "Event cancelled"
                    : "Event closed"
              }
              actions={
                <a href={event.escrow.transactionUrl} target="_blank" rel="noopener noreferrer">
                  View publication transaction
                </a>
              }
            />
            <h2>Event controls</h2>
            <p>
              Invite attendees, run check-in, view results, or cancel and make deposits refundable.
            </p>
            {event.escrow.status === "published" && event.registration !== "closed" && (
              <JourneyStatus
                tone="action"
                title="Next: invite attendees"
                actions={
                  <Link className="primary-button" href={`/events/${id}/manage#invitations`}>
                    Create attendee invitation
                  </Link>
                }
              />
            )}
            <Link className="secondary-button" href={`/events/${id}/manage`}>
              Manage event
            </Link>
          </section>
        )}
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
        {event.escrow && !event.canManage && (
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
          <h2>
            {event.hasV1Registration
              ? "Your event activity"
              : event.registration === "closed"
                ? "Registration closed"
                : "Join this event"}
          </h2>
          {event.escrow &&
            (event.viewer === "attendee" || event.viewer === "recovery") &&
            (event.hasV1Registration ? (
              <Link className="primary-button" href={`/events/${id}/commit`} prefetch={false}>
                {event.escrow.status === "cancelled"
                  ? "View refund"
                  : "View deposit, check-in and results"}
              </Link>
            ) : event.viewer === "attendee" && event.registration !== "closed" ? (
              <>
                <Link className="primary-button" href={`/events/${id}/commit`} prefetch={false}>
                  Deposit USDC
                </Link>
                <p>
                  Pay from NEAR, Base, Ethereum, or Solana. Review your amount and fees before you
                  approve.
                </p>
              </>
            ) : (
              <p>Deposits are closed.</p>
            ))}
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
                  {!event.escrow && event.registration !== "closed" && (
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
          <summary>Event terms</summary>
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
            <dt>USDC prize</dt>
            <dd>{`${event.data.sponsorBudget} USDC`}</dd>
            <dt>What happens to no-shows</dt>
            <dd>
              {event.escrow
                ? `No-show deposits split equally among checked-in attendees.${Number(event.data.sponsorBudget) > 0 ? " One checked-in attendee also receives the funded USDC prize." : ""}`
                : event.data.rewardPreset === "equal"
                  ? "Equal split"
                  : event.data.rewardPreset === "draw"
                    ? "Draw"
                    : "Equal split and draw"}
            </dd>
          </dl>
        </details>
        <details>
          <summary>Published rules reference</summary>
          <p style={{ overflowWrap: "anywhere" }}>{event.rulesHash}</p>
        </details>
      </main>
    </>
  );
}
