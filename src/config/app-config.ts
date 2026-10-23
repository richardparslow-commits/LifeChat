/**
 * Application Configuration (Section 4.1 — Product Definition)
 *
 * Centralized configuration for LifeChat, the AI educational assistant
 * provided by Life Insurance Broker Advocate (see ./branding).
 * All sensitive values should be loaded from environment variables.
 */

import { resolve } from 'path';
import { isArchilStorageConfigured } from '../archil/disk';
import { ASSISTANT_DISPLAY_NAME, PRODUCT_NAME, PROVIDER_BRAND } from './branding';
import {
  durableStorageStatus,
  isDurableStorageVerified,
  verifyDurableStorage,
} from './durable-storage';

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
  /** Current medical consent version. The route ignores any client-supplied
   *  version and stores this value only; a different value is not current. */
  medicalConsentVersion: string;
  /**
   * Data subject request (DSR) contact — where consumers submit access,
   * deletion, correction, and portability requests (TDPSA consumer rights).
   * `DSR_CONTACT_EMAIL` is the canonical variable (`DSR_EMAIL` is still
   * accepted for deployments that set it), and the value is derived from
   * {@link DEFAULT_DSR_CONTACT_EMAIL}. `npm run rights:channel` proves the
   * configured domain accepts mail before a release.
   */
  dsrEmail: string;
  /** LLM API key (loaded from environment) */
  llmApiKey: string;
  /** LLM model identifier */
  llmModel: string;
  /**
   * OpenAI-compatible base URL for chat completions (no trailing slash), e.g.
   * `https://api.openai.com/v1` or a gateway/proxy. Read here rather than in
   * the client so startup, /health, and the preflight all report the same
   * endpoint the app will actually call.
   */
  llmApiBaseUrl: string;
  /**
   * Browser origins allowed to call the API cross-origin (the widget's
   * `data-server-url` embed case), from the comma-separated ALLOWED_ORIGINS
   * env var. Empty by default: same-origin only. Each entry is scheme + host +
   * optional port, normalized without a trailing slash.
   */
  allowedOrigins: string[];
  /** Whether the system is in pilot mode (Phase 1) */
  pilotMode: boolean;
  /** Whether the app must not listen on a port (serverless platforms).
   *  Set SERVERLESS=true on platforms whose runtime starts invocations itself
   *  (Vercel). Unset by default: local and container runs listen as before. */
  serverless: boolean;
  /**
   * Express `trust proxy` setting, from TRUST_PROXY. Empty means "do not trust
   * any proxy", except on Vercel where the resolver applies its single-edge
   * default of one hop. `true` is refused because it lets a caller spoof
   * X-Forwarded-For and escape the per-client budgets; set the platform's hop
   * count (or subnet list) only for proxies you control. See
   * `src/config/trust-proxy.ts`.
   */
  trustProxy: string;
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
   * No raw question text or PII is ever written; only an HMAC-SHA-256 of the
   * normalized question plus an allowlisted category label. Kill switch: set
   * ABSTENTION_LOGGING_ENABLED=false to disable without a code change.
   */
  abstentionLoggingEnabled: boolean;
  /** Where the append-only JSONL abstention log is written. */
  abstentionLogPath: string;
  /**
   * Secret that keys the abstention question hash (M-08). An unkeyed digest of
   * a question such as "I have HIV" can be reversed by dictionary lookup, so
   * without this value no abstention is recorded at all.
   */
  abstentionLogKey: string;
  /**
   * Shared secret for admin/internal API endpoints (system-prompt, session
   * history, session count, DSR status, lead export). Admin endpoints require
   * an x-admin-key header matching this value. When it is unset they answer
   * 503 in every mode, including pilot; production startup additionally fails
   * fast until a key is supplied.
   */
  adminApiKey: string;
  /** Where the append-only JSONL DSR records log is written. */
  dsrLogPath: string;
  /** Where the append-only JSONL lead/consent records log is written. */
  leadLogPath: string;
  /**
   * Where the derived, PII-free session → lead index is written (C-07).
   *
   * It holds only `session_id`, `lead_id` and `created_at` — no name, email,
   * phone, or medical field — so a chat turn can resolve a session's consent
   * without decrypting the whole lead log. The lead log remains the source of
   * truth: the index is rebuilt from it when missing or older than the log
   * (`npm run records:index-sessions` rebuilds it deliberately).
   */
  leadSessionIndexPath: string;
  /**
   * Where PII-free lead-access audit entries are appended. Each line records
   * that an export happened, which lead ids it returned, and how many — never
   * a name, address, phone number, or medical detail. Kept apart from the
   * erasure log so the two audit trails keep distinct meanings.
   */
  leadAccessLogPath: string;
  /**
   * Where PII-free admin read-access entries are appended (M-04). Each line
   * records the route, the actor's key id, an opaque record id and the status —
   * never a key, a query, or record content. An admin read is refused if this
   * write fails.
   */
  adminAccessLogPath: string;
  /**
   * Where PII-free erasure and retention audit entries are appended. Each line
   * records what was removed, when, and under which DSR — never the subject's
   * address or any other identifying value.
   */
  erasureLogPath: string;
  /**
   * Directory holding one claim file per booked appointment slot. `bookSlot`
   * creates the claim with `O_CREAT|O_EXCL`, so exactly one process can hold a
   * slot even when several instances share the same filesystem. Needs a shared
   * POSIX filesystem: on a serverless runtime the path must be absolute and
   * outside the platform's ephemeral roots, otherwise booking fails closed.
   */
  bookingLedgerPath: string;
  /**
   * Retention period, in days, for lead records and fulfilled DSR records.
   * Defaults to seven years; counsel sets the real value. Records older than
   * the cutoff are removed by the retention sweep (never automatically in the
   * request path) unless a legal hold applies outside this system.
   */
  dataRetentionDays: number;
  /**
   * Secret used to encrypt record logs (DSR + lead) at rest with AES-256-GCM.
   * Required in production (PILOT_MODE=false); in pilot mode records fall back
   * to plaintext for dev convenience. DSR/lead records may contain PII, so in
   * production this must be set (see index.ts production gate).
   */
  recordEncryptionKey: string;
  /**
   * Previous record-encryption secrets, used only to decrypt records written
   * before a key rotation (comma-separated). Each key's id is derived from the
   * key itself, so there is no id to track by hand. Retire a key from this list
   * only after `npm run records:rekey` has rewritten every log with the current
   * key — see docs/data-lifecycle-runbook.md.
   */
  recordEncryptionLegacyKeys: readonly string[];
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

/**
 * Reads a positive integer from the environment, falling back when the value is
 * absent or not a usable count. A malformed retention value must never widen
 * retention to infinity or collapse it to zero.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Default location of the session → lead index: a sibling of the lead log.
 *
 * Shipped beside the log so a deployment that overrides LEAD_LOG_PATH (a test
 * temp file, a mounted volume) gets its index in the same place without a
 * second setting, and two processes pointed at different logs never share one
 * index.
 */
function defaultLeadSessionIndexPath(): string {
  const leadPath = process.env.LEAD_LOG_PATH || 'data/lead-records.jsonl';
  const suffix = '.jsonl';
  return leadPath.endsWith(suffix)
    ? `${leadPath.slice(0, -suffix.length)}-session-index.jsonl`
    : `${leadPath}-session-index.jsonl`;
}

/**
 * The published privacy-rights address — permanent.
 *
 * This is the one address the privacy notice, `/api/disclosure`,
 * `/api/consent-text`, the DSR receipt and the just-in-time notice all point
 * at. It is the permanent rights mailbox and is not scheduled to move; what
 * matters is that its domain accepts mail, because a TDPSA request sent to an
 * unroutable address bounces while the 45-day clock is already running.
 * `npm run rights:channel` verifies the route at release time.
 */
export const DEFAULT_DSR_CONTACT_EMAIL = 'richardparslow@lifepolicypilot.blog';

export const config: AppConfig = {
  // LIFECHAT_PORT wins; PORT is honored as the fallback because managed sandbox
  // and hosting platforms inject PORT and expect the app to bind to it.
  port: parseInt(process.env.LIFECHAT_PORT || process.env.PORT || '3000', 10),
  businessName: process.env.BUSINESS_NAME || PRODUCT_NAME,
  licensedBrokerName: process.env.LICENSED_BROKER_NAME || 'Richard Parslow',
  texasLicenseNumber: process.env.TEXAS_LICENSE_NUMBER || LICENSE_PENDING_PLACEHOLDER,
  appointedCarriers: (process.env.APPOINTED_CARRIERS || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean),
  // The live site the widget is embedded in. Citations, the privacy notice and
  // the contact link all derive from it (or from the two explicit overrides), so
  // a future domain move is one environment change, not a corpus edit.
  websiteUrl: process.env.WEBSITE_URL || 'https://lifeinsurancebrokeradvocate.com/',
  privacyNoticeUrl:
    process.env.PRIVACY_NOTICE_URL || 'https://lifeinsurancebrokeradvocate.com/privacy',
  contactUrl: process.env.CONTACT_URL || 'https://lifeinsurancebrokeradvocate.com/contact',
  privacyNoticeVersion: process.env.PRIVACY_NOTICE_VERSION || '1.3.0',
  // The consent artefact stores a hash of the exact copy the visitor affirmed,
  // so the version must change whenever the copy does. 1.1.0 is the
  // LifeChat / Life Insurance Broker Advocate naming (from 1.0.0, which named
  // the retired Life Policy Pilot brand), approved for use by the principal
  // owner and licensed Texas broker, Richard Parslow, on 2026-10-23.
  contactConsentVersion: process.env.CONTACT_CONSENT_VERSION || '1.1.0',
  medicalConsentVersion: process.env.MEDICAL_CONSENT_VERSION || '1.1.0',
  // The permanent, published rights mailbox. DSR_CONTACT_EMAIL is the single
  // name for it (DSR_EMAIL is still accepted for existing deployments), and it
  // is served verbatim by /api/disclosure and /api/consent-text. A TDPSA
  // request needs a working route, so `npm run rights:channel` refuses a
  // release whose configured address cannot receive mail.
  dsrEmail: (
    process.env.DSR_CONTACT_EMAIL ||
    process.env.DSR_EMAIL ||
    DEFAULT_DSR_CONTACT_EMAIL
  ).trim(),
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o',
  llmApiBaseUrl: (process.env.LLM_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean),
  // Pilot is an explicit posture, never an inference from a missing variable.
  // A process that loses PILOT_MODE in a production environment must fail
  // closed (admin routes 503, encryption required at boot), so the default is
  // only "pilot" outside production. Set PILOT_MODE=true to opt in explicitly.
  pilotMode:
    process.env.PILOT_MODE === undefined
      ? process.env.NODE_ENV !== 'production'
      : process.env.PILOT_MODE !== 'false',
  // Serverless deployment gate — when true, importing the server module builds
  // the Express app but does not listen on a port. The platform (Vercel) starts
  // each invocation itself; a self-started listener would crash the cold start.
  // Detected automatically from the platform's VERCEL marker, with
  // SERVERLESS=true as the manual override for any other serverless runtime.
  // Local and container runs leave both unset so the server starts as before.
  serverless: process.env.SERVERLESS === 'true' || process.env.VERCEL === '1',
  trustProxy: (process.env.TRUST_PROXY || '').trim(),
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
  // Secret that keys the abstention question hash (M-08). Without it the log is
  // not written at all: an unkeyed digest is a dictionary lookup away from the
  // question, and those questions are often about a health condition.
  abstentionLogKey: process.env.ABSTENTION_LOG_KEY || '',
  adminApiKey: process.env.ADMIN_API_KEY || '',
  dsrLogPath: process.env.DSR_LOG_PATH || 'data/dsr-records.jsonl',
  leadLogPath: process.env.LEAD_LOG_PATH || 'data/lead-records.jsonl',
  leadSessionIndexPath: process.env.LEAD_SESSION_INDEX_PATH || defaultLeadSessionIndexPath(),
  leadAccessLogPath: process.env.LEAD_ACCESS_LOG_PATH || 'data/lead-access-log.jsonl',
  adminAccessLogPath: process.env.ADMIN_ACCESS_LOG_PATH || 'data/admin-access-log.jsonl',
  erasureLogPath: process.env.ERASURE_LOG_PATH || 'data/erasure-log.jsonl',
  bookingLedgerPath: process.env.BOOKING_LEDGER_PATH || 'data/bookings',
  dataRetentionDays: positiveIntFromEnv('DATA_RETENTION_DAYS', 2555),
  recordEncryptionKey: process.env.RECORD_ENCRYPTION_KEY || '',
  recordEncryptionLegacyKeys: (process.env.RECORD_ENCRYPTION_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean),
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
 * Builds an absolute URL on the public site from a site-relative path.
 *
 * The RAG corpus stores citation targets as paths (`blog/term-vs-whole-life-
 * insurance-texas`) rather than absolute URLs, so citations follow WEBSITE_URL.
 * Moving from the legacy blog to the Lovable site therefore changed one default
 * rather than nineteen corpus strings.
 */
export function publicationUrl(path = '/'): string {
  const base = config.websiteUrl.trim().replace(/\/+$/, '');
  const suffix = String(path || '/')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return suffix ? `${base}/${suffix}` : `${base}/`;
}

/**
 * Matches one allowlist entry against a browser origin.
 *
 * An entry is normally an exact origin. It may also be a subdomain wildcard
 * (`https://*.lovable.app`) so a host app's preview deployments do not need a
 * new value on every build. Wildcards are deliberately narrow: http(s) only, a
 * leading `*.` and nothing else, at least one subdomain label, no port and no
 * path. `*.lovable.app` does not match `lovable.app` itself, so a preview
 * allowlist cannot silently widen to the vendor's own origin.
 */
function originMatches(entry: string, origin: string): boolean {
  if (!entry.includes('*')) return entry === origin;
  const schemeEnd = entry.indexOf('://');
  if (schemeEnd < 0) return false;
  const scheme = entry.slice(0, schemeEnd);
  const hostPattern = entry.slice(schemeEnd + 3);
  if ((scheme !== 'https' && scheme !== 'http') || !hostPattern.startsWith('*.')) return false;
  if (!origin.startsWith(`${scheme}://`)) return false;
  const host = origin.slice(scheme.length + 3);
  if (host.includes('/') || host.includes(':') || host.includes('*')) return false;
  const suffix = hostPattern.slice(1); // leading dot retained
  return host.endsWith(suffix) && host.length > suffix.length;
}

/**
 * True when a browser origin is on the cross-origin allowlist.
 *
 * Deny-by-default: with ALLOWED_ORIGINS unset nothing is allowed cross-origin,
 * which is the correct posture while the widget is only used same-origin (the
 * bundled demo page). The Lovable site embed is the case that opts in, by
 * listing its origin. Comparison ignores case and a trailing slash.
 */
export function isAllowedOrigin(origin: string): boolean {
  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase();
  if (normalized.length === 0) return false;
  return config.allowedOrigins.some((entry) => originMatches(entry, normalized));
}

/**
 * Allowlist entries that are subdomain wildcards rather than exact origins.
 *
 * Exported so boot can name them: a wildcard is a deliberate convenience for
 * preview deployments, but it grants CORS to every site on the vendor's
 * domain, not only to this project's previews. That is a spend and data-entry
 * risk (any tenant could call `/api/chat` on this key's budget and post consent
 * or DSR records), so it is reported at boot instead of being silent. The
 * entries themselves are validated by {@link originMatches}, which refuses any
 * wildcard shape broader than `http(s)://*.suffix`.
 */
export function wildcardAllowedOrigins(): string[] {
  return config.allowedOrigins.filter((entry) => entry.includes('*'));
}

/**
 * Minimum length for ADMIN_API_KEY (SEC-10).
 *
 * The key is the only thing standing in front of the system prompt, session
 * history, lead-status lookups, session deletion, and the runtime kill switch.
 * A short key is guessable offline, and the constant-time comparison in front
 * of it cannot help against a 4-character secret — so the floor is enforced at
 * boot, in every mode, exactly as it is for RECORD_ENCRYPTION_KEY.
 */
export const MIN_ADMIN_API_KEY_LENGTH = 32;

/**
 * True when an admin API key is configured (non-empty). Admin endpoints use
 * this to decide whether to enforce the x-admin-key header. A missing key is
 * a 503 in every mode, including pilot: fail closed, never an open door.
 */
export function isAdminApiKeyConfigured(): boolean {
  return config.adminApiKey.trim().length > 0;
}

/**
 * True when the configured admin key meets the minimum length. A configured
 * key below the floor is refused at boot rather than accepted as "configured".
 */
export function isAdminApiKeyStrong(): boolean {
  return config.adminApiKey.trim().length >= MIN_ADMIN_API_KEY_LENGTH;
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
 * True when a record log path points to an ephemeral or relative filesystem
 * location while running in serverless mode (`config.serverless === true`).
 *
 * Serverless platforms (such as Vercel) provide a read-only deployment bundle
 * and an ephemeral `/tmp` scratchpad that is wiped across cold starts and not
 * shared across instances. Legal records (TDPSA DSR requests and consent-proof
 * lead records) must never be acknowledged if written to an ephemeral
 * serverless filesystem.
 *
 * Durability is established by the boot probe in `durable-storage.ts` (Archil,
 * a real mounted volume, or a long-running process), never by declaration. The
 * former `DURABLE_STORAGE_CONFIGURED=true` flag is intentionally ignored: it
 * disabled this guard without proving anything, which let `/tmp` writes be
 * acknowledged and then lost (SEC-11).
 */
export function isDurableStorageConfigured(): boolean {
  return isArchilStorageConfigured() || isDurableStorageVerified();
}

/**
 * True when a record write cannot be lost to an ephemeral filesystem: either
 * this process owns its disk, or a probe proved the configured storage
 * survives it. Call sites use this instead of `config.serverless && …`.
 *
 * The probe normally runs in the entry-point preflight. It is also run lazily
 * here, once, because a serverless host may import the app directly (Vercel's
 * `api/index.ts`, the Sites Worker entry) and never execute `src/index.ts`.
 * Probing is synchronous and cached after the first verdict, so the request
 * path pays for it only until the first record operation.
 */
export function isRecordStorageSafe(): boolean {
  if (!config.serverless) return true;
  if (durableStorageStatus().reason === 'probe_pending') {
    verifyDurableStorage({
      serverless: true,
      archilConfigured: isArchilStorageConfigured(),
      logPaths: [
        config.leadLogPath,
        config.dsrLogPath,
        config.erasureLogPath,
        config.leadAccessLogPath,
        config.adminAccessLogPath,
      ],
    });
  }
  return isDurableStorageConfigured();
}

export function isEphemeralServerlessPath(logPath: string): boolean {
  if (isRecordStorageSafe()) {
    return false;
  }
  const trimmed = logPath.trim();
  if (!trimmed) {
    return true;
  }
  const resolved = resolve(trimmed);
  if (
    resolved === '/tmp' ||
    resolved.startsWith('/tmp/') ||
    resolved === '/private/tmp' ||
    resolved.startsWith('/private/tmp/') ||
    resolved.startsWith('/var/task/')
  ) {
    return true;
  }
  // Relative paths inside the serverless bundle (e.g., default `data/*.jsonl`)
  // are either read-only or ephemeral to the invocation container.
  if (!trimmed.startsWith('/')) {
    return true;
  }
  return false;
}

/**
 * The product definition (Section 4.1).
 */
export const PRODUCT_DEFINITION = {
  name: ASSISTANT_DISPLAY_NAME,
  owner: `Richard Parslow / ${PROVIDER_BRAND}`,
  initialJurisdiction: 'Texas visitors seeking general life-insurance education',
  primaryObjective: `Provide short, source-linked answers from approved ${PROVIDER_BRAND} articles and primary regulatory/consumer sources, then offer an optional handoff or appointment with a licensed Texas broker.`,
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
