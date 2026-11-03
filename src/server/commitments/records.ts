import type pg from "pg";
import type { AuthConfig } from "../auth/config";
import { unseal } from "../auth/crypto";
import { transaction } from "../db/client";
import { isUuid } from "../events/drafts";
import { AppFailure } from "../http/security";
import { canonicalHash } from "../protocol/canonical";
import type { CommitmentConsent, ConsentTerms } from "./consent";

export type OwnFinancialRecord = {
  id: string;
  eventId: string;
  eventTitle: string;
  eventState: string;
  terms: ConsentTerms;
  createdAt: string;
  authorizedAt: string | null;
  escrowState: "not_confirmed";
  fundingAllowed: false;
};
export async function listOwnFinancialRecords(
  pool: pg.Pool,
  config: AuthConfig,
  session: string,
  before?: string,
): Promise<{
  records: OwnFinancialRecord[];
  nextCursor: string | null;
}> {
  if (before !== undefined && !isUuid(before))
    throw new AppFailure(400, "Invalid financial history reference.");
  return transaction(pool, async (client) => {
    const current = await client.query(
      `SELECT a.id FROM app_sessions s JOIN app_accounts a ON a.id=s.account_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.state='active' FOR SHARE OF a,s`,
      [session],
    );
    if (!current.rowCount)
      throw new AppFailure(401, "Sign in again to view your financial authorizations.");
    const actor = current.rows[0].id;
    if (before) {
      const cursor = (
        await client.query("SELECT id FROM app_commitment_consents WHERE id=$1 AND account_id=$2", [
          before,
          actor,
        ])
      ).rows[0];
      if (!cursor) throw new AppFailure(404, "Private financial history unavailable.");
    }
    const result = await client.query(
      `SELECT c.*,e.data->>'title' AS event_title,e.state AS event_state
      FROM app_commitment_consents c JOIN app_events e ON e.id=c.event_id WHERE c.account_id=$1
      AND ($2::uuid IS NULL OR (c.created_at,c.id)<(SELECT older.created_at,older.id
        FROM app_commitment_consents older WHERE older.id=$2 AND older.account_id=$1))
      ORDER BY c.created_at DESC,c.id DESC LIMIT 51`,
      [actor, before ?? null],
    );
    const rows = result.rows.slice(0, 50);
    const records = rows.map((row) => {
      const { consent } = unseal(
        config.encryptionKey,
        `commitment-consent:${actor}:${row.id}`,
        row.encrypted_consent,
      ) as { consent: CommitmentConsent };
      if (canonicalHash(consent) !== row.consent_hash)
        throw new Error("Financial record integrity failure");
      return {
        id: row.id,
        eventId: row.event_id,
        eventTitle: row.event_title ?? "Event",
        eventState: row.event_state,
        terms: consent.terms,
        createdAt: row.created_at.toISOString(),
        authorizedAt: row.authorized_at?.toISOString() ?? null,
        escrowState: "not_confirmed" as const,
        fundingAllowed: false as const,
      };
    });
    return { records, nextCursor: result.rows.length > 50 ? rows.at(-1)!.id : null };
  });
}
