import { cookies } from "next/headers";
import { authConfig } from "../../../server/auth/config";
import {
  cookieOptions,
  findSession,
  requireSession,
  sessionCookie,
} from "../../../server/auth/sessions";
import { createDatabase } from "../../../server/db/client";
import {
  AppFailure,
  failureResponse,
  guardRequest,
  jsonBody,
  limit,
} from "../../../server/http/security";
import {
  issueInvitation,
  listInvitations,
  redeemInvitation,
  revokeInvitation,
} from "../../../server/invitations/service";
import {
  encodePendingInvitation,
  inspectInvitation,
  invitationCookie,
  pendingInvitation,
} from "../../../server/invitations/pending";

export const dynamic = "force-dynamic";

async function handle(request: Request) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const config = authConfig();
    if (!config) return new Response(null, { status: 404 });
    guardRequest(request, config.origin, request.method !== "GET");
    database = createDatabase();
    const jar = await cookies();
    if (request.method === "GET" && new URL(request.url).searchParams.has("pending")) {
      const value = pendingInvitation(config.encryptionKey, jar.get(invitationCookie)?.value);
      const session = await findSession(database.pool, jar.get(sessionCookie)?.value);
      return Response.json(
        {
          invitation: value ? await inspectInvitation(database.pool, value) : null,
          signedIn: Boolean(session),
          accountReference: session?.accountId ?? null,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const input = request.method === "POST" ? await jsonBody(request, 2048) : null;
    if (input?.operation === "prepare") {
      if (typeof input.token !== "string")
        throw new AppFailure(400, "Open a valid invitation link.");
      await limit(database.pool, "invite-prepare:global", 60);
      const invitation = await inspectInvitation(database.pool, input.token);
      jar.set(invitationCookie, encodePendingInvitation(config.encryptionKey, input.token), {
        ...cookieOptions,
        maxAge: 900,
      });
      return Response.json({ invitation }, { headers: { "Cache-Control": "no-store" } });
    }
    const session = await requireSession(database.pool, jar.get(sessionCookie)?.value);
    if (request.method === "GET")
      return Response.json(
        { invitations: await listInvitations(database.pool, session.accountId) },
        { headers: { "Cache-Control": "no-store" } },
      );
    await limit(database.pool, `invitation:${session.accountId}`, 30);
    const operationId = input?.operationId;
    if (typeof operationId !== "string") throw new AppFailure(400, "Missing operation reference.");
    let result: unknown;
    if (input?.operation === "issue" && (input.kind === "host" || input.kind === "event")) {
      if (input.eventId !== undefined && typeof input.eventId !== "string")
        throw new AppFailure(400, "Invalid event reference.");
      result = await issueInvitation(database.pool, config, session.tokenHash, operationId, {
        kind: input.kind,
        eventId: input.eventId as string | undefined,
      });
    } else if (input?.operation === "revoke" && typeof input.id === "string") {
      result = await revokeInvitation(
        database.pool,
        config,
        session.tokenHash,
        operationId,
        input.id,
      );
    } else if (input?.operation === "redeem") {
      const value = pendingInvitation(config.encryptionKey, jar.get(invitationCookie)?.value);
      if (!value) throw new AppFailure(410, "Reopen your invitation link to continue.");
      result = await redeemInvitation(
        database.pool,
        config,
        session.tokenHash,
        operationId,
        value,
        input.consent === true,
      );
      // Keep the short-lived encrypted capability for transport-loss retries.
    } else throw new AppFailure(400, "Choose a valid invitation action.");
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return failureResponse(error);
  } finally {
    await database?.pool.end();
  }
}
export const GET = handle;
export const POST = handle;
