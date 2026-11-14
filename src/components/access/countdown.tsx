"use client";
import { useServerClock } from "./server-clock";
import { DotText } from "../dot-text";

export function remainingSeconds(deadline: number, now: number) {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Counts down to an instant in dot-matrix digits and warns near the end.
 * Server time anchors the countdown independently of the device clock.
 */
export function Countdown({
  until,
  label,
  warnBelow = 60,
  serverNow,
}: {
  until: string;
  label: string;
  warnBelow?: number;
  serverNow?: number;
}) {
  const now = useServerClock(serverNow);
  if (!now) return null;
  const left = remainingSeconds(Date.parse(until), now);
  const low = left > 0 && left < warnBelow;
  return (
    <span className="countdown" data-low={low} role="timer" aria-label={label}>
      <span className="dot-number">
        <DotText value={clock(left)} />
      </span>
      {low && <span className="countdown-tag">Expiring soon</span>}
      {left === 0 && <span className="countdown-tag">Expired</span>}
    </span>
  );
}
