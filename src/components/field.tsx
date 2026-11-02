import type { ReactNode } from "react";
import type { DraftErrors } from "../domain/event-draft";

type Attributes = { id: string; "aria-invalid": boolean; "aria-describedby": string | undefined };

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
