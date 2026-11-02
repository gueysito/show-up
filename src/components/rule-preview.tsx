import { rulePreview, type EventDraft } from "../domain/event-draft";

function time(value: number, zone: string) {
  if (!Number.isFinite(value)) return "Set event times";
  try {
    return new Intl.DateTimeFormat("en", {
      timeZone: zone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(value);
  } catch {
    return "Check the event timezone";
  }
}

export function RulePreview({ draft }: { draft: EventDraft }) {
  const rules = rulePreview(draft);
  return (
    <aside className="preview" aria-label="Event rules preview">
      <div className="preview-heading">
        <span className="eyebrow">The attendee promise</span>
        <span className="outline-tag">Unfunded draft</span>
      </div>
      <h2>{draft.title || "Your next gathering"}</h2>
      <p className="preview-commitment">
        {draft.commitment || "0"}
        <span> USDC commitment</span>
      </p>
      <p>Show up and get your deposit back, less disclosed transaction fees.</p>
      <dl className="split">
        <div>
          <dt>Equal rewards</dt>
          <dd>
            <span>{rules.equal}</span>
            <small> USDC</small>
          </dd>
        </div>
        <div>
          <dt>One draw prize</dt>
          <dd>
            <span>{rules.draw}</span>
            <small> USDC</small>
          </dd>
        </div>
      </dl>
      <p className="preview-note">
        Planned sponsor allocation, not a balance. Valid no-show forfeitures go to the equal pool in
        every preset, including draw-only. Hosts receive no cut.
      </p>
      <div className="preview-section">
        <h3>Attendance windows</h3>
        <p className="preview-note">
          {`Displayed in ${draft.timeZone || "UTC"}. Schedule entry uses UTC.`}
        </p>
        <dl className="timeline">
          {(
            [
              ["Registration closes", rules.registrationClose],
              ["Attendee release before", rules.releaseDeadline],
              ["Check-in opens", rules.checkinOpen],
              ["On-time through", rules.onTimeThrough],
              ["Final check-in cutoff", rules.checkinCutoff],
              ["Hard close", rules.hardClose],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{time(value, draft.timeZone)}</dd>
            </div>
          ))}
        </dl>
        <p className="preview-note">
          Late valid attendance keeps principal, equal rewards and streak credit, with no draw
          entries. Five-minute evidence grace follows each relevant window.
        </p>
      </div>
      <div className="preview-section">
        <h3>{draft.mode === "digital" ? "Live-code check-in" : "Staff-validated QR"}</h3>
        <p className="preview-note">
          {draft.mode === "digital"
            ? "A fresh host word or phrase opens a three-minute window, clipped at the final cutoff."
            : "Assigned staff scan a personal, expiring QR and confirm presence. No manual override."}
        </p>
        <p className="preview-note">
          {`${draft.capacity} seats · ${draft.quizzes.length} optional questions. Missing a quiz never costs an earned principal refund.`}
        </p>
      </div>
      <details className="preview-section" open>
        <summary>Fees, cancellation and access</summary>
        <p className="preview-note">
          Zero platform fee. Attendees pay deposit and withdrawal delivery costs, under a separately
          authorized fee maximum. Quotes and fee caps are unavailable here; no net payout is
          promised.
        </p>
        <p className="preview-note">
          Pre-start cancellation returns principal and sponsor funds. An early abort returns all
          unreleased principal, sponsor rewards and any NFT; no rewards or forfeitures are
          distributed. Already-incurred costs remain costs.
        </p>
        <p className="preview-note">
          Restricted rollout requires invitations, even when a draft requests open registration.
          Material terms lock only through the future publication flow.
        </p>
      </details>
      {draft.nft && (
        <p className="preview-note">
          {`One planned ${draft.nft.network} NFT supplements the monetary draw. Custody and contributor-funded delivery/return reserve are unverified. The selected winner must accept both prizes together.`}
        </p>
      )}
      <div className="publication-limit">
        <h3>Before this can go live</h3>
        <p>
          Host authentication and invitations, sponsor funding, fee policy, contract rules and any
          NFT custody must be verified. Publication is unavailable.
        </p>
      </div>
    </aside>
  );
}
