import { AppHeader } from "../../components/app-header";
import Link from "next/link";
import { cookies } from "next/headers";
import { EventDraftForm } from "../../components/event-draft-form";
import { authConfig } from "../../server/auth/config";
import { findSession, sessionCookie } from "../../server/auth/sessions";
import { createDatabase } from "../../server/db/client";

export const dynamic = "force-dynamic";
export default async function HostPage() {
  const config = authConfig();
  if (config) {
    const { pool } = createDatabase();
    try {
      const session = await findSession(pool, (await cookies()).get(sessionCookie)?.value);
      if (session?.roles.includes("host")) return <EventDraftForm persistence account />;
    } finally {
      await pool.end();
    }
  }
  return (
    <>
      <AppHeader area={"host"} />
      <main>
        <h1>Host access required</h1>
        <p>Sign in and redeem an administrator-issued host invitation.</p>
        <Link href="/account">Account and sign-in</Link>
      </main>
    </>
  );
}
