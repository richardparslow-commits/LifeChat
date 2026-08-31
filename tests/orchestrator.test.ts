/**
 * Tests for the LLM orchestrator's retry-on-invalid-JSON resilience
 * (src/llm/orchestrator.ts).
 *
 * Simulates the model returning invalid JSON first and a valid response on
 * the retry, asserting the orchestrator feeds the validation errors back and
 * returns the retry's response instead of falling back.
 */

import { generateResponse } from '../src/llm/orchestrator';
import { callLLM } from '../src/llm/llm-client';
import { config } from '../src/config/app-config';

jest.mock('../src/llm/llm-client', () => {
  const actual = jest.requireActual('../src/llm/llm-client');
  return { ...actual, callLLM: jest.fn() };
});

const mockCallLLM = callLLM as jest.MockedFunction<typeof callLLM>;

/** A full schema-valid response (passes AssistantResponseSchema + rules). */
function validJson(message = 'Term life insurance covers a set period.'): string {
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

/** JSON that parses but is missing required fields (fails Zod). */
const invalidJson = JSON.stringify({ assistant_message: 'this is incomplete' });

const input = {
  userMessage: 'I am looking for term life insurance with about 500000 dollars of coverage.',
  currentState: 'education' as const,
};

beforeEach(() => {
  mockCallLLM.mockReset();
});

afterEach(() => {
  // Restore the marketing-review gate for other suites
  config.freeOfferMarketingApproved = false;
});

describe('generateResponse retry-on-invalid-JSON', () => {
  it('retries once with feedback and returns the valid retry response', async () => {
    mockCallLLM
      .mockResolvedValueOnce({ success: true, content: invalidJson, latencyMs: 5 })
      .mockResolvedValueOnce({
        success: true,
        content: validJson('retry succeeded'),
        latencyMs: 5,
      });

    const { response } = await generateResponse(input);

    expect(response.assistant_message).toBe('retry succeeded');
    expect(response.state).toBe('education');
    // The invalid response was repaired via retry — not a fallback
    expect(response.risk_flags).not.toContain('static_fallback_used');

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    const feedback = mockCallLLM.mock.calls[1][0].validationFeedback;
    expect(feedback).toBeDefined();
    expect(feedback).toContain('rejected');
    expect(feedback).toContain('assistant_message, state, citations');
  });

  it('does not retry when the first response is valid', async () => {
    mockCallLLM.mockResolvedValueOnce({ success: true, content: validJson(), latencyMs: 5 });

    const { response } = await generateResponse(input);

    expect(response.assistant_message).toBe('Term life insurance covers a set period.');
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockCallLLM.mock.calls[0][0].validationFeedback).toBeUndefined();
  });

  it('falls back after two invalid responses', async () => {
    mockCallLLM
      .mockResolvedValueOnce({ success: true, content: invalidJson, latencyMs: 5 })
      .mockResolvedValueOnce({ success: true, content: invalidJson, latencyMs: 5 });

    const { response } = await generateResponse(input);

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(response.state).toBe('standby');
    expect(response.risk_flags).toContain('static_fallback_used');
    expect(response.analytics.event_name).toBe('ai_fallback_shown');
  });
});

describe('generateResponse — promotional-offer output guard (marketing review)', () => {
  it('rejects a "free quote" claim and retries until the phrasing is removed', async () => {
    mockCallLLM
      .mockResolvedValueOnce({
        success: true,
        content: validJson('Would you like a free quote today?'),
        latencyMs: 5,
      })
      .mockResolvedValueOnce({
        success: true,
        content: validJson('Would you like to talk with Richard about your coverage?'),
        latencyMs: 5,
      });

    const { response } = await generateResponse(input);

    expect(response.assistant_message).toBe(
      'Would you like to talk with Richard about your coverage?',
    );
    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    const feedback = mockCallLLM.mock.calls[1][0].validationFeedback;
    expect(feedback).toBeDefined();
    expect(feedback).toContain('free');
    expect(feedback).toContain('marketing');
  });

  it('falls back when the retry still contains the free-offer phrasing', async () => {
    mockCallLLM
      .mockResolvedValueOnce({
        success: true,
        content: validJson('Get a free consultation!'),
        latencyMs: 5,
      })
      .mockResolvedValueOnce({
        success: true,
        content: validJson('Sign up for a no-obligation review.'),
        latencyMs: 5,
      });

    const { response } = await generateResponse(input);

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(response.risk_flags).toContain('static_fallback_used');
    // The fallback never contains the promotional phrasing
    expect(response.assistant_message).not.toMatch(/free|obligation/i);
  });

  it('allows the phrasing once marketing review approves it (flag on)', async () => {
    config.freeOfferMarketingApproved = true;
    mockCallLLM.mockResolvedValueOnce({
      success: true,
      content: validJson('Would you like a free quote today?'),
      latencyMs: 5,
    });

    const { response } = await generateResponse(input);

    expect(response.assistant_message).toBe('Would you like a free quote today?');
    expect(mockCallLLM).toHaveBeenCalledTimes(1);
  });
});
