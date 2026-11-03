"use client";

import { useEffect, useRef, useState } from "react";

type Status = { connected: boolean; available: boolean; botUsername: string | null };
export function TelegramConnection({ initialStatus }: { initialStatus: Status | null }) {
  const [status, setStatus] = useState<Status | null>(initialStatus),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [link, setLink] = useState<{ deepLink: string; expiresAt: string } | null>(null);
  const pending = useRef<{ action: "connect" | "disconnect"; operationId: string } | null>(null),
    generation = useRef(0);
  async function refresh() {
    const current = generation.current;
    try {
      const response = await fetch("/api/telegram/connection", { cache: "no-store" }),
        data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Connection status is unavailable. Retry.");
      if (current !== generation.current) return;
      setStatus(data);
      if (data.connected) {
        setLink(null);
        pending.current = null;
        setConsent(false);
      }
    } catch (error) {
      if (current === generation.current)
        setMessage(
          error instanceof Error ? error.message : "Connection status is unavailable. Retry.",
        );
    }
  }
  useEffect(() => {
    const invalidate = () => {
      generation.current++;
    };
    const hide = () => {
      invalidate();
      pending.current = null;
      setLink(null);
      setConsent(false);
      setBusy(false);
    };
    window.addEventListener("pagehide", hide);
    return () => {
      invalidate();
      window.removeEventListener("pagehide", hide);
    };
  }, []);
  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(
      () => {
        setLink(null);
        pending.current = null;
        setMessage(
          "Connection link expired. Create a new link if you still want Telegram messages.",
        );
      },
      Math.max(0, Date.parse(link.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [link]);
  async function change(action: "connect" | "disconnect") {
    const current = generation.current;
    setBusy(true);
    setMessage("");
    if (!pending.current || pending.current.action !== action)
      pending.current = { action, operationId: crypto.randomUUID() };
    try {
      const response = await fetch("/api/telegram/connection", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...pending.current,
            ...(action === "connect" ? { consentMessages: consent } : {}),
          }),
        }),
        data = await response.json();
      if (current !== generation.current) return;
      if (!response.ok) {
        if (response.status < 500) pending.current = null;
        throw new Error(
          data.error ?? "The connection action was not confirmed. Retry the same action.",
        );
      }
      if (action === "connect") {
        const url = new URL(data.deepLink);
        if (
          url.origin !== "https://t.me" ||
          !/^\/[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/.test(url.pathname) ||
          url.searchParams.size !== 1 ||
          !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("start") ?? "") ||
          url.hash ||
          url.username ||
          url.password ||
          !Number.isFinite(Date.parse(data.expiresAt)) ||
          Date.parse(data.expiresAt) <= Date.now()
        )
          throw new Error(
            "A valid connection link was not confirmed. Refresh before trying again.",
          );
        setLink(data);
        setMessage(
          "Open Telegram and press Start with the same Telegram identity linked here. Return to this page and refresh status.",
        );
      } else {
        setLink(null);
        setConsent(false);
        pending.current = null;
        setMessage(
          "Telegram messages disconnected. Your Showup account and Telegram sign-in remain available.",
        );
        await refresh();
      }
    } catch (error) {
      if (current === generation.current)
        setMessage(
          error instanceof Error
            ? error.message
            : "The connection action was not confirmed. Retry.",
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Optional Telegram messages" className="saved-panel">
      <h2>Optional Telegram messages</h2>
      <p>
        Telegram is optional. You can use Showup on the website. Connecting messages does not
        authorize a deposit or confirm attendance.
      </p>
      {status?.connected ? (
        <>
          <p role="status">{`Connected to @${status.botUsername}.`}</p>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void change("disconnect")}
          >
            Disconnect Telegram messages
          </button>
        </>
      ) : (
        <>
          {status && !status.available && (
            <p>
              Telegram messages are currently unavailable. Website participation remains available.
            </p>
          )}
          <label className="check-label">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy || !status?.available || Boolean(link)}
              onChange={(event) => setConsent(event.target.checked)}
            />
            I want optional event reminders and check-in prompts in my Telegram chat.
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !status?.available || !consent || Boolean(link)}
            onClick={() => void change("connect")}
          >
            Create Telegram connection link
          </button>
          {link && (
            <p>
              <a
                href={link.deepLink}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                Open your private Telegram connection
              </a>
            </p>
          )}
        </>
      )}
      <button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>
        Refresh connection status
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
