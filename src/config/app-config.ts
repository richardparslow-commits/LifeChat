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
  /** Richard Parslow's Texas license number (or registered assumed name) */
  texasLicenseNumber: string;
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
}

/**
 * Default configuration. Sensitive values come from environment variables.
 */
export const config: AppConfig = {
  port: parseInt(process.env.LIFECHAT_PORT || '3000', 10),
  businessName: process.env.BUSINESS_NAME || 'Life Policy Pilot',
  licensedBrokerName: process.env.LICENSED_BROKER_NAME || 'Richard Parslow',
  texasLicenseNumber: process.env.TEXAS_LICENSE_NUMBER || '[Pending compliance approval]',
  websiteUrl: process.env.WEBSITE_URL || 'https://lifepolicypilot.blog/',
  privacyNoticeUrl: process.env.PRIVACY_NOTICE_URL || 'https://lifepolicypilot.blog/privacy/',
  contactUrl: process.env.CONTACT_URL || 'https://lifepolicypilot.blog/contact/',
  privacyNoticeVersion: process.env.PRIVACY_NOTICE_VERSION || '1.0.0',
  contactConsentVersion: process.env.CONTACT_CONSENT_VERSION || '1.0.0',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o',
  pilotMode: process.env.PILOT_MODE !== 'false',
  // Phase 2 gate — enabled only by explicit opt-in in .env after counsel review
  healthDataCollectionDisabled: process.env.HEALTH_DATA_COLLECTION_DISABLED !== 'false',
  outboundMarketingDisabled: true,
};

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
