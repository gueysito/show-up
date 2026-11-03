"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Invitation = {
  kind: string;
  eventId: string | null;
  expiresAt: string;
  revoked: boolean;
  redeemed: boolean;
  eventTitle?: string | null;
  startsAt?: string | null;
  timeZone?: string | null;
};

function invitationTime(value: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  } catch {
    return "Confirm the planned time with the host";
  }
}

export function InvitationRedemption() {
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [accountReference, setAccountReference] = useState("");
  const [status, setStatus] = useState("Reading invitation…");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(true);
  const operationId = useRef<string | null>(null);
  const preparation = useRef<Promise<Response> | null>(null);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    async function load() {
      const current = ++sequence;
      // Fragment capabilities never reach HTTP access logs or referrers.
      const value = location.hash.slice(1);
      if (value) {
        history.replaceState(null, "", location.pathname);
        preparation.current = fetch("/api/invitations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "prepare", token: value }),
        });
      }
      if (preparation.current && !(await preparation.current).ok)
        throw new Error("Invitation unavailable. Reopen a valid link.");
      const response = await fetch("/api/invitations?pending=1", { cache: "no-store" });
      if (!response.ok)
        throw new Error("Invitation service is unavailable. Reopen the link and retry.");
      const result = await response.json();
      if (!active || current !== sequence) return;
      setInvitation(result.invitation);
      setSignedIn(result.signedIn);
      setAccountReference(result.accountReference ?? "");
      setStatus(
        result.invitation
          ? "Review the access grant before accepting."
          : "Open your original invitation link to continue.",
      );
    }
    function startLoad() {
      void load()
        .catch((error) => {
          if (active) setStatus(error.message);
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }
    function onHashChange() {
      setBusy(true);
      setConsent(false);
      operationId.current = null;
      startLoad();
    }
    startLoad();
    window.addEventListener("hashchange", onHashChange);
    return () => {
      active = false;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  async function redeem() {
    setBusy(true);
    operationId.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "redeem", consent, operationId: operationId.current }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Access was not confirmed. Retry.");
      setInvitation(null);
      setStatus(
        result.kind === "host"
          ? "Host access confirmed. Open your host workspace."
          : result.kind === "validator"
            ? "Validator assignment confirmed for this event. It is fixed at publication and grants no funding, payout or host authority."
            : "Event access confirmed. No seat is funded or reserved.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Access was not confirmed. Retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Invitation redemption">
      <p role="status">{status}</p>
      {invitation && (
        <>
          {invitation.eventTitle && <p>{`Event: ${invitation.eventTitle}`}</p>}
          {invitation.startsAt && (
            <p>{`Planned start: ${invitationTime(invitation.startsAt, invitation.timeZone ?? "UTC")} (${invitation.timeZone ?? "UTC"})`}</p>
          )}
          <p>
            {invitation.kind === "host"
              ? "Grant: host access to create and manage your own events."
              : invitation.kind === "validator"
                ? "Grant: validate physical attendance for one event after publication. You cannot earn this event's attendee rewards. No wallet, funding or host authority is granted."
                : "Grant: access to one event. Funding and capacity are separate."}
          </p>
          <p>{`Unused link expires: ${new Date(invitation.expiresAt).toLocaleString()}`}</p>
          {invitation.revoked && <p role="alert">This unused link was revoked.</p>}
          {signedIn ? (
            <>
              <p>{`Accepting account reference: ${accountReference}`}</p>
              <label className="consent-field">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I accept this access grant for my signed-in account. Messaging consent is separate.
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !consent || invitation.revoked}
                onClick={redeem}
              >
                Accept invitation
              </button>
            </>
          ) : (
            <div>
              <p>
                <Link href="/account">Sign in, then return to this invitation</Link>
              </p>
              <p>The link is retained privately for 15 minutes.</p>
            </div>
          )}
        </>
      )}
      <p>
        <Link href="/host">Open host workspace</Link>
      </p>
      <p>
        <Link href="/account">Account and sign-in</Link>
      </p>
    </section>
  );
}
