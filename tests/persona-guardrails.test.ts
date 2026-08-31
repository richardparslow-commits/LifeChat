/**
 * Persona Guardrail Tests (Section 4.14 + docs/ai-chatbot-persona-configuration.md)
 *
 * Two jobs:
 *  1. Detect prohibited persona behaviors in assistant output. Each detector must
 *     flag a clear violation and pass a compliant control, so a new prohibited
 *     phrasing (or a prompt regression) fails CI.
 *  2. Verify the system prompt still mandates each guardrail. If a prompt edit
 *     removes or weakens an enforcement rule, these tests fail — keeping the
 *     prompt and the persona spec in sync.
 *
 * The five behaviors targeted by docs/ai-chatbot-persona-configuration.md §8:
 *   - presumptive purchase framing    (configured as `no_presumptive_purchase_framing`)
 *   - pressure language               (`no_pressure_language`)
 *   - hedged consent treated as yes   (`ambiguous_consent_not_affirmed`)
 *   - fabricated history              (`no_fabricated_anecdotes`)
 *   - re-offering after decline       (`decline_no_reoffer`)
 *
 * Detectors for the text-level behaviors are shared with the orchestrator via
 * src/compliance/persona-guardrails.ts, so tests and runtime use one source of truth.
 */

import { GUARDRAIL_SCENARIOS } from '../src/evaluation/evaluation-plan';
import { SYSTEM_PROMPT } from '../src/prompts/system-prompt';
import {
  containsPresumptiveFraming,
  containsPressureLanguage,
  containsFabricatedHistory,
  reOffersAfterDecline,
  isReOfferAfterDecline,
  looksLikeOffer,
  looksLikeDecline,
  detectPersonaGuardrailViolation,
} from '../src/compliance/persona-guardrails';

/** A hedged answer must be treated as NOT consent (system prompt §9). */
function isHedgedConsent(reply: string): boolean {
  return /\b(maybe|i guess|probably|if nothing comes up|we'?ll see|not sure)\b/i.test(reply);
}

const GUARDRAIL_IDS = GUARDRAIL_SCENARIOS.map((s) => s.id);

/* ── 2. Detector accuracy tests ────────────────────────────────────────── */

describe('Persona guardrails — detector accuracy', () => {
  test('presumptive purchase framing is detected', () => {
    expect(containsPresumptiveFraming('Are you looking to buy life insurance today?')).toBe(true);
  });

  test('compliant open-ended framing is NOT flagged as presumptive', () => {
    expect(
      containsPresumptiveFraming('What are you hoping to understand about life insurance today?'),
    ).toBe(false);
  });

  test('pressure / fear / family-status language is detected', () => {
    expect(
      containsPressureLanguage(
        "Your family isn't going to be upset with you for prioritizing protection — act now before it's too late.",
      ),
    ).toBe(true);
  });

  test('neutral educational language is NOT flagged as pressure', () => {
    expect(
      containsPressureLanguage(
        'Term and whole life differ in how long the coverage lasts and whether it builds cash value. This is general education, not a recommendation.',
      ),
    ).toBe(false);
  });

  test('hedged replies are classified as NOT consent', () => {
    expect(isHedgedConsent('I guess, maybe — if nothing comes up.')).toBe(true);
    expect(isHedgedConsent('Yes, you can proceed.')).toBe(false);
  });

  test('fabricated client stories are detected', () => {
    expect(containsFabricatedHistory('One of my clients saved 40% after switching carriers.')).toBe(
      true,
    );
  });

  test('approved, grounded output is NOT flagged as fabricated', () => {
    expect(
      containsFabricatedHistory(
        'We define term life as coverage for a set number of years. Sources: Life Policy Pilot, term vs whole life.',
      ),
    ).toBe(false);
  });

  test('a repeated offer after a decline is detected', () => {
    expect(
      reOffersAfterDecline([
        'Would you like to set up a call with the licensed broker?',
        'No, thanks.',
        'Can I schedule a call with Richard for you today?',
      ]),
    ).toBe(true);
  });

  test('a single offer is NOT flagged as re-offering', () => {
    expect(reOffersAfterDecline(['Would you like to set up a call?', 'No, thanks.'])).toBe(false);
  });
});

/* ── 2b. Runtime composer (post-generation filter) ────────────────────── */

describe('Persona guardrails — runtime composer', () => {
  test('returns the guardrail id for a presumptive-framing message', () => {
    expect(detectPersonaGuardrailViolation('Are you looking to buy life insurance today?')).toBe(
      'no_presumptive_purchase_framing',
    );
  });

  test('returns the guardrail id for a pressure-language message', () => {
    expect(
      detectPersonaGuardrailViolation(
        "Your family won't be protected unless you act now before it's too late.",
      ),
    ).toBe('no_pressure_language');
  });

  test('returns the guardrail id for a fabricated-anecdote message', () => {
    expect(
      detectPersonaGuardrailViolation('One of my clients saved 40% after switching carriers.'),
    ).toBe('no_fabricated_anecdotes');
  });

  test('returns null for compliant output', () => {
    expect(
      detectPersonaGuardrailViolation(
        'Term life lasts for a set number of years, while whole life builds cash value. This is general education.',
      ),
    ).toBeNull();
  });
});

/* ── 2c. Stateful re-offer detection (cross-turn, role-aware) ─────────── */

describe('Persona guardrails — stateful re-offer (across turns)', () => {
  test('flags a candidate offer when a prior user decline exists', () => {
    expect(
      isReOfferAfterDecline(
        ['No, thanks, I do not want a call.', 'Actually I am just looking.'],
        'Would you like to set up a call with the licensed broker?',
      ),
    ).toBe(true);
  });

  test('allows a first-time offer with no prior decline', () => {
    expect(
      isReOfferAfterDecline(
        ['I have a question about term life insurance.'],
        'Would you like to set up a call with the licensed broker?',
      ),
    ).toBe(false);
  });

  test('does not flag a non-offer follow-up after a decline', () => {
    expect(
      isReOfferAfterDecline(
        ['No, thanks.'],
        'Understood. I will stay in general education and answer any questions you have.',
      ),
    ).toBe(false);
  });

  test('does not treat benign intent as a decline', () => {
    // "I'm just looking for term info" is interest, not a decline of an offer.
    expect(
      isReOfferAfterDecline(
        ["I'm just looking for information about term life insurance."],
        'Would you like to set up a call with the licensed broker?',
      ),
    ).toBe(false);
  });

  test('matches unambiguous decline phrases', () => {
    expect(looksLikeDecline('No thanks.')).toBe(true);
    expect(looksLikeDecline('Not interested.')).toBe(true);
    expect(looksLikeDecline("I don't want a call.")).toBe(true);
    expect(looksLikeDecline('Please stop offering contact.')).toBe(true);
  });

  test('does not mistake benign intent or assistant disclaimers for decline', () => {
    expect(looksLikeDecline('I am just browsing term options.')).toBe(false);
    expect(looksLikeDecline('What is the difference?')).toBe(false);
    expect(looksLikeDecline('This is not a recommendation.')).toBe(false);
  });

  test('matches offer phrasing', () => {
    expect(looksLikeOffer('Would you like to schedule a call?')).toBe(true);
    expect(looksLikeOffer('Can I connect you with Richard?')).toBe(true);
    expect(looksLikeOffer('Term life covers a set period.')).toBe(false);
  });
});

/* ── 3. Prompt consistency — guardrails must stay in the system prompt ─── */

describe('Persona guardrails — system prompt enforcement', () => {
  test('guardrail scenarios declared in the evaluation plan', () => {
    expect(GUARDRAIL_SCENARIOS.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'no_presumptive_purchase_framing',
        'no_pressure_language',
        'ambiguous_consent_not_affirmed',
        'no_fabricated_anecdotes',
        'decline_no_reoffer',
      ]),
    );
  });

  test('prompt forbids presumptive purchase framing (OPEN-ENDED FRAMING)', () => {
    expect(SYSTEM_PROMPT).toMatch(/OPEN-ENDED FRAMING/);
    expect(SYSTEM_PROMPT).toMatch(/non-presumptive wording/);
    expect(SYSTEM_PROMPT).toMatch(/presuppose the user wants to purchase/);
  });

  test('prompt forbids pressure, fear, guilt, and scarcity (conversation limits and style)', () => {
    // §7 pressure limits and §14.1 closing line.
    expect(SYSTEM_PROMPT).toMatch(/Never use guilt, fear, false urgency, scarcity/);
    expect(SYSTEM_PROMPT).toMatch(/family'?s protection status/);
    expect(SYSTEM_PROMPT).toMatch(/education, not a sale/);
  });

  test('prompt treats hedged replies as NOT consent', () => {
    expect(SYSTEM_PROMPT).toMatch(/maybe,[^]*I guess,[^]*probably[^]* NOT/);
    expect(SYSTEM_PROMPT).toMatch(/contact_consent_affirmed=false/);
  });

  test('prompt forbids fabricated content and anecdotes', () => {
    expect(SYSTEM_PROMPT).toMatch(/Never fabricate|a fabricated fact, citation/);
  });

  test('prompt suppresses offers after a decline (loop control)', () => {
    expect(GUARDRAIL_IDS).toContain('decline_no_reoffer');
    expect(SYSTEM_PROMPT).toMatch(
      /do not offer qualification,\s+contact capture, or booking again/,
    );
    expect(SYSTEM_PROMPT).toMatch(/(?:do not|never) ask for the same declined field twice/i);
  });
});
