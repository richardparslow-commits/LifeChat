/**
 * Human Escalation and Service Levels (Section 4.10 of the specification)
 *
 * Defines immediate escalation triggers, proposed operating SLAs,
 * and the handoff data transfer rules.
 */

/**
 * Immediate escalation triggers (Section 4.10).
 * Any of these must trigger an immediate offer of a licensed-human handoff.
 */
export const ESCALATION_TRIGGERS = [
  'individualized_recommendation',
  'quote_or_application',
  'annuity_or_replacement',
  'policy_claim_complaint',
  'legal_tax_medical_issue',
  'health_disclosure',
  'non_texas_advice',
  'angry_or_distressed_visitor',
  'vulnerability_or_exploitation_concern',
  'repeated_retrieval_failure',
  'suspected_prompt_injection',
  'privacy_request',
  'consent_dispute',
  'tool_failure_affecting_booking',
] as const;

export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

/**
 * Proposed operating SLA (Section 4.10).
 * These are business choices, NOT legal rules.
 */
export const SERVICE_LEVEL_AGREEMENT = {
  /** Business hours displayed in Central Time */
  BUSINESS_HOURS_TIMEZONE: 'America/Chicago',
  /** Business hours (configurable) */
  BUSINESS_HOURS: {
    start: '08:00',
    end: '18:00',
    days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  },
  /** Live queue acknowledgment within 60 seconds when staffed */
  LIVE_QUEUE_ACK_TARGET_SECONDS: 60,
  /** Licensed-human first response within 15 minutes during staffed hours */
  FIRST_RESPONSE_TARGET_MINUTES: 15,
  /** After-hours: state closed status and expected response by next business day */
  AFTER_HOURS_BEHAVIOR: 'state_closed_and_next_business_day',
  /** Urgent policy/claim issues: provide carrier/TDI contact route, not emergency promises */
  URGENT_ISSUE_ROUTE: 'carrier_or_tdi_contact',
} as const;

/**
 * Checks if the business is currently staffed based on the SLA config.
 */
export function isCurrentlyStaffed(now: Date = new Date()): boolean {
  const centralTimeOptions: Intl.DateTimeFormatOptions = {
    timeZone: SERVICE_LEVEL_AGREEMENT.BUSINESS_HOURS_TIMEZONE,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  const formatter = new Intl.DateTimeFormat('en-US', centralTimeOptions);
  const parts = formatter.formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
  const hourStr = parts.find((p) => p.type === 'hour')?.value || '0';
  const minuteStr = parts.find((p) => p.type === 'minute')?.value || '0';

  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const timeAsMinutes = hour * 60 + minute;

  const startParts = SERVICE_LEVEL_AGREEMENT.BUSINESS_HOURS.start.split(':');
  const endParts = SERVICE_LEVEL_AGREEMENT.BUSINESS_HOURS.end.split(':');
  const startMinutes = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
  const endMinutes = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);

  const isBusinessDay = (SERVICE_LEVEL_AGREEMENT.BUSINESS_HOURS.days as readonly string[]).includes(
    weekday,
  );
  const isBusinessHour = timeAsMinutes >= startMinutes && timeAsMinutes < endMinutes;

  return isBusinessDay && isBusinessHour;
}

/**
 * Generates the staff availability message for the user.
 */
export function getStaffAvailabilityMessage(): string {
  if (isCurrentlyStaffed()) {
    return `Richard Parslow or a member of his team is currently available. A licensed professional will respond shortly — typically within ${SERVICE_LEVEL_AGREEMENT.FIRST_RESPONSE_TARGET_MINUTES} minutes.`;
  }
  return `Our office is currently closed. We'll respond by the next business day. For urgent policy or claim issues, please contact your carrier directly or the Texas Department of Insurance.`;
}

/**
 * Handoff data transfer rules (Section 4.10):
 * - Transfer only the minimum consented data and a factual, PII-minimized summary
 * - Let the user review or correct the summary when possible
 * - Never promise immediate response unless a live queue confirms it
 */
export const HANDOFF_RULES = {
  TRANSFER_MINIMUM_CONSENTED_DATA: true,
  PII_MINIMIZED_SUMMARY: true,
  ALLOW_USER_REVIEW_OR_CORRECT: true,
  NO_IMMEDIATE_RESPONSE_PROMISE_UNLESS_LIVE_QUEUE_CONFIRMS: true,
} as const;

/**
 * Creates a PII-minimized handoff summary from lead data.
 * Only includes consented fields and factual information.
 */
export function createHandoffSummary(leadData: {
  goal_category: string | null;
  timeline_category: string | null;
  current_coverage_category: string | null;
  contact_channel: string | null;
  time_zone: string | null;
  preferred_contact_window: string | null;
}): string {
  const parts: string[] = [];

  if (leadData.goal_category) {
    parts.push(`Goal: ${leadData.goal_category}`);
  }
  if (leadData.timeline_category) {
    parts.push(`Timeline: ${leadData.timeline_category}`);
  }
  if (leadData.current_coverage_category) {
    parts.push(`Current coverage: ${leadData.current_coverage_category}`);
  }
  if (leadData.contact_channel) {
    parts.push(`Preferred contact: ${leadData.contact_channel}`);
  }
  if (leadData.time_zone) {
    parts.push(`Time zone: ${leadData.time_zone}`);
  }
  if (leadData.preferred_contact_window) {
    parts.push(`Preferred window: ${leadData.preferred_contact_window}`);
  }

  return parts.length > 0 ? parts.join('; ') : 'No qualification data provided.';
}

/**
 * The immediate danger / self-harm response (Section 5).
 * Stop the sales flow and use the approved emergency resources.
 */
export const EMERGENCY_RESPONSE = `If you are in immediate danger or experiencing a crisis, please call 911 or the National Suicide and Crisis Lifeline at 988. This chat assistant is not equipped to handle emergencies.`;
