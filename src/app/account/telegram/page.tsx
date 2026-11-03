import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { findSession, sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import { TelegramConnection } from "../../../components/access/telegram-connection";
import { ownTelegramConnection } from "../../../server/telegram/connection";
import { telegramBotConfig } from "../../../server/telegram/config";
import { isUuid } from "../../../server/events/drafts";

export const dynamic = "force-dynamic";
export default async function TelegramPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string }>;
}) {
  const query = await searchParams,
    eventId = isUuid(query.event) ? query.event : undefined;
  const config = authConfig();
  let session = null;
  let initialStatus = null;
  if (config) {
    const { pool } = createDatabase();
    try {
      session = await findSession(pool, (await cookies()).get(sessionCookie)?.value);
      if (session)
        initialStatus = {
          ...(await ownTelegramConnection(pool, session.tokenHash)),
          available: Boolean(telegramBotConfig()),
        };
    } catch {
      initialStatus = null;
    } finally {
      await pool.end();
    }
  }
  return (
    <main>
      <Link href="/account" prefetch={false}>
        Back to your account
      </Link>
      <h1>Telegram messages</h1>
      {session ? (
        <TelegramConnection initialStatus={initialStatus} eventId={eventId} />
      ) : (
        <p>
          <Link href="/account" prefetch={false}>
            Sign in to an active account to manage optional Telegram messages
          </Link>
        </p>
      )}
    </main>
  );
}
