import { AppHeader } from "../../../components/app-header";
import Link from "next/link";
import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { findSession, sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import {
  listStaffAttendanceEvents,
  type StaffAttendanceEvent,
} from "../../../server/attendance/staff";
import { AttendanceStaffScanner } from "../../../components/access/attendance-staff-scanner";

export const dynamic = "force-dynamic";
export default async function StaffAttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; before?: string }>;
}) {
  const query = await searchParams,
    config = authConfig();
  let signedIn = false,
    available = Boolean(config),
    events: StaffAttendanceEvent[] = [],
    nextCursor: string | null = null;
  if (config) {
    const { pool } = createDatabase();
    try {
      const session = await findSession(pool, (await cookies()).get(sessionCookie)?.value);
      signedIn = Boolean(session);
      if (session)
        ({ events, nextCursor } = await listStaffAttendanceEvents(pool, session.tokenHash, {
          eventId: query.event,
          before: query.before,
        }));
    } catch {
      available = false;
    } finally {
      await pool.end();
    }
  }
  return (
    <>
      <AppHeader area={"account"} />
      <main>
        <Link href="/account" prefetch={false}>
          Back to your account
        </Link>
        <h1>Staff attendance</h1>
        <p>
          Only published physical events with your host or validator assignment appear here.
          Scanning never confirms attendance by itself.
        </p>
        {!available ? (
          <p role="alert">Assigned events are unavailable. Review your account and reload.</p>
        ) : !signedIn ? (
          <Link href="/account" prefetch={false}>
            Sign in to review your staff assignments
          </Link>
        ) : (
          <>
            {query.event && (
              <p>
                <Link href="/account/attendance" prefetch={false}>
                  All your staff events
                </Link>
              </p>
            )}
            {!events.length && (
              <p>No published physical events are available for scanning on this account.</p>
            )}
            {events.map((event) => (
              <article key={event.eventId} className="saved-panel">
                <h2>{event.title}</h2>
                <p>{`Your assignment: ${event.assignment}.`}</p>
                {query.event === event.eventId ? (
                  <AttendanceStaffScanner event={event} />
                ) : (
                  <Link href={`/account/attendance?event=${event.eventId}`} prefetch={false}>
                    Open scan controls
                  </Link>
                )}
              </article>
            ))}
            {nextCursor && (
              <p>
                <Link href={`/account/attendance?before=${nextCursor}`} prefetch={false}>
                  Older staff events
                </Link>
              </p>
            )}
          </>
        )}
      </main>
    </>
  );
}
