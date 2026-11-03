"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeletionRequest({ intent, operationId }: { intent: string; operationId: string }) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState(""),
    [acknowledge, setAcknowledge] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function submit() {
    setBusy(true);
    try {
      const response = await fetch("/api/account/deletion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId,
          intent,
          confirmation,
          acknowledgeOnChain: acknowledge,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error ?? "Deletion was not confirmed. Reload your data page before retrying.",
        );
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Deletion was not confirmed. Reload before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Account deletion request">
      <h2>Request account deletion</h2>
      <p>
        This stops new activity and removes unneeded off-chain data. If financial or published-event
        obligations remain unverified, the minimum records and restricted access needed to resolve
        them are retained. A request does not cancel a funded commitment, erase debt or send money.
      </p>
      <p>
        When no unresolved obligations remain, off-chain identity is deleted. On-chain records
        cannot be erased. Minimal non-identifying audit records may be retained for 90 days.
      </p>
      <label htmlFor="deletion-confirmation">Type DELETE to request deletion</label>
      <input
        id="deletion-confirmation"
        value={confirmation}
        disabled={busy}
        maxLength={6}
        autoComplete="off"
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={acknowledge}
          disabled={busy}
          onChange={(event) => setAcknowledge(event.target.checked)}
        />
        I understand that on-chain records cannot be erased and unresolved payments must remain
        recoverable.
      </label>
      <button
        type="button"
        className="secondary-button"
        disabled={busy || confirmation !== "DELETE" || !acknowledge}
        onClick={submit}
      >
        {busy ? "Requesting deletion…" : "Request account deletion"}
      </button>
      <p role="status">{message}</p>
      {message && (
        <button type="button" className="secondary-button" onClick={() => router.refresh()}>
          Reload deletion confirmation
        </button>
      )}
    </section>
  );
}
