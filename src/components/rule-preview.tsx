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

export function RulePreview({
  draft,
  state = "draft",
  v1 = false,
}: {
  draft: EventDraft;
  state?: string;
  v1?: boolean;
}) {
  if (v1) return <V1RulePreview draft={draft} state={state} />;
  const rules = rulePreview(draft);
  const labels: Record<string, string> = {
    published: "Published terms",
    cancelled: "Cancelled",
    aborted: "Aborted",
    closed: "Closed",
  };
  return (
    <aside className="preview" aria-label="Event rules preview">
      <div className="preview-heading">
        <span className="eyebrow">The attendee promise</span>
        <span className="outline-tag">{labels[state] ?? "Unfunded draft"}</span>
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
          {`Displayed in ${draft.timeZone || "UTC"}. Enter event times in your device’s timezone.`}
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
        <h3>{state === "draft" ? "Before this can go live" : "Existing event terms"}</h3>
        <p>
          {state === "draft"
            ? "Host authentication and invitations, sponsor funding, fee policy, contract rules and any NFT custody must be verified. Publication is unavailable."
            : "Material terms are locked. No new funding route is enabled in this build. Duplicate into an independent draft to change material terms."}
        </p>
      </div>
    </aside>
  );
}

function V1RulePreview({ draft, state }: { draft: EventDraft; state: string }) {
  const start = Date.parse(draft.startsAt),
    end = Date.parse(draft.endsAt);
  return (
    <aside className="preview" aria-label="Event rules preview">
      <div className="preview-heading">
        <span className="eyebrow">The attendee promise</span>
        <span className="outline-tag">
          {state === "published"
            ? "Published terms"
            : state === "publication_pending"
              ? "Publication requested"
              : "Unfunded draft"}
        </span>
      </div>
      <h2>{draft.title || "Your next gathering"}</h2>
      <p className="preview-commitment">
        {draft.commitment || "0"}
        <span> USDC commitment</span>
      </p>
      <p>Show up and get your deposit back, less disclosed transaction fees.</p>
      <p className="preview-note">
        No-show deposits are split equally among attendees who check in. Hosts receive no cut. If
        nobody checks in, all deposits are returned.
      </p>
      <div className="preview-section">
        <h3>Event timing</h3>
        <dl className="timeline">
          {[
            ["Registration closes / check-in opens", start],
            ["Check-in closes", end],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <dt>{label}</dt>
              <dd>{time(Number(value), draft.timeZone)}</dd>
            </div>
          ))}
        </dl>
        <p className="preview-note">
          The host can close the event after it starts. Check in before the event closes or ends to
          qualify for the attendance refund.
        </p>
      </div>
      <div className="preview-section">
        <h3>Live-code check-in</h3>
        <p className="preview-note">{`${draft.capacity} seats. Use the host's live code during the event, online or in person.`}</p>
      </div>
      <div className="preview-section">
        <h3>Optional prize</h3>
        <p className="preview-note">{`${draft.sponsorBudget || "0"} USDC planned prize${draft.nft ? " plus one planned Ethereum NFT" : ""}. Prizes must be funded or held in custody before publication.`}</p>
      </div>
      <details className="preview-section" open>
        <summary>Refunds, fees and access</summary>
        <p className="preview-note">
          Refunds are USDC on NEAR. Cancellation before settlement returns attendee deposits;
          network costs remain costs. Deposits open only after confirmed publication.
        </p>
        <p className="preview-note">
          {`${draft.access === "open" ? "Anyone can view the public event page." : "The event page requires an invitation or existing event access."} Published material terms are locked.`}
        </p>
      </details>
      <div className="publication-limit">
        <h3>{state === "draft" ? "Ready when you are" : "Event terms"}</h3>
        <p>
          {state === "draft"
            ? "Save your draft, then publish it to the mainnet escrow. A USDC prize must arrive from your chosen verified NEAR wallet before publication."
            : "Review the original publication transaction from the event page. Duplicate the event to change published material terms."}
        </p>
      </div>
    </aside>
  );
}
