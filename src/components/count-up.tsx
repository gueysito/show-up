"use client";
import { useEffect, useState } from "react";
import { DotText } from "./dot-text";

/** Ticks a money figure up once on load. Reduced-motion visitors see the final value. */
export function CountUp({ from, to, ms = 900 }: { from: number; to: number; ms?: number }) {
  const [value, setValue] = useState(to);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const started = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - started - 400) / ms);
      setValue(progress <= 0 ? from : from + (to - from) * progress);
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [from, to, ms]);
  return (
    <>
      <span aria-hidden="true">
        <DotText value={value.toFixed(2)} />
      </span>
      <span className="visually-hidden">{to.toFixed(2)}</span>
    </>
  );
}
