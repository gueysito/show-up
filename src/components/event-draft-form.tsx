"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  emptyDraft,
  validateDraft,
  type DraftErrors,
  type EventDraft,
} from "../domain/event-draft";
import { DetailsFields, CommitmentFields, ParticipationFields } from "./event-fields";
import { RulePreview } from "./rule-preview";
import { SaveConfirmation } from "./save-confirmation";
import { errorFieldLabel } from "./field";

type SavedDraft = { id: string; revision: number; data: EventDraft; updatedAt: string };
type SaveRequest = { id: string; revision: number; operationId: string; data: EventDraft };
const api = "/api/dev/drafts";
const headers = { "x-showup-harness": "1", "content-type": "application/json" };

export function EventDraftForm({ persistence = false }: { persistence?: boolean }) {
  const [draft, setDraft] = useState<EventDraft>(() => structuredClone(emptyDraft));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saved, setSaved] = useState<SavedDraft[]>([]);
  const [identity, setIdentity] = useState<{ id: string; revision: number } | null>(null);
  const [snapshot, setSnapshot] = useState("");
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<EventDraft | null>(null);
  const [conflict, setConflict] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const pending = useRef<SaveRequest | null>(null);
  const dirty = snapshot !== JSON.stringify(draft);

  async function loadSaved() {
    const response = await fetch(api, { headers, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Storage unavailable.");
    setSaved(result.drafts);
    setReady(true);
    return result.drafts as SavedDraft[];
  }

  useEffect(() => {
    if (!persistence) return;
    const controller = new AbortController();
    fetch(api, { headers, cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Storage unavailable");
        const result = await response.json();
        setSaved(result.drafts);
        setReady(true);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setStatus("Storage unavailable. Your form is still editable. Reconnect storage to save.");
      });
    return () => controller.abort();
  }, [persistence]);

  function change<K extends keyof EventDraft>(key: K, value: EventDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setStatus("");
  }

  function showErrors(next: DraftErrors) {
    setErrors(next);
    setShowValidation(true);
    requestAnimationFrame(() => document.getElementById("draft-errors")?.focus());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setConfirmation(null);
    const result = validateDraft(draft);
    if (!result.ok) {
      showErrors(result.errors);
      setStatus("Review the highlighted fields. Your entries are preserved.");
      return;
    }
    setErrors({});
    setShowValidation(false);
    if (!persistence) {
      setStatus(
        "Draft rules are valid. This preview is not saved; use the isolated local workspace for persistence.",
      );
      return;
    }
    setBusy(true);
    const id = identity?.id ?? pending.current?.id ?? crypto.randomUUID();
    if (!pending.current || JSON.stringify(pending.current.data) !== JSON.stringify(draft)) {
      pending.current = {
        id,
        revision: identity?.revision ?? 0,
        operationId: crypto.randomUUID(),
        data: draft,
      };
    }
    try {
      const response = await fetch(api, {
        method: "POST",
        headers,
        body: JSON.stringify(pending.current),
      });
      const receipt = await response.json();
      if (!response.ok) {
        if (receipt.errors) showErrors(receipt.errors);
        if (response.status === 409) setConflict(true);
        throw new Error(receipt.error ?? "Save failed. Retry without changing the form.");
      }
      setIdentity({ id: receipt.id, revision: receipt.revision });
      setSnapshot(JSON.stringify(draft));
      pending.current = null;
      setConfirmation(structuredClone(draft));
      setStatus(
        `Saved locally · revision ${receipt.revision}. This event is unpublished and unfunded.`,
      );
      await loadSaved().catch(() =>
        setStatus(
          `Saved locally · revision ${receipt.revision}. The saved list could not refresh; reconnect storage.`,
        ),
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Save failed. Retry without changing the form.",
      );
    } finally {
      setBusy(false);
    }
  }

  function openDraft(item?: SavedDraft) {
    if (dirty && (draft.title || identity) && !window.confirm("Discard unsaved form changes?"))
      return;
    setDraft(item ? structuredClone(item.data) : structuredClone(emptyDraft));
    setIdentity(item ? { id: item.id, revision: item.revision } : null);
    setSnapshot(item ? JSON.stringify(item.data) : "");
    pending.current = null;
    setErrors({});
    setShowValidation(false);
    setConflict(false);
    setConfirmation(null);
    setStatus(item ? `Loaded saved revision ${item.revision}.` : "New draft. Nothing saved yet.");
    document.getElementById("title")?.focus();
  }

  async function clearWorkspace() {
    if (
      !window.confirm("Delete all drafts in this local browser workspace? This cannot be undone.")
    )
      return;
    setBusy(true);
    try {
      const response = await fetch(api, { method: "DELETE", headers });
      if (!response.ok) throw new Error();
      setDraft(structuredClone(emptyDraft));
      setIdentity(null);
      setSnapshot("");
      pending.current = null;
      setSaved([]);
      setErrors({});
      setShowValidation(false);
      setConflict(false);
      setConfirmation(null);
      await loadSaved();
      setStatus("Local workspace cleared. A new empty workspace is ready.");
    } catch {
      setStatus(
        "Could not clear the workspace. No deletion is confirmed; retry after checking storage.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Showup home">
          <span className="brand-mark" aria-hidden="true">
            s.
          </span>
          showup
          <span className="brand-dot">®</span>
        </Link>
        <span className="environment-tag">
          {persistence ? "Development workspace" : "Local rules preview"}
        </span>
      </header>
      <main>
        <div className="intro">
          <p className="eyebrow">Gather with intention</p>
          <h1>
            Make showing up
            <br />
            <em>mean something.</em>
          </h1>
          <p className="intro-copy">
            Shape your gathering. Set a fair commitment. Make the rules clear before anyone joins.
          </p>
        </div>
        <div className="scope-banner">
          <span className="status-dot" aria-hidden="true" />
          <p>
            <span>
              {persistence
                ? "Isolated development harness. Drafts save to this browser workspace for 24 hours of access. Use fictional event details only."
                : "Plan and validate an event. This preview stays on this page and is lost on refresh."}
            </span>
            <span> Authentication, publication and funding are unavailable.</span>
          </p>
        </div>
        <p>
          <Link href="/account">Account and host access</Link>
        </p>
        <div className="workspace-grid">
          <div className="editor-column">
            <div className="editor-topline">
              <span className="eyebrow">Event draft</span>
              <span className="draft-state">
                {identity
                  ? `Revision ${identity.revision}${dirty ? " · unsaved changes" : " · saved"}`
                  : "Not saved"}
              </span>
            </div>
            <nav className="section-nav" aria-label="Draft sections">
              <a href="#details">01 Details</a>
              <a href="#commitment-section">02 Commitment</a>
              <a href="#participation">03 Participation</a>
            </nav>
            <form noValidate onSubmit={submit} id="event-form" aria-label="Event draft">
              {showValidation && Object.keys(errors).length > 0 && (
                <div
                  className="error-summary feedback-card"
                  id="draft-errors"
                  tabIndex={-1}
                  role="alert"
                  aria-label="Draft validation errors"
                >
                  <h2>
                    {`Check ${Object.keys(errors).length} ${Object.keys(errors).length === 1 ? "field" : "fields"} before continuing`}
                  </h2>
                  <ul>
                    {Object.entries(errors).map(([name, message]) => (
                      <li key={name}>
                        <a
                          href={`#${name}`}
                          onClick={() => {
                            setShowValidation(false);
                            requestAnimationFrame(() => document.getElementById(name)?.focus());
                          }}
                        >
                          {`${errorFieldLabel(name)}: ${message}`}
                        </a>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setShowValidation(false)}
                  >
                    Return to editing; keep inline errors
                  </button>
                </div>
              )}
              <DetailsFields draft={draft} errors={errors} change={change} />
              <CommitmentFields draft={draft} errors={errors} change={change} />
              <ParticipationFields draft={draft} errors={errors} change={change} />
              <div className="form-footer">
                <p role="status" aria-live="polite">
                  {status ||
                    (dirty
                      ? "Draft changes have not been saved."
                      : "Your saved revision is current.")}
                </p>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busy || conflict || (persistence && !ready)}
                >
                  {busy ? "Saving…" : persistence ? "Validate & save draft" : "Check draft rules"}
                  <span aria-hidden="true">↗</span>
                </button>
                <p className="hint">No publication, wallet action or funding takes place.</p>
              </div>
            </form>
            {!showValidation && Object.keys(errors).length > 0 && (
              <button type="button" className="text-button" onClick={() => showErrors(errors)}>
                Review validation errors
              </button>
            )}
            {conflict && (
              <section
                className="error-summary feedback-card"
                role="alert"
                aria-label="Newer saved draft"
              >
                <h2>A newer saved version exists</h2>
                <p>Your edits are preserved here. The newer save has not been overwritten.</p>
                <p>
                  Reloading asks before discarding your unsaved edits. Cancel to keep them for
                  reference.
                </p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const items = await loadSaved();
                      const latest = items.find((item) => item.id === identity?.id);
                      if (latest) openDraft(latest);
                      else
                        setStatus(
                          "Saved draft unavailable. Your edits remain; reconnect or start a new draft.",
                        );
                    } catch {
                      setStatus(
                        "Could not reload storage. Your edits remain; retry when connected.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Load newer saved version
                </button>
                <button type="button" className="text-button" onClick={() => setConflict(false)}>
                  Keep my edits for reference
                </button>
              </section>
            )}
            {confirmation && (
              <SaveConfirmation draft={confirmation} onClose={() => setConfirmation(null)} />
            )}
            {persistence && (
              <section className="saved-panel" aria-label="Saved drafts">
                <h2>In this browser workspace</h2>
                <p className="hint">
                  50 most recent drafts. Access expires after 24 hours; refresh restores saved
                  revisions. Unsaved edits stay on this page.
                </p>
                <div className="saved-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => openDraft()}
                  >
                    New draft
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      loadSaved()
                        .then(() => setStatus("Storage reconnected."))
                        .catch(() =>
                          setStatus("Storage unavailable. Check the local database and retry."),
                        )
                    }
                  >
                    Reconnect storage
                  </button>
                </div>
                <ul>
                  {saved.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="saved-draft"
                        disabled={busy}
                        onClick={() => openDraft(item)}
                      >
                        <span>{item.data.title}</span>
                        <span>{`Revision ${item.revision} ↗`}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="text-button danger"
                  disabled={busy || !ready}
                  onClick={clearWorkspace}
                >
                  Clear this local workspace
                </button>
              </section>
            )}
          </div>
          <RulePreview draft={draft} />
        </div>
        <footer className="page-footer">
          <span className="brand">showup.</span>
          <p>Less uncertainty. More people who mean it.</p>
          <span>Local draft edition / 01</span>
        </footer>
      </main>
    </>
  );
}
