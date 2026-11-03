"use client";

import Link from "next/link";
import { useRef, useState } from "react";

export function TelegramCheckIn({ eventId, consentId }: { eventId: string; consentId: string }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const operation = useRef<string | null>(null);
  async function send() {
    setBusy(true);
    setMessage("");
    operation.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/telegram/attendance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ eventId, consentId, operationId: operation.current }),
        }),
        result = await response.json();
      if (!response.ok) {
        if (response.status < 500) operation.current = null;
        throw new Error(
          result.error ??
            "The prompt was not confirmed. Retry the same request or use website check-in.",
        );
      }
      setMessage(
        result.status === "sent"
          ? "Telegram accepted the event check-in prompt. Reply to that message with the host's current phrase. Attendance still needs verification."
          : "Review your existing event prompt or use website check-in. Message delivery is not confirmed; another message was not sent.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The prompt was not confirmed. Website check-in remains available.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Optional Telegram check-in">
      <p>
        <Link href={`/account/telegram?event=${eventId}`} prefetch={false}>
          Manage optional Telegram messages for this event
        </Link>
      </p>
      <button type="button" className="text-button" disabled={busy} onClick={() => void send()}>
        Send this event&apos;s check-in prompt to Telegram
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
