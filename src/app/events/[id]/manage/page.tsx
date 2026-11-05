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
  let nft = false;
  try {
    const actor = await findPrivacySession(pool, (await cookies()).get(sessionCookie)?.value);
    if (
      !actor ||
      !(
        await pool.query(
          "SELECT 1 FROM app_events e JOIN app_publication_images p ON p.event_id=e.id WHERE e.id=$1 AND e.owner_id=$2 AND p.environment='near-mainnet-v1' AND p.transaction_state IN ('verified','awaiting_prize','cancelled','failed')",
          [id, actor.accountId],
        )
      ).rowCount
    )
      notFound();
    active = actor.state === "active";
    nft = Boolean(
      (
        await pool.query("SELECT data->'nft' AS nft FROM app_events WHERE id=$1 AND owner_id=$2", [
          id,
          actor.accountId,
        ])
      ).rows[0]?.nft,
    );
  } finally {
    await pool.end();
  }
  return (
    <main>
      <Link href={`/events/${id}`} prefetch={false}>
        Back to event
      </Link>
      <h1>Manage your event</h1>
      <V1EventConsole eventId={id} host active={active} />
      {nft && <V1NftPrize eventId={id} active={active} />}
    </main>
  );
}
