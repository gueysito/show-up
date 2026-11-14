import { InvitationManager } from "../../../../components/access/invitation-manager";
import { AppHeader } from "../../../../components/app-header";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { V1EventConsole } from "../../../../components/access/v1-event-console";
import { V1NftPrize } from "../../../../components/access/v1-nft-prize";
import { authConfig } from "../../../../server/auth/config";
import { sessionCookie } from "../../../../server/auth/sessions";
import { findPrivacySession } from "../../../../server/privacy/access";
import { createDatabase } from "../../../../server/db/client";
import { isUuid } from "../../../../server/events/drafts";

export const dynamic = "force-dynamic";
export default async function ManageEvent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params,
    config = authConfig();
  if (!config || !isUuid(id)) notFound();
  const { pool } = createDatabase();
  let active = false;
  let event: { title: string; nft: boolean; canInvite: boolean };
  try {
    const actor = await findPrivacySession(pool, (await cookies()).get(sessionCookie)?.value);
    if (!actor) notFound();
    const result = await pool.query<typeof event>(
      `SELECT e.data->>'title' AS title, COALESCE(jsonb_typeof(e.data->'nft')='object', false) AS nft,
        (e.state='published' AND e.registration_closes_at > clock_timestamp() AND p.transaction_state='verified' AND NOT EXISTS
          (SELECT 1 FROM app_v1_event_actions a WHERE a.event_id=e.id AND a.kind IN ('settle','cancel') AND a.state='verified')) AS "canInvite"
        FROM app_events e JOIN app_publication_images p ON p.event_id=e.id
        WHERE e.id=$1 AND e.owner_id=$2 AND p.environment='near-mainnet-v1'
          AND p.transaction_state IN ('verified','awaiting_prize','cancelled','failed')`,
      [id, actor.accountId],
    );
    if (!result.rows[0]) notFound();
    event = result.rows[0];
    active = actor.state === "active";
  } finally {
    await pool.end();
  }
  return (
    <>
      <AppHeader area={"host"} />
      <main>
        <Link href={`/events/${id}`} prefetch={false}>
          Event page
        </Link>
        <h1>{event.title}</h1>
        {active && event.canInvite && (
          <section id="invitations" className="saved-panel">
            <h2>{`Attendee invitations for ${event.title}`}</h2>
            <p>Issue an attendee invitation, then copy and share its link.</p>
            <InvitationManager canIssueHost={false} eventId={id} />
          </section>
        )}
        <V1EventConsole eventId={id} host active={active} />
        {event.nft && <V1NftPrize eventId={id} active={active} />}
      </main>
    </>
  );
}
