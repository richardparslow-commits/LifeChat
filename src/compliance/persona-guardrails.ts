/**
 * Persona Guardrail Detectors (Section 4.14 + docs/ai-chatbot-persona-configuration.md)
 *
 * Shared source of truth for the prohibited persona behaviors named in the persona
 * spec §8. Used both by the orchestration runtime (as a post-generation filter on
 * `assistant_message`) and by the evaluation tests, so the two can never drift.
 *
 * Each detector returns true when the prohibited content is present. The composed
 * `detectPersonaGuardrailViolation` returns the guardrail-scenario id of the first
 * violation found in a given assistant message, or null when the message is clean.
 */

/**
 * Presumptive purchase framing — the assistant must use open-ended, non-presumptive
 * wording and never presuppose a purchase intent (system prompt §14.1 OPEN-ENDED FRAMING;
 * guardrail `no_presumptive_purchase_framing`).
 */
export function containsPresumptiveFraming(output: string): boolean {
  return /are you looking to buy|ready to get started|let's get you covered|do you want me to set up your policy/i.test(
    output,
  );
}

/**
 * Pressure language — guilt, fear, false urgency, scarcity, shame, or claims about the
 * user's family's protection status (system prompt §7, §14.1; guardrail `no_pressure_language`).
 */
export function containsPressureLanguage(output: string): boolean {
  return /(?:your|the) (?:family'?s|wife'?s|husband'?s|kids'?) (protection)|before it'?s too late|act now|carriers will decline the application anyway|you need to do this now|don'?t miss out|today only/i.test(
    output,
  );
}

/**
 * Fabricated history / anecdotes — only approved retrieved content with citations is
 * allowed; invented client stories or fabricated case examples are prohibited
 * (system prompt §5; guardrail `no_fabricated_anecdotes`).
 */
export function containsFabricatedHistory(output: string): boolean {
  return /(?:one of|many of) my (?:clients|customers)|i remember a case|let me tell you about a client|a client of mine/i.test(
    output,
  );
}

/**
 * Matches the assistant offering a follow-up action (call/schedule/connect/book).
 * Offers are attached to assistant-side turns only (see isReOfferAfterDecline).
 */
const OFFER_PATTERN =
  /(?:would you like|can i|shall i|want me to|let me (?:set up|book|schedule))[^.?]*(?:call|schedule|connect|prepare|set up|book)/i;

/**
 * Matches an unambiguous user refusal/decline. Deliberately specific to avoid
 * flagging benign intent like "I'm just looking for term-life info" (which is
 * interest, not a decline of an offer).
 */
const DECLINE_PATTERN =
  /\b(?:no[,\s]+thanks?|not\s+interested|not\s+(?:ready|now|right\s+now)|don'?t\s+(?:want|need|like)|do\s+not\s+(?:want|need|like)|i'?ll\s+pass|decline|stop\b|not\s+ready\s+to\s+(?:sign|buy))\b/i;

export function looksLikeOffer(message: string): boolean {
  return OFFER_PATTERN.test(message);
}

export function looksLikeDecline(message: string): boolean {
  return DECLINE_PATTERN.test(message);
}

/**
 * Re-occurring offers after a decline — the assistant must not re-offer a declined
 * step in the session (system prompt §7 LOOP_CONTROLS; guardrail `decline_no_reoffer`).
 *
 * Scans a flat sequence of messages (already role-resolved by the caller) and flags
 * an offer that appears after a decline. Backward-compatible heuristic used by the
 * unit tests; the orchestrator uses the role-aware isReOfferAfterDecline instead.
 */
export function reOffersAfterDecline(messages: readonly string[]): boolean {
  let sawDecline = false;
  for (const m of messages) {
    if (looksLikeDecline(m)) {
      sawDecline = true;
      continue;
    }
    if (sawDecline && looksLikeOffer(m)) {
      return true;
    }
  }
  return false;
}

/**
 * A single assistant-side message that is an offer ignores whether it is the first
 * offer or a re-offer; use this within a full conversation via isReOfferAfterDecline.
 */

/**
 * Role-aware re-offer detection for a conversation lifecycle.
 *
 * - Only USER messages count as a decline (an assistant disclaimer like "this is not
 *   a recommendation" must not be mistaken for one).
 * - Only the messages up to and including the CURRENT user turn are considered as
 *   prior context (conversationHistory is snapshotted before the current turn is
 *   recorded).
 * - The candidate assistant message is flagged only if it is itself an offer AND a
 *   prior user decline exists — so a single first-time offer is allowed, and an
 *   offer after a decline is blocked across turns.
 *
 * @param priorUserMessages - user history content (including the current user message).
 * @param candidateAssistantMessage - the assistant_message being validated this turn.
 */
export function isReOfferAfterDecline(
  priorUserMessages: readonly string[],
  candidateAssistantMessage: string,
): boolean {
  if (!looksLikeOffer(candidateAssistantMessage)) {
    return false;
  }
  return priorUserMessages.some(looksLikeDecline);
}

/**
 * Guardrail id for the first text-level persona guardrail violation in a single
 * assistant message, or null if none is present.
 *
 * Consent-affirmative and re-offer behaviors are not single-message text checks
 * (consent is enforced by schema booleans; re-offering requires history), so this
 * covers the three text-detectable prohibited behaviors at generation time.
 */
export function detectPersonaGuardrailViolation(assistantMessage: string): string | null {
  if (containsPresumptiveFraming(assistantMessage)) {
    return 'no_presumptive_purchase_framing';
  }
  if (containsPressureLanguage(assistantMessage)) {
    return 'no_pressure_language';
  }
  if (containsFabricatedHistory(assistantMessage)) {
    return 'no_fabricated_anecdotes';
  }
  return null;
}
