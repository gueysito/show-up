"use client";
import { useEffect, useState } from "react";
import { DotText } from "../dot-text";

export function remainingSeconds(deadline: number, now: number) {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Counts down to an instant in dot-matrix digits and warns near the end.
 * It reads the device clock. docs/plan.md tracks moving it to server time.
 */
export function Countdown({
  until,
  label,
  warnBelow = 60,
}: {
  until: string;
  label: string;
  warnBelow?: number;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  if (now === null) return null;
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
