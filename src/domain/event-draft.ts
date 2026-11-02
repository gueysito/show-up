export type QuizDraft = {
  question: string;
  type: "choice" | "short";
  options: string[];
  correctOption: number;
  aliases: string[];
  plannedAt: string;
  durationSeconds: number;
};

export type NFTDraft = {
  network: "near" | "base" | "solana" | "ethereum";
  collection: string;
  assetId: string;
  contributorReturnAddress: string;
};

export type EventDraft = {
  title: string;
  description: string;
  series: string;
  mode: "digital" | "physical";
  sessionReference: string;
  venue: string;
  timeZone: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  commitment: string;
  sponsorBudget: string;
  rewardPreset: "hybrid" | "equal" | "draw";
  access: "invitation" | "open";
  quizzes: QuizDraft[];
  nft: NFTDraft | null;
};

export type DraftErrors = Record<string, string>;
export type DraftValidation = { ok: true; value: EventDraft } | { ok: false; errors: DraftErrors };

export const emptyDraft: EventDraft = {
  title: "",
  description: "",
  series: "",
  mode: "digital",
  sessionReference: "",
  venue: "",
  timeZone: "UTC",
  startsAt: "",
  endsAt: "",
  capacity: 100,
  commitment: "5",
  sponsorBudget: "",
  rewardPreset: "hybrid",
  access: "invitation",
  quizzes: [],
  nft: null,
};

export function usdcAtomic(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
}

export function formatUsdc(value: bigint) {
  const fraction = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1000000n}.${fraction.padEnd(2, "0")}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function instant(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value))
    return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
    ? time
    : NaN;
}

export function normalizeAnswer(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function validateDraft(input: unknown, now = Date.now()): DraftValidation {
  const errors: DraftErrors = {};
  if (!record(input)) return { ok: false, errors: { form: "Enter an event draft." } };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(emptyDraft, key)) errors.form = "Unexpected fields are not accepted.";
  }
  const text = (value: unknown, path: string, max: number, required = true) => {
    if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
      errors[path] = `Enter ${required ? "a value" : "text"} of at most ${max} characters.`;
    }
  };
  text(input.title, "title", 120);
  text(input.description, "description", 2000, false);
  text(input.series, "series", 120, false);
  text(input.sessionReference, "sessionReference", 500, input.mode === "digital");
  text(input.venue, "venue", 300, input.mode === "physical");
  if (!["digital", "physical"].includes(String(input.mode)))
    errors.mode = "Choose digital or physical.";
  if (input.mode === "digital") {
    try {
      const url = new URL(String(input.sessionReference));
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch {
      errors.sessionReference = "Enter an HTTPS session URL without credentials.";
    }
  }
  try {
    if (typeof input.timeZone !== "string" || input.timeZone.length > 100) throw new Error();
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
  } catch {
    errors.timeZone = "Enter an IANA timezone, such as America/Denver or UTC.";
  }
  const start = instant(input.startsAt);
  const end = instant(input.endsAt);
  if (!Number.isFinite(start) || start <= now)
    errors.startsAt = "Choose a future start, as a UTC instant.";
  if (!Number.isFinite(end) || end - start < 30 * 60000 || end - start > 120 * 60000) {
    errors.endsAt = "Plan a duration of 30–120 minutes.";
  }
  if (
    !Number.isInteger(input.capacity) ||
    Number(input.capacity) < 1 ||
    Number(input.capacity) > 100
  ) {
    errors.capacity = "Choose a whole number from 1 to 100.";
  }
  const commitment = usdcAtomic(input.commitment);
  if (commitment === null || commitment < 2500000n) {
    errors.commitment = "Use at least 2.50 USDC, with at most six decimal places.";
  }
  const budget = usdcAtomic(input.sponsorBudget);
  if (budget === null)
    errors.sponsorBudget = "Enter a nonnegative USDC budget with at most six decimal places.";
  if (!["equal", "draw", "hybrid"].includes(String(input.rewardPreset))) {
    errors.rewardPreset = "Choose equal-only, draw-only or hybrid.";
  }
  if (!["open", "invitation"].includes(String(input.access)))
    errors.access = "Choose an access mode.";
  if (!Array.isArray(input.quizzes) || input.quizzes.length > 2) {
    errors.quizzes = "Add zero, one or two optional questions.";
  } else {
    input.quizzes.forEach((quiz, index) => {
      const prefix = `quizzes.${index}`;
      if (!record(quiz)) {
        errors[prefix] = "Enter a question.";
        return;
      }
      text(quiz.question, `${prefix}.question`, 500);
      if (!["choice", "short"].includes(String(quiz.type)))
        errors[`${prefix}.type`] = "Choose a question type.";
      if (
        !Number.isInteger(quiz.durationSeconds) ||
        Number(quiz.durationSeconds) < 60 ||
        Number(quiz.durationSeconds) > 180
      )
        errors[`${prefix}.durationSeconds`] = "Choose 60–180 seconds.";
      const planned = instant(quiz.plannedAt);
      if (
        !Number.isFinite(planned) ||
        planned < start ||
        planned + Number(quiz.durationSeconds) * 1000 > end
      ) {
        errors[`${prefix}.plannedAt`] = "Keep the full question window within the planned event.";
      }
      if (
        !Array.isArray(quiz.options) ||
        quiz.options.length > 6 ||
        quiz.options.some((option) => typeof option !== "string" || option.length > 200)
      ) {
        errors[`${prefix}.options`] = "Use at most six options, each up to 200 characters.";
      } else if (quiz.type === "choice") {
        if (quiz.options.length < 2)
          errors[`${prefix}.options`] = "Add at least two answer choices.";
        else if (new Set(quiz.options.map(normalizeAnswer)).size !== quiz.options.length)
          errors[`${prefix}.options`] = "Each answer choice must be distinct; remove duplicates.";
        quiz.options.forEach((option, i) => {
          if (!option.trim())
            errors[`${prefix}.options.${i}`] =
              `Enter choice ${i + 1} or remove this unused choice.`;
        });
      }
      if (
        quiz.type === "choice" &&
        (!Number.isInteger(quiz.correctOption) ||
          Number(quiz.correctOption) < 0 ||
          Number(quiz.correctOption) >= Number((quiz.options as unknown[])?.length))
      ) {
        errors[`${prefix}.correctOption`] = "Choose a correct option.";
      }
      if (
        !Array.isArray(quiz.aliases) ||
        quiz.aliases.length > 10 ||
        quiz.aliases.some(
          (alias) => typeof alias !== "string" || !alias.trim() || alias.length > 200,
        ) ||
        (quiz.type === "short" && quiz.aliases.length === 0)
      ) {
        errors[`${prefix}.aliases`] =
          "Enter one to ten accepted answers, each up to 200 characters.";
      }
    });
  }
  if (input.nft !== null) {
    if (!record(input.nft)) errors.nft = "Enter one planned NFT or remove it.";
    else {
      if (!["near", "base", "solana", "ethereum"].includes(String(input.nft.network)))
        errors["nft.network"] = "Choose a supported network.";
      for (const key of ["collection", "assetId", "contributorReturnAddress"]) {
        text(input.nft[key], `nft.${key}`, 200);
      }
      if (input.rewardPreset === "equal" || budget === 0n) {
        errors.nft = "An NFT supplements a monetary draw; choose a funded draw-bearing plan.";
      }
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  // Shape checks above are the trust boundary; return only the declared draft fields.
  const value = Object.fromEntries(
    Object.keys(emptyDraft).map((key) => [key, input[key]]),
  ) as EventDraft;
  return { ok: true, value };
}

export function rulePreview(draft: EventDraft) {
  const budget = usdcAtomic(draft.sponsorBudget) ?? 0n;
  const equal =
    draft.rewardPreset === "equal"
      ? budget
      : draft.rewardPreset === "hybrid"
        ? (budget * 4000n) / 10000n
        : 0n;
  const start = Date.parse(draft.startsAt);
  const end = Date.parse(draft.endsAt);
  return {
    equal: formatUsdc(equal),
    draw: formatUsdc(budget - equal),
    registrationClose: start,
    releaseDeadline: start - 10 * 60000,
    checkinOpen: start - 5 * 60000,
    onTimeThrough: start + 10 * 60000,
    checkinCutoff: end - 15 * 60000,
    hardClose: end + 30 * 60000,
  };
}
