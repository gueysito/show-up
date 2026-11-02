import type { EventDraft } from "../domain/event-draft";

export type SavedDraft = {
  id: string;
  revision: number;
  data: EventDraft;
  updatedAt: string;
  state?: string;
};

export function SavedDrafts({
  saved,
  account,
  busy,
  ready,
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
  onOpen: (item: SavedDraft) => void;
  onNew: () => void;
  onRefresh: () => void;
  onClear: () => void;
  onDuplicate: (item: SavedDraft) => void;
}) {
  return (
    <section className="saved-panel" aria-label="Saved drafts">
      <h2>{account ? "Your private events" : "In this browser workspace"}</h2>
      <p className="hint">
        {account
          ? "50 most recent events owned by this account. Reopen or duplicate independently; no commitments, invitations or funds are copied."
          : "50 most recent drafts. Access expires after 24 hours; refresh restores saved revisions. Unsaved edits stay on this page."}
      </p>
      <div className="saved-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onNew}>
          New draft
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={onRefresh}>
          Reconnect storage
        </button>
      </div>
      <ul>
        {saved.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="saved-draft"
              disabled={busy}
              onClick={() => onOpen(item)}
            >
              <span>{item.data.title}</span>
              <span>{`Revision ${item.revision} ↗`}</span>
            </button>
            {account && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => onDuplicate(item)}
              >
                {`Duplicate ${item.data.title}`}
              </button>
            )}
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
