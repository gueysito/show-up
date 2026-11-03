import { BrowserLocalTime } from "./browser-local-time";

// Both labels describe the same original UTC instant. Display never changes a window.
export function EventTime({ instant, timeZone }: { instant: string | number; timeZone: string }) {
  const date = new Date(instant);
  const iso = date.toISOString();
  const display = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone,
  }).format(date);
  return (
    <>
      <time dateTime={iso} data-time-zone={timeZone}>
        {`${display} (${timeZone})`}
      </time>
      <BrowserLocalTime instant={date.getTime()} eventTimeZone={timeZone} />
    </>
  );
}

export function AttendanceTimes({
  schedule,
  timeZone,
}: {
  schedule: { opensAt: string; onTimeThrough?: string; cutoff: string };
  timeZone: string;
}) {
  const rows = [
    ["Check-in opens", schedule.opensAt],
    ["On-time entry ends", schedule.onTimeThrough],
    ["Final cutoff", schedule.cutoff],
  ];
  return (
    <dl aria-label="Published check-in times">
      {rows.map(([label, instant]) =>
        instant ? (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <EventTime instant={instant} timeZone={timeZone} />
            </dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}
