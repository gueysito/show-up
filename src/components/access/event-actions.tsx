"use client";

import { useRef, useState } from "react";
import { InvitationManager } from "./invitation-manager";
import type { V1PublicationState } from "../../server/events/v1-publication";
import { HostCodeWindowManager } from "./host-code-window";
import { EventValidatorManager } from "./event-validators";
import Link from "next/link";
import { useRouter } from "next/navigation";

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
  timeZone,
  onPublicationRequested,
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
  timeZone: string;
  onPublicationRequested: () => void;
}) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [readiness, setReadiness] = useState<V1PublicationState | null>(null);
  const publicationPending = useRef<{ operationId: string; revision: number } | null>(null);
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
      setStatus(result.message);
      if (result.state === "verified") router.push(`/events/${id}`);
      else if (result.state !== "draft") onPublicationRequested();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Publication check unavailable. Retry.");
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    setBusy(true);
    if (publicationPending.current?.revision !== revision)
      publicationPending.current = { operationId: crypto.randomUUID(), revision };
    try {
      const response = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "publish", id, ...publicationPending.current }),
      });
      const receipt = await response.json();
      if (!response.ok)
        throw new Error(
          receipt.error ?? "Publication was not confirmed. Check status before retrying.",
        );
      setReadiness({
        eventId: id,
        revision,
        state: receipt.state,
        canPublish: false,
        message:
          "Publication requested. Your saved terms are now locked. Check publication status for the original transaction.",
        transactionUrl: null,
      });
      setStatus("Publication requested. Check publication status for confirmation on mainnet.");
      onPublicationRequested();
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Publication was not confirmed. Check status before retrying.",
      );
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
      <h2>
        {state === "published"
          ? "Published terms are locked"
          : state === "publication_pending"
            ? "Publication in progress"
            : "Before publication"}
      </h2>
      <p>
        Publishing locks the saved event terms in the NEAR escrow. The project pays network gas.
        Attendee deposits are not open yet.
      </p>
      {state !== "published" && (
        <div>
          <button
            type="button"
            className="primary-button"
            disabled={
              busy ||
              dirty ||
              (readiness !== null && (!readiness.canPublish || readiness.revision !== revision))
            }
            onClick={publish}
          >
            Publish event on mainnet
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || dirty}
            onClick={checkPublication}
          >
            Check publication status
          </button>
          {dirty && <p>Save your changes before checking publication requirements.</p>}
          {!dirty && readiness?.revision === revision && (
            <section aria-label="Saved publication requirements">
              <p>{readiness.message}</p>
              {readiness.transactionUrl && (
                <p>
                  <a href={readiness.transactionUrl} target="_blank" rel="noopener noreferrer">
                    View publication transaction
                  </a>
                </p>
              )}
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
          {mode === "digital" && (
            <HostCodeWindowManager key={id} eventId={id} timeZone={timeZone} />
          )}
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
