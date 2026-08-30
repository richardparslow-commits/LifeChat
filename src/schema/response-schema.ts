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
 * Lead data — PII fields for the secure operational system only.
 * All fields are optional (null by default). Never include sensitive data.
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
  contact_channel: z.enum(['email', 'phone', 'calendar']).nullable().default(null),
  time_zone: z.string().nullable().default(null),
  preferred_contact_window: z.string().nullable().default(null),
});

/**
 * Consent state — tracks privacy notice and contact consent versions.
 */
export const ConsentSchema = z.object({
  privacy_notice_version: z.string().nullable().default(null),
  contact_consent_version: z.string().nullable().default(null),
  contact_consent_affirmed: z.boolean().default(false),
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
    'contact_offer',
    'consent',
    'lead_submit',
    'scheduling',
    'confirmation',
    'handoff',
    'standby',
  ]),
  citations: z.array(CitationSchema).default([]),
  lead_data: LeadDataSchema,
  consent: ConsentSchema,
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
    contact_channel: null,
    time_zone: null,
    preferred_contact_window: null,
  },
  consent: {
    privacy_notice_version: null,
    contact_consent_version: null,
    contact_consent_affirmed: false,
    do_not_contact: false,
  },
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
