"use client";
import { useRef } from "react";
import { DotText } from "../dot-text";
import { clock, remainingSeconds } from "./countdown";

/**
 * The host's check-in code, sized for a room or a stream, with a read-aloud card
 * for audio-only events. The countdown uses the device clock against the server's
 * closing time. docs/plan.md tracks moving it to server time.
 */
export function LiveCode({
  code,
  expiresAt,
  now,
}: {
  code: string;
  expiresAt: string;
  now: number;
}) {
  const screen = useRef<HTMLDivElement>(null);
  const left = remainingSeconds(Date.parse(expiresAt), now);
  return (
    <div className="live-code">
      <div className="live-code-screen" ref={screen}>
        <div className="live-code-top">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">
              s.
            </span>
            showup
          </span>
          <span>Check-in code</span>
        </div>
        <div className="live-code-mid">
          <strong className="live-code-digits" aria-label="Live check-in code">
            {code}
          </strong>
          <span className="live-code-timer" data-low={left < 30} role="timer">
            {"Closes in "}
            <b>
              <DotText value={clock(left)} />
            </b>
          </span>
        </div>
        <p className="live-code-foot">Open your Showup event page, then type this code.</p>
      </div>
      <div className="saved-actions">
        <button type="button" onClick={() => void screen.current?.requestFullscreen?.()}>
          Show on a big screen
        </button>
      </div>
      <div className="live-code-aloud">
        <span className="eyebrow">Read this aloud</span>
        <p className="live-code-say">The check-in code is:</p>
        <p className="live-code-spell" aria-hidden="true">
          {code.split("").join(" ")}
        </p>
        <p className="hint">{`Valid until ${new Date(expiresAt).toLocaleTimeString()}.`}</p>
      </div>
    </div>
  );
}
