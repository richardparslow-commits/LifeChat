/**
 * Tool and Integration Controls (Section 4.8 of the specification)
 *
 * The model may propose, but not directly authorize, side effects.
 * The application layer must validate the JSON schema, verify required
 * consent, reject fields not on the allowlist, redact secrets and sensitive
 * data, use scoped service accounts, enforce idempotency, recheck slot
 * availability, log tool outcomes, require human approval for outbound
 * marketing, and never confirm a lead/message/booking until the downstream
 * service returns success.
 */

import type { ProposedAction, Consent, LeadData } from '../schema/response-schema';

/**
 * The allowlist of tools the model may propose.
 * Any action not on this list must be rejected.
 */
export const ALLOWED_TOOLS = [
  'search_knowledge',
  'create_lead',
  'get_calendar_slots',
  'book_appointment',
  'request_human_handoff',
  'send_transactional_confirmation',
] as const;

export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

/**
 * Context for tool authorization validation.
 */
export interface ToolAuthorizationContext {
  proposedAction: ProposedAction;
  actionArguments: Record<string, unknown>;
  consent: Consent;
  leadData: LeadData;
  userRequestedAction: boolean;
  requiredFieldsValid: boolean;
  suppressionChecksPassed: boolean;
  slotId?: string;
}

/**
 * Result of tool authorization validation.
 */
export interface ToolAuthorizationResult {
  authorized: boolean;
  errors: string[];
  sanitizedArguments: Record<string, unknown>;
}

/**
 * Validates a proposed tool action before the application layer executes it.
 *
 * Rules:
 * - validate the JSON schema
 * - verify required consent and its current version
 * - reject fields not on the allowlist
 * - redact secrets and sensitive data
 * - use scoped service accounts and server-side credentials
 * - enforce idempotency keys for lead creation/booking
 * - recheck slot availability at commit time
 * - log tool name, outcome, latency, and non-PII error code
 * - require human approval for any outbound marketing or exception
 * - never confirm a lead, message, or booking until the downstream service
 *   returns success
 */
export function authorizeToolAction(ctx: ToolAuthorizationContext): ToolAuthorizationResult {
  const errors: string[] = [];
  const sanitizedArgs: Record<string, unknown> = {};

  // 1. Check that the proposed action is on the allowlist
  if (!ALLOWED_TOOLS.includes(ctx.proposedAction as AllowedTool)) {
    errors.push(`Tool "${ctx.proposedAction}" is not on the allowlist`);
    return { authorized: false, errors, sanitizedArguments: sanitizedArgs };
  }

  // 2. 'none' and 'search_knowledge' and 'request_human_handoff' don't require consent
  if (
    ctx.proposedAction === 'none' ||
    ctx.proposedAction === 'search_knowledge' ||
    ctx.proposedAction === 'request_human_handoff'
  ) {
    // Still sanitize action arguments — redact any fields not expected
    for (const [key, value] of Object.entries(ctx.actionArguments)) {
      if (isAllowedArgument(key, ctx.proposedAction)) {
        sanitizedArgs[key] = value;
      } else {
        errors.push(`Argument "${key}" is not allowed for action "${ctx.proposedAction}"`);
      }
    }
    return { authorized: errors.length === 0, errors, sanitizedArguments: sanitizedArgs };
  }

  // 3. create_lead requires affirmative current consent + valid fields + user request
  if (ctx.proposedAction === 'create_lead') {
    if (!ctx.userRequestedAction) {
      errors.push('create_lead requires that the user requested that action');
    }
    if (!ctx.consent.contact_consent_affirmed) {
      errors.push('create_lead requires affirmative current contact consent');
    }
    if (!ctx.consent.contact_consent_version) {
      errors.push('create_lead requires a current contact_consent_version');
    }
    if (!ctx.requiredFieldsValid) {
      errors.push('create_lead requires all required fields to be valid');
    }
    if (!ctx.suppressionChecksPassed) {
      errors.push('create_lead requires suppression/do-not-contact checks to pass');
    }
    if (ctx.consent.do_not_contact) {
      errors.push('create_lead blocked: do_not_contact is true');
    }
    // Require idempotency key
    if (!ctx.actionArguments.idempotency_key) {
      errors.push('create_lead requires an idempotency_key');
    } else {
      sanitizedArgs.idempotency_key = ctx.actionArguments.idempotency_key;
    }
  }

  // 4. get_calendar_slots requires user request
  if (ctx.proposedAction === 'get_calendar_slots') {
    if (!ctx.userRequestedAction) {
      errors.push('get_calendar_slots requires that the user requested scheduling');
    }
    // Calendar slots is a read-only operation; consent not strictly required
    // but the user must have initiated
    if (ctx.actionArguments.time_zone) {
      sanitizedArgs.time_zone = ctx.actionArguments.time_zone;
    }
  }

  // 5. book_appointment requires verified slot + explicit user confirmation
  if (ctx.proposedAction === 'book_appointment') {
    if (!ctx.userRequestedAction) {
      errors.push('book_appointment requires that the user requested booking');
    }
    if (!ctx.actionArguments.slot_id) {
      errors.push('book_appointment requires a verified slot_id');
    } else {
      sanitizedArgs.slot_id = ctx.actionArguments.slot_id;
    }
    if (!ctx.actionArguments.idempotency_key) {
      errors.push('book_appointment requires an idempotency_key');
    } else {
      sanitizedArgs.idempotency_key = ctx.actionArguments.idempotency_key;
    }
    // Recheck slot availability at commit time (application must do this)
    // The tool itself doesn't confirm until downstream returns success
  }

  // 6. send_transactional_confirmation requires a booking to have succeeded
  if (ctx.proposedAction === 'send_transactional_confirmation') {
    if (!ctx.actionArguments.appointment_id) {
      errors.push('send_transactional_confirmation requires an appointment_id from a confirmed booking');
    } else {
      sanitizedArgs.appointment_id = ctx.actionArguments.appointment_id;
    }
  }

  // 7. Redact secrets and sensitive data from all arguments
  for (const [key, value] of Object.entries(ctx.actionArguments)) {
    if (isSensitiveKey(key)) {
      // Skip — do not include in sanitized output
      errors.push(`Sensitive field "${key}" redacted from tool arguments`);
      continue;
    }
    if (!(key in sanitizedArgs) && isAllowedArgument(key, ctx.proposedAction)) {
      sanitizedArgs[key] = value;
    }
  }

  return {
    authorized: errors.length === 0,
    errors,
    sanitizedArguments: sanitizedArgs,
  };
}

/**
 * Checks if a key name suggests sensitive data that should be redacted.
 */
function isSensitiveKey(key: string): boolean {
  const sensitivePatterns = [
    /password/i,
    /secret/i,
    /token/i,
    /credential/i,
    /api_?key/i,
    /private_?key/i,
    /ssn/i,
    /social_security/i,
    /diagnosis/i,
    /medical/i,
    /health/i,
    /birth/i,
  ];
  return sensitivePatterns.some((pattern) => pattern.test(key));
}

/**
 * Checks if an argument key is allowed for a given proposed action.
 */
function isAllowedArgument(key: string, action: ProposedAction): boolean {
  const allowedArgumentsByAction: Record<string, string[]> = {
    none: [],
    search_knowledge: ['query', 'topic_category', 'article_id'],
    create_lead: ['idempotency_key', 'lead_data'],
    get_calendar_slots: ['time_zone', 'date_range_start', 'date_range_end'],
    book_appointment: ['slot_id', 'idempotency_key', 'time_zone'],
    request_human_handoff: ['handoff_reason', 'summary'],
    send_transactional_confirmation: ['appointment_id', 'channel'],
  };
  const allowed = allowedArgumentsByAction[action] || [];
  return allowed.includes(key);
}

/**
 * Scheduling-specific rules from the system prompt (Section 10):
 * - display time zone
 * - offer only slots returned by the calendar tool
 * - recheck the chosen slot before booking
 * - say an appointment is booked only after confirmed success
 * - on failure, say it could not be confirmed and offer retry or human contact
 */
export const SCHEDULING_RULES = {
  DISPLAY_TIME_ZONE: true,
  ONLY_TOOL_RETURNED_SLOTS: true,
  RECHECK_BEFORE_BOOKING: true,
  CONFIRM_ONLY_AFTER_SUCCESS: true,
  ON_FAILURE_OFFER_RETRY_OR_HUMAN: true,
} as const;

/**
 * The application layer must never confirm a lead, message, or booking
 * until the downstream service returns success.
 */
export function confirmOnlyAfterDownstreamSuccess(
  downstreamResult: { success: boolean; data?: unknown }
): boolean {
  return downstreamResult.success === true;
}
