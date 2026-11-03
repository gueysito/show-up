import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { sessionCookie } from "../../../server/auth/sessions";
import { findPrivacySession } from "../../../server/privacy/access";
import { createDatabase } from "../../../server/db/client";
import { listOwnFinancialRecords } from "../../../server/commitments/records";
import { AppFailure, failureResponse, guardRequest, limit } from "../../../server/http/security";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, false);
    database = createDatabase();
    const session = await findPrivacySession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    if (!session) throw new AppFailure(401, "Sign in again to view your financial records.");
    await limit(database.pool, `financial-records:${session.accountId}`, 60);
    const query = new URL(request.url).searchParams;
    if (
      [...query.keys()].some((key) => !["before", "event"].includes(key)) ||
      query.getAll("before").length > 1 ||
      query.getAll("event").length > 1
    )
      throw new AppFailure(400, "Use your own financial history reference.");
    return Response.json(
      await listOwnFinancialRecords(
        database.pool,
        config,
        session.tokenHash,
        query.get("before") ?? undefined,
        query.get("event") ?? undefined,
      ),
      {
        headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      },
    );
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
