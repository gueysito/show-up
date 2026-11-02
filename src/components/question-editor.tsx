import type { DraftErrors, QuizDraft } from "../domain/event-draft";
import { Field, fromDateInput, toDateInput } from "./field";

export function QuestionEditor({
  quiz,
  index,
  errors,
  onChange,
  onRemove,
}: {
  quiz: QuizDraft;
  index: number;
  errors: DraftErrors;
  onChange: (quiz: QuizDraft) => void;
  onRemove: () => void;
}) {
  const path = `quizzes.${index}`;
  return (
    <fieldset className="question-card">
      <legend>{`Question ${index + 1}`}</legend>
      <Field name={`${path}.question`} label="Question" errors={errors}>
        {(attrs) => (
          <input
            {...attrs}
            value={quiz.question}
            maxLength={500}
            onChange={(e) => onChange({ ...quiz, question: e.target.value })}
          />
        )}
      </Field>
      <div className="field-grid">
        <Field name={`${path}.type`} label="Answer format" errors={errors}>
          {(attrs) => (
            <select
              {...attrs}
              value={quiz.type}
              onChange={(e) => onChange({ ...quiz, type: e.target.value as QuizDraft["type"] })}
            >
              <option value="choice">Multiple choice</option>
              <option value="short">Short answer</option>
            </select>
          )}
        </Field>
        <Field name={`${path}.durationSeconds`} label="Window (seconds)" errors={errors}>
          {(attrs) => (
            <input
              {...attrs}
              type="number"
              min="60"
              max="180"
              value={quiz.durationSeconds}
              onChange={(e) => onChange({ ...quiz, durationSeconds: Number(e.target.value) })}
            />
          )}
        </Field>
      </div>
      <Field
        name={`${path}.plannedAt`}
        label="Planned question time (UTC)"
        hint="Manual opening with a reminder. The entire window must finish by planned end."
        errors={errors}
      >
        {(attrs) => (
          <input
            {...attrs}
            type="datetime-local"
            value={toDateInput(quiz.plannedAt)}
            onChange={(e) => onChange({ ...quiz, plannedAt: fromDateInput(e.target.value) })}
          />
        )}
      </Field>
      {quiz.type === "choice" ? (
        <>
          <div id={`${path}.options`} tabIndex={-1}>
            <p>Answer choices: two to six distinct, nonempty options.</p>
            {errors[`${path}.options`] && (
              <p className="field-error">{errors[`${path}.options`]}</p>
            )}
            {quiz.options.map((option, i) => (
              <div className="choice-row" key={i}>
                <Field name={`${path}.options.${i}`} label={`Choice ${i + 1}`} errors={errors}>
                  {(attrs) => (
                    <input
                      {...attrs}
                      value={option}
                      maxLength={200}
                      onChange={(e) =>
                        onChange({
                          ...quiz,
                          options: quiz.options.map((text, n) => (n === i ? e.target.value : text)),
                        })
                      }
                    />
                  )}
                </Field>
                <button
                  type="button"
                  className="text-button"
                  disabled={quiz.options.length <= 2}
                  onClick={() =>
                    onChange({
                      ...quiz,
                      options: quiz.options.filter((_, n) => n !== i),
                      correctOption:
                        quiz.correctOption === i
                          ? 0
                          : quiz.correctOption > i
                            ? quiz.correctOption - 1
                            : quiz.correctOption,
                    })
                  }
                >
                  {`Remove choice ${i + 1}`}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="secondary-button"
              disabled={quiz.options.length >= 6}
              onClick={() => onChange({ ...quiz, options: [...quiz.options, ""] })}
            >
              {`Add answer choice (${quiz.options.length}/6)`}
            </button>
          </div>
          <Field name={`${path}.correctOption`} label="Correct option" errors={errors}>
            {(attrs) => (
              <select
                {...attrs}
                value={quiz.correctOption}
                onChange={(e) => onChange({ ...quiz, correctOption: Number(e.target.value) })}
              >
                {quiz.options.map((option, i) => (
                  <option key={i} value={i}>
                    {`${i + 1}. ${option || "Empty option"}`}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </>
      ) : (
        <Field
          name={`${path}.aliases`}
          label="Accepted answers"
          hint="One per line. Unicode, case and extra spaces are normalized; no fuzzy grading."
          errors={errors}
        >
          {(attrs) => (
            <textarea
              {...attrs}
              rows={3}
              value={quiz.aliases.join("\n")}
              onChange={(e) => onChange({ ...quiz, aliases: e.target.value.split("\n") })}
            />
          )}
        </Field>
      )}
      <p className="hint">Correct answers stay inside this private draft workspace.</p>
      <button type="button" className="text-button" onClick={onRemove}>
        {`Remove question ${index + 1}`}
      </button>
    </fieldset>
  );
}
