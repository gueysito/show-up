"use client";

import { useEffect, useRef, useState } from "react";
import type { OwnAttendanceWindow } from "../../server/commitments/records";

type Attempt = { eventId: string; consentId: string; operationId: string; phrase: string };
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function time(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}
export function AttendanceCodeEntry({
  eventId,
  consentId,
  window: schedule,
  timeZone,
}: {
  eventId: string;
  consentId: string;
  window: OwnAttendanceWindow;
  timeZone: string;
}) {
  const [phrase, setPhrase] = useState(""),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(false),
    [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null),
    [recorded, setRecorded] = useState(false),
    [signedOut, setSignedOut] = useState(false);
  const pending = useRef<Attempt | null>(null),
    lifecycle = useRef({ active: null as AbortController | null, generation: 0 }),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const current = lifecycle.current;
    const clear = () => {
      current.generation++;
      current.active?.abort();
      current.active = null;
      pending.current = null;
      if (input.current) input.current.value = "";
      setPhrase("");
      setBusy(false);
      setRetry(false);
      setNotice(null);
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", restore);
    return () => {
      current.generation++;
      current.active?.abort();
      current.active = null;
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", restore);
    };
  }, []);
  async function submit() {
    if (lifecycle.current.active || recorded || signedOut) return;
    const attempt = pending.current ?? {
        eventId,
        consentId,
        operationId: crypto.randomUUID(),
        phrase,
      },
      controller = new AbortController(),
      current = lifecycle.current.generation;
    pending.current = attempt;
    lifecycle.current.active = controller;
    setBusy(true);
    setRetry(true);
    setNotice(null);
    const timer = setTimeout(() => controller.abort(), 15000);
    const resolveAttempt = () => {
      pending.current = null;
      setRetry(false);
    };
    try {
      const response = await fetch("/api/attendance/check-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt),
        cache: "no-store",
        signal: controller.signal,
      });
      let result: Record<string, unknown> | null = null;
      try {
        result = object(await response.json());
      } catch {
        if (response.status < 400 || response.status >= 500)
          throw new Error("Unacknowledged response");
      }
      if (current !== lifecycle.current.generation) return;
      if (
        response.status === 202 &&
        result?.status === "pending_contract" &&
        result.eventId === eventId &&
        result.consentId === consentId &&
        result.attendanceConfirmed === false &&
        result.liveSubmissionAllowed === false &&
        typeof result.id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.id) &&
        (result.environment === "mainnet" || result.environment === "sandbox") &&
        (result.classification === "on_time" || result.classification === "late") &&
        typeof result.receivedAt === "string" &&
        Number.isFinite(Date.parse(result.receivedAt))
      ) {
        resolveAttempt();
        setPhrase("");
        setRecorded(true);
        setNotice({
          error: false,
          text: "Your request is recorded. Attendance confirmation is still pending. Reload to review the saved record.",
        });
        return;
      }
      if (response.status < 500 && !response.ok) {
        resolveAttempt();
        if (response.status === 401 || response.status === 403) {
          setPhrase("");
          setSignedOut(true);
          setNotice({
            error: true,
            text:
              response.status === 401
                ? "Sign in again before checking in."
                : "This account cannot check in for this event. Review your account access.",
          });
        } else if (
          result?.status === "incorrect_code" &&
          Number.isInteger(result.remainingAttempts) &&
          Number(result.remainingAttempts) >= 0 &&
          Number(result.remainingAttempts) <= 4
        ) {
          setNotice({
            error: true,
            text: `That code was not accepted. ${result.remainingAttempts} attempts remain in this code window.`,
          });
        } else if (result?.status === "attempt_limit") {
          setNotice({
            error: true,
            text: "No attempts remain in this code window. Wait for the host to open a fresh window.",
          });
        } else if (result?.status === "window_closed") {
          setNotice({
            error: true,
            text: "No fresh code window is open. Wait for the host's next code; the published cutoff still applies.",
          });
        } else {
          setNotice({
            error: true,
            text:
              typeof result?.error === "string" && result.error.length <= 240
                ? result.error
                : "The request was not accepted. Reload your event details before trying again.",
          });
        }
        return;
      }
      setNotice({
        error: true,
        text:
          response.status >= 500
            ? "Check-in is temporarily unavailable. Attendance is not confirmed. Retry the same submission later."
            : "The check-in response could not be verified. Attendance is not confirmed. Retry the same submission.",
      });
    } catch {
      if (current === lifecycle.current.generation)
        setNotice({
          error: true,
          text: "The submission was not acknowledged. Attendance is not confirmed. Retry the same submission.",
        });
    } finally {
      clearTimeout(timer);
      if (current === lifecycle.current.generation) {
        lifecycle.current.active = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="saved-panel" aria-label="Event code check-in">
      <h3>Check in with the event code</h3>
      <p>
        Enter the fresh word or phrase announced by your host. Each code lasts at most three
        minutes. The server checks your deposit and event rules before recording a request.
      </p>
      <p>{`Check-in opens ${time(schedule.opensAt, timeZone)}. On-time entry ends ${time(schedule.onTimeThrough, timeZone)}. Final cutoff ${time(schedule.cutoff, timeZone)} (${timeZone}).`}</p>
      <p>
        Submitting a code does not confirm your deposit or attendance. A late valid entry keeps
        principal protection under the published rules.
      </p>
      {!recorded && !signedOut && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="field">
            <label htmlFor={`attendance-code-${consentId}`}>Word or phrase from your host</label>
            <input
              ref={input}
              id={`attendance-code-${consentId}`}
              value={phrase}
              maxLength={80}
              autoComplete="off"
              autoCapitalize="none"
              enterKeyHint="send"
              style={{ fontSize: 16 }}
              spellCheck={false}
              disabled={busy || retry}
              onChange={(event) => setPhrase(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className="secondary-button"
            disabled={busy || (!phrase.trim() && !retry)}
          >
            {busy
              ? "Submitting code…"
              : retry
                ? "Retry the same code submission"
                : "Submit code for verification"}
          </button>
        </form>
      )}
      {notice && <p role={notice.error ? "alert" : "status"}>{notice.text}</p>}
      {signedOut && <a href="/account">Review your account</a>}
    </section>
  );
}
