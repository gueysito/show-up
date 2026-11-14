export type JourneyStep = {
  label: string;
  note?: string;
  state: "done" | "current" | "upcoming" | "missed";
};

const stateText = { done: "done", current: "current step", upcoming: "not yet", missed: "missed" };

/** Shows where an attendee is on the path from commitment to payout. */
export function JourneyStrip({ steps }: { steps: JourneyStep[] }) {
  return (
    <ol className="journey-strip" aria-label="Your progress">
      {steps.map((step) => (
        <li
          key={step.label}
          data-state={step.state}
          aria-current={step.state === "current" ? "step" : undefined}
        >
          <span>
            {step.state === "done" ? "✓ " : step.state === "missed" ? "✕ " : ""}
            {step.label}
            <span className="visually-hidden">{`, ${stateText[step.state]}`}</span>
          </span>
          {step.note && <small>{step.note}</small>}
        </li>
      ))}
    </ol>
  );
}

/** The standard four steps, given how far the attendee has come. */
export function attendeeJourney(progress: {
  registered: boolean;
  funded: boolean;
  attended: boolean;
  paid: boolean;
  ended?: boolean;
  cancelled?: boolean;
}): JourneyStep[] {
  const { registered, funded, attended, paid, ended = false, cancelled = false } = progress;
  const done = [registered || funded, funded, attended, paid];
  if (cancelled) done[2] = funded;
  const current = done.indexOf(false);
  const labels = cancelled
    ? ["Commit", "Funded", "Cancelled", "Refunded"]
    : ["Commit", "Funded", "Checked in", "Paid out"];
  const notes = cancelled
    ? ["Review and register", "Deposit in escrow", "Host cancelled", "Deposit returned"]
    : ["Review and register", "Deposit in escrow", "Host’s live code", "Deposit plus share"];
  return labels.map((label, index) => ({
    label,
    note: notes[index],
    state: done[index]
      ? "done"
      : ended && !cancelled && funded && !attended
        ? "missed"
        : index === current
          ? "current"
          : "upcoming",
  }));
}
