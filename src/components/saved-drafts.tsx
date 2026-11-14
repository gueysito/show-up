import Link from "next/link";
import { EventTime } from "./access/event-time";
import type { EventDraft } from "../domain/event-draft";

export type SavedDraft = {
  id: string;
  revision: number;
  data: EventDraft;
  updatedAt: string;
  state?: string;
  canManageV1?: boolean;
  registrationOpen?: boolean;
};

const eventLabels: Record<string, string> = {
  draft: "Draft",
  publication_pending: "Publishing",
  published: "Published",
  settled: "Closed",
  closed: "Closed",
  cancelled: "Cancelled",
};

export function SavedDrafts({
  saved,
  account,
  busy,
  ready,
  storageUnavailable,
  onOpen,
  onNew,
  onRefresh,
  onClear,
  onDuplicate,
}: {
  saved: SavedDraft[];
  account: boolean;
  busy: boolean;
  ready: boolean;
  storageUnavailable: boolean;
  onOpen: (item: SavedDraft) => void;
  onNew: () => void;
  onRefresh: () => void;
  onClear: () => void;
  onDuplicate: (item: SavedDraft) => void;
}) {
  return (
    <section
      id={account ? "your-events" : undefined}
      className="saved-panel"
      aria-label="Saved drafts"
    >
      <h2>{account ? "Your events" : "In this browser workspace"}</h2>
      <p className="hint">
        {account
          ? "50 most recent events owned by this account. Reopen or duplicate independently; no commitments, invitations or funds are copied."
          : "50 most recent drafts. Access expires after 24 hours; refresh restores saved revisions. Unsaved edits stay on this page."}
      </p>
      <div className="saved-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onNew}>
          New event
        </button>
        {storageUnavailable && (
          <button type="button" className="text-button" disabled={busy} onClick={onRefresh}>
            Reconnect storage
          </button>
        )}
      </div>
      <ul>
        {saved.map((item) => (
          <li key={item.id}>
            <div className="event-list-actions">
              {account &&
              item.canManageV1 &&
              item.state &&
              ["published", "closed", "settled", "cancelled"].includes(item.state) ? (
                <Link className="saved-draft" href={`/events/${item.id}/manage`}>
                  <span>{item.data.title}</span>
                  <span>{eventLabels[item.state]}</span>
                </Link>
              ) : (
                <button
                  type="button"
                  className="saved-draft"
                  disabled={busy}
                  onClick={() => onOpen(item)}
                >
                  <span>{item.data.title}</span>
                  <span>
                    {account
                      ? (eventLabels[item.state ?? "draft"] ?? "Review status")
                      : `Revision ${item.revision} ↗`}
                  </span>
                </button>
              )}
              {account && (
                <div className="receipt-links">
                  <EventTime instant={item.data.startsAt} timeZone={item.data.timeZone} />
                  {item.canManageV1 && item.state === "published" && (
                    <>
                      {item.registrationOpen && (
                        <Link href={`/events/${item.id}/manage#invitations`}>Invite attendees</Link>
                      )}
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => onOpen(item)}
                      >
                        Edit description
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => onDuplicate(item)}
                  >
                    {`Duplicate ${item.data.title}`}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!account && (
        <button
          type="button"
          className="text-button danger"
          disabled={busy || !ready}
          onClick={onClear}
        >
          Clear this local workspace
        </button>
      )}
    </section>
  );
}
