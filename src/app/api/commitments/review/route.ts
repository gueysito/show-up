import { cookies } from "next/headers";
import { authConfig } from "../../../../server/auth/config";
import { requireSession, sessionCookie } from "../../../../server/auth/sessions";
import { createDatabase } from "../../../../server/db/client";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../../server/http/security";
import { reviewCommitment } from "../../../../server/commitments/review";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, true);
    database = createDatabase();
    const session = await requireSession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    await limit(database.pool, `commitment-review:${session.accountId}`, 30);
    const body = await jsonBody(request, 2048);
    if (
      Object.keys(body).sort().join() !== "eventId,rulesHash,wallets" ||
      typeof body.eventId !== "string" ||
      typeof body.rulesHash !== "string" ||
      !body.wallets ||
      typeof body.wallets !== "object" ||
      Array.isArray(body.wallets)
    )
      throw new AppFailure(400, "Review this event with your verified wallet selections.");
    const result = await reviewCommitment(database.pool, config, session.tokenHash, {
      eventId: body.eventId,
      rulesHash: body.rulesHash,
      wallets: body.wallets as { source: string; refund: string; payout: string },
    });
    return Response.json(result, {
      headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
