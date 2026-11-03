"use client";

import { useEffect, useRef, useState } from "react";
import { personalAttendanceQr } from "../../domain/attendance-qr";

export function AttendancePersonalQr({
  eventId,
  consentId,
}: {
  eventId: string;
  consentId: string;
}) {
  const [payload, setPayload] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(false),
    [locked, setLocked] = useState(false),
    [notice, setNotice] = useState(""),
    canvas = useRef<HTMLCanvasElement>(null),
    pending = useRef<{
      action: "issue";
      eventId: string;
      consentId: string;
      operationId: string;
    } | null>(null),
    lifecycle = useRef({ generation: 0, active: null as AbortController | null });
  useEffect(() => {
    const current = lifecycle.current;
    const clear = () => {
      current.generation++;
      current.active?.abort();
      current.active = null;
      pending.current = null;
      // Clear pixels synchronously before a page can be retained in history.
      if (canvas.current) canvas.current.width = 0;
      setPayload(null);
      setBusy(false);
      setRetry(false);
      setNotice("");
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", restore);
    document.addEventListener("visibilitychange", hide);
    function hide() {
      if (document.hidden) clear();
    }
    return () => {
      current.generation++;
      current.active?.abort();
      pending.current = null;
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", restore);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  useEffect(() => {
    if (!payload) return;
    const qr = personalAttendanceQr(payload),
      target = canvas.current,
      generation = lifecycle.current.generation;
    if (!qr || !target) return;
    let active = true;
    const expire = () => {
      active = false;
      target.width = 0;
      setPayload(null);
      setNotice("This personal QR expired. Request a fresh QR when staff are ready.");
    };
    const timer = setTimeout(expire, Math.max(0, qr.expiresAt - Date.now()));
    void import("qrcode-generator")
      .then(({ default: qrcode }) => {
        if (
          !active ||
          generation !== lifecycle.current.generation ||
          document.hidden ||
          Date.now() >= qr.expiresAt
        )
          return;
        const image = qrcode(0, "M");
        image.addData(payload, "Byte");
        image.make();
        const modules = image.getModuleCount(),
          cell = 4,
          margin = 4;
        target.width = target.height = (modules + margin * 2) * cell;
        const context = target.getContext("2d");
        if (!context) throw new Error("Canvas unavailable");
        context.fillStyle = "white";
        context.fillRect(0, 0, target.width, target.height);
        context.fillStyle = "black";
        for (let row = 0; row < modules; row++)
          for (let column = 0; column < modules; column++)
            if (image.isDark(row, column))
              context.fillRect((column + margin) * cell, (row + margin) * cell, cell, cell);
      })
      .catch(() => {
        if (active && generation === lifecycle.current.generation) {
          target.width = 0;
          setPayload(null);
          setNotice("The QR could not be displayed. Request a fresh QR to try again.");
        }
      });
    return () => {
      active = false;
      clearTimeout(timer);
      target.width = 0;
    };
  }, [payload]);
  async function issue() {
    if (lifecycle.current.active || locked || payload) return;
    const attempt = pending.current ?? {
        action: "issue" as const,
        eventId,
        consentId,
        operationId: crypto.randomUUID(),
      },
      controller = new AbortController(),
      generation = lifecycle.current.generation;
    pending.current = attempt;
    lifecycle.current.active = controller;
    setBusy(true);
    setRetry(true);
    setNotice("");
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/attendance/qr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt),
        cache: "no-store",
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (generation !== lifecycle.current.generation) return;
      const parsed = personalAttendanceQr(result?.payload);
      if (
        response.status === 202 &&
        result?.status === "scan_required" &&
        result.attendanceConfirmed === false &&
        result.liveSubmissionAllowed === false &&
        result.environment === "sandbox" &&
        parsed?.eventId === eventId &&
        parsed.expiresAt === result.expiresAt &&
        parsed.expiresAt <= Date.now() + 65_000
      ) {
        pending.current = null;
        setRetry(false);
        if (parsed.expiresAt > Date.now()) {
          setPayload(result.payload);
          setNotice("Show this QR only to your event's staff. Attendance is not confirmed.");
        } else {
          setNotice("This personal QR expired. Request a fresh QR when staff are ready.");
        }
      } else if (response.status >= 400 && response.status < 500) {
        pending.current = null;
        setRetry(false);
        if (response.status === 401 || response.status === 403) setLocked(true);
        setNotice(
          response.status === 401 || response.status === 403
            ? "Review your account access before requesting a personal QR."
            : "A personal QR is unavailable for this authorization. Review the event window and your saved records.",
        );
      } else {
        setNotice(
          "The QR response could not be verified. Attendance is not confirmed. Retry the same request.",
        );
      }
    } catch {
      if (generation === lifecycle.current.generation)
        setNotice(
          "The request was not acknowledged. Attendance is not confirmed. Retry the same request.",
        );
    } finally {
      clearTimeout(timer);
      if (generation === lifecycle.current.generation) {
        lifecycle.current.active = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="saved-panel" aria-label="Personal attendance QR">
      <h3>Show your personal QR to staff</h3>
      <p>
        Request it when you are with your event&apos;s staff. It lasts at most one minute. Staff
        must scan it and separately confirm that you are present.
      </p>
      <p>
        A QR does not confirm your deposit, book a seat or confirm attendance. Never share a
        screenshot.
      </p>
      {payload && (
        <canvas
          ref={canvas}
          role="img"
          aria-label="Private personal attendance QR"
          style={{ maxWidth: "100%", height: "auto", imageRendering: "pixelated" }}
        />
      )}
      {!payload && !locked && (
        <button className="secondary-button" onClick={() => void issue()} disabled={busy}>
          {busy
            ? "Requesting personal QR…"
            : retry
              ? "Retry the same QR request"
              : "Request a personal QR"}
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {locked && <a href="/account">Review your account</a>}
    </section>
  );
}
