/**
 * Analytics and GTM/GA4 Implementation (Section 4.13)
 *
 * Event taxonomy with stable snake_case names and NO PII.
 * Google specifically identifies emails, phone numbers, names, and
 * user-entered form/search content as PII that must not be sent to Analytics.
 */

/**
 * The full event taxonomy (Section 4.13).
 * Use stable snake_case names. Never send PII.
 */
export const EVENT_TAXONOMY = [
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
] as const;

export type AnalyticsEvent = (typeof EVENT_TAXONOMY)[number];

/**
 * Allowed parameters for analytics events (Section 4.13).
 * These are allowlisted categorical values, never user-entered free text.
 */
export const ALLOWED_PARAMETERS = [
  'article_id',
  'topic_category',
  'conversation_stage',
  'fallback_type',
  'handoff_reason',
  'error_code',
  'response_latency_bucket',
  'answer_grounded_bucket',
  'device_class',
  'experiment_variant',
] as const;

/**
 * Fields that must NEVER be sent to analytics (Section 4.13).
 * Google specifically identifies these as PII.
 */
export const FORBIDDEN_ANALYTICS_PAYLOAD = [
  'free_text',
  'contact_fields',
  'transcript',
  'lead_id',
  'calendar_invite_data',
  'health_category',
  'url_with_query_string_pii',
  'email',
  'phone',
  'name',
  'user_entered_form_content',
  'user_entered_search_content',
] as const;

/**
 * Key events (conversions) — only the true business outcomes.
 * Do not label chat opens or consent screens as conversions.
 */
export const KEY_EVENTS = ['ai_appointment_booked'] as const;

export const OPTIONAL_KEY_EVENTS = ['ai_lead_submit_success'] as const;

/**
 * KPI definitions (Section 4.13).
 */
export const KPI_DEFINITIONS = {
  answer_rate: 'conversations with at least one ai_answer_shown / conversations started',
  abstention_rate: 'ai_abstention / substantive questions',
  grounded_answer_rate:
    'sampled answers with all material claims supported / sampled substantive answers',
  qualification_opt_in: 'qualification starts / qualification offers',
  consent_rate: 'contact consents / contact offers',
  lead_completion: 'successful lead submissions / contact consents',
  booking_rate: 'confirmed bookings / conversations started, and / schedule opens',
  handoff_completion: 'completed / requested handoffs',
  containment:
    'conversations resolved educationally without handoff, lead, or unresolved failure / eligible conversations',
  fallback_loop_rate:
    'sessions with more than one fallback of the same type / sessions with any fallback',
  p95_latency: '95th percentile latency by answer and tool action',
} as const;

/**
 * Generates a valid GTM dataLayer push object for a given event.
 * Ensures no PII is included.
 *
 * @param eventName - The snake_case event name from the taxonomy
 * @param parameters - Allowlisted categorical parameters only
 * @returns A dataLayer push object safe for GTM/GA4
 */
export function createDataLayerPush(
  eventName: AnalyticsEvent,
  parameters: Partial<Record<(typeof ALLOWED_PARAMETERS)[number], string>> = {},
): Record<string, unknown> {
  const push: Record<string, unknown> = {
    event: eventName,
  };

  // Only include allowlisted parameters
  for (const param of ALLOWED_PARAMETERS) {
    if (parameters[param] !== undefined) {
      push[param] = parameters[param];
    }
  }

  return push;
}

/**
 * The correct GTM sequence for firing an event (Section 4.13):
 *
 * 1. At the verified application state transition — not because the model
 *    merely wrote fallback words — push to window.dataLayer
 * 2. In GTM, create Data Layer Variables for each parameter
 * 3. Create a Custom Event trigger with the event name
 * 4. Create a GA4 Event tag, map parameters to Data Layer Variables, attach trigger
 * 5. Preview in Tag Assistant, verify in GA4 Realtime/DebugView, publish through change control
 * 6. In GA4 Admin → Data display → Custom definitions, create event-scoped custom dimensions
 * 7. Mark only the true business outcome as a key event
 */
export const GTM_SEQUENCE = [
  'Push event to window.dataLayer at verified application state transition',
  'Create Data Layer Variables in GTM for each parameter',
  'Create Custom Event trigger in GTM with the event name',
  'Create GA4 Event tag, map parameters to Data Layer Variables, attach trigger',
  'Preview in Tag Assistant, verify in GA4 Realtime/DebugView, publish through change control',
  'Create event-scoped custom dimensions in GA4 Admin → Data display → Custom definitions',
  'Mark only true business outcome (ai_appointment_booked) as key event',
] as const;

/**
 * Generates the JavaScript snippet for a dataLayer push.
 * This is the code that runs in the browser at the verified state transition.
 *
 * Example output (for ai_fallback_shown):
 * window.dataLayer = window.dataLayer || [];
 * window.dataLayer.push({
 *   event: 'ai_fallback_shown',
 *   fallback_type: 'contact_declined',
 *   conversation_stage: 'contact_offer',
 *   article_id: 'policy-laddering-001'
 * });
 */
export function generateDataLayerSnippet(
  eventName: AnalyticsEvent,
  parameters: Partial<Record<(typeof ALLOWED_PARAMETERS)[number], string>> = {},
): string {
  const push = createDataLayerPush(eventName, parameters);
  const jsonStr = JSON.stringify(push, null, 2);
  return `window.dataLayer = window.dataLayer || [];\nwindow.dataLayer.push(${jsonStr});`;
}

/**
 * Sanitizes a URL to ensure no query-string PII can leak.
 * Use a controlled article_id or a sanitized canonical path.
 *
 * @param rawUrl - The raw window.location.href (NEVER sent to analytics)
 * @returns A sanitized canonical path with query parameters stripped
 */
export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    // Strip query parameters entirely — they can contain PII
    return url.pathname;
  } catch {
    // If URL parsing fails, return a placeholder
    return '/unknown';
  }
}

/**
 * GA4 custom dimension registration reminder (Section 4.13).
 * Google states that event-scoped custom dimensions are what make custom
 * event parameters available for analysis and that reporting may take 24-48 hours.
 */
export const GA4_REPORTING_NOTE =
  'Reporting may take 24-48 hours after custom dimensions are registered and data starts flowing.';
