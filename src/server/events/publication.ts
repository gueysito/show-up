import type pg from "pg";
import { validateDraft, usdcAtomic, type EventDraft } from "../../domain/event-draft";
import { transaction } from "../db/client";
import { isUuid } from "./drafts";
import { AppFailure } from "../http/security";

export type PublicationCheck = {
  id: string;
  label: string;
  state: "ready" | "blocked" | "not_required";
  detail: string;
};
export type PublicationReadiness = {
  eventId: string;
  revision: number;
  eventState: string;
  checkedAt: string;
  publicationAllowed: false;
  checks: PublicationCheck[];
};

// Qualification must come from actual attributable evidence. Neither draft fields,
// browser assertions nor sandbox receipts can enable these live prerequisites.
export function publicationChecks(data: EventDraft, now: number): PublicationCheck[] {
  const valid = validateDraft(data, now).ok;
  const sponsor = (usdcAtomic(data.sponsorBudget) ?? 0n) > 0n;
  const draw = data.nft !== null || (sponsor && data.rewardPreset !== "equal");
  return [
    {
      id: "rules",
      label: "Saved event rules",
      state: valid ? "ready" : "blocked",
      detail: valid
        ? "Saved rules pass validation at this check. They are not yet published or frozen in escrow."
        : "Review and save valid rules, including a future start and a 30–120 minute duration.",
    },
    {
      id: "routes",
      label: "Funding and authorized principal returns",
      state: "blocked",
      detail:
        "Actual attributable funding and authorized returns remain unqualified for NEAR, Base, Solana and Ethereum. No deposits are enabled.",
    },
    {
      id: "escrow",
      label: "Immutable escrow rules and capacity",
      state: "blocked",
      detail:
        "The saved revision must match a verified escrow deployment with fixed capacity, timing, account eligibility and destinations.",
    },
    {
      id: "execution",
      label: "Project execution funding",
      state: "blocked",
      detail:
        "A separately funded execution reserve must cover the event. Attendee principal and sponsor rewards cannot fund it.",
    },
    {
      id: "sponsor",
      label: "Sponsor reward funding",
      state: sponsor ? "blocked" : "not_required",
      detail: sponsor
        ? "The full published sponsor reward budget needs confirmed attributable escrow."
        : "This saved event has no monetary sponsor reward budget.",
    },
    {
      id: "nft",
      label: "NFT custody and contributor reserve",
      state: data.nft ? "blocked" : "not_required",
      detail: data.nft
        ? "The exact NFT needs verified escrow, an authorized return destination and a separately funded delivery/return reserve."
        : "This saved event has no NFT prize.",
    },
    {
      id: "draw",
      label: "Draw verification and original-request recovery",
      state: draw ? "blocked" : "not_required",
      detail: draw
        ? "The actual draw provider must pass verification and recovery of the original request."
        : "This saved event does not allocate a monetary or NFT draw prize.",
    },
    {
      id: "staff",
      label: "Fixed event staff and eligibility",
      state: "blocked",
      detail:
        data.mode === "physical"
          ? "Assign and verify the event's authenticated validators before publication; funded attendees cannot become validators."
          : "Freeze the host, staff and contributor exclusions before publication.",
    },
  ];
}

export async function readPublicationReadiness(
  pool: pg.Pool,
  session: string,
  eventId: string,
  revision: number,
): Promise<PublicationReadiness> {
  if (!isUuid(eventId) || !Number.isSafeInteger(revision) || revision < 1)
    throw new AppFailure(400, "Choose a saved event revision.");
  return transaction(pool, async (client) => {
    const actor = (
      await client.query(
        `SELECT a.id FROM app_accounts a JOIN app_sessions s ON s.account_id=a.id
      WHERE s.token_hash=$1 AND a.state='active' AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF a,s`,
        [session],
      )
    ).rows[0];
    if (!actor) throw new AppFailure(401, "Sign in again to check publication.");
    const role = await client.query(
      "SELECT role FROM app_roles WHERE account_id=$1 AND role='host' FOR SHARE",
      [actor.id],
    );
    if (!role.rowCount) throw new AppFailure(403, "Host access required.");
    const event = (
      await client.query(
        "SELECT id,revision,data,state FROM app_events WHERE id=$1 AND owner_id=$2 FOR SHARE",
        [eventId, actor.id],
      )
    ).rows[0];
    if (!event) throw new AppFailure(404, "Private event unavailable.");
    if (event.revision !== revision)
      throw new AppFailure(
        409,
        "This draft changed. Reload the saved revision before checking publication.",
      );
    const now = Date.now();
    return {
      eventId: event.id,
      revision: event.revision,
      eventState: event.state,
      checkedAt: new Date(now).toISOString(),
      publicationAllowed: false,
      checks: publicationChecks(event.data, now),
    };
  });
}
