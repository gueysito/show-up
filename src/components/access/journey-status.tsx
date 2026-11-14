import type { ReactNode } from "react";

export type JourneyTone = "action" | "checking" | "confirmed" | "blocked";

// Every tone pairs its color with a word and a glyph, so color is never the only signal.
const labels: Record<JourneyTone, string> = {
  action: "Your turn",
  checking: "Checking",
  confirmed: "Confirmed",
  blocked: "Blocked",
};

function Glyph({ tone }: { tone: JourneyTone }) {
  if (tone === "checking")
    return (
      <span className="journey-glyph journey-dots">
        <i />
        <i />
        <i />
      </span>
    );
  if (tone === "confirmed")
    return (
      <span className="journey-glyph">
        <svg viewBox="0 0 16 16">
          <path d="M3 8.5l3.2 3L13 4.5" />
        </svg>
      </span>
    );
  return <span className="journey-glyph">{tone === "action" ? "→" : "!"}</span>;
}

export function JourneyStatus({
  tone,
  title,
  children,
  actions,
  heading = false,
}: {
  tone: JourneyTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  heading?: boolean;
}) {
  const Title = heading ? "h2" : "strong";
  return (
    <div className={`journey-status journey-status--${tone}`}>
      <span className="journey-status-label" aria-hidden="true">
        <Glyph tone={tone} />
        {labels[tone]}
      </span>
      <div role={tone === "blocked" ? "alert" : "status"}>
        <Title className="journey-status-title">{title}</Title>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="saved-actions">{actions}</div>}
    </div>
  );
}
