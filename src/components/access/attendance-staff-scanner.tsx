"use client";

import { useEffect, useRef, useState } from "react";
import type QrScanner from "qr-scanner";
import { personalAttendanceQr } from "../../domain/attendance-qr";
import type { StaffAttendanceEvent } from "../../server/attendance/staff";
import type { QrInspection } from "../../server/attendance/qr";
import { AttendanceTimes } from "./event-time";

type Scan = { action: "scan"; eventId: string; operationId: string; payload: string };
type Confirmation = {
  action: "confirm";
  eventId: string;
  operationId: string;
  scanId: string;
  confirmPresence: true;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Camera = {
  generation: number;
  scanner: QrScanner | null;
  stream: MediaStream | null;
  video: HTMLVideoElement | null;
  timer: ReturnType<typeof setTimeout> | undefined;
};
function releaseCamera(current: Camera) {
  current.generation++;
  clearTimeout(current.timer);
  if (current.scanner) {
    void current.scanner.pause(true);
    current.scanner.destroy();
    current.scanner.$canvas.width = 0;
    current.scanner = null;
  }
  current.stream?.getTracks().forEach((track) => track.stop());
  current.stream = null;
  if (current.video) {
    current.video.pause();
    current.video.srcObject = null;
  }
  current.video = null;
}
export function AttendanceStaffScanner({ event }: { event: StaffAttendanceEvent }) {
  const video = useRef<HTMLVideoElement>(null),
    lifecycle = useRef({ generation: 0, active: null as AbortController | null }),
    camera = useRef<Camera>({
      generation: 0,
      scanner: null as QrScanner | null,
      stream: null,
      video: null,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }),
    pending = useRef<Scan | Confirmation | null>(null),
    [cameraOn, setCameraOn] = useState(false),
    [videoGeneration, setVideoGeneration] = useState(0),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(false),
    [inspection, setInspection] = useState<QrInspection | null>(null),
    [present, setPresent] = useState(false),
    [expired, setExpired] = useState(false),
    [recorded, setRecorded] = useState(false),
    [locked, setLocked] = useState(false),
    [notice, setNotice] = useState("");
  function stopCamera() {
    releaseCamera(camera.current);
    setVideoGeneration((value) => value + 1);
    setCameraOn(false);
  }
  useEffect(() => {
    const current = lifecycle.current,
      currentCamera = camera.current;
    const clear = () => {
      current.generation++;
      current.active?.abort();
      current.active = null;
      releaseCamera(currentCamera);
      setVideoGeneration((value) => value + 1);
      pending.current = null;
      setCameraOn(false);
      setBusy(false);
      setRetry(false);
      setInspection(null);
      setPresent(false);
      setExpired(false);
      setRecorded(false);
      setNotice("");
    };
    const hidden = () => {
      if (document.hidden) clear();
    };
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", restore);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clear();
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", restore);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    if (!inspection) return;
    const timer = setTimeout(
      () => {
        setExpired(true);
        setPresent(false);
      },
      Math.max(0, inspection.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [inspection]);
  async function send(attempt: Scan | Confirmation) {
    if (lifecycle.current.active || locked) return;
    const controller = new AbortController(),
      generation = lifecycle.current.generation;
    pending.current = attempt;
    lifecycle.current.active = controller;
    setBusy(true);
    setRetry(true);
    setNotice("");
    const timer = setTimeout(() => controller.abort(), 15000);
    const resolve = () => {
      pending.current = null;
      setRetry(false);
    };
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
      const scanned = attempt.action === "scan" ? personalAttendanceQr(attempt.payload) : null;
      if (
        response.status === 202 &&
        result?.eventId === event.eventId &&
        result.attendanceConfirmed === false &&
        attempt.action === "scan" &&
        scanned &&
        result.status === "presence_confirmation_required" &&
        typeof result.scanId === "string" &&
        uuid.test(result.scanId) &&
        typeof result.alias === "string" &&
        /^Attendee [0-9a-f]{16}$/.test(result.alias) &&
        result.expiresAt === scanned.expiresAt
      ) {
        resolve();
        setPresent(false);
        setExpired(false);
        if (result.expiresAt > Date.now()) {
          setInspection({
            scanId: result.scanId,
            eventId: event.eventId,
            alias: result.alias,
            expiresAt: result.expiresAt,
            status: "presence_confirmation_required",
            attendanceConfirmed: false,
          });
          setNotice("Scan checked. Confirm presence separately while this QR is still valid.");
        } else setNotice("The scanned QR expired. Ask the attendee for a fresh QR and scan again.");
      } else if (
        response.status === 202 &&
        attempt.action === "confirm" &&
        result?.eventId === event.eventId &&
        result.scanId === attempt.scanId &&
        result.status === "pending_contract" &&
        result.attendanceConfirmed === false &&
        result.liveSubmissionAllowed === false &&
        (result.classification === "on_time" || result.classification === "late") &&
        typeof result.receivedAt === "string" &&
        Number.isFinite(Date.parse(result.receivedAt))
      ) {
        resolve();
        setInspection(null);
        setPresent(false);
        setRecorded(true);
        setNotice(
          "Presence request recorded. Attendance confirmation is still pending. No deposit or attendance is confirmed here.",
        );
      } else if (response.status >= 400 && response.status < 500) {
        resolve();
        setInspection(null);
        setPresent(false);
        if (response.status === 401 || response.status === 403) setLocked(true);
        setNotice(
          response.status === 401 || response.status === 403
            ? "Review your account access before scanning again."
            : "This QR action was not accepted. Ask for a fresh QR and review the event window before scanning again.",
        );
      } else
        setNotice(
          "The response could not be verified. Attendance is not confirmed. Retry the same QR action.",
        );
    } catch {
      if (generation === lifecycle.current.generation)
        setNotice(
          "The action was not acknowledged. Attendance is not confirmed. Retry the same QR action.",
        );
    } finally {
      clearTimeout(timer);
      if (generation === lifecycle.current.generation) {
        lifecycle.current.active = null;
        setBusy(false);
      }
    }
  }
  async function startCamera() {
    if (
      camera.current.scanner ||
      cameraOn ||
      lifecycle.current.active ||
      pending.current ||
      locked ||
      inspection ||
      recorded ||
      document.hidden
    )
      return;
    const generation = ++camera.current.generation;
    setCameraOn(true);
    setNotice("");
    camera.current.timer = setTimeout(() => {
      stopCamera();
      setNotice("Camera stopped after one minute. Start it again when the attendee is ready.");
    }, 60000);
    try {
      const { default: Scanner } = await import("qr-scanner");
      if (generation !== camera.current.generation || !video.current || document.hidden) return;
      // Own one permission request per explicit start. The decoder's built-in
      // acquisition loop retries six constraint sets, even after a denial.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      if (generation !== camera.current.generation || !video.current || document.hidden) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      camera.current.stream = stream;
      camera.current.video = video.current;
      video.current.srcObject = stream;
      const scanner = new Scanner(
        video.current,
        (result) => {
          if (generation !== camera.current.generation) return;
          stopCamera();
          const qr = personalAttendanceQr(result.data);
          if (
            !qr ||
            qr.eventId !== event.eventId ||
            qr.expiresAt <= Date.now() ||
            qr.expiresAt > Date.now() + 65000
          ) {
            setNotice(
              "Scan a current personal QR for this event. Links and other QR codes are not opened.",
            );
            return;
          }
          void send({
            action: "scan",
            eventId: event.eventId,
            operationId: crypto.randomUUID(),
            payload: result.data,
          });
        },
        {
          returnDetailedScanResult: true,
          preferredCamera: "environment",
          maxScansPerSecond: 5,
          onDecodeError: () => {},
        },
      );
      camera.current.scanner = scanner;
      await scanner.start();
    } catch {
      if (generation === camera.current.generation) {
        stopCamera();
        setNotice(
          "Camera unavailable. Check browser camera permission and use HTTPS, then try again.",
        );
      }
    }
  }
  return (
    <section aria-label="Staff QR scan controls">
      <h3>Scan and confirm presence</h3>
      <AttendanceTimes schedule={event} timeZone={event.timeZone} />
      <p>The server checks the published window.</p>
      <p>
        The camera starts only when you choose. Video is processed on this device; no audio is
        requested and no frames are uploaded. It stops after a scan, one minute, tab hiding or
        leaving this page.
      </p>
      <video
        key={videoGeneration}
        ref={video}
        muted
        playsInline
        hidden={!cameraOn}
        aria-label="Attendance QR camera preview"
        style={{ width: "100%", maxWidth: 480 }}
      />
      {cameraOn ? (
        <button className="secondary-button" onClick={stopCamera}>
          Stop camera
        </button>
      ) : (
        !inspection &&
        !retry &&
        !recorded &&
        !locked && (
          <button className="secondary-button" onClick={() => void startCamera()}>
            Start camera to scan QR
          </button>
        )
      )}
      {inspection && (
        <section aria-label="Scanned attendee presence">
          <p style={{ overflowWrap: "anywhere" }}>
            {`Scanned alias: ${inspection.alias}. Attendance not confirmed.`}
          </p>
          {expired && (
            <p role="status">This scan expired. A fresh QR is required for a new confirmation.</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (present && !expired && !pending.current && !busy)
                void send({
                  action: "confirm",
                  eventId: event.eventId,
                  operationId: crypto.randomUUID(),
                  scanId: inspection.scanId,
                  confirmPresence: true,
                });
            }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44 }}>
              <input
                type="checkbox"
                checked={present}
                disabled={busy || retry || expired}
                onChange={(e) => setPresent(e.target.checked)}
              />
              <span>I checked that this person is physically present at this event.</span>
            </label>
            <button
              className="secondary-button"
              type="submit"
              disabled={!present || busy || retry || expired}
            >
              Record presence request
            </button>
          </form>
          {!retry && (
            <button
              className="text-button"
              onClick={() => {
                setInspection(null);
                setPresent(false);
                setExpired(false);
                setNotice("");
              }}
            >
              Discard scan and ask for a fresh QR
            </button>
          )}
        </section>
      )}
      {retry && (
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => {
            if (pending.current) void send(pending.current);
          }}
        >
          {busy ? "Checking QR action…" : "Retry the same QR action"}
        </button>
      )}
      {recorded && (
        <button
          className="secondary-button"
          onClick={() => {
            setRecorded(false);
            setNotice("");
          }}
        >
          Scan next person
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {locked && <a href="/account">Review your account</a>}
    </section>
  );
}
