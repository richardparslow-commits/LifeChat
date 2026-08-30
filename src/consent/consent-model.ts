/**
 * Lead Data and Consent Model (Section 4.7 of the specification)
 *
 * Defines permitted lead fields, forbidden analytics fields, validation rules,
 * storage requirements, and the contact consent framework.
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Permitted lead fields (Section 4.7).
 * These are the ONLY fields that may be stored in the operational lead record.
 */
export interface LeadRecord {
  /** Server-generated UUID */
  lead_id: string;
  /** Server timestamp */
  created_at: string;
  /** Sanitized canonical path — never raw window.location.href with query params */
  source_page_id: string;
  sanitized_canonical_path: string;
  topic_category: string;
  goal_category: string | null;
  timeline_category: string | null;
  current_coverage_category: string | null;
  /** Optional until booking */
  first_name: string | null;
  /** Email or phone according to selected channel */
  email: string | null;
  phone: string | null;
  time_zone: string | null;
  preferred_contact_window: string | null;
  contact_channel: string | null;
  /** Consent tracking */
  privacy_notice_version: string;
  contact_consent_version: string | null;
  consent_timestamp: string | null;
  consent_text_hash: string | null;
  /** Scheduling */
  appointment_id: string | null;
  appointment_status: string | null;
  /** PII-redacted summary for handoff */
  handoff_summary: string | null;
}

/**
 * Fields that are FORBIDDEN in analytics and routine model logs (Section 4.7).
 */
export const FORBIDDEN_ANALYTICS_FIELDS = [
  'free_text_health_information',
  'diagnoses',
  'medications',
  'ssn',
  'drivers_license_passport_numbers',
  'account_payment_data',
  'full_birth_date',
  'exact_income',
  'exact_debt',
  'full_street_address',
  'beneficiaries',
  'raw_transcript',
  'email',
  'phone',
  'full_name',
] as const;

/**
 * Email validation (server-side).
 */
export function validateEmail(email: string): boolean {
  // Basic RFC 5322 compliant pattern for server-side validation
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return emailRegex.test(email);
}

/**
 * Phone validation (server-side).
 * Accepts US phone formats: (XXX) XXX-XXXX, XXX-XXX-XXXX, XXXXXXXXXX, +1XXXXXXXXXX
 */
export function validatePhone(phone: string): boolean {
  const cleaned = phone.replace(/[\s\-.()+]/g, '');
  // US numbers: 10 digits, or 11 starting with 1
  return /^1?\d{10}$/.test(cleaned);
}

/**
 * Creates a new empty lead record with server-generated ID and timestamp.
 */
export function createLeadRecord(sourcePageId: string, sanitizedPath: string, topicCategory: string): LeadRecord {
  return {
    lead_id: uuidv4(),
    created_at: new Date().toISOString(),
    source_page_id: sourcePageId,
    sanitized_canonical_path: sanitizedPath,
    topic_category: topicCategory,
    goal_category: null,
    timeline_category: null,
    current_coverage_category: null,
    first_name: null,
    email: null,
    phone: null,
    time_zone: null,
    preferred_contact_window: null,
    contact_channel: null,
    privacy_notice_version: '1.0.0',
    contact_consent_version: null,
    consent_timestamp: null,
    consent_text_hash: null,
    appointment_id: null,
    appointment_status: null,
    handoff_summary: null,
  };
}

/**
 * Storage and security requirements (Section 4.7).
 * These are implementation requirements, not just types.
 */
export const STORAGE_REQUIREMENTS = {
  /** Validate email/phone server-side */
  SERVER_SIDE_VALIDATION: true,
  /** Encrypt in transit (TLS 1.2+) and at rest (AES-256) */
  ENCRYPT_IN_TRANSIT: true,
  ENCRYPT_AT_REST: true,
  /** Role-based access, MFA for staff, audit logging, least privilege */
  RBAC: true,
  MFA_FOR_STAFF: true,
  AUDIT_LOGGING: true,
  LEAST_PRIVILEGE: true,
  /** Separate operational lead storage from deidentified analytics */
  SEPARATE_STORAGE: true,
  /** Do not train/fine-tune on conversations by default */
  NO_TRAINING_BY_DEFAULT: true,
} as const;

/**
 * Consumer rights handling (Section 4.7).
 */
export const CONSUMER_RIGHTS = {
  /** Define deletion, access, correction, and consent-withdrawal handling */
  DELETION: true,
  ACCESS: true,
  CORRECTION: true,
  CONSENT_WITHDRAWAL: true,
  /** Set a counsel-approved retention schedule by record category */
  RETENTION_SCHEDULE: 'counsel_approved',
  /** Automatically delete when purpose expires unless a legal hold applies */
  AUTO_DELETE_ON_PURPOSE_EXPIRY: true,
} as const;

/**
 * Processor contract requirements (Section 4.7).
 * Contractually require processors to:
 */
export const PROCESSOR_CONTRACT_REQUIREMENTS = [
  'follow_instructions',
  'secure_data',
  'assist_with_rights_requests',
  'govern_subprocessors',
  'notify_incidents',
  'return_or_delete_data',
  'disclose_model_training_use',
] as const;

/**
 * The recommended phone-consent copy for counsel review (Section 2.3).
 * This text must be reviewed and approved by counsel before use.
 */
export const RECOMMENDED_PHONE_CONSENT_COPY = `Optional: I agree that Life Policy Pilot and Richard Parslow may call or text the number I provide about my life-insurance inquiry, including using automated technology or an artificial/prerecorded voice if applicable. Consent is not a condition of purchase. Message and data rates may apply. Reply STOP to stop texts. See the Privacy Notice.`;

/**
 * Just-in-time notice shown immediately before lead submission (Section 4.7).
 * Identifies exact fields, purpose, recipients, retention summary,
 * optionality, contact choices, and withdrawal/deletion route.
 */
export const JUST_IN_TIME_NOTICE = `Before you submit: The information you provide (name, email/phone, and optional preferences) will be shared with Richard Parslow, a licensed Texas life-insurance broker, to follow up about your life-insurance inquiry. Providing this information is optional. You can withdraw consent or request deletion at any time by contacting us. See our Privacy Notice for full details.`;
