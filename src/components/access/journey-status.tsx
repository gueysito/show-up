import type { ReactNode } from "react";

export type JourneyTone = "action" | "checking" | "confirmed" | "blocked";

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
      <div role={tone === "blocked" ? "alert" : "status"}>
        <Title className="journey-status-title">{title}</Title>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="saved-actions">{actions}</div>}
    </div>
  );
}
