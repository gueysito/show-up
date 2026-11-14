import type { EventDraft, DraftErrors } from "../domain/event-draft";
import { Field } from "./field";
import { QuestionEditor } from "./question-editor";

type Props = {
  v1?: boolean;
  draft: EventDraft;
  errors: DraftErrors;
  change: <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => void;
};

function localEventInput(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function eventInstant(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

export function DetailsFields({ draft, errors, change, v1 = false }: Props) {
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
              <option value="physical">
                {v1 ? "In person · live code" : "In person · staff QR"}
              </option>
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
          hint={
            v1
              ? "Share the host's live check-in code with people who are there."
              : "Plan a personal QR check-in. Invite validators from the saved event before publication."
          }
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
        <Field
          name="startsAt"
          label="Planned start"
          hint="Enter the time in your device’s timezone."
          errors={errors}
        >
          {(attrs) => (
            <input
              {...attrs}
              type="datetime-local"
              suppressHydrationWarning
              value={localEventInput(draft.startsAt)}
              onChange={(e) => change("startsAt", eventInstant(e.target.value))}
            />
          )}
        </Field>
        <Field name="endsAt" label="Planned end" hint="30–120 minutes after start." errors={errors}>
          {(attrs) => (
            <input
              {...attrs}
              type="datetime-local"
              suppressHydrationWarning
              value={localEventInput(draft.endsAt)}
              onChange={(e) => change("endsAt", eventInstant(e.target.value))}
            />
          )}
        </Field>
      </div>
      <Field
        name="timeZone"
        label="Event display timezone"
        hint="Choose how event times appear to attendees and in the preview."
        errors={errors}
      >
        {(attrs) => (
          <input
            {...attrs}
            list="event-timezones"
            autoComplete="off"
            value={draft.timeZone}
            onChange={(e) => change("timeZone", e.target.value)}
          />
        )}
      </Field>
      <datalist id="event-timezones">
        {["UTC", ...Intl.supportedValuesOf("timeZone")].map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </section>
  );
}

export function CommitmentFields({ draft, errors, change, v1 = false }: Props) {
  return (
    <section className="form-section" id="commitment-section">
      <div className="section-title">
        <span>02</span>
        <div>
          <h2>A fair commitment</h2>
          <p>Principal, rewards and costs stay separate.</p>
        </div>
      </div>
      <div className="field-grid">
        <Field
          name="capacity"
          label="Capacity"
          hint={v1 ? "1–64 funded attendees." : "1–100 funded attendees."}
          errors={errors}
        >
          {(attrs) => (
            <input
              {...attrs}
              type="number"
              min="1"
              max={v1 ? "64" : "100"}
              step="1"
              value={draft.capacity}
              onChange={(e) => change("capacity", Number(e.target.value))}
            />
          )}
        </Field>
        <Field
          name="commitment"
          label="Refundable commitment (USDC)"
          hint={
            v1
              ? "1–100 USDC. Returned to attendees who check in, less disclosed transaction fees."
              : "Default 5. Minimum 2.50; no reduced-funds exception is enabled."
          }
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
        {v1 ? (
          <p className="hint">
            No-show deposits are split equally among checked-in attendees. An optional funded prize
            goes to one drawn attendee.
          </p>
        ) : (
          <Field name="rewardPreset" label="Reward recipe" errors={errors}>
            {(attrs) => (
              <select
                {...attrs}
                value={draft.rewardPreset}
                onChange={(e) =>
                  change("rewardPreset", e.target.value as EventDraft["rewardPreset"])
                }
              >
                {!v1 && <option value="hybrid">Hybrid · 40% equal / 60% draw</option>}
                {!v1 && <option value="equal">Equal-only</option>}
                <option value="draw">
                  {v1
                    ? "No-show deposits split equally; optional prize drawn to one attendee"
                    : "Draw-only"}
                </option>
              </select>
            )}
          </Field>
        )}
      </div>
      <Field
        name="access"
        label="Registration access"
        hint={
          v1
            ? "Open events have a public event page. Invitation-only events require access."
            : "The restricted rollout will enforce invitations regardless of this draft choice."
        }
        errors={errors}
      >
        {(attrs) => (
          <select
            {...attrs}
            value={draft.access}
            onChange={(e) => change("access", e.target.value as EventDraft["access"])}
          >
            <option value="invitation">Invitation-only</option>
            <option value="open">{v1 ? "Open" : "Open · future release approval required"}</option>
          </select>
        )}
      </Field>
    </section>
  );
}

export function ParticipationFields({ draft, errors, change, v1 = false }: Props) {
  return (
    <section className="form-section" id="participation">
      <div className="section-title">
        <span>03</span>
        <div>
          <h2>{v1 ? "Optional prize" : "A little more participation"}</h2>
          <p>
            {v1
              ? "Add a USDC prize or an Ethereum NFT. After saving, Showup guides you through funding before publication."
              : "Optional questions. Extra upside, never a condition for principal."}
          </p>
        </div>
      </div>
      {!v1 && (
        <>
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
        </>
      )}
      {v1 && draft.quizzes.length > 0 && (
        <button type="button" className="secondary-button" onClick={() => change("quizzes", [])}>
          Remove planned questions for this event
        </button>
      )}
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
                      network: v1 ? "ethereum" : "near",
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
                {!v1 && <option value="near">NEAR · NEP-171</option>}
                {!v1 && <option value="base">Base · ERC-721</option>}
                {!v1 && <option value="solana">Solana · Core</option>}
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
                v1
                  ? "Contributor return destination"
                  : "Contributor return destination (fictional for this harness)",
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
