/**
 * JSON Output Schema (Section 15 of the specification)
 *
 * The model must return exactly one valid JSON object with no surrounding
 * prose or markdown. The application shows only `assistant_message` to
 * the visitor. Uses null for unknown values and never invents lead fields.
 */

import { z } from 'zod';

/**
 * Citation object — title and canonical URL of an approved source.
 */
export const CitationSchema = z.object({
  title: z.string(),
  url: z.string().url(),
});

/**
 * Medical profile — Phase 2 consented medical fact-finding (Section 9.1).
 * Collected ONLY after the user gives explicit, current, versioned medical
 * consent. Never placed in analytics events.
 */
export const DiabetesProfileSchema = z.object({
  diabetes_type: z.enum(['type1', 'type2', 'unsure']).nullable().default(null),
  treatment_method: z.enum(['pills', 'insulin', 'other']).nullable().default(null),
  last_a1c: z.string().nullable().default(null),
});

/**
 * Cancer history — Phase 2 consented medical fact-finding (Section 9.1).
 */
export const CancerProfileSchema = z.object({
  cancer_type: z.string().nullable().default(null),
  years_cancer_free: z.number().nullable().default(null),
});

/**
 * Medical profile — Phase 2 consented medical fact-finding (Section 9.1).
 * Only populated when medical consent is affirmed. Never in analytics.
 */
export const MedicalProfileSchema = z.object({
  date_of_birth: z.string().nullable().default(null),
  gender: z.enum(['male', 'female', 'other', 'prefer_not_to_say']).nullable().default(null),
  height_inches: z.number().nullable().default(null),
  weight_lbs: z.number().nullable().default(null),
  tobacco_nicotine_use: z
    .enum(['none', 'cigarettes', 'vaping', 'other_nicotine', 'prefer_not_to_say'])
    .nullable()
    .default(null),
  medical_conditions: z.array(z.string()).default([]),
  medications: z.array(z.string()).default([]),
  // Sub-blocks are nullable: the model legitimately emits null until those
  // facts are collected ("use null for unknown" per Section 15).
  diabetes: DiabetesProfileSchema.nullable().default(null),
  cancer: CancerProfileSchema.nullable().default(null),
});

/**
 * Lead data — PII fields for the secure operational system only.
 * All fields are optional (null by default). Never include sensitive data in
 * analytics. The medical_profile block is Phase 2 and requires affirmed,
 * versioned medical consent (enforced by validateSchemaRules).
 */
export const LeadDataSchema = z.object({
  first_name: z.string().nullable().default(null),
  email: z.string().email().nullable().default(null),
  phone: z.string().nullable().default(null),
  goal_category: z
    .enum([
      'income_replacement',
      'mortgage_time_limited_need',
      'final_expenses',
      'legacy_planning',
      'other',
    ])
    .nullable()
    .default(null),
  timeline_category: z
    .enum(['researching', 'comparing_soon', 'putting_coverage_in_place_now'])
    .nullable()
    .default(null),
  current_coverage_category: z.enum(['yes', 'no', 'unsure']).nullable().default(null),
  /** Product preference captured with contact consent (Phase 2) */
  policy_type_seeking: z.enum(['term', 'whole_life', 'iul', 'unsure']).nullable().default(null),
  coverage_amount_seeking: z.string().nullable().default(null),
  contact_channel: z.enum(['email', 'phone', 'calendar']).nullable().default(null),
  time_zone: z.string().nullable().default(null),
  preferred_contact_window: z.string().nullable().default(null),
  /** Phase 2 consented medical profile */
  medical_profile: MedicalProfileSchema.nullable().default(null),
});

/**
 * Consent state — tracks privacy notice, contact consent, and Phase 2
 * medical consent versions.
 */
export const ConsentSchema = z.object({
  privacy_notice_version: z.string().nullable().default(null),
  contact_consent_version: z.string().nullable().default(null),
  contact_consent_affirmed: z.boolean().default(false),
  /** Phase 2 — explicit, current, versioned medical consent */
  medical_consent_version: z.string().nullable().default(null),
  medical_consent_affirmed: z.boolean().default(false),
  do_not_contact: z.boolean().default(false),
});

/**
 * Allowed proposed actions the model may emit.
 * The application layer validates and authorizes before executing.
 */
export const ProposedActionSchema = z.enum([
  'none',
  'search_knowledge',
  'create_lead',
  'get_calendar_slots',
  'book_appointment',
  'request_human_handoff',
  'send_transactional_confirmation',
]);

/**
 * DIME coverage-needs estimator — educational sub-flow (Section 9.2).
 * Coarse, non-sensitive inputs only; the application computes the range.
 */
export const DimeEstimatorSchema = z.object({
  /** Whether the estimator is active (offering or collecting). */
  active: z.boolean().default(false),
  /** Next question to ask (1–3); null while inactive or once complete. */
  step: z.number().int().min(1).max(3).nullable().default(null),
  has_mortgage_or_debt: z.boolean().nullable().default(null),
  income_replacement_years: z.number().int().min(0).max(40).nullable().default(null),
  future_expenses: z.boolean().nullable().default(null),
  /** True when all three inputs are collected (application-derived). */
  complete: z.boolean().default(false),
  /**
   * Structured illustrative range on completion (application-derived; only
   * populated when complete=true) so the handoff can carry the educational
   * figure without the model inventing amounts.
   */
  range_min: z.number().int().nonnegative().nullable().default(null),
  range_max: z.number().int().nonnegative().nullable().default(null),
  range_label: z.string().nullable().default(null),
});

/**
 * The default (inactive) DIME block. The model emits this shape with
 * active=true when running the estimator; the application derives step and
 * complete deterministically after each turn.
 */
export const EMPTY_DIME_ESTIMATOR: DimeEstimator = {
  active: false,
  step: null,
  has_mortgage_or_debt: null,
  income_replacement_years: null,
  future_expenses: null,
  complete: false,
  range_min: null,
  range_max: null,
  range_label: null,
};

/**
 * Analytics event — allowlisted categorical values only.
 * Never user-entered free text. Never PII.
 */
export const AnalyticsSchema = z.object({
  event_name: z
    .enum([
      'ai_chat_open',
      'ai_conversation_start',
      'ai_answer_shown',
      'ai_source_click',
      'ai_abstention',
      'ai_qualification_offer',
      'ai_qualification_start',
      'ai_qualification_complete',
      'ai_contact_offer',
      'ai_contact_consent',
      'ai_lead_submit_success',
      'ai_schedule_open',
      'ai_appointment_booked',
      'ai_handoff_request',
      'ai_handoff_complete',
      'ai_dime_offer',
      'ai_dime_complete',
      'ai_fallback_shown',
      'ai_error',
    ])
    .nullable()
    .default(null),
  topic_category: z.string().nullable().default(null),
  conversation_stage: z.string().nullable().default(null),
  fallback_type: z.string().nullable().default(null),
  handoff_reason: z.string().nullable().default(null),
  error_code: z.string().nullable().default(null),
});

/**
 * Visual Rich Card reference (Section 17 / 4.1).
 *
 * The model may reference AT MOST ONE pre-approved card by card_id; it can
 * never supply card content. The application layer validates the id against
 * the pre-approved library and attaches the full approved content. When the
 * model emits no card, this is null.
 */
export const VisualCardReferenceSchema = z.object({
  card_id: z.string().min(1),
});

/**
 * The resolved, validated visual card payload returned to the widget (Section
 * 4.2). Carries the full pre-approved content; never model-generated.
 */
export const VisualCardSchema = z.object({
  card_id: z.string(),
  card_type: z.string(),
  title: z.string(),
  content: z.record(z.unknown()),
  disclaimer: z.string().nullable().default(null),
});

/**
 * The full response schema the model must return.
 */
export const AssistantResponseSchema = z.object({
  assistant_message: z.string(),
  state: z.enum([
    'disclosure',
    'education',
    'clarify',
    'qualification_offer',
    'qualification',
    'medical_offer',
    'medical_review',
    'contact_offer',
    'consent',
    'lead_submit',
    'scheduling',
    'confirmation',
    'handoff',
    'standby',
    'dime_estimator',
  ]),
  citations: z.array(CitationSchema).default([]),
  lead_data: LeadDataSchema,
  consent: ConsentSchema,
  /** DIME coverage-needs estimator (educational sub-flow, Section 9.2). */
  dime_estimator: DimeEstimatorSchema.default(() => ({ ...EMPTY_DIME_ESTIMATOR })),
  /**
   * Visual Rich Card reference — the model emits only { card_id }; the
   * application replaces it with the full approved card.
   */
  visual_card: VisualCardReferenceSchema.nullable().default(null),
  proposed_action: ProposedActionSchema.default('none'),
  action_arguments: z.record(z.unknown()).default({}),
  risk_flags: z.array(z.string()).default([]),
  analytics: AnalyticsSchema,
});

/**
 * Schema rules enforced by the application layer:
 * - citations must be empty when no approved source was used
 * - analytics values must be allowlisted categorical values, never free text
 * - lead_data may contain PII for the secure operational system, but the
 *   analytics object must never contain PII
 * - proposed_action=create_lead requires affirmative current contact consent
 * - proposed_action=book_appointment requires a verified slot and explicit
 *   user confirmation
 * - any health disclosure requires proposed_action=request_human_handoff or none
 *   and the sensitive_data_disclosed risk flag
 * - if JSON validation fails, the application must discard it and use a
 *   static safe fallback
 */

export type Citation = z.infer<typeof CitationSchema>;
export type LeadData = z.infer<typeof LeadDataSchema>;
export type Consent = z.infer<typeof ConsentSchema>;
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
export type Analytics = z.infer<typeof AnalyticsSchema>;
export type DimeEstimator = z.infer<typeof DimeEstimatorSchema>;
export type VisualCardReference = z.infer<typeof VisualCardReferenceSchema>;
export type VisualCard = z.infer<typeof VisualCardSchema>;
export type AssistantResponse = z.infer<typeof AssistantResponseSchema>;

/**
 * Schema rules validation — enforces the cross-field constraints.
 * Returns an array of error messages (empty if valid).
 */
export function validateSchemaRules(response: AssistantResponse): string[] {
  const errors: string[] = [];

  // create_lead requires affirmative current contact consent
  if (response.proposed_action === 'create_lead' && !response.consent.contact_consent_affirmed) {
    errors.push('proposed_action=create_lead requires affirmative current contact consent');
  }

  // Any populated medical profile requires affirmative current medical consent
  const med = response.lead_data.medical_profile;
  const medPopulated =
    med !== null &&
    (med.date_of_birth !== null ||
      med.gender !== null ||
      med.height_inches !== null ||
      med.weight_lbs !== null ||
      med.tobacco_nicotine_use !== null ||
      med.medical_conditions.length > 0 ||
      med.medications.length > 0 ||
      // Loose nullish checks: when the sub-block is null, the optional-chained
      // field is undefined, and `!== null` would wrongly count it as populated.
      med.diabetes?.diabetes_type != null ||
      med.diabetes?.treatment_method != null ||
      med.diabetes?.last_a1c != null ||
      med.cancer?.cancer_type != null ||
      med.cancer?.years_cancer_free != null);
  if (medPopulated && !response.consent.medical_consent_affirmed) {
    errors.push('medical_profile data requires affirmative current medical consent');
  }
  if (
    medPopulated &&
    response.consent.medical_consent_affirmed &&
    !response.consent.medical_consent_version
  ) {
    errors.push('medical_consent_affirmed requires a current medical_consent_version');
  }

  // book_appointment requires a verified slot and explicit user confirmation
  if (response.proposed_action === 'book_appointment' && !response.action_arguments?.slot_id) {
    errors.push('proposed_action=book_appointment requires a verified slot_id in action_arguments');
  }

  // Health disclosure requires handoff or none + risk flag
  if (
    response.risk_flags.includes('sensitive_data_disclosed') &&
    response.proposed_action !== 'request_human_handoff' &&
    response.proposed_action !== 'none'
  ) {
    errors.push(
      'sensitive_data_disclosed risk flag requires proposed_action=request_human_handoff or none',
    );
  }

  // do_not_contact must suppress contact offers
  if (
    response.consent.do_not_contact &&
    (response.proposed_action === 'create_lead' ||
      response.state === 'contact_offer' ||
      response.state === 'consent')
  ) {
    errors.push('do_not_contact=true must suppress all contact offers and lead creation');
  }

  // DIME estimator coherence (Section 9.2 — educational sub-flow)
  const dime = response.dime_estimator;
  // Claiming the dime_estimator state requires an active DIME block
  if (response.state === 'dime_estimator' && !dime.active) {
    errors.push('state=dime_estimator requires dime_estimator.active=true');
  }
  // An active DIME block only runs in the estimator state (or the completion
  // turn that advances to contact_offer); never in a plain education answer.
  if (dime.active && response.state !== 'dime_estimator' && response.state !== 'contact_offer') {
    errors.push(
      'dime_estimator.active=true is only allowed in state dime_estimator or contact_offer',
    );
  }
  // Completion requires all three inputs
  if (
    dime.complete &&
    (dime.has_mortgage_or_debt === null ||
      dime.income_replacement_years === null ||
      dime.future_expenses === null)
  ) {
    errors.push('dime_estimator.complete=true requires all three inputs to be collected');
  }
  // Inputs imply an active estimator
  const dimeHasInput =
    dime.has_mortgage_or_debt !== null ||
    dime.income_replacement_years !== null ||
    dime.future_expenses !== null;
  if (dimeHasInput && !dime.active) {
    errors.push('dime_estimator inputs require active=true');
  }
  // The structured educational range is only carried on completion, and a
  // complete estimator must carry it (application-derived; the model never
  // invents these figures — it is how the handoff receives the estimate).
  const rangePresent =
    dime.range_min !== null || dime.range_max !== null || dime.range_label !== null;
  if (!dime.complete && rangePresent) {
    errors.push('dime_estimator range fields require complete=true');
  }
  if (dime.complete && !rangePresent) {
    errors.push(
      'dime_estimator.complete=true requires a populated range (range_min/range_max/range_label)',
    );
  }

  return errors;
}

/**
 * A static safe fallback response used when JSON validation fails or
 * the model produces invalid output.
 */
export const STATIC_SAFE_FALLBACK: AssistantResponse = {
  assistant_message:
    "I'm sorry, I wasn't able to process that. You can continue browsing our educational articles, or I can connect you with Richard Parslow, a licensed Texas life-insurance broker, for personalized help.",
  state: 'standby',
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
    privacy_notice_version: null,
    contact_consent_version: null,
    contact_consent_affirmed: false,
    medical_consent_version: null,
    medical_consent_affirmed: false,
    do_not_contact: false,
  },
  dime_estimator: { ...EMPTY_DIME_ESTIMATOR },
  visual_card: null,
  proposed_action: 'none',
  action_arguments: {},
  risk_flags: ['static_fallback_used'],
  analytics: {
    event_name: 'ai_fallback_shown',
    topic_category: null,
    conversation_stage: 'standby',
    fallback_type: 'json_validation_failure',
    handoff_reason: null,
    error_code: 'schema_validation_failed',
  },
};
