/**
 * DIME Coverage Needs Estimator — Educational Sub-Flow (Section 4.4 extension)
 *
 * A 3-step educational exercise that teaches the general DIME method
 * (Debt, Income, Mortgage, Education) for thinking about life-insurance
 * coverage needs. It is educational, not advisory:
 *   - it never asks for income, debt balances, mortgage balances, or any
 *     sensitive/PII data (the inputs are one yes/no and one coarse years range);
 *   - the dollar output is an ILLUSTRATIVE range from a fixed, pre-approved
 *     table — never a personalized figure, quote, or recommendation;
 *   - the application layer computes the range deterministically; the model
 *     never invents dollar figures.
 *
 * COMPLIANCE NOTE: the question wording and the illustrative range table are
 * proposed educational content for Texas insurance counsel review (Phase 0
 * sign-off), like the consent copy in consent-model.ts. Nothing here is a
 * recommendation, and the disclaimer must stay attached to the output.
 */

/** Coarse inputs collected by the estimator (no amounts, no PII). */
export interface DimeInputs {
  has_mortgage_or_debt: boolean | null;
  /** Rough number of years of income the user would want to replace (0–40). */
  income_replacement_years: number | null;
  future_expenses: boolean | null;
}

/** The offer line — the single entry point from education/clarify. */
export const DIME_OFFER_LINE =
  "Would you like to see how life insurance needs are typically estimated? It's a simple 3-step educational exercise.";

/** The three scripted questions, asked one per turn in order. */
export const DIME_QUESTIONS = [
  'Step 1: Do you have a mortgage or other large debts? (Yes/No)',
  'Step 2: Roughly how many years of income would you want to replace for your family? (e.g., 5, 10, or 20 years)',
  "Step 3: Are there future expenses you'd want to cover, like college? (Yes/No)",
] as const;

/**
 * The illustrative educational range table.
 *
 * Deterministic formula behind the "pre-approved table":
 *   midpoint = base(years group) + 200k if mortgage/debt + 200k if future expenses
 *   range    = midpoint ± 25%, rounded outward to the nearest $50k
 *
 * The output is deliberately a wide illustrative band — it is not based on the
 * user's income or debts (never collected) and never a personalized figure.
 */
const INCOME_YEARS_BASE: ReadonlyArray<{ maxYears: number; base: number }> = [
  { maxYears: 5, base: 200_000 },
  { maxYears: 10, base: 400_000 },
  { maxYears: 20, base: 600_000 },
  { maxYears: 40, base: 800_000 },
];

const DEBT_INCREMENT = 200_000;
const EDUCATION_INCREMENT = 200_000;
const RANGE_MARGIN = 0.25;
const ROUND_STEP = 50_000;

export interface DimeEstimate {
  /** Lower bound of the illustrative range, in dollars. */
  min: number;
  /** Upper bound of the illustrative range, in dollars. */
  max: number;
  /** Human-readable range label, e.g. "$600,000 – $1,000,000". */
  rangeLabel: string;
}

/**
 * The disclaimer that must accompany every estimate. The application layer
 * attaches it to the deterministic result message; the model must never
 * soften or drop it.
 */
export const DIME_DISCLAIMER =
  'This is an educational estimate based on the general DIME method — not a recommendation, quote, or personalized assessment.';

/**
 * Computes the illustrative range for a complete set of DIME inputs.
 * Deterministic and testable; throws if any input is missing.
 */
export function computeDimeEstimate(inputs: DimeInputs): DimeEstimate {
  if (!dimeInputsComplete(inputs)) {
    throw new Error('computeDimeEstimate requires all three DIME inputs to be collected');
  }

  const years = inputs.income_replacement_years ?? 0;
  const baseRow =
    INCOME_YEARS_BASE.find((row) => years <= row.maxYears) ??
    INCOME_YEARS_BASE[INCOME_YEARS_BASE.length - 1];

  const midpoint =
    baseRow.base +
    (inputs.has_mortgage_or_debt ? DEBT_INCREMENT : 0) +
    (inputs.future_expenses ? EDUCATION_INCREMENT : 0);

  // Round outward to the nearest $50k so the band stays wide and honest.
  const min = Math.floor((midpoint * (1 - RANGE_MARGIN)) / ROUND_STEP) * ROUND_STEP;
  const max = Math.ceil((midpoint * (1 + RANGE_MARGIN)) / ROUND_STEP) * ROUND_STEP;

  return {
    min,
    max,
    rangeLabel: `$${min.toLocaleString('en-US')} – $${max.toLocaleString('en-US')}`,
  };
}

/**
 * The final assistant_message shown when the estimate is ready. Built by the
 * application layer (deterministic), then the licensed-broker bridge to the
 * contact_offer flow.
 */
export function buildDimeResultMessage(estimate: DimeEstimate): string {
  return `Based on the general DIME method (Debt, Income, Mortgage, Education), many families in your situation consider coverage in the range of ${estimate.rangeLabel}. ${DIME_DISCLAIMER} Would you like to discuss your situation with Richard Parslow, a licensed Texas life-insurance broker, to get a personalized assessment?`;
}

/** True when all three inputs are collected. */
export function dimeInputsComplete(inputs: DimeInputs): boolean {
  return (
    inputs.has_mortgage_or_debt !== null &&
    inputs.income_replacement_years !== null &&
    inputs.future_expenses !== null
  );
}

/**
 * The next question to ask (1-based), or null when the exercise is complete.
 * Derived deterministically from how many inputs are already collected.
 */
export function nextDimeStep(inputs: DimeInputs): 1 | 2 | 3 | null {
  const collected = countDimeInputs(inputs);
  if (collected >= DIME_QUESTIONS.length) {
    return null;
  }
  return (collected + 1) as 1 | 2 | 3;
}

/** Counts how many of the three inputs are collected. */
export function countDimeInputs(inputs: DimeInputs): number {
  let count = 0;
  if (inputs.has_mortgage_or_debt !== null) count += 1;
  if (inputs.income_replacement_years !== null) count += 1;
  if (inputs.future_expenses !== null) count += 1;
  return count;
}

/**
 * Merges the model's freshly emitted inputs into the session's collected
 * inputs. Fresh non-null values overwrite; nulls leave the session value
 * intact so a later turn can never wipe an earlier answer.
 */
export function mergeDimeInputs(session: DimeInputs, incoming: DimeInputs): DimeInputs {
  return {
    has_mortgage_or_debt: incoming.has_mortgage_or_debt ?? session.has_mortgage_or_debt,
    income_replacement_years: incoming.income_replacement_years ?? session.income_replacement_years,
    future_expenses: incoming.future_expenses ?? session.future_expenses,
  };
}

/** An empty DimeInputs record (nothing collected). */
export const EMPTY_DIME_INPUTS: DimeInputs = {
  has_mortgage_or_debt: null,
  income_replacement_years: null,
  future_expenses: null,
};

/**
 * Builds the authoritative application-context string passed to the LLM while
 * the estimator is active, so the model never re-asks a collected question,
 * never asks an unapproved question, and never states a dollar figure.
 */
export function buildDimeProgressContext(inputs: DimeInputs): string {
  const answered = (v: boolean | null): string => (v === null ? 'not yet' : v ? 'yes' : 'no');
  const years =
    inputs.income_replacement_years === null
      ? 'not yet'
      : `${inputs.income_replacement_years} years`;
  const step = nextDimeStep(inputs);
  return [
    'DIME estimator progress (application record):',
    `- mortgage or large debts answered: ${answered(inputs.has_mortgage_or_debt)}`,
    `- income replacement years answered: ${years}`,
    `- future expenses answered: ${answered(inputs.future_expenses)}`,
    `Next question to ask: ${step === null ? 'none — all three collected' : `step ${step}`}.`,
    'Ask exactly one approved question per turn. Never re-ask an answered question. Never state a dollar figure in your message — the application computes the educational estimate.',
  ].join('\n');
}
