import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { EventDraft } from "../../domain/event-draft";

export type DraftReceipt = { id: string; revision: number; operationId: string };

export const workspaces = pgTable("harness_workspaces", {
  id: uuid().primaryKey(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const drafts = pgTable("event_drafts", {
  id: uuid().primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  revision: integer().notNull(),
  state: text().notNull().default("DRAFT"),
  data: jsonb().$type<EventDraft>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mutations = pgTable("draft_mutations", {
  operationId: uuid("operation_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  requestHash: text("request_hash").notNull(),
  receipt: jsonb().$type<DraftReceipt>().notNull(),
});

export const outbox = pgTable("outbox", {
  operationId: uuid("operation_id").primaryKey(),
  topic: text().notNull(),
  payload: jsonb().$type<{ draftId: string; revision: number }>().notNull(),
});
