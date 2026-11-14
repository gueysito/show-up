import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { validateDraft, type DraftErrors } from "../../domain/event-draft";
import { drafts, mutations, outbox, workspaces, type DraftReceipt } from "../db/schema";

export class DraftFailure extends Error {
  constructor(
    public status: number,
    message: string,
    public errors?: DraftErrors,
  ) {
    super(message);
  }
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export type DraftSave = {
  id: string;
  revision: number;
  operationId: string;
  data: unknown;
};

export async function saveDraft(
  pool: pg.Pool,
  workspaceId: string,
  input: DraftSave,
): Promise<DraftReceipt> {
  if (
    !isUuid(input.id) ||
    !isUuid(input.operationId) ||
    !Number.isInteger(input.revision) ||
    input.revision < 0
  ) {
    throw new DraftFailure(400, "Invalid draft operation.");
  }
  const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const db = drizzle(pool);
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    if (!workspace || workspace.expiresAt.getTime() <= Date.now())
      throw new DraftFailure(401, "Workspace expired. Reload to start a new workspace.");
    const [prior] = await tx
      .select()
      .from(mutations)
      .where(eq(mutations.operationId, input.operationId));
    if (prior) {
      if (prior.workspaceId !== workspaceId || prior.requestHash !== requestHash)
        throw new DraftFailure(409, "Operation conflicts with an earlier save.");
      return prior.receipt;
    }
    const validated = validateDraft(input.data);
    if (!validated.ok) throw new DraftFailure(422, "Review the event rules.", validated.errors);
    const [existing] = await tx
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, input.id), eq(drafts.workspaceId, workspaceId)));
    if ((existing?.revision ?? 0) !== input.revision)
      throw new DraftFailure(
        409,
        "This draft changed in another tab. Reload the saved version before editing.",
      );
    if (!existing && input.revision !== 0) throw new DraftFailure(404, "Draft unavailable.");
    const revision = input.revision + 1;
    if (existing) {
      await tx
        .update(drafts)
        .set({ data: validated.value, revision, updatedAt: new Date() })
        .where(and(eq(drafts.id, input.id), eq(drafts.workspaceId, workspaceId)));
    } else {
      const inserted = await tx
        .insert(drafts)
        .values({ id: input.id, workspaceId, revision, data: validated.value })
        .onConflictDoNothing()
        .returning({ id: drafts.id });
      if (!inserted.length) throw new DraftFailure(409, "Draft unavailable. Start a new draft.");
    }
    const receipt = { id: input.id, revision, operationId: input.operationId };
    await tx
      .insert(mutations)
      .values({ operationId: input.operationId, workspaceId, requestHash, receipt });
    await tx.insert(outbox).values({
      operationId: input.operationId,
      topic: "draft.saved",
      payload: { draftId: input.id, revision },
    });
    return receipt;
  });
}

export async function listDrafts(pool: pg.Pool, workspaceId: string) {
  return drizzle(pool)
    .select({
      id: drafts.id,
      revision: drafts.revision,
      data: drafts.data,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .where(eq(drafts.workspaceId, workspaceId))
    .orderBy(desc(drafts.updatedAt))
    .limit(50);
}
