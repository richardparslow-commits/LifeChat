/**
 * Application Configuration (Section 4.1 — Product Definition)
 *
 * Centralized configuration for the Life Policy Pilot AI Educational Assistant.
 * All sensitive values should be loaded from environment variables.
 */

export interface AppConfig {
  /** Port for the Express server */
  port: number;
  /** The business name as approved by compliance */
  businessName: string;
  /** Richard Parslow's approved licensed name */
  licensedBrokerName: string;
  /** Richard Parslow's Texas license number (or registered assumed name).
   *  Required before production startup; never served to users while unset. */
  texasLicenseNumber: string;
  /** Carriers Richard Parslow is appointed with (allowlist).
   *  The assistant must never imply coverage availability from carriers
   *  outside this list. Empty until the broker supplies the appointment list. */
  appointedCarriers: string[];
  /** The blog website URL */
  websiteUrl: string;
  /** Privacy notice URL */
  privacyNoticeUrl: string;
  /** Contact page URL */
  contactUrl: string;
  /** Current privacy notice version */
  privacyNoticeVersion: string;
  /** Current contact consent version */
  contactConsentVersion: string;
  /**
   * Data subject request (DSR) contact — where consumers submit access,
   * deletion, correction, and portability requests (TDPSA consumer rights).
   */
  dsrEmail: string;
  /** LLM API key (loaded from environment) */
  llmApiKey: string;
  /** LLM model identifier */
  llmModel: string;
  /** Whether the system is in pilot mode (Phase 1) */
  pilotMode: boolean;
  /** Whether health data collection is disabled.
   *  Phase 1/2 gate: default true. Flip to false only after counsel approval
   *  of the medical consent flow (docs/medical-lead-capture-phase2.md).
   *  Set HEALTH_DATA_COLLECTION_DISABLED=false in .env to enable. */
  healthDataCollectionDisabled: boolean;
  /** Whether outbound marketing is disabled */
  outboundMarketingDisabled: boolean;
  /**
   * Whether promotional/free-offer terms ("free quote", "free consultation",
   * "no-obligation") have passed marketing review. Default false — flagged
   * for future marketing review. While false, the output guard rejects any
   * assistant message containing those phrases.
   */
  freeOfferMarketingApproved: boolean;
  /**
   * Contextual Content Bridge — reads the page a user is viewing to make the
   * opening message and RAG retrieval more relevant. Educational only: page
   * context is treated as untrusted data, never as user characteristics, and
   * no new personal data is collected. Kill switch: set
   * CONTEXTUAL_BRIDGE_ENABLED=false to disable without a code change.
   */
  contextualBridgeEnabled: boolean;
  /**
   * Visual Rich Cards — let the model attach a pre-approved, deterministic
   * educational card (comparison table, definition, etc.) to a response.
   * Compliance-neutral: cards are display-only, content comes entirely from the
   * versioned card library (never LLM-generated), and every card carries a
   * disclaimer. Kill switch: set VISUAL_CARDS_ENABLED=false to disable without
   * a code change.
   */
  visualCardsEnabled: boolean;
  /**
   * Abstention logging for content strategy — append an anonymized JSONL record
   * whenever the RAG layer has insufficient evidence and the assistant abstains.
   * No raw question text or PII is ever written; only a SHA-256 hash of the
   * normalized question plus an allowlisted category label. Kill switch: set
   * ABSTENTION_LOGGING_ENABLED=false to disable without a code change.
   */
  abstentionLoggingEnabled: boolean;
  /** Where the append-only JSONL abstention log is written. */
  abstentionLogPath: string;
  /**
   * Shared secret for admin/internal API endpoints (system-prompt, session
   * history, session count, DSR status). When set, admin endpoints require
   * an x-admin-key header matching this value. When unset in pilot mode the
   * endpoints are accessible without auth (dev convenience); in production
   * mode startup fails fast until a key is supplied.
   */
  adminApiKey: string;
  /** Where the append-only JSONL DSR records log is written. */
  dsrLogPath: string;
  /** Where the append-only JSONL lead/consent records log is written. */
  leadLogPath: string;
  /**
   * Secret used to encrypt record logs (DSR + lead) at rest with AES-256-GCM.
   * Required in production (PILOT_MODE=false); in pilot mode records fall back
   * to plaintext for dev convenience. DSR/lead records may contain PII, so in
   * production this must be set (see index.ts production gate).
   */
  recordEncryptionKey: string;
}

/**
 * Default configuration. Sensitive values come from environment variables.
 */
/**
 * Sentinel for an unconfigured license number. Never served to users —
 * /api/disclosure returns null and the disclosure omits the license line
 * until a real number is supplied, and production startup fails fast.
 */
export const LICENSE_PENDING_PLACEHOLDER = '[Pending compliance approval]';

export const config: AppConfig = {
  port: parseInt(process.env.LIFECHAT_PORT || '3000', 10),
  businessName: process.env.BUSINESS_NAME || 'Life Policy Pilot',
  licensedBrokerName: process.env.LICENSED_BROKER_NAME || 'Richard Parslow',
  texasLicenseNumber: process.env.TEXAS_LICENSE_NUMBER || LICENSE_PENDING_PLACEHOLDER,
  appointedCarriers: (process.env.APPOINTED_CARRIERS || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean),
  websiteUrl: process.env.WEBSITE_URL || 'https://lifepolicypilot.blog/',
  privacyNoticeUrl: process.env.PRIVACY_NOTICE_URL || 'https://lifepolicypilot.blog/privacy/',
  contactUrl: process.env.CONTACT_URL || 'https://lifepolicypilot.blog/contact/',
  privacyNoticeVersion: process.env.PRIVACY_NOTICE_VERSION || '1.3.0',
  contactConsentVersion: process.env.CONTACT_CONSENT_VERSION || '1.0.0',
  dsrEmail: process.env.DSR_EMAIL || 'privacy@lifepolicypilot.blog',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o',
  pilotMode: process.env.PILOT_MODE !== 'false',
  // Phase 2 gate — enabled only by explicit opt-in in .env after counsel review
  healthDataCollectionDisabled: process.env.HEALTH_DATA_COLLECTION_DISABLED !== 'false',
  outboundMarketingDisabled: true,
  // Marketing-review gate: flip to true only after the free-offer terms are
  // reviewed and approved. Until then the output guard blocks the phrasing.
  freeOfferMarketingApproved: process.env.FREE_OFFER_MARKETING_APPROVED === 'true',
  // Contextual Content Bridge kill switch. Default enabled; set to 'false' to
  // disable (rollback path).
  contextualBridgeEnabled: process.env.CONTEXTUAL_BRIDGE_ENABLED !== 'false',
  // Visual Rich Cards kill switch. Default enabled; set to 'false' to disable
  // (rollback path). Cards are compliance-neutral and display-only.
  visualCardsEnabled: process.env.VISUAL_CARDS_ENABLED !== 'false',
  // Abstention logging kill switch. Default enabled; set to 'false' to disable.
  // JSONL path can be overridden (serverless read-only filesystems should set
  // ABSTENTION_LOG_PATH to a writable volume).
  abstentionLoggingEnabled: process.env.ABSTENTION_LOGGING_ENABLED !== 'false',
  abstentionLogPath: process.env.ABSTENTION_LOG_PATH || 'data/abstention-log.jsonl',
  adminApiKey: process.env.ADMIN_API_KEY || '',
  dsrLogPath: process.env.DSR_LOG_PATH || 'data/dsr-records.jsonl',
  leadLogPath: process.env.LEAD_LOG_PATH || 'data/lead-records.jsonl',
  recordEncryptionKey: process.env.RECORD_ENCRYPTION_KEY || '',
};

/**
 * True when a real Texas license number is configured (not empty and not the
 * pending-approval sentinel). The number is only ever displayed when this
 * passes; otherwise the disclosure fails closed and shows no license line.
 */
export function isLicenseNumberConfigured(): boolean {
  const value = config.texasLicenseNumber.trim();
  return value.length > 0 && value !== LICENSE_PENDING_PLACEHOLDER;
}

/**
 * True when an admin API key is configured (non-empty). Admin endpoints use
 * this to decide whether to enforce the x-admin-key header. In pilot mode
 * the endpoints remain accessible without a key for dev convenience; in
 * production mode startup fails fast until a key is supplied.
 */
export function isAdminApiKeyConfigured(): boolean {
  return config.adminApiKey.trim().length > 0;
}

/**
 * True when at-rest record encryption is configured (RECORD_ENCRYPTION_KEY
 * non-empty). In production mode startup fails fast until a key is supplied,
 * so DSR and lead logs are never persisted in plaintext in production.
 */
export function isRecordEncryptionKeyConfigured(): boolean {
  return config.recordEncryptionKey.trim().length > 0;
}

/**
 * The product definition (Section 4.1).
 */
export const PRODUCT_DEFINITION = {
  name: 'Life Policy Pilot AI Educational Assistant',
  owner: 'Richard Parslow / Life Policy Pilot',
  initialJurisdiction: 'Texas visitors seeking general life-insurance education',
  primaryObjective:
    'Provide short, source-linked answers from approved Life Policy Pilot and primary regulatory/consumer sources, then offer an optional handoff or appointment with a licensed Texas broker.',
  secondaryObjective:
    'Collect only the minimum lead data and contact consent required for a user-requested follow-up.',
  nonObjectives: [
    'not a licensed producer',
    'not an underwriter',
    'not a tax adviser',
    'not an attorney',
    'not a medical professional',
    'not a carrier quoting engine',
    'not an application',
    'not a replacement analysis',
    'not a suitability engine',
    'not an autonomous sales agent',
  ],
  /** Success hierarchy — a conversion must never override the first four priorities */
  successHierarchy: [
    'legal and consumer safety',
    'truthful, grounded education',
    'user autonomy and accessibility',
    'reliable handoff',
    'lead and booking conversion',
  ],
} as const;
