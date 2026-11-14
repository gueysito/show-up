"use client";
import { useEffect, useState } from "react";

/** Advance a server timestamp using elapsed time, independent of device clock changes. */
export function useServerClock(serverNow?: number) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(serverNow)) return;
    const started = performance.now();
    const tick = () => setNow(serverNow! + performance.now() - started);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [serverNow]);
  return now;
}
