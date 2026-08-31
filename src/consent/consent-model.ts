/**
 * Lead Data and Consent Model (Section 4.7 of the specification)
 *
 * Defines permitted lead fields, forbidden analytics fields, validation rules,
 * storage requirements, and the contact consent framework.
 */

import { v4 as uuidv4 } from 'uuid';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config/app-config';
import { encryptRecordLine, decryptRecordLine } from '../privacy/record-encryption';

/**
 * Permitted lead fields (Section 4.7).
 * These are the ONLY fields that may be stored in the operational lead record.
 * Medical profile fields are permitted ONLY when the user has given explicit,
 * current, versioned medical consent (Phase 2) — see MedicalProfile below.
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
  /** Product preference captured with contact consent (Phase 2) */
  policy_type_seeking: 'term' | 'whole_life' | 'iul' | 'unsure' | null;
  coverage_amount_seeking: string | null;
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
  /** Medical consent tracking (Phase 2) — explicit, current, versioned */
  medical_consent_version: string | null;
  medical_consent_timestamp: string | null;
  /** Consented medical profile (Phase 2) — only populated after medical consent */
  medical_profile: MedicalProfile | null;
  /** Scheduling */
  appointment_id: string | null;
  appointment_status: string | null;
  /** PII-redacted summary for handoff */
  handoff_summary: string | null;
}

/**
 * Medical profile (Phase 2 — consented medical fact-finding).
 * Collected ONLY after the user gives explicit, current, versioned medical
 * consent (Section 9.1). Used by the licensed broker to match carriers to the
 * user's profile. Never placed in analytics events.
 */
export interface MedicalProfile {
  /** YYYY-MM-DD */
  date_of_birth: string | null;
  gender: 'male' | 'female' | 'other' | 'prefer_not_to_say' | null;
  height_inches: number | null;
  weight_lbs: number | null;
  tobacco_nicotine_use:
    'none' | 'cigarettes' | 'vaping' | 'other_nicotine' | 'prefer_not_to_say' | null;
  /** Diagnosed by a doctor, as stated by the user */
  medical_conditions: string[];
  /** Prescribed by a doctor, as stated by the user */
  medications: string[];
  /** Only populated when the user reports diabetes; null until then (matches the response schema) */
  diabetes: {
    diabetes_type: 'type1' | 'type2' | 'unsure' | null;
    treatment_method: 'pills' | 'insulin' | 'other' | null;
    last_a1c: string | null;
  } | null;
  /** Only populated when the user reports cancer history; null until then (matches the response schema) */
  cancer: {
    cancer_type: string | null;
    years_cancer_free: number | null;
  } | null;
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
  const emailRegex =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
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
export function createLeadRecord(
  sourcePageId: string,
  sanitizedPath: string,
  topicCategory: string,
): LeadRecord {
  return {
    lead_id: uuidv4(),
    created_at: new Date().toISOString(),
    source_page_id: sourcePageId,
    sanitized_canonical_path: sanitizedPath,
    topic_category: topicCategory,
    goal_category: null,
    timeline_category: null,
    current_coverage_category: null,
    policy_type_seeking: null,
    coverage_amount_seeking: null,
    first_name: null,
    email: null,
    phone: null,
    time_zone: null,
    preferred_contact_window: null,
    contact_channel: null,
    privacy_notice_version: '1.3.0',
    contact_consent_version: null,
    consent_timestamp: null,
    consent_text_hash: null,
    medical_consent_version: null,
    medical_consent_timestamp: null,
    medical_profile: null,
    appointment_id: null,
    appointment_status: null,
    handoff_summary: null,
  };
}

/**
 * In-memory lead store for the pilot phase (mirrors the DSR pattern).
 * Backed by an append-only JSONL file (encrypted at rest when a
 * RECORD_ENCRYPTION_KEY is set) so lead records and their consent artifacts
 * survive process restarts. Lead records and consent proof are legal records
 * under TDPSA retention / consent-proof requirements and must not be lost
 * when the server restarts.
 */
const leadRecords: LeadRecord[] = [];

/** Loads existing lead records from the JSONL log at startup. */
function loadLeadRecordsFromDisk(): void {
  const logPath = config.leadLogPath;
  if (!existsSync(logPath)) return;
  try {
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const plain = decryptRecordLine(line);
        if (plain === null) continue; // cannot decode — skip
        const parsed = JSON.parse(plain) as LeadRecord;
        if (parsed && parsed.lead_id) {
          leadRecords.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // Best-effort — don't block startup if the log can't be read
  }
}

// Load persisted records on module init so they survive restarts
loadLeadRecordsFromDisk();

/**
 * Appends a lead record to the JSONL log.
 * Returns true on success, false on failure (read-only dir, full disk).
 */
function persistLeadRecord(lead: LeadRecord): boolean {
  try {
    const logPath = config.leadLogPath;
    const dir = dirname(logPath);
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, `${encryptRecordLine(JSON.stringify(lead))}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Persists a lead record to the store. The record should already be fully
 * populated (PII fields, consent version, timestamp) before calling this.
 *
 * Fail-closed: returns true only when the record was durably written, and
 * only then adds it to the in-memory store. On a persistence failure it
 * returns false and the record is neither stored nor acknowledged — the
 * consent artifact is a legal record under TDPSA consent-proof
 * requirements, so a lost write must not be confirmed (mirrors the DSR
 * intake path in src/privacy/dsr.ts).
 *
 * @returns true when durably persisted, false when the write failed.
 */
export function saveLeadRecord(lead: LeadRecord): boolean {
  if (!persistLeadRecord(lead)) {
    return false;
  }
  leadRecords.push(lead);
  return true;
}

/**
 * Gets a lead record by its lead_id (admin/debug + handoff lookup).
 */
export function getLeadRecord(leadId: string): LeadRecord | undefined {
  return leadRecords.find((l) => l.lead_id === leadId);
}

/**
 * Lists all lead records (admin).
 */
export function listLeadRecords(): LeadRecord[] {
  return leadRecords.slice();
}

/**
 * Clears all lead records (testing). Also removes the JSONL log file so
 * tests start with a clean slate on disk as well as in memory.
 */
export function clearAllLeadRecords(): void {
  leadRecords.length = 0;
  try {
    if (existsSync(config.leadLogPath)) {
      unlinkSync(config.leadLogPath);
    }
  } catch {
    // Best-effort — test cleanup must not throw
  }
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
 * The recommended medical-consent copy for counsel review (Phase 2, Section 9.1).
 * This text must be reviewed and approved by Texas insurance counsel before use.
 * It must be presented through the application UI as an explicit, unchecked,
 * opt-in control — never inferred from continued chat or from contact consent.
 */
export const RECOMMENDED_MEDICAL_CONSENT_COPY = `Optional: I consent to Life Policy Pilot and Richard Parslow collecting and using the medical information I provide in this chat (including date of birth, gender, height/weight, tobacco or nicotine use, diagnosed medical conditions, and prescribed medications) for the sole purpose of matching carriers to my profile for a life-insurance inquiry. I understand this is optional, that consent is not a condition of anything, that my information will be shared only with Richard Parslow, and that I can withdraw consent or request deletion at any time. See the Privacy Notice for full details.`;

/**
 * Just-in-time notice shown immediately before lead submission (Section 4.7).
 * Identifies exact fields, purpose, recipients, retention summary,
 * optionality, contact choices, and the withdrawal/deletion route — with the
 * DSR contact email (TDPSA consumer rights) from verified configuration.
 */
export function getJustInTimeNotice(): string {
  return `Before you submit: The information you provide (name, email/phone, and optional preferences) will be shared with Richard Parslow, a licensed Texas life-insurance broker, to follow up about your life-insurance inquiry. Providing this information is optional. You can withdraw consent, or submit an access, deletion, correction, or portability request, at any time by emailing ${config.dsrEmail}. See our Privacy Notice for full details.`;
}
