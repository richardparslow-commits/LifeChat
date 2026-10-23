/**
 * Lead Data and Consent Model (Section 4.7 of the specification)
 *
 * Defines permitted lead fields, forbidden analytics fields, validation rules,
 * storage requirements, and the contact consent framework.
 */

import { stat } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { config, isEphemeralServerlessPath } from '../config/app-config';
import { isArchilStorageConfigured } from '../archil/disk';
import { BoundedLruCache } from '../persistence/bounded-lru';
import {
  appendJsonlLine,
  findJsonlRecord,
  findLastJsonlRecord,
  forEachJsonlLine,
  readJsonlLines,
  removeLogFile,
  replaceJsonlLines,
} from '../persistence/jsonl-log';
import type { CanonicalConditionRef } from '../medical/condition-crosswalk';
import {
  encryptRecordLine,
  decryptRecordLine,
  isEncryptedRecordLine,
  isLegacyPlaintextRecordAllowed,
  isLegacyPlaintextRecordLine,
  isRecordEncryptionConfigured,
} from '../privacy/record-encryption';

/**
 * Permitted lead fields (Section 4.7).
 * These are the ONLY fields that may be stored in the operational lead record.
 * Medical profile fields are permitted ONLY when the user has given explicit,
 * current, versioned medical consent (Phase 2) — see MedicalProfile below.
 */
export interface LeadRecord {
  /** Server-generated UUID */
  lead_id: string;
  /**
   * The chat session the consent was submitted from, when the form carried one.
   *
   * This is the join key that lets the chat route verify consent server-side:
   * the record is created by /api/consent, so a session id found here proves the
   * visitor submitted the consent form, while an id the model asserts about
   * itself proves nothing. It is the client-generated opaque session id, never
   * a name, email, or phone number.
   */
  session_id: string | null;
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
  /** Diagnosed by a doctor, as stated by the user — kept verbatim */
  medical_conditions: string[];
  /**
   * Canonical crosswalk of `medical_conditions` (Phase 2) — ICD-10-CM refs
   * resolved against a versioned vocabulary so a profile can be matched and
   * queried. Additive only: it never rewrites the user's stated wording, and
   * conditions with no exact match stay in `medical_conditions` unmatched
   * rather than being guessed onto a code. Empty until the crosswalk runs, and
   * only ever populated alongside explicit, current, versioned medical consent.
   */
  canonical_conditions: CanonicalConditionRef[];
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
 * True when the record carries a consented medical profile (SEC-18).
 *
 * `medical_profile` is populated only on the consented Phase 2 path, so a
 * non-null profile is a TDPSA sensitive-health payload: date of birth,
 * conditions, medications. Such a record must never be written in clear text,
 * which is why the write below asks the encryption boundary to refuse the
 * pilot-mode plaintext fallback for it.
 */
export function leadCarriesMedicalData(lead: LeadRecord): boolean {
  return lead.medical_profile !== null;
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
    session_id: null,
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
 * Bounded in-memory cache of lead records, in front of the JSONL log.
 *
 * The log on disk is the source of truth; this cache makes admin and handoff
 * lookups O(1). It is capped so a long-lived process cannot grow without
 * bound, and it is hydrated from disk asynchronously at module load rather
 * than with a blocking read.
 */
export const MAX_CACHED_LEAD_RECORDS = 5000;
const leadRecords = new BoundedLruCache<string, LeadRecord>(MAX_CACHED_LEAD_RECORDS);

/**
 * One line of the derived session → lead index.
 *
 * PII-free by construction. The consent artifact itself (name, email, phone,
 * consent-copy hash) stays only in the encrypted lead record; this index holds
 * the join key that lets a chat turn prove consent without decrypting the log.
 */
export interface LeadSessionIndexEntry {
  session_id: string;
  lead_id: string;
  created_at: string;
}

/**
 * Session id → lead id for every consented session in the durable log.
 *
 * A plain Map rather than a bounded cache: this *is* the index, so a miss has
 * to be meaningful. With `sessionIndexComplete` true, a session absent here has
 * no consent record, which is the answer the chat hot path needs — the previous
 * design scanned (and decrypted) the whole log on the first turn of every new
 * visitor, measured at ~1.4 s for 3,397 records (C-07).
 *
 * Memory is proportional to the number of distinct consented sessions, not to
 * the size of a decrypted log: one session id and one lead id per entry, with
 * no PII. The lead cache above stays bounded because its values are full
 * records.
 */
const leadIdBySession = new Map<string, string>();

/**
 * Sessions already scanned and found to have no record.
 *
 * Only the fallback path uses this: when the index cannot be loaded or
 * rebuilt, a lookup streams the log, and remembering the misses keeps a session
 * that never consented from re-reading the file on every turn.
 */
const scannedSessionMisses = new BoundedLruCache<string, null>(MAX_CACHED_LEAD_RECORDS);

/** True once `leadIdBySession` reflects every record in the durable log. */
let sessionIndexComplete = false;
let sessionIndexPromise: Promise<void> | null = null;

let loadPromise: Promise<void> | null = null;

/** Parses one index line defensively; a malformed line is ignored, not fatal. */
function parseSessionIndexEntry(line: string): LeadSessionIndexEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<LeadSessionIndexEntry> | null;
    if (!parsed || typeof parsed.session_id !== 'string' || typeof parsed.lead_id !== 'string') {
      return null;
    }
    if (parsed.session_id.length === 0 || parsed.lead_id.length === 0) return null;
    return {
      session_id: parsed.session_id,
      lead_id: parsed.lead_id,
      created_at: typeof parsed.created_at === 'string' ? parsed.created_at : '',
    };
  } catch {
    return null;
  }
}

/**
 * True when the index file is at least as new as the lead log.
 *
 * A consent write appends the lead first and the index line second, so an index
 * older than the log means the index append (or a whole rebuild) did not land —
 * exactly the case a restart has to repair by rebuilding. Archil objects expose
 * no POSIX mtime, so there a non-empty index is trusted and only an empty one
 * is rebuilt.
 */
async function indexCoversLeadLog(): Promise<boolean> {
  if (isArchilStorageConfigured()) return true;
  try {
    const indexStat = await stat(config.leadSessionIndexPath);
    const logStat = await stat(config.leadLogPath).catch(() => null);
    if (logStat === null) return true; // nothing to index
    return logStat.mtimeMs <= indexStat.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Hydrates the session index from its file, rebuilding it when it is missing
 * or older than the log. Resolves once `sessionIndexComplete` is settled.
 */
async function loadSessionIndexFromDisk(): Promise<void> {
  if (!(await indexCoversLeadLog())) {
    await rebuildLeadSessionIndex();
    return;
  }

  const lines = await readJsonlLines(config.leadSessionIndexPath);
  for (const line of lines) {
    const entry = parseSessionIndexEntry(line);
    if (entry) leadIdBySession.set(entry.session_id, entry.lead_id);
  }

  if (leadIdBySession.size === 0) {
    // An empty index beside a log with records is not trustworthy. With no log
    // (or an empty one) there is nothing to index, and a scan would only prove
    // that again on every boot.
    if (!isArchilStorageConfigured()) {
      const logStat = await stat(config.leadLogPath).catch(() => null);
      if (logStat === null || logStat.size === 0) {
        sessionIndexComplete = true;
        return;
      }
    }
    await rebuildLeadSessionIndex();
    return;
  }
  sessionIndexComplete = true;
}

/**
 * Resolves once the session index has been loaded (or the attempt failed).
 *
 * Called at boot and lazily from the lookup, so a runtime that imports the app
 * without running the Node entry point (the Sites Worker) still gets the index.
 */
export function ensureSessionIndexLoaded(): Promise<void> {
  if (sessionIndexComplete) return Promise.resolve();
  sessionIndexPromise ??= loadSessionIndexFromDisk().catch(() => {
    // Fail safe, not silent: lookups stay correct by scanning the log, but the
    // O(1) path is gone for this process until it restarts.
    console.warn(
      `WARNING: could not load the session index at ${config.leadSessionIndexPath}; ` +
        'session consent lookups will scan the lead log until it is rebuilt.',
    );
  });
  return sessionIndexPromise;
}

/** Result of a full rebuild, safe to print (never contains record contents). */
export interface SessionIndexRebuildResult {
  path: string;
  sessionsIndexed: number;
  recordsScanned: number;
  unreadable: number;
  written: boolean;
}

/**
 * Rebuilds the PII-free session → lead index from the durable lead log.
 *
 * Streams the log, decrypting each record only to read `session_id`, `lead_id`
 * and `created_at`, then replaces the index file in one atomic write. The
 * in-memory map is replaced wholesale too, so an erasure or retention rewrite
 * cannot leave a deleted session resolving to a deleted lead.
 *
 * Runs on boot when the index is missing or older than the log, after erasure
 * and retention rewrites, and from `npm run records:index-sessions`.
 */
export async function rebuildLeadSessionIndex(): Promise<SessionIndexRebuildResult> {
  const entries = new Map<string, LeadSessionIndexEntry>();
  let recordsScanned = 0;
  let unreadable = 0;

  const complete = await forEachJsonlLine(config.leadLogPath, (line) => {
    recordsScanned += 1;
    let record: LeadRecord | null = null;
    try {
      const plain = decryptRecordLine(line);
      record = plain === null ? null : (JSON.parse(plain) as LeadRecord);
    } catch {
      record = null;
    }
    if (!record || typeof record.lead_id !== 'string' || record.lead_id.length === 0) {
      unreadable += 1;
      return;
    }
    if (typeof record.session_id !== 'string' || record.session_id.length === 0) return;
    // Append-only: the last record for a session supersedes an earlier one.
    entries.set(record.session_id, {
      session_id: record.session_id,
      lead_id: record.lead_id,
      created_at: typeof record.created_at === 'string' ? record.created_at : '',
    });
  });

  if (!complete) {
    // Never publish a truncated index: it would look authoritative and deny
    // consent for every session after the point the read failed.
    console.warn(
      `WARNING: could not read all of ${config.leadLogPath}; the session index was left unchanged.`,
    );
    return {
      path: config.leadSessionIndexPath,
      sessionsIndexed: 0,
      recordsScanned,
      unreadable: unreadable + 1,
      written: false,
    };
  }

  leadIdBySession.clear();
  scannedSessionMisses.clear();
  for (const [sessionId, entry] of entries) {
    leadIdBySession.set(sessionId, entry.lead_id);
  }

  const lines = [...entries.values()].map((entry) => JSON.stringify(entry));
  const written = await replaceJsonlLines(config.leadSessionIndexPath, lines);

  // The map is complete whether or not the file write landed; the file is only
  // what saves the next process a scan.
  sessionIndexComplete = true;

  if (!written) {
    console.warn(
      'WARNING: rebuilt the session index in memory but could not write ' +
        `${config.leadSessionIndexPath}; session lookups will rescan the lead log after a restart.`,
    );
  }

  return {
    path: config.leadSessionIndexPath,
    sessionsIndexed: entries.size,
    recordsScanned,
    unreadable,
    written,
  };
}

/** Streams the JSONL log into the cache, without collecting the file. */
async function loadLeadRecordsFromDisk(): Promise<void> {
  const logPath = config.leadLogPath;
  let skippedMissingKey = 0;
  let skippedUndecodable = 0;
  let skippedPlaintext = 0;

  await forEachJsonlLine(logPath, (line) => {
    try {
      const plain = decryptRecordLine(line);
      if (plain === null) {
        // Skipped encrypted lines are an operational trap — records silently
        // vanish on startup. Count them so we can warn, whether the key is
        // missing or present-but-wrong.
        if (isEncryptedRecordLine(line)) {
          if (isRecordEncryptionConfigured()) {
            skippedUndecodable++;
          } else {
            skippedMissingKey++;
          }
        } else if (isLegacyPlaintextRecordLine(line) && !isLegacyPlaintextRecordAllowed()) {
          // SEC-15: an unauthenticated line is refused outside pilot mode. It is
          // reported, not silently ignored, so an operator knows to rekey.
          skippedPlaintext++;
        }
        return; // cannot decode — skip
      }
      const parsed = JSON.parse(plain) as LeadRecord;
      if (parsed && parsed.lead_id) {
        leadRecords.set(parsed.lead_id, parsed);
      }
    } catch {
      // skip malformed lines
    }
  });

  if (skippedMissingKey > 0) {
    console.warn(
      `WARNING: ${skippedMissingKey} encrypted lead record(s) in ${logPath} were skipped because ` +
        'RECORD_ENCRYPTION_KEY is not configured. Set it to load existing records; without it, ' +
        'new writes fall back to plaintext (pilot mode only).',
    );
  }
  if (skippedUndecodable > 0) {
    console.warn(
      `WARNING: ${skippedUndecodable} encrypted lead record(s) in ${logPath} could not be decoded ` +
        'with the configured key — the key may have changed or the data may be corrupt.',
    );
  }
  if (skippedPlaintext > 0) {
    console.warn(
      `WARNING: ${skippedPlaintext} unencrypted lead record(s) in ${logPath} were refused because ` +
        'plaintext records are not accepted outside pilot mode. Run `npm run records:rekey` to ' +
        'encrypt them under RECORD_ENCRYPTION_KEY.',
    );
  }
}

/**
 * Resolves once the startup load from disk has finished.
 *
 * Writes await this so a record appended during startup can never interleave
 * with a half-loaded cache; tests and admin tooling await it before asserting
 * on records that came from disk rather than from this process.
 */
export function ensureLeadRecordsLoaded(): Promise<void> {
  loadPromise ??= loadLeadRecordsFromDisk();
  return loadPromise;
}

/**
 * Re-reads the lead log after an out-of-band rewrite (erasure or retention),
 * replacing both in-memory caches with what is actually on disk.
 *
 * The session index is rebuilt too: erasing a lead must also erase the
 * session → lead mapping, or a later chat turn could resolve a deleted record.
 */
export async function reloadLeadRecords(): Promise<void> {
  leadRecords.clear();
  leadIdBySession.clear();
  scannedSessionMisses.clear();
  sessionIndexComplete = false;
  sessionIndexPromise = null;
  loadPromise = loadLeadRecordsFromDisk();
  await loadPromise;
  // A forced rebuild, not the mtime check: the file on disk still names every
  // session that was erased, even though the log no longer has those records.
  await rebuildLeadSessionIndex();
}

// Hydration is explicit: the entry point (src/index.ts) starts it at boot and
// the first write awaits it. Module evaluation itself stays free of I/O and of
// log output, so importing this module never races a caller's console spy.

/**
 * Appends a lead record to the JSONL log through an async stream.
 * Returns false on failure (read-only dir, full disk, or ephemeral serverless
 * filesystem).
 */
async function persistLeadRecord(lead: LeadRecord): Promise<boolean> {
  const logPath = config.leadLogPath;
  if (isEphemeralServerlessPath(logPath)) {
    return false;
  }
  try {
    return await appendJsonlLine(
      logPath,
      encryptRecordLine(JSON.stringify(lead), {
        // SEC-18: a medical profile fails closed without a key, in pilot mode
        // too, rather than putting health data on disk as plaintext.
        requireEncryption: leadCarriesMedicalData(lead),
      }),
    );
  } catch {
    // Fail closed: any unexpected error is a failed write, never a rejection
    // that would surface as a hanging request under Express 4.
    return false;
  }
}

/**
 * Persists a lead record to the store. The record should already be fully
 * populated (PII fields, consent version, timestamp) before calling this.
 *
 * Fail-closed: resolves true only when the record was durably written, and
 * only then adds it to the in-memory cache. On a persistence failure it
 * resolves false and the record is neither stored nor acknowledged — the
 * consent artifact is a legal record under TDPSA consent-proof requirements,
 * so a lost write must not be confirmed (mirrors the DSR intake path in
 * src/privacy/dsr.ts).
 *
 * @returns true when durably persisted, false when the write failed.
 */
export async function saveLeadRecord(lead: LeadRecord): Promise<boolean> {
  await ensureLeadRecordsLoaded();
  await ensureSessionIndexLoaded();
  if (!(await persistLeadRecord(lead))) {
    return false;
  }
  leadRecords.set(lead.lead_id, lead);
  if (lead.session_id) {
    leadIdBySession.set(lead.session_id, lead.lead_id);
    // Keep the durable index in step. It is derived, so a failed append is not
    // a failed consent — the lead itself is durable, and the next process sees
    // a log newer than the index and rebuilds it.
    const indexed = await appendJsonlLine(
      config.leadSessionIndexPath,
      JSON.stringify({
        session_id: lead.session_id,
        lead_id: lead.lead_id,
        created_at: lead.created_at,
      } satisfies LeadSessionIndexEntry),
    );
    if (!indexed) {
      console.warn(
        `WARNING: could not append to the session index at ${config.leadSessionIndexPath}; ` +
          'the consent record was stored, and the index will be rebuilt from the lead log.',
      );
    }
  }
  return true;
}

/**
 * Finds the lead id submitted from a session.
 *
 * Index-first: the durable session index answers in O(1), including the
 * common negative case of a visitor who has not consented. Only when the index
 * could not be loaded does this fall back to scanning the log, and a scan miss
 * is remembered so later turns on that session do not repeat it.
 */
async function findLeadIdBySession(sessionId: string): Promise<string | undefined> {
  const indexed = leadIdBySession.get(sessionId);
  if (indexed !== undefined) return indexed;

  await ensureSessionIndexLoaded();

  const loaded = leadIdBySession.get(sessionId);
  if (loaded !== undefined) return loaded;

  // With a complete index, absence is the answer: no consent record exists
  // for this session, and no log read is needed to prove it.
  if (sessionIndexComplete) return undefined;

  if (scannedSessionMisses.has(sessionId)) return undefined;
  const match = await findLastJsonlRecord<LeadRecord>(config.leadLogPath, (line) => {
    const plain = decryptRecordLine(line);
    if (plain === null) return null;
    const parsed = JSON.parse(plain) as LeadRecord;
    return parsed && parsed.session_id === sessionId ? parsed : null;
  });
  if (match) {
    leadIdBySession.set(sessionId, match.lead_id);
    return match.lead_id;
  }
  scannedSessionMisses.set(sessionId, null);
  return undefined;
}

/**
 * The session's consented contact details, as verified from storage.
 *
 * Note what is *not* here: nothing the model said. Every field comes from the
 * record /api/consent wrote on a user submission.
 */
export interface VerifiedContactConsent {
  leadId: string;
  channel: 'email' | 'phone' | 'calendar';
  email: string | null;
  phone: string | null;
  version: string;
  consentedAt: string;
}

/** Why a session has no usable consent. Stable codes, safe to log. */
export type ContactConsentRejection =
  'no_consent_record' | 'stale_consent_version' | 'invalid_contact_field';

export type ContactConsentVerification =
  { ok: true; consent: VerifiedContactConsent } | { ok: false; reason: ContactConsentRejection };

/**
 * Verifies that the session holds affirmative, current, complete contact
 * consent, derived entirely from the durable lead record.
 *
 * Fail-closed: a record that is missing, incomplete (no consent version,
 * timestamp, or affirmed-copy hash), written under a superseded consent
 * version, or that lacks a valid value for its own channel does not authorize
 * anything. The caller must treat every rejection reason as "no consent".
 */
export async function getVerifiedContactConsent(
  sessionId: string,
): Promise<ContactConsentVerification> {
  const leadId = await findLeadIdBySession(sessionId);
  if (!leadId) return { ok: false, reason: 'no_consent_record' };

  const record = await getLeadRecord(leadId);
  if (!record) return { ok: false, reason: 'no_consent_record' };

  // An incomplete artifact is not consent: the version names the copy that was
  // shown, the timestamp proves when, and the hash proves which words.
  if (!record.contact_consent_version || !record.consent_timestamp || !record.consent_text_hash) {
    return { ok: false, reason: 'no_consent_record' };
  }

  if (record.contact_consent_version !== config.contactConsentVersion) {
    return { ok: false, reason: 'stale_consent_version' };
  }

  const channel = record.contact_channel;
  if (channel === 'email') {
    if (!record.email || !validateEmail(record.email)) {
      return { ok: false, reason: 'invalid_contact_field' };
    }
  } else if (channel === 'phone') {
    if (!record.phone || !validatePhone(record.phone)) {
      return { ok: false, reason: 'invalid_contact_field' };
    }
  } else if (channel !== 'calendar') {
    // No channel was captured, so there is no consented route to reach the
    // visitor through.
    return { ok: false, reason: 'invalid_contact_field' };
  }

  return {
    ok: true,
    consent: {
      leadId: record.lead_id,
      channel,
      email: record.email,
      phone: record.phone,
      version: record.contact_consent_version,
      consentedAt: record.consent_timestamp,
    },
  };
}

/**
 * Reads one lead record straight from the JSONL log, decrypting each line.
 * Used only when the cache does not hold the id.
 */
async function findLeadRecordOnDisk(leadId: string): Promise<LeadRecord | undefined> {
  return findJsonlRecord<LeadRecord>(config.leadLogPath, (line) => {
    const plain = decryptRecordLine(line);
    if (plain === null) return null;
    const parsed = JSON.parse(plain) as LeadRecord;
    return parsed && parsed.lead_id === leadId ? parsed : null;
  });
}

/**
 * Gets a lead record by its lead_id (admin/debug + handoff lookup).
 *
 * Cache-first, log-backed: a bounded cache evicts old entries, so a miss is
 * not proof the record does not exist. On a miss this streams the JSONL log
 * for the id, caches the match, and returns it. A record written by another
 * process (or before this process started) is therefore just as findable as
 * one written here — eviction changes lookup cost, never the answer.
 */
export async function getLeadRecord(leadId: string): Promise<LeadRecord | undefined> {
  const cached = leadRecords.get(leadId);
  if (cached) return cached;

  // If startup hydration is still running, let it finish first; it may already
  // hold the record, and the cache must not be read half-loaded.
  await ensureLeadRecordsLoaded();

  const hydrated = leadRecords.get(leadId);
  if (hydrated) return hydrated;

  const fromDisk = await findLeadRecordOnDisk(leadId);
  if (fromDisk) {
    leadRecords.set(leadId, fromDisk);
  }
  return fromDisk;
}

/**
 * Lists cached lead records, oldest first. The JSONL log remains the full
 * record set; this is capped at MAX_CACHED_LEAD_RECORDS entries.
 */
export function listLeadRecords(): LeadRecord[] {
  return leadRecords.values();
}

/** Timestamp sort key; an unparseable date sorts last rather than throwing. */
function createdAtMs(record: LeadRecord): number {
  const parsed = Date.parse(record.created_at);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Every lead record in the durable log, newest first, de-duplicated by id.
 *
 * This is the read path for the operator export (SEC-08), and it deliberately
 * does not use `listLeadRecords()`: that cache is bounded, so an export built
 * from it would silently omit records the process had evicted while presenting
 * itself as complete. The log is the record set.
 *
 * The log is append-only, so a later line for the same `lead_id` supersedes an
 * earlier one. `unreadable` counts lines that could not be decoded (missing or
 * wrong key, malformed envelope, invalid JSON) so the caller can refuse to
 * return a partial export instead of hiding the gap. Ordering is newest first,
 * with `lead_id` as the tie-break so pagination is stable across calls.
 */
export async function listAllLeadRecords(): Promise<{
  records: LeadRecord[];
  unreadable: number;
}> {
  const byId = new Map<string, LeadRecord>();
  let unreadable = 0;

  const complete = await forEachJsonlLine(config.leadLogPath, (line) => {
    let parsed: LeadRecord | null = null;
    try {
      const plain = decryptRecordLine(line);
      if (plain !== null) {
        parsed = JSON.parse(plain) as LeadRecord;
      }
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.lead_id !== 'string' || parsed.lead_id.length === 0) {
      unreadable += 1;
      return;
    }
    byId.set(parsed.lead_id, parsed);
  });
  // A short read is a gap the caller must not mistake for a complete export.
  if (!complete) unreadable += 1;

  const records = [...byId.values()].sort(
    (left, right) =>
      createdAtMs(right) - createdAtMs(left) || left.lead_id.localeCompare(right.lead_id),
  );
  return { records, unreadable };
}

/**
 * Clears all lead records (testing). Also removes the JSONL log file so
 * tests start with a clean slate on disk as well as in memory.
 */
export async function clearAllLeadRecords(): Promise<void> {
  // Testing only: the durable log is removed below, so the derived session
  // index must go with it or a later lookup would resolve an id that is gone.
  leadRecords.clear();
  leadIdBySession.clear();
  scannedSessionMisses.clear();
  sessionIndexComplete = false;
  sessionIndexPromise = null;
  await removeLogFile(config.leadSessionIndexPath);
  await removeLogFile(config.leadLogPath);
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

// The canonical copies live in consent-copy.ts (pure copy, no config import),
// and are re-exported here for the existing import sites.
export { RECOMMENDED_PHONE_CONSENT_COPY, RECOMMENDED_EMAIL_CONSENT_COPY } from './consent-copy';

/**
 * The recommended medical-consent copy for counsel review (Phase 2, Section 9.1).
 * This text must be reviewed and approved by Texas insurance counsel before use.
 * It must be presented through the application UI as an explicit, unchecked,
 * opt-in control — never inferred from continued chat or from contact consent.
 */
export const RECOMMENDED_MEDICAL_CONSENT_COPY = `Optional: I consent to Life Insurance Broker Advocate and Richard Parslow collecting and using the medical information I provide in this chat (including date of birth, gender, height/weight, tobacco or nicotine use, diagnosed medical conditions, and prescribed medications) for the sole purpose of matching carriers to my profile for a life-insurance inquiry. I understand this is optional, that consent is not a condition of anything, that my information will be shared only with Richard Parslow, and that I can withdraw consent or request deletion at any time. See the Privacy Notice for full details.`;

/**
 * Just-in-time notice shown immediately before lead submission (Section 4.7).
 * Identifies exact fields, purpose, recipients, retention summary,
 * optionality, contact choices, and the withdrawal/deletion route — with the
 * DSR contact email (TDPSA consumer rights) from verified configuration.
 */
export function getJustInTimeNotice(): string {
  return `Before you submit: The information you provide (name, email/phone, and optional preferences) will be shared with Richard Parslow, a licensed Texas life-insurance broker, to follow up about your life-insurance inquiry. Providing this information is optional. You can withdraw consent, or submit an access, deletion, correction, or portability request, at any time by emailing ${config.dsrEmail}. See our Privacy Notice for full details.`;
}
