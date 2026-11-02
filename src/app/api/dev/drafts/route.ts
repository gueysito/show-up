import { cookies } from "next/headers";
import { createDatabase } from "../../../../server/db/client";
import { DraftFailure, listDrafts, saveDraft } from "../../../../server/events/drafts";
import { harnessRequestAllowed } from "../../../../server/harness/guard";
import { getWorkspace, rateLimit, workspaceCookie } from "../../../../server/harness/workspace";

export const dynamic = "force-dynamic";

async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new DraftFailure(415, "Use JSON for draft operations.");
  const reader = request.body?.getReader();
  if (!reader) throw new DraftFailure(400, "Enter a draft operation.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 32768) {
      await reader.cancel();
      throw new DraftFailure(413, "Draft request exceeds 32 KiB.");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DraftFailure(400, "Draft request is not valid JSON.");
  }
}

async function handle(request: Request) {
  if (!harnessRequestAllowed(request)) return new Response(null, { status: 404 });
  const { pool } = createDatabase();
  try {
    const jar = await cookies();
    const workspace = await getWorkspace(
      pool,
      jar.get(workspaceCookie)?.value,
      request.method === "GET",
    );
    await rateLimit(pool, workspace.id);
    let data: unknown;
    if (request.method === "GET") data = { drafts: await listDrafts(pool, workspace.id) };
    else if (request.method === "DELETE") {
      await pool.query("DELETE FROM harness_workspaces WHERE id=$1", [workspace.id]);
      jar.delete(workspaceCookie);
      data = { cleared: true };
    } else {
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new DraftFailure(400, "Invalid draft operation.");
      const fields = body as Record<string, unknown>;
      data = await saveDraft(pool, workspace.id, {
        id: fields.id as string,
        revision: fields.revision as number,
        operationId: fields.operationId as string,
        data: fields.data,
      });
    }
    if (workspace.token)
      jar.set(workspaceCookie, workspace.token, {
        httpOnly: true,
        sameSite: "strict",
        path: "/api/dev/drafts",
        maxAge: 86400,
      });
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DraftFailure)
      return Response.json(
        { error: error.message, errors: error.errors },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      );
    return Response.json(
      {
        error:
          "Draft storage is unavailable. Your form remains on this page; retry after checking the local database.",
      },
      { status: 503 },
    );
  } finally {
    await pool.end();
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
