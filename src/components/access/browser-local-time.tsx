"use client";

import { useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  window.addEventListener("focus", callback);
  return () => window.removeEventListener("focus", callback);
}
function browserTimeZone() {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function BrowserLocalTime({
  instant,
  eventTimeZone,
}: {
  instant: number;
  eventTimeZone: string;
}) {
  const zone = useSyncExternalStore<string | null>(subscribe, browserTimeZone, () => null);
  if (!zone || zone === eventTimeZone) return null;
  const date = new Date(instant);
  const display = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: zone,
  }).format(date);
  const iso = date.toISOString();
  const label = `Your time: ${display} (${zone})`;
  return (
    <span style={{ display: "block" }}>
      <time dateTime={iso} data-time-zone={zone}>
        {label}
      </time>
    </span>
  );
}
