"use client";

import { useState } from "react";
import type { HostCodeWindow } from "../../server/attendance/codes";

export function HostCodeWindowManager({ eventId }: { eventId: string }) {
  const [phrase, setPhrase] = useState("");
  const [current, setCurrent] = useState<HostCodeWindow | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{
    operationId: string;
    eventId: string;
    phrase: string;
  } | null>(null);

  async function loadCurrent() {
    const response = await fetch(`/api/attendance/codes?event=${eventId}`, { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Code status is unavailable. Retry.");
    setCurrent(result.window);
    return result.window as HostCodeWindow | null;
  }
  async function revealCurrent() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const window = await loadCurrent();
      setStatus(
        window
          ? "Current code loaded. Check its closing time below."
          : "No code has been opened yet.",
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Code status is unavailable. Retry.");
    } finally {
      setBusy(false);
    }
  }
  async function activate() {
    setBusy(true);
    setError("");
    setStatus("");
    const attempt = pending ?? { operationId: crypto.randomUUID(), eventId, phrase };
    setPending(attempt);
    try {
      const response = await fetch("/api/attendance/codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status < 500) setPending(null);
        throw new Error(result.error ?? "Code activation was not confirmed. Retry.");
      }
      // Read current state after an original-operation replay; a different tab
      // may have rotated the code since the original response was lost.
      await loadCurrent();
      setPending(null);
      setPhrase("");
      setStatus("Code window opened. Reveal the phrase verbally during the event.");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Activation was not confirmed. Retry the same attempt.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="saved-panel" aria-label="Online attendance code">
      <h3>Online attendance code</h3>
      <p>
        Open a fresh word or short phrase for three minutes, ending sooner at the published check-in
        cutoff. Each phrase can be used for one window in this event.
      </p>
      <p>
        Only attendees with confirmed deposits can check in. Opening a code does not check anyone
        in.
      </p>
      <button type="button" className="secondary-button" disabled={busy} onClick={revealCurrent}>
        Show current code
      </button>
      {current && (
        <div aria-label="Last checked code window">
          <p>{`Phrase: ${current.phrase}`}</p>
          <p>{`Closes: ${new Date(current.expiresAt).toISOString()} (UTC)`}</p>
          <p>{current.active ? "Open when last checked." : "This code window is closed."}</p>
          <p>
            Refresh with Show current code after changing it in another tab. A displayed phrase does
            not extend its closing time.
          </p>
        </div>
      )}
      <div className="field">
        <label htmlFor="new-attendance-code">Fresh word or phrase</label>
        <input
          id="new-attendance-code"
          value={phrase}
          maxLength={80}
          autoComplete="off"
          disabled={busy || pending !== null}
          onChange={(event) => setPhrase(event.target.value)}
        />
      </div>
      <button
        type="button"
        className="secondary-button"
        disabled={busy || (!phrase.trim() && !pending)}
        onClick={activate}
      >
        {pending ? "Retry the same code activation" : "Open fresh code window"}
      </button>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
