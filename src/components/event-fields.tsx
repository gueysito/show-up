import type { EventDraft, DraftErrors } from "../domain/event-draft";
import { Field, fromDateInput, toDateInput } from "./field";
import { QuestionEditor } from "./question-editor";

type Props = {
  draft: EventDraft;
  errors: DraftErrors;
  change: <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => void;
};

export function DetailsFields({ draft, errors, change }: Props) {
  return (
    <section className="form-section" id="details">
      <div className="section-title">
        <span>01</span>
        <div>
          <h2>The gathering</h2>
          <p>Give people a reason to be there.</p>
        </div>
      </div>
      <Field name="title" label="Event name" errors={errors}>
        {(attrs) => (
          <input
            {...attrs}
            placeholder="e.g. The community listening room"
            maxLength={120}
            value={draft.title}
            onChange={(e) => change("title", e.target.value)}
          />
        )}
      </Field>
      <Field name="description" label="Description (optional)" errors={errors}>
        {(attrs) => (
          <textarea
            {...attrs}
            rows={3}
            placeholder="What will people take away?"
            maxLength={2000}
            value={draft.description}
            onChange={(e) => change("description", e.target.value)}
          />
        )}
      </Field>
      <div className="field-grid">
        <Field name="mode" label="Where we meet" errors={errors}>
          {(attrs) => (
            <select
              {...attrs}
              value={draft.mode}
              onChange={(e) => change("mode", e.target.value as EventDraft["mode"])}
            >
              <option value="digital">Online · live code</option>
              <option value="physical">In person · staff QR</option>
            </select>
          )}
        </Field>
        <Field name="series" label="Series (optional)" errors={errors}>
          {(attrs) => (
            <input
              {...attrs}
              maxLength={120}
              placeholder="e.g. Friday conversations"
              value={draft.series}
              onChange={(e) => change("series", e.target.value)}
            />
          )}
        </Field>
      </div>
      {draft.mode === "digital" ? (
        <Field
          name="sessionReference"
          label="Session URL"
          hint="HTTPS link to the actual planned session. No audio is hosted here."
          errors={errors}
        >
          {(attrs) => (
            <input
              {...attrs}
              type="url"
              value={draft.sessionReference}
              placeholder="https://x.com/i/spaces/…"
              onChange={(e) => change("sessionReference", e.target.value)}
            />
          )}
        </Field>
      ) : (
        <Field
          name="venue"
          label="Venue and proof instructions"
          hint="Plan a staff-validated personal QR check-in. Staff assignment comes later."
          errors={errors}
        >
          {(attrs) => (
            <input
              {...attrs}
              value={draft.venue}
              onChange={(e) => change("venue", e.target.value)}
            />
          )}
        </Field>
      )}
      <div className="field-grid">
        <Field name="startsAt" label="Planned start (UTC)" errors={errors}>
          {(attrs) => (
            <input
              {...attrs}
              type="datetime-local"
              value={toDateInput(draft.startsAt)}
              onChange={(e) => change("startsAt", fromDateInput(e.target.value))}
            />
          )}
        </Field>
        <Field
          name="endsAt"
          label="Planned end (UTC)"
          hint="30–120 minutes after start."
          errors={errors}
        >
          {(attrs) => (
            <input
              {...attrs}
              type="datetime-local"
              value={toDateInput(draft.endsAt)}
              onChange={(e) => change("endsAt", fromDateInput(e.target.value))}
            />
          )}
        </Field>
      </div>
      <Field
        name="timeZone"
        label="Event display timezone"
        hint="IANA name, such as America/Denver. Preview converts UTC instants into this timezone."
        errors={errors}
      >
        {(attrs) => (
          <input
            {...attrs}
            value={draft.timeZone}
            onChange={(e) => change("timeZone", e.target.value)}
          />
        )}
      </Field>
    </section>
  );
}

export function CommitmentFields({ draft, errors, change }: Props) {
  return (
    <section className="form-section" id="commitment">
      <div className="section-title">
        <span>02</span>
        <div>
          <h2>A fair commitment</h2>
          <p>Principal, rewards and costs stay separate.</p>
        </div>
      </div>
      <div className="field-grid">
        <Field name="capacity" label="Capacity" hint="1–100 funded attendees." errors={errors}>
          {(attrs) => (
            <input
              {...attrs}
              type="number"
              min="1"
              max="100"
              step="1"
              value={draft.capacity}
              onChange={(e) => change("capacity", Number(e.target.value))}
            />
          )}
        </Field>
        <Field
          name="commitment"
          label="Refundable commitment (USDC)"
          hint="Default 5. Minimum 2.50; no reduced-funds exception is enabled."
          errors={errors}
        >
          {(attrs) => (
            <input
              {...attrs}
              inputMode="decimal"
              value={draft.commitment}
              onChange={(e) => change("commitment", e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="field-grid">
        <Field
          name="sponsorBudget"
          label="Planned sponsor budget (USDC)"
          hint="A proposed amount, not a funded balance."
          errors={errors}
        >
          {(attrs) => (
            <input
              {...attrs}
              inputMode="decimal"
              placeholder="e.g. 100"
              value={draft.sponsorBudget}
              onChange={(e) => change("sponsorBudget", e.target.value)}
            />
          )}
        </Field>
        <Field name="rewardPreset" label="Reward recipe" errors={errors}>
          {(attrs) => (
            <select
              {...attrs}
              value={draft.rewardPreset}
              onChange={(e) => change("rewardPreset", e.target.value as EventDraft["rewardPreset"])}
            >
              <option value="hybrid">Hybrid · 40% equal / 60% draw</option>
              <option value="equal">Equal-only</option>
              <option value="draw">Draw-only</option>
            </select>
          )}
        </Field>
      </div>
      <Field
        name="access"
        label="Registration access"
        hint="The restricted rollout will enforce invitations regardless of this draft choice."
        errors={errors}
      >
        {(attrs) => (
          <select
            {...attrs}
            value={draft.access}
            onChange={(e) => change("access", e.target.value as EventDraft["access"])}
          >
            <option value="invitation">Invitation-only</option>
            <option value="open">Open · future release approval required</option>
          </select>
        )}
      </Field>
    </section>
  );
}

export function ParticipationFields({ draft, errors, change }: Props) {
  return (
    <section className="form-section" id="participation">
      <div className="section-title">
        <span>03</span>
        <div>
          <h2>A little more participation</h2>
          <p>Optional questions. Extra upside, never a condition for principal.</p>
        </div>
      </div>
      {draft.quizzes.map((quiz, index) => (
        <QuestionEditor
          key={index}
          quiz={quiz}
          index={index}
          errors={errors}
          onChange={(next) =>
            change(
              "quizzes",
              draft.quizzes.map((q, i) => (i === index ? next : q)),
            )
          }
          onRemove={() =>
            change(
              "quizzes",
              draft.quizzes.filter((_, i) => i !== index),
            )
          }
        />
      ))}
      <button
        type="button"
        className="secondary-button"
        disabled={draft.quizzes.length >= 2}
        onClick={() =>
          change("quizzes", [
            ...draft.quizzes,
            {
              question: "",
              type: "choice",
              options: ["", ""],
              correctOption: 0,
              aliases: [],
              plannedAt: draft.startsAt,
              durationSeconds: 90,
            },
          ])
        }
      >
        {`+ Add optional question (${draft.quizzes.length}/2)`}
      </button>
      <div className="nft-toggle">
        <label>
          <input
            type="checkbox"
            checked={draft.nft !== null}
            onChange={(e) =>
              change(
                "nft",
                e.target.checked
                  ? {
                      network: "near",
                      collection: "",
                      assetId: "",
                      contributorReturnAddress: "",
                    }
                  : null,
              )
            }
          />
          Include one planned NFT prize
        </label>
        <p className="hint">
          A descriptor only. No asset is connected, approved or held in custody.
        </p>
      </div>
      {draft.nft && (
        <fieldset className="question-card" id="nft">
          <legend>Planned NFT supplement</legend>
          {errors.nft && <p className="field-error">{errors.nft}</p>}
          <Field name="nft.network" label="NFT network" errors={errors}>
            {(attrs) => (
              <select
                {...attrs}
                value={draft.nft!.network}
                onChange={(e) =>
                  change("nft", {
                    ...draft.nft!,
                    network: e.target.value as NonNullable<EventDraft["nft"]>["network"],
                  })
                }
              >
                <option value="near">NEAR · NEP-171</option>
                <option value="base">Base · ERC-721</option>
                <option value="solana">Solana · Core</option>
                <option value="ethereum">Ethereum · ERC-721</option>
              </select>
            )}
          </Field>
          {(
            [
              ["collection", "Collection / contract / mint"],
              ["assetId", "Token / asset identifier"],
              [
                "contributorReturnAddress",
                "Contributor return destination (fictional for this harness)",
              ],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} name={`nft.${key}`} label={label} errors={errors}>
              {(attrs) => (
                <input
                  {...attrs}
                  maxLength={200}
                  value={draft.nft![key]}
                  onChange={(e) => change("nft", { ...draft.nft!, [key]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </fieldset>
      )}
    </section>
  );
}
