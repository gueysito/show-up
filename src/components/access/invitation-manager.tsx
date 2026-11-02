"use client";

import { useEffect, useRef, useState } from "react";

type Invitation = {
  id: string;
  kind: string;
  eventId: string | null;
  expiresAt: string;
  revokedAt: string | null;
  redeemed: boolean;
};

export function InvitationManager({
  canIssueHost,
  eventId,
}: {
  canIssueHost: boolean;
  eventId?: string;
}) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ serialized: string; operationId: string } | null>(null);

  async function refresh() {
    const response = await fetch("/api/invitations", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Invitation list unavailable.");
    setInvitations(result.invitations);
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/invitations", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result = await response.json();
        setInvitations(result.invitations);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setStatus("Invitation list unavailable. Retry when connected.");
      });
    return () => controller.abort();
  }, []);

  async function act(input: Record<string, string>) {
    setBusy(true);
    const serialized = JSON.stringify(input);
    if (pending.current?.serialized !== serialized)
      pending.current = { serialized, operationId: crypto.randomUUID() };
    try {
      const response = await fetch("/api/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, operationId: pending.current.operationId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Invitation action was not confirmed.");
      if (result.url) setUrl(result.url);
      pending.current = null;
      setStatus(
        result.url
          ? "Invitation issued. Copy the private single-use link; no message was sent."
          : "Unused invitation revoked.",
      );
      await refresh().catch(() =>
        setStatus("Action confirmed. The list could not refresh; reconnect to see current status."),
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Action was not confirmed. Retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="saved-panel" aria-label="Invitation controls">
      <h2>Invitations</h2>
      <p>
        Links grant account access only. Unused links reserve no capacity. No external message is
        sent.
      </p>
      <p role="status">{status}</p>
      {canIssueHost && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => act({ operation: "issue", kind: "host" })}
        >
          Issue host invitation
        </button>
      )}
      {eventId && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => act({ operation: "issue", kind: "event", eventId })}
        >
          Issue attendee invitation
        </button>
      )}
      {url && (
        <div>
          <label htmlFor="issued-invitation">Private invitation link</label>
          <input
            id="issued-invitation"
            data-private="true"
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
          <button
            type="button"
            className="secondary-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setStatus("Invitation link copied. No message was sent.");
              } catch {
                setStatus("Select the private link and copy it manually.");
              }
            }}
          >
            Copy invitation link
          </button>
        </div>
      )}
      <ul>
        {invitations
          .filter((item) => !eventId || item.eventId === eventId)
          .map((item) => (
            <li key={item.id}>
              <p>{`${item.kind === "host" ? "Host" : "Event"} invitation · ${item.redeemed ? "Redeemed" : item.revokedAt ? "Revoked" : "Unused"} · expires ${new Date(item.expiresAt).toLocaleString()}`}</p>
              <button
                type="button"
                className="text-button danger"
                disabled={busy || item.redeemed || Boolean(item.revokedAt)}
                onClick={() => {
                  if (
                    window.confirm(
                      "Revoke this unused invitation? Existing account access and obligations are unaffected.",
                    )
                  )
                    void act({ operation: "revoke", id: item.id });
                }}
              >
                Revoke unused invitation
              </button>
            </li>
          ))}
      </ul>
    </section>
  );
}
