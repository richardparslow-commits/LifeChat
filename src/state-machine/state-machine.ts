/**
 * Conversation State Machine (Section 4.4 of the specification)
 *
 * Defines the states, entry conditions, allowed behaviors, and exit conditions
 * for the Life Policy Pilot AI Educational Assistant conversation flow.
 */

export type ConversationState =
  | 'disclosure'
  | 'education'
  | 'clarify'
  | 'qualification_offer'
  | 'qualification'
  | 'medical_offer'
  | 'medical_review'
  | 'contact_offer'
  | 'consent'
  | 'lead_submit'
  | 'scheduling'
  | 'confirmation'
  | 'handoff'
  | 'standby';

export interface StateTransitionContext {
  currentState: ConversationState;
  userMessage: string;
  hasValueBeenDelivered: boolean;
  userShowsInterest: boolean;
  queryIsAmbiguous: boolean;
  userAgreesToQualification: boolean;
  /** Phase 2 — user opts into optional medical fact-finding */
  userAgreesToMedicalReview: boolean;
  /** Phase 2 — user affirmed explicit medical consent */
  medicalConsentAffirmative: boolean;
  /** Phase 2 — consented medical questions complete */
  medicalReviewComplete: boolean;
  userRequestsFollowup: boolean;
  contactChannelChosen: boolean;
  consentAffirmative: boolean;
  requiredFieldsValid: boolean;
  userAsksToBook: boolean;
  bookingApiConfirms: boolean;
  riskOrEscalationTrigger: boolean;
  userDeclinesOrFlowEnds: boolean;
}

/**
 * Validates a proposed state transition.
 * Returns the allowed next state or null if the transition is invalid.
 */
export function getNextState(ctx: StateTransitionContext): ConversationState | null {
  const { currentState } = ctx;

  switch (currentState) {
    case 'disclosure':
      // Wait for user input after showing the AI identity, scope, and privacy warning
      if (ctx.userMessage && ctx.userMessage.trim().length > 0) {
        return 'education';
      }
      return null;

    case 'education':
      // User asked an in-scope question → retrieve, answer, cite
      if (ctx.queryIsAmbiguous) {
        return 'clarify';
      }
      // After value delivered, optionally offer qualification
      if (ctx.hasValueBeenDelivered && ctx.userShowsInterest) {
        return 'qualification_offer';
      }
      // User requests followup or booking
      if (ctx.userRequestsFollowup) {
        return 'contact_offer';
      }
      // Risk/escalation trigger
      if (ctx.riskOrEscalationTrigger) {
        return 'handoff';
      }
      // Stay in education
      return 'education';

    case 'clarify':
      // Ask one clarifying question; never ask for PII merely to answer
      if (!ctx.queryIsAmbiguous) {
        return 'education';
      }
      if (ctx.riskOrEscalationTrigger) {
        return 'handoff';
      }
      return 'clarify';

    case 'qualification_offer':
      // Ask permission: "Would you like up to three optional questions..."
      if (ctx.userAgreesToQualification) {
        return 'qualification';
      }
      if (ctx.userDeclinesOrFlowEnds) {
        return 'standby';
      }
      return 'education';

    case 'qualification':
      // Ask one question at a time; max three; no health details
      // Phase 2: user may opt into optional medical fact-finding (consented)
      if (ctx.userAgreesToMedicalReview) {
        return 'medical_offer';
      }
      if (ctx.userRequestsFollowup) {
        return 'contact_offer';
      }
      if (ctx.userDeclinesOrFlowEnds) {
        return 'education';
      }
      return 'qualification';

    case 'medical_offer':
      // Phase 2 — propose optional medical fact-finding with just-in-time
      // notice and explicit medical consent; never collect health data without it.
      // A decline returns to education; loop controls suppress further offers.
      if (ctx.medicalConsentAffirmative) {
        return 'medical_review';
      }
      if (ctx.userDeclinesOrFlowEnds) {
        return 'education';
      }
      return 'medical_offer';

    case 'medical_review':
      // Phase 2 — ask consented medical questions one at a time; never re-ask a
      // declined field; on refusal return to education with offers suppressed
      if (ctx.medicalReviewComplete) {
        return 'contact_offer';
      }
      if (ctx.userDeclinesOrFlowEnds) {
        return 'education';
      }
      if (ctx.riskOrEscalationTrigger) {
        return 'handoff';
      }
      return 'medical_review';

    case 'contact_offer':
      // Offer email, manual call, or calendar; explain data use
      if (ctx.contactChannelChosen) {
        return 'consent';
      }
      if (ctx.userDeclinesOrFlowEnds) {
        return 'education';
      }
      return 'contact_offer';

    case 'consent':
      // Present channel-specific consent; affirmative consent required
      if (ctx.consentAffirmative && ctx.requiredFieldsValid) {
        return 'lead_submit';
      }
      if (ctx.userDeclinesOrFlowEnds) {
        return 'education';
      }
      return 'consent';

    case 'lead_submit':
      // Emit validated structured data to application layer
      if (ctx.userAsksToBook) {
        return 'scheduling';
      }
      if (ctx.riskOrEscalationTrigger) {
        return 'handoff';
      }
      return 'confirmation';

    case 'scheduling':
      // Request real availability; present time zone and 2-3 options
      if (ctx.bookingApiConfirms) {
        return 'confirmation';
      }
      if (ctx.riskOrEscalationTrigger) {
        return 'handoff';
      }
      return 'scheduling';

    case 'confirmation':
      // Repeat verified date/time/time zone and confirmation method
      if (ctx.riskOrEscalationTrigger) {
        return 'handoff';
      }
      return 'standby';

    case 'handoff':
      // Summarize with consent; provide availability/SLA; no further advice
      return 'standby';

    case 'standby':
      // User declines or flow ends; remain available for education only
      // Only re-enter active flow on user initiative
      if (ctx.userMessage && ctx.userMessage.trim().length > 0 && !ctx.userDeclinesOrFlowEnds) {
        return 'education';
      }
      return 'standby';

    default:
      return null;
  }
}

/**
 * Loop control rules from Section 4.4
 */
export const LOOP_CONTROLS = {
  /** Never request the same field more than once after refusal. */
  MAX_FIELD_REQUESTS_AFTER_REFUSAL: 0,

  /** After one declined qualification or booking offer, suppress further offers for that session
   * unless the user reopens the topic. */
  SUPPRESS_OFFERS_AFTER_DECLINE: true,

  /** After two failed clarifications, provide relevant links and offer human help. */
  MAX_CLARIFICATION_FAILURES: 2,

  /** After two retrieval failures on the same subject, stop generating and hand off. */
  MAX_RETRIEVAL_FAILURES_PER_TOPIC: 2,

  /** After two tool failures, stop the loop and offer a human handoff. */
  MAX_TOOL_FAILURES: 2,

  /** Maximum qualification questions allowed. */
  MAX_QUALIFICATION_QUESTIONS: 3,
} as const;

/**
 * Prohibited pressure tactics from Section 7.
 * The assistant must never use these.
 */
export const PROHIBITED_PRESSURE_TACTICS = [
  'guilt',
  'fear',
  'false_urgency',
  'scarcity',
  'shame',
  'repeated_persuasion',
  'family_protection_status_claims',
  'aviation_metaphors',
  'puns',
  'slogans',
] as const;

/**
 * Approved optional qualification topics only (Section 7).
 */
export const APPROVED_QUALIFICATION_TOPICS = [
  'goal_category',
  'timeline_category',
  'current_coverage_category',
] as const;

/**
 * Approved medical topics (Phase 2, Section 9.1).
 * These may be asked ONLY after the user affirms explicit, current, versioned
 * medical consent. They are never asked in the default educational flow and
 * never re-asked after a refusal.
 */
export const APPROVED_MEDICAL_TOPICS = [
  'date_of_birth',
  'gender',
  'height_weight',
  'tobacco_nicotine_use',
  'diagnosed_conditions',
  'prescribed_medications',
  'diabetes_profile',
  'cancer_history',
] as const;

/**
 * Fields that must NOT be collected in the public chat (Section 7).
 */
export const FORBIDDEN_CHAT_FIELDS = [
  'medical_details',
  'diagnoses',
  'prescriptions',
  'tobacco_details',
  'date_of_birth',
  'height_weight',
  'family_history',
  'government_identifiers',
  'account_payment_data',
  'exact_income',
  'exact_debt',
  'beneficiary_details',
  'citizenship_immigration',
  'precise_location',
] as const;
