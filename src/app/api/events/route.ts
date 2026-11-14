import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import { requireSession, sessionCookie } from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import {
  correctPublishedDescription,
  duplicateAccountEvent,
  listAccountEvents,
  saveAccountDraft,
} from "../../../server/events/accounts";
import {
  prepareV1Publication,
  readV1PublicationState,
} from "../../../server/events/v1-publication";
import {
  prepareV1PrizeFunding,
  confirmV1PrizeFunding,
} from "../../../server/events/v1-prize-funding";
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
    if (request.method === "GET") {
      const query = new URL(request.url).searchParams;
      if (query.has("publication")) {
        if (
          [...query.keys()].some((key) => !["publication", "revision"].includes(key)) ||
          query.getAll("publication").length !== 1 ||
          query.getAll("revision").length !== 1 ||
          !/^[1-9]\d{0,8}$/.test(query.get("revision") ?? "")
        )
          throw new AppFailure(400, "Choose a saved event revision.");
        return Response.json(
          await readV1PublicationState(
            database.pool,
            session.tokenHash,
            query.get("publication")!,
            Number(query.get("revision")),
            config.encryptionKey,
          ),
          { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
        );
      }
      return Response.json(
        { drafts: await listAccountEvents(database.pool, session.accountId) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
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
    else if (body.operation === "publish") {
      if (body.sponsorWalletId !== undefined && typeof body.sponsorWalletId !== "string")
        throw new AppFailure(400, "Choose a verified funding wallet.");
      if (
        Object.keys(body).some(
          (field) =>
            !["operation", "operationId", "id", "revision", "sponsorWalletId"].includes(field),
        )
      )
        throw new AppFailure(400, "Unexpected publication fields.");
      await limit(pool, `publish:${session.accountId}`, 5);
      result = await prepareV1Publication(
        pool,
        key,
        tokenHash,
        body.operationId,
        body.id,
        body.revision as number,
        typeof body.sponsorWalletId === "string" ? body.sponsorWalletId : undefined,
      );
    } else if (body.operation === "fund-prize" || body.operation === "confirm-prize") {
      if (
        Object.keys(body).some(
          (field) => !["operation", "operationId", "id", "revision"].includes(field),
        )
      )
        throw new AppFailure(400, "Unexpected prize funding fields.");
      await limit(pool, `prize:${session.accountId}`, 5);
      result =
        body.operation === "fund-prize"
          ? await prepareV1PrizeFunding(pool, config, tokenHash, body.id, body.revision as number)
          : await confirmV1PrizeFunding(
              pool,
              key,
              tokenHash,
              body.operationId,
              body.id,
              body.revision as number,
            );
    } else if (body.operation === undefined)
      result = await saveAccountDraft(
        pool,
        key,
        tokenHash,
        {
          id: body.id,
          operationId: body.operationId,
          revision: body.revision as number,
          data: body.data,
        },
        "v1",
      );
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
