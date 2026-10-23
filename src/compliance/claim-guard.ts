/**
 * Claim-level output guard (SEC-13).
 *
 * The validation pipeline already enforces schema shape, consent cross-fields,
 * promotional phrasing, persona style and re-offers. None of those look at the
 * factual content of `assistant_message`, so a model slip could still state a
 * price, a guarantee, a prohibited ranking, or echo personal data. In a
 * regulated insurance context each of those is a regulatory statement, not a
 * stylistic problem.
 *
 * This module is the deterministic backstop. It is intentionally conservative:
 * - It matches only the claim shapes the system prompt already prohibits
 *   (Section 5/5.1: guarantees, dollar figures, "best/cheapest/optimal",
 *   tax-free framing, "right for you").
 * - It ignores negated or disclaimed uses ("no option is guaranteed",
 *   "I can't tell you which is best"), so compliant disclaimers do not trip it.
 * - It tolerates rounded, non-monetary numbers ("three steps", "2 options");
 *   only currency amounts, percentages and percent words are figures.
 *
 * The orchestrator runs it before accepting a response; a violation becomes
 * validation feedback for the one retry, and the rule id persists onto the
 * final response's risk_flags so a blocked claim is auditable.
 */

/** Rule ids attached to `risk_flags` when a blocked claim was caught. */
export type ClaimViolationId =
  | 'claim_guarantee'
  | 'claim_prohibited_figure'
  | 'claim_prohibited_comparison'
  | 'claim_personal_data';

export interface ClaimViolation {
  /** Stable rule id, safe to persist and log. */
  id: ClaimViolationId;
  /** Human-readable rule name for logs. */
  rule: string;
  /** Instruction fed back to the model for the retry. */
  retryInstruction: string;
}

/**
 * Negation cues. A prohibited term inside a negation window is a disclaimer,
 * not a claim: "coverage is not guaranteed", "I cannot promise approval".
 */
const NEGATION_WINDOW_CHARS = 48;
const NEGATION_CUE =
  /\b(?:not|never|no|none|nobody|cannot|can't|can’t|isn't|aren't|wasn't|weren't|won't|wouldn't|don't|doesn't|didn't|shouldn't|couldn't|unable|nothing)\b/i;

/**
 * True when the match at `index` sits inside a negated clause.
 *
 * Only the text since the nearest clause boundary is considered, so a negation
 * in a previous sentence cannot excuse a later assertion.
 */
function isNegated(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - NEGATION_WINDOW_CHARS), index);
  const clause = window.split(/[.;:!?]/).pop() ?? window;
  return NEGATION_CUE.test(clause);
}

/** Returns the first non-negated match, or null when every match is negated. */
function firstUnnegated(text: string, pattern: RegExp): RegExpExecArray | null {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  for (let match = global.exec(text); match !== null; match = global.exec(text)) {
    if (!isNegated(text, match.index)) return match;
  }
  return null;
}

/** Guarantee / certainty claims about coverage, approval or outcome. */
const GUARANTEE_PATTERN =
  /\b(?:guarantee(?:d|s)?|we promise|promise you|assured (?:approval|acceptance)|risk[- ]free|always approved|approval is (?:certain|guaranteed)|will definitely (?:be approved|qualify)|no[- ]risk)\b/i;

/**
 * Currency amounts and percentages. The approved corpus contains no figures,
 * and the system prompt forbids the model inventing them; the application
 * supplies the DIME range after validation. A figure here is therefore
 * unapproved by construction.
 */
const FIGURE_PATTERN =
  /(?:\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?%|\b\d[\d,]*(?:\.\d+)?\s+percent\b)/i;

/**
 * Prohibited option claims and rankings (Section 5/5.1). Scoped to an option
 * context on purpose: "the best way to think about it" is ordinary prose,
 * while "the best option for your family" is a prohibited recommendation.
 */
const COMPARISON_PATTERN =
  /(?:\b(?:is|are|would be|will be)\s+the\s+(?:best|cheapest|most affordable|optimal|right)\b|\b(?:best|cheapest|most affordable|lowest[- ]cost|optimal)\s+(?:option|choice|policy|plan|coverage|carrier|for you)\b|\b(?:right|perfect|suitable)\s+for\s+you\b|\btax[- ]free\b)/i;

/** Direct personal identifiers that must never appear in assistant prose. */
const PERSONAL_DATA_PATTERN =
  /(?:\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|\b\d{13,19}\b)/;

/**
 * Detects the first prohibited claim in an assistant message.
 *
 * @param assistantMessage - the candidate `assistant_message`
 * @returns the violation with its retry instruction, or null when clean.
 */
export function detectClaimViolation(assistantMessage: string): ClaimViolation | null {
  if (firstUnnegated(assistantMessage, PERSONAL_DATA_PATTERN)) {
    return {
      id: 'claim_personal_data',
      rule: 'no_personal_data_in_output',
      retryInstruction:
        'The response contains a personal identifier (email address, phone number, Social Security number or card number). Never include contact details or identifiers in the message; direct the visitor to the consent or contact step instead. Rewrite the message without them.',
    };
  }

  if (firstUnnegated(assistantMessage, FIGURE_PATTERN)) {
    return {
      id: 'claim_prohibited_figure',
      rule: 'no_unapproved_figures',
      retryInstruction:
        'The response states a dollar amount or a percentage. The assistant may not state premiums, coverage amounts, savings, rates or returns; the application supplies any educational estimate. Rewrite the message without figures, describing only general factors.',
    };
  }

  if (firstUnnegated(assistantMessage, GUARANTEE_PATTERN)) {
    return {
      id: 'claim_guarantee',
      rule: 'no_guarantees',
      retryInstruction:
        'The response promises or implies a guarantee, assured approval, or a risk-free outcome. No coverage, acceptance, premium or result can be promised. Rewrite the message to describe eligibility and underwriting as subject to review by the carrier, without any guarantee.',
    };
  }

  if (firstUnnegated(assistantMessage, COMPARISON_PATTERN)) {
    return {
      id: 'claim_prohibited_comparison',
      rule: 'no_prohibited_comparison',
      retryInstruction:
        'The response makes a prohibited comparison or recommendation (for example calling an option "best", "cheapest", "optimal", "tax-free", or "right for you"). Present generic category differences from approved sources without ranking or recommending any option. Rewrite the message.',
    };
  }

  return null;
}
