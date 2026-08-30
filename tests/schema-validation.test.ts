/**
 * Tests for the JSON Output Schema and Validation (Section 15)
 *
 * Verifies Zod schema parsing, cross-field rule validation,
 * and the static safe fallback.
 */

import {
  AssistantResponseSchema,
  validateSchemaRules,
  STATIC_SAFE_FALLBACK,
  type AssistantResponse,
} from '../src/schema/response-schema';

/** Helper: build a valid response that can be overridden. */
function makeValidResponse(overrides: Partial<AssistantResponse> = {}): AssistantResponse {
  return {
    assistant_message: 'Term life insurance provides coverage for a specific period.',
    state: 'education',
    citations: [
      { title: 'Term vs Whole Life', url: 'https://lifepolicypilot.blog/term-vs-whole/' },
    ],
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
    risk_flags: [],
    analytics: {
      event_name: 'ai_answer_shown',
      topic_category: 'term_life',
      conversation_stage: 'education',
      fallback_type: null,
      handoff_reason: null,
      error_code: null,
    },
    ...overrides,
  };
}

describe('Schema — Zod parsing', () => {
  test('accepts a fully valid response', () => {
    const response = makeValidResponse();
    const result = AssistantResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test('rejects response missing assistant_message', () => {
    const bad = makeValidResponse();
    delete (bad as Record<string, unknown>).assistant_message;
    const result = AssistantResponseSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test('rejects invalid state enum value', () => {
    const result = AssistantResponseSchema.safeParse(
      makeValidResponse({ state: 'invalid_state' as never }),
    );
    expect(result.success).toBe(false);
  });

  test('rejects invalid proposed_action value', () => {
    const result = AssistantResponseSchema.safeParse(
      makeValidResponse({ proposed_action: 'hack_the_mainframe' as never }),
    );
    expect(result.success).toBe(false);
  });

  test('accepts null for optional lead_data fields', () => {
    const result = AssistantResponseSchema.safeParse(makeValidResponse());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lead_data.first_name).toBeNull();
      expect(result.data.lead_data.email).toBeNull();
    }
  });

  test('accepts valid goal_category enum', () => {
    const response = makeValidResponse();
    response.lead_data.goal_category = 'income_replacement';
    const result = AssistantResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test('rejects invalid goal_category enum', () => {
    const response = makeValidResponse();
    response.lead_data.goal_category = 'something_else' as never;
    const result = AssistantResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });

  test('accepts valid contact_channel enum', () => {
    const response = makeValidResponse();
    response.lead_data.contact_channel = 'email';
    const result = AssistantResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test('accepts analytics event_name from allowlist', () => {
    const response = makeValidResponse();
    response.analytics.event_name = 'ai_abstention';
    const result = AssistantResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test('rejects non-allowlisted analytics event_name', () => {
    const response = makeValidResponse();
    response.analytics.event_name = 'user_clicked_buy' as never;
    const result = AssistantResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });

  test('accepts empty citations array', () => {
    const response = makeValidResponse();
    response.citations = [];
    const result = AssistantResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test('accepts multiple citations', () => {
    const response = makeValidResponse();
    response.citations = [
      { title: 'Source A', url: 'https://example.com/a' },
      { title: 'Source B', url: 'https://example.com/b' },
      { title: 'Source C', url: 'https://example.com/c' },
    ];
    const result = AssistantResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  test('rejects citation with non-URL string', () => {
    const response = makeValidResponse();
    response.citations = [{ title: 'Bad Source', url: 'not-a-url' }];
    const result = AssistantResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});

describe('Schema — cross-field rule validation', () => {
  test('passes for a normal education response', () => {
    const errors = validateSchemaRules(makeValidResponse());
    expect(errors).toEqual([]);
  });

  test('create_lead without consent_affirmed fails', () => {
    const response = makeValidResponse({
      proposed_action: 'create_lead',
    });
    const errors = validateSchemaRules(response);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('create_lead requires affirmative current contact consent');
  });

  test('create_lead with consent_affirmed passes consent rule', () => {
    const response = makeValidResponse({
      proposed_action: 'create_lead',
    });
    response.consent.contact_consent_affirmed = true;
    response.consent.contact_consent_version = '1.0.0';
    const errors = validateSchemaRules(response);
    // Should not have the consent error (may still have other errors)
    const hasConsentError = errors.some((e) => e.includes('affirmative current contact consent'));
    expect(hasConsentError).toBe(false);
  });

  test('book_appointment without slot_id fails', () => {
    const response = makeValidResponse({
      proposed_action: 'book_appointment',
    });
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('verified slot_id'))).toBe(true);
  });

  test('book_appointment with slot_id passes that rule', () => {
    const response = makeValidResponse({
      proposed_action: 'book_appointment',
      action_arguments: { slot_id: 'slot_123' },
    });
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('verified slot_id'))).toBe(false);
  });

  test('sensitive_data_disclosed with handoff action passes', () => {
    const response = makeValidResponse({
      proposed_action: 'request_human_handoff',
      risk_flags: ['sensitive_data_disclosed'],
    });
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('sensitive_data_disclosed'))).toBe(false);
  });

  test('sensitive_data_disclosed with create_lead action fails', () => {
    const response = makeValidResponse({
      proposed_action: 'create_lead',
      risk_flags: ['sensitive_data_disclosed'],
    });
    response.consent.contact_consent_affirmed = true;
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('sensitive_data_disclosed'))).toBe(true);
  });

  test('do_not_contact=true suppresses contact_offer state', () => {
    const response = makeValidResponse({
      state: 'contact_offer',
    });
    response.consent.do_not_contact = true;
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('do_not_contact'))).toBe(true);
  });

  test('do_not_contact=true suppresses create_lead action', () => {
    const response = makeValidResponse({
      proposed_action: 'create_lead',
    });
    response.consent.do_not_contact = true;
    response.consent.contact_consent_affirmed = true;
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('do_not_contact'))).toBe(true);
  });

  test('do_not_contact=true with education state and none action passes', () => {
    const response = makeValidResponse();
    response.consent.do_not_contact = true;
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('do_not_contact'))).toBe(false);
  });

  test('medical_profile without medical consent fails', () => {
    const response = makeValidResponse();
    response.lead_data.medical_profile = {
      date_of_birth: '1985-06-15',
      gender: null,
      height_inches: null,
      weight_lbs: null,
      tobacco_nicotine_use: null,
      medical_conditions: [],
      medications: [],
      diabetes: { diabetes_type: null, treatment_method: null, last_a1c: null },
      cancer: { cancer_type: null, years_cancer_free: null },
    };
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('medical_profile data requires affirmative'))).toBe(true);
  });

  test('medical_profile with affirmed medical consent passes', () => {
    const response = makeValidResponse();
    response.lead_data.medical_profile = {
      date_of_birth: '1985-06-15',
      gender: 'female',
      height_inches: 66,
      weight_lbs: 150,
      tobacco_nicotine_use: 'none',
      medical_conditions: [],
      medications: [],
      diabetes: { diabetes_type: null, treatment_method: null, last_a1c: null },
      cancer: { cancer_type: null, years_cancer_free: null },
    };
    response.consent.medical_consent_affirmed = true;
    response.consent.medical_consent_version = '1.0.0';
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('medical_profile data requires affirmative'))).toBe(false);
    expect(errors.some((e) => e.includes('medical_consent_affirmed requires'))).toBe(false);
  });

  test('affirmed medical consent without version fails', () => {
    const response = makeValidResponse();
    response.lead_data.medical_profile = {
      date_of_birth: '1985-06-15',
      gender: null,
      height_inches: null,
      weight_lbs: null,
      tobacco_nicotine_use: null,
      medical_conditions: [],
      medications: [],
      diabetes: { diabetes_type: null, treatment_method: null, last_a1c: null },
      cancer: { cancer_type: null, years_cancer_free: null },
    };
    response.consent.medical_consent_affirmed = true;
    const errors = validateSchemaRules(response);
    expect(errors.some((e) => e.includes('medical_consent_affirmed requires'))).toBe(true);
  });

  test('diabetes and cancer sub-profiles parse', () => {
    const response = makeValidResponse();
    response.lead_data.medical_profile = {
      date_of_birth: null,
      gender: null,
      height_inches: null,
      weight_lbs: null,
      tobacco_nicotine_use: null,
      medical_conditions: [],
      medications: [],
      diabetes: { diabetes_type: 'type2', treatment_method: 'insulin', last_a1c: '7.2' },
      cancer: { cancer_type: 'breast', years_cancer_free: 5 },
    };
    response.consent.medical_consent_affirmed = true;
    response.consent.medical_consent_version = '1.0.0';
    const parsed = AssistantResponseSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lead_data.medical_profile?.diabetes.diabetes_type).toBe('type2');
      expect(parsed.data.lead_data.medical_profile?.cancer.years_cancer_free).toBe(5);
    }
  });
});

describe('Schema — static safe fallback', () => {
  test('has state standby', () => {
    expect(STATIC_SAFE_FALLBACK.state).toBe('standby');
  });

  test('has proposed_action none', () => {
    expect(STATIC_SAFE_FALLBACK.proposed_action).toBe('none');
  });

  test('includes static_fallback_used risk flag', () => {
    expect(STATIC_SAFE_FALLBACK.risk_flags).toContain('static_fallback_used');
  });

  test('has ai_fallback_shown event', () => {
    expect(STATIC_SAFE_FALLBACK.analytics.event_name).toBe('ai_fallback_shown');
  });

  test('has no PII in lead_data', () => {
    expect(STATIC_SAFE_FALLBACK.lead_data.first_name).toBeNull();
    expect(STATIC_SAFE_FALLBACK.lead_data.email).toBeNull();
    expect(STATIC_SAFE_FALLBACK.lead_data.phone).toBeNull();
  });

  test('has no medical profile and no medical consent', () => {
    expect(STATIC_SAFE_FALLBACK.lead_data.medical_profile).toBeNull();
    expect(STATIC_SAFE_FALLBACK.consent.medical_consent_affirmed).toBe(false);
    expect(STATIC_SAFE_FALLBACK.consent.medical_consent_version).toBeNull();
  });

  test('has no citations (no fabricated sources)', () => {
    expect(STATIC_SAFE_FALLBACK.citations).toEqual([]);
  });
});
