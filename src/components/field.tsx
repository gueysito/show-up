import type { ReactNode } from "react";
import type { DraftErrors } from "../domain/event-draft";

type Attributes = { id: string; "aria-invalid": boolean; "aria-describedby": string | undefined };

export function errorFieldLabel(name: string): string {
  const labels: Record<string, string> = {
    title: "Event name",
    sessionReference: "Session URL",
    venue: "Venue and proof instructions",
    startsAt: "Planned start",
    endsAt: "Planned end / duration",
    timeZone: "Event display timezone",
    capacity: "Capacity",
    commitment: "Refundable commitment",
    sponsorBudget: "Sponsor budget",
    rewardPreset: "Reward recipe",
    access: "Registration access",
    nft: "NFT prize",
    question: "Question",
    type: "Answer format",
    options: "Answer choices",
    correctOption: "Correct option",
    aliases: "Accepted answers",
    plannedAt: "Question time",
    durationSeconds: "Question window",
    collection: "Collection",
    assetId: "Asset identifier",
    contributorReturnAddress: "Contributor return destination",
    network: "Network",
  };
  const parts = name.split(".");
  if (parts[0] === "quizzes") {
    const field =
      parts[2] === "options" && parts[3]
        ? `Choice ${Number(parts[3]) + 1}`
        : (labels[parts[2]] ?? "Question");
    return `Question ${Number(parts[1]) + 1} · ${field}`;
  }
  return labels[parts.at(-1)!] ?? name;
}

export function Field({
  name,
  label,
  hint,
  errors,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  errors: DraftErrors;
  children: (attributes: Attributes) => ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      {children({
        id: name,
        "aria-invalid": Boolean(errors[name]),
        "aria-describedby": hint || errors[name] ? `${name}-help` : undefined,
      })}
      {(hint || errors[name]) && (
        <div id={`${name}-help`}>
          {hint && <p className="hint">{hint}</p>}
          {errors[name] && <p className="field-error">{errors[name]}</p>}
        </div>
      )}
    </div>
  );
}

export function fromDateInput(value: string) {
  if (!value) return "";
  const date = new Date(`${value}:00Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

export function toDateInput(value: string) {
  return value.slice(0, 16);
}
