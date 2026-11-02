import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { requireSession, sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import {
  correctPublishedDescription,
  duplicateAccountEvent,
  listAccountEvents,
  requestPublication,
  saveAccountDraft,
} from "../../../server/events/accounts";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../server/http/security";

export const dynamic = "force-dynamic";
async function handle(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, request.method !== "GET");
    database = createDatabase();
    const session = await requireSession(
      database.pool,
      (await cookies()).get(sessionCookie)?.value,
    );
    await limit(database.pool, `events:${session.accountId}`, 60);
    if (request.method === "GET")
      return Response.json(
        { drafts: await listAccountEvents(database.pool, session.accountId) },
        { headers: { "Cache-Control": "no-store" } },
      );
    const body = await jsonBody(request);
    if (typeof body.operationId !== "string" || typeof body.id !== "string")
      throw new AppFailure(400, "Invalid event operation.");
    const { pool } = database;
    const key = config.encryptionKey;
    const { tokenHash } = session;
    let result: unknown;
    if (body.operation === "duplicate")
      result = await duplicateAccountEvent(pool, key, tokenHash, body.operationId, body.id);
    else if (body.operation === "copy")
      result = await correctPublishedDescription(
        pool,
        key,
        tokenHash,
        body.operationId,
        body.id,
        body.revision as number,
        body.description as string,
      );
    else if (body.operation === "publish")
      result = await requestPublication(pool, key, tokenHash, body.operationId, body.id);
    else if (body.operation === undefined)
      result = await saveAccountDraft(pool, key, tokenHash, {
        id: body.id,
        operationId: body.operationId,
        revision: body.revision as number,
        data: body.data,
      });
    else throw new AppFailure(400, "Invalid event action.");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
export const GET = handle;
export const POST = handle;
