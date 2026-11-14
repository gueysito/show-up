import { emptyDraft, type EventDraft } from "../../src/domain/event-draft";

export function validDraft(): EventDraft {
  const start = Date.now() + 86400000;
  return {
    ...emptyDraft,
    title: "Community listening room",
    sessionReference: "https://x.com/i/spaces/example",
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 60 * 60000).toISOString(),
    sponsorBudget: "100",
    quizzes: [],
  };
}
