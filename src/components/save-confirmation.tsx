import type { EventDraft } from "../domain/event-draft";

export function SaveConfirmation({ draft, onClose }: { draft: EventDraft; onClose: () => void }) {
  const format = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: draft.timeZone,
  });
  return (
    <section
      className="feedback-card save-confirmation"
      aria-label="Saved draft confirmation"
      aria-live="polite"
    >
      <h2>Draft saved</h2>
      <p>Unpublished and unfunded. No wallet action took place.</p>
      <p>{`Commitment: ${draft.commitment} USDC · Sponsor budget: ${draft.sponsorBudget} USDC`}</p>
      <p>{`Start: ${format.format(new Date(draft.startsAt))}`}</p>
      <p>{`End: ${format.format(new Date(draft.endsAt))} (${draft.timeZone})`}</p>
      <button type="button" className="text-button" onClick={onClose}>
        Close saved details
      </button>
    </section>
  );
}
