"use client";
import { useState } from "react";
import { InvitationManager } from "./invitation-manager";
import type { ValidatorRoster } from "../../server/events/validators";

export function EventValidatorManager({
  eventId,
  draft,
  dirty,
}: {
  eventId: string;
  draft: boolean;
  dirty: boolean;
}) {
  const [roster, setRoster] = useState<ValidatorRoster | null>(null);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  const [pending, setPending] = useState<{
    eventId: string;
    validatorId: string;
    operationId: string;
  } | null>(null);
  async function load() {
    const response = await fetch(`/api/attendance/validators?event=${eventId}`, {
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? "Validator assignments are unavailable. Retry.");
    setRoster(result);
  }
  async function refresh() {
    setBusy(true);
    setStatus("");
    try {
      await load();
    } catch (error) {
      setRoster(null);
      setStatus(error instanceof Error ? error.message : "Validator assignments are unavailable.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(validatorId: string) {
    if (
      !pending &&
      !window.confirm(
        "Remove this validator before publication? They will lose this event assignment.",
      )
    )
      return;
    setBusy(true);
    setStatus("");
    const attempt =
      pending?.validatorId === validatorId
        ? pending
        : { eventId, validatorId, operationId: crypto.randomUUID() };
    setPending(attempt);
    try {
      const response = await fetch("/api/attendance/validators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500) setPending(null);
        throw new Error(result.error ?? "Removal was not confirmed. Retry.");
      }
      await load();
      setPending(null);
      setStatus(
        "Validator removed. Reconnect storage and reopen the saved event before editing or checking publication requirements.",
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Removal was not confirmed. Retry the same assignment.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="saved-panel" aria-label="Event validators">
      <h3>Event validators</h3>
      <p>
        Invite validators before publication. They can confirm physical presence only for this
        event, and cannot earn its attendee rewards. Assignments are fixed at publication.
      </p>
      {draft && (
        <>
          <p>
            Assignment changes advance the saved event revision. Reconnect storage and reopen the
            event before editing its rules.
          </p>
          {dirty && <p>Save your current edits before inviting or removing validators.</p>}
          <InvitationManager
            canIssueHost={false}
            eventId={eventId}
            validatorInvites
            blocked={dirty}
          />
        </>
      )}
      <button type="button" className="secondary-button" disabled={busy} onClick={refresh}>
        Refresh validator assignments
      </button>
      {roster && (
        <>
          <p>
            {roster.frozen
              ? "Published validator assignments are fixed."
              : "Draft validator assignments can still change."}
          </p>
          <ul>
            {roster.validators.map((validator) => (
              <li key={validator.id}>
                <p>{`${validator.alias} · ${validator.revokedAt ? "Removed" : !validator.available ? "Unavailable" : "Assigned"}`}</p>
                {draft && (
                  <button
                    type="button"
                    className="text-button danger"
                    disabled={
                      busy ||
                      dirty ||
                      roster.frozen ||
                      Boolean(validator.revokedAt) ||
                      (pending !== null && pending.validatorId !== validator.id)
                    }
                    onClick={() => remove(validator.id)}
                  >
                    {pending?.validatorId === validator.id
                      ? "Retry validator removal"
                      : "Remove validator before publication"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!roster.validators.length && <p>No validator has accepted an invitation yet.</p>}
        </>
      )}
      <p role="status">{status}</p>
    </section>
  );
}
