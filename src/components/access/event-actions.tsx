"use client";

import { useRef, useState } from "react";
import { InvitationManager } from "./invitation-manager";
import type { PublicationReadiness } from "../../server/events/publication";
import { HostCodeWindowManager } from "./host-code-window";
import { EventValidatorManager } from "./event-validators";
import Link from "next/link";

export function EventActions({
  id,
  revision,
  state,
  description,
  changeDescription,
  onSaved,
  busy,
  setBusy,
  dirty,
  mode,
}: {
  id: string;
  revision: number;
  state?: string;
  description: string;
  changeDescription: (value: string) => void;
  onSaved: (revision: number) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  dirty: boolean;
  mode: "digital" | "physical";
}) {
  const [status, setStatus] = useState("");
  const [readiness, setReadiness] = useState<PublicationReadiness | null>(null);
  async function checkPublication() {
    setBusy(true);
    setReadiness(null);
    try {
      const response = await fetch(`/api/events?publication=${id}&revision=${revision}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Publication check unavailable. Retry.");
      setReadiness(result);
      setStatus("Publication remains unavailable. Review the saved-revision requirements below.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Publication check unavailable. Retry.");
    } finally {
      setBusy(false);
    }
  }
  const pending = useRef<{ operationId: string; description: string; revision: number } | null>(
    null,
  );
  async function correctDescription() {
    setBusy(true);
    if (pending.current?.description !== description || pending.current.revision !== revision)
      pending.current = { operationId: crypto.randomUUID(), description, revision };
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "copy", id, ...pending.current }),
      });
      const receipt = await response.json();
      if (!response.ok)
        throw new Error(receipt.error ?? "Description correction was not confirmed.");
      onSaved(receipt.revision);
      pending.current = null;
      setStatus("Description correction saved. Published material terms remain locked.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Correction was not confirmed. Retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="saved-panel" aria-label="Event publication and access">
      <h2>{state === "published" ? "Published terms are locked" : "Before publication"}</h2>
      <p>
        Publication requires attributable escrow, authorized principal returns and verified protocol
        prerequisites. No funding route is enabled yet.
      </p>
      <button type="button" className="secondary-button" disabled>
        Publish event · protocol verification required
      </button>
      {state !== "published" && (
        <div>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || dirty}
            onClick={checkPublication}
          >
            Check saved publication requirements
          </button>
          {dirty && <p>Save your changes before checking publication requirements.</p>}
          {!dirty && readiness?.revision === revision && (
            <section aria-label="Saved publication requirements">
              <p>{`Checked saved revision ${readiness.revision} at ${readiness.checkedAt}. This check does not publish or fund the event.`}</p>
              {readiness.preparation && (
                <p>
                  {readiness.preparation.state === "awaiting_observation"
                    ? `Revision ${readiness.preparation.revision} has a frozen publication request awaiting its original contract outcome. Keep this event for reconciliation; duplicate it to change material rules.`
                    : "Publication was observed in the disposable sandbox. This does not qualify live publication or deposits."}
                </p>
              )}
              <ul>
                {readiness.checks.map((check) => (
                  <li key={check.id}>
                    <strong>{check.label}</strong>
                    {`: ${check.state === "ready" ? "Validated" : check.state === "not_required" ? "Not required" : "Verification required"}. ${check.detail}`}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {status && <p role="status">{status}</p>}
        </div>
      )}
      {state === "published" && (
        <div>
          <p>
            <Link href={`/events/${id}`} prefetch={false}>
              Open attendee event page
            </Link>
          </p>
          <label htmlFor="copy-description">Correct description only</label>
          <textarea
            id="copy-description"
            disabled={busy}
            value={description}
            maxLength={2000}
            onChange={(event) => changeDescription(event.target.value)}
          />
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={correctDescription}
          >
            Save description correction
          </button>
          <p role="status">{status}</p>
          <InvitationManager canIssueHost={false} eventId={id} />
          {mode === "digital" && <HostCodeWindowManager key={id} eventId={id} />}
        </div>
      )}
      {mode === "physical" && (
        <EventValidatorManager
          key={id}
          eventId={id}
          draft={(state ?? "draft") === "draft"}
          dirty={dirty}
        />
      )}
    </section>
  );
}
