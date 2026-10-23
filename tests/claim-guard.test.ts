/**
 * SEC-13 — claim-level output guard.
 *
 * Two layers:
 * 1. `detectClaimViolation` unit behavior, including the negation handling that
 *    keeps compliant disclaimers from being rejected.
 * 2. Orchestrator wiring: a prohibited claim is fed back for the single retry,
 *    the rule id persists onto the final response's risk_flags, and a second
 *    violation falls back to the static safe response instead of shipping the
 *    claim.
 */

import { generateResponse } from '../src/llm/orchestrator';
import { callLLM } from '../src/llm/llm-client';
import { detectClaimViolation } from '../src/compliance/claim-guard';

jest.mock('../src/llm/llm-client', () => {
  const actual = jest.requireActual('../src/llm/llm-client');
  return { ...actual, callLLM: jest.fn() };
});

const mockCallLLM = callLLM as jest.MockedFunction<typeof callLLM>;

/** A full schema-valid response (passes AssistantResponseSchema + rules). */
function validJson(message: string): string {
  return JSON.stringify({
    assistant_message: message,
    state: 'education',
    citations: [],
    lead_data: {
      first_name: null,
      email: null,
      phone: null,
      goal_category: null,
      timeline_category: null,
      current_coverage_category: null,
      policy_type_seeking: null,
      coverage_amount_seeking: null,
      contact_channel: null,
      time_zone: null,
      preferred_contact_window: null,
      medical_profile: null,
    },
    consent: {
      privacy_notice_version: '1.0.0',
      contact_consent_version: null,
      contact_consent_affirmed: false,
      medical_consent_version: null,
      medical_consent_affirmed: false,
      do_not_contact: false,
    },
    proposed_action: 'none',
    action_arguments: {},
    visual_card: null,
    risk_flags: [],
    analytics: {
      event_name: 'ai_answer_shown',
      topic_category: null,
      conversation_stage: 'education',
      fallback_type: null,
      handoff_reason: null,
      error_code: null,
    },
  });
}

const input = {
  userMessage: 'How does underwriting for term life work?',
  currentState: 'education' as const,
};

beforeEach(() => {
  mockCallLLM.mockReset();
});

describe('detectClaimViolation — guarantees', () => {
  it('blocks a guarantee of coverage or approval', () => {
    expect(detectClaimViolation('Your coverage is guaranteed for life.')?.id).toBe(
      'claim_guarantee',
    );
    expect(detectClaimViolation('We promise approval within a week.')?.id).toBe('claim_guarantee');
    expect(detectClaimViolation('This is a risk-free decision.')?.id).toBe('claim_guarantee');
  });

  it('allows a negated disclaimer', () => {
    expect(
      detectClaimViolation('No coverage is guaranteed before the carrier completes underwriting.'),
    ).toBeNull();
    expect(
      detectClaimViolation('I cannot guarantee approval; the carrier decides after review.'),
    ).toBeNull();
  });

  it('does not let a negation in an earlier sentence excuse a later claim', () => {
    expect(detectClaimViolation('Underwriting is never instant. Approval is guaranteed.')?.id).toBe(
      'claim_guarantee',
    );
  });
});

describe('detectClaimViolation — unapproved figures', () => {
  it('blocks dollar amounts and percentages', () => {
    expect(detectClaimViolation('You could pay $47 a month for that.')?.id).toBe(
      'claim_prohibited_figure',
    );
    expect(detectClaimViolation('Premiums rose about 3% last year.')?.id).toBe(
      'claim_prohibited_figure',
    );
    expect(detectClaimViolation('Expect to save 12 percent.')?.id).toBe('claim_prohibited_figure');
  });

  it('leaves ordinary prose numbers alone', () => {
    expect(detectClaimViolation('There are 3 broad categories of term policy.')).toBeNull();
    expect(
      detectClaimViolation('Ask one question per turn; step 2 covers years of income.'),
    ).toBeNull();
  });
});

describe('detectClaimViolation — prohibited comparisons and recommendations', () => {
  it('blocks rankings and "right for you" recommendations', () => {
    expect(detectClaimViolation('Whole life is the best option for your family.')?.id).toBe(
      'claim_prohibited_comparison',
    );
    expect(detectClaimViolation('Term is the cheapest coverage available.')?.id).toBe(
      'claim_prohibited_comparison',
    );
    expect(detectClaimViolation('This plan is right for you.')?.id).toBe(
      'claim_prohibited_comparison',
    );
    expect(detectClaimViolation('Growth inside the policy is tax-free.')?.id).toBe(
      'claim_prohibited_comparison',
    );
  });

  it('allows neutral wording and negated rankings', () => {
    expect(
      detectClaimViolation('There is no single best plan; it depends on your goals.'),
    ).toBeNull();
    expect(detectClaimViolation("I can't tell you which option is best.")).toBeNull();
  });
});

describe('detectClaimViolation — personal data in assistant prose', () => {
  it('blocks identifiers', () => {
    expect(detectClaimViolation('Send your details to jane@example.com.')?.id).toBe(
      'claim_personal_data',
    );
    expect(detectClaimViolation('My number is 512-555-0100.')?.id).toBe('claim_personal_data');
    expect(detectClaimViolation('The SSN 123-45-6789 is on file.')?.id).toBe('claim_personal_data');
  });

  it('allows emergency guidance', () => {
    expect(detectClaimViolation('Call 911 if you are in immediate danger.')).toBeNull();
  });
});

describe('orchestrator — claim guard wiring', () => {
  it('retries a figure claim and returns the rewritten message', async () => {
    mockCallLLM
      .mockResolvedValueOnce({
        success: true,
        content: validJson('You would pay $42 a month for that coverage.'),
        latencyMs: 5,
      })
      .mockResolvedValueOnce({
        success: true,
        content: validJson('Cost depends on age, health, term length and coverage amount.'),
        latencyMs: 5,
      });

    const { response } = await generateResponse(input);

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(response.assistant_message).toBe(
      'Cost depends on age, health, term length and coverage amount.',
    );
    expect(response.risk_flags).toContain('claim_prohibited_figure');
    expect(response.risk_flags).not.toContain('static_fallback_used');

    const feedback = mockCallLLM.mock.calls[1][0].validationFeedback;
    expect(feedback).toContain('dollar amount or a percentage');
  });

  it('falls back rather than shipping a claim the retry repeats', async () => {
    mockCallLLM
      .mockResolvedValueOnce({
        success: true,
        content: validJson('Approval is guaranteed with this carrier.'),
        latencyMs: 5,
      })
      .mockResolvedValueOnce({
        success: true,
        content: validJson('We promise you will be approved.'),
        latencyMs: 5,
      });

    const { response } = await generateResponse(input);

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(response.risk_flags).toContain('static_fallback_used');
    expect(response.assistant_message).not.toMatch(/guarantee|promise you will be approved/i);
  });

  it('accepts a compliant disclaimer without a retry', async () => {
    mockCallLLM.mockResolvedValueOnce({
      success: true,
      content: validJson(
        'No policy is guaranteed to be approved; the carrier reviews your application.',
      ),
      latencyMs: 5,
    });

    const { response } = await generateResponse(input);

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(response.risk_flags).not.toContain('claim_guarantee');
    expect(response.risk_flags).not.toContain('static_fallback_used');
  });
});
