import { createDatabase } from "../../../server/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { pool } = createDatabase();
    try {
      await pool.query("SELECT operation_id FROM outbox LIMIT 0");
      return Response.json({
        status: "ready",
        scope: process.env.SHOWUP_ENV === "production" ? "hosted-v1" : "local-foundation",
      });
    } finally {
      await pool.end();
    }
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
