/**
 * Data Subject Request (DSR) Process — TDPSA Consumer Rights (Section 4.7)
 *
 * TDPSA grants Texas consumers the right to access, delete, correct, and
 * port their personal data. This module implements a minimal DSR intake:
 * a validated record is created for each request and an acknowledgment is
 * returned with the TDPSA response window.
 *
 * The consumer-facing contact is served through config.dsrEmail and the
 * disclosure/consent copy; this endpoint is the structured intake route.
 * Records are persisted to an append-only JSONL file so they survive process
 * restarts (DSR records are legal artifacts under TDPSA's 45-day response
 * SLA). Each line is encrypted at rest with AES-256-GCM when a
 * RECORD_ENCRYPTION_KEY is configured (required in production). In
 * production, also persist to the operational CRM/lead store.
 *
 * Persistence is fail-closed: a submission is only acknowledged if its record
 * was durably written. If the append fails (read-only directory, full disk),
 * submitDsr returns ok:false and the consumer is not told the request was
 * received — a TDPSA response obligation must never be acknowledged if it
 * may have been lost.
 */

import { v4 as uuidv4 } from 'uuid';
import { config, isEphemeralServerlessPath } from '../config/app-config';
import { BoundedLruCache } from '../persistence/bounded-lru';
import {
  appendJsonlLine,
  findLastJsonlRecord,
  readJsonlLines,
  removeLogFile,
} from '../persistence/jsonl-log';
import {
  encryptRecordLine,
  decryptRecordLine,
  isEncryptedRecordLine,
  isLegacyPlaintextRecordAllowed,
  isLegacyPlaintextRecordLine,
  isRecordEncryptionConfigured,
} from './record-encryption';
import { validateEmail } from '../consent/consent-model';

/** The TDPSA consumer-rights request types this intake accepts. */
export const DSR_REQUEST_TYPES = [
  'access',
  'deletion',
  'correction',
  'portability',
  'other',
] as const;

export type DsrRequestType = (typeof DSR_REQUEST_TYPES)[number];

/** TDPSA requires responding to a verified request within 45 days. */
export const DSR_RESPONSE_SLA_DAYS = 45;

/**
 * The lifecycle of a request: intake → identity verification → fulfilment.
 *
 * `received` means only that the intake accepted the submission. `verifying`
 * means an operator has confirmed the requester controls the address (which is
 * also what grants suppression authority). `fulfilled` means the requested
 * action — for a deletion, the erasure — completed and was recorded.
 */
export type DsrStatus = 'received' | 'verifying' | 'fulfilled';

/**
 * Placeholder written over a contact address once it has been erased.
 *
 * The tombstone keeps the request id, type, timestamps and status so the
 * deletion itself remains auditable, while removing the PII. It is not a
 * valid address and never matches a consent record.
 */
export const ERASED_CONTACT_MARKER = 'erased';

export interface DsrRecord {
  /** Server-generated UUID */
  request_id: string;
  /** Server timestamp */
  created_at: string;
  request_type: DsrRequestType;
  /** Contact email where the response is sent */
  contact_email: string;
  /**
   * Optional free-text detail — NOT used for analytics, never PII-logged.
   *
   * Only ever stored inside the encrypted envelope (M-09): a consumer may paste
   * an SSN, a diagnosis or an account number into it, and pilot mode used to
   * write that in clear. When no key is configured the intake keeps the request
   * and drops the text, setting `detail_withheld` so the operator knows to ask.
   */
  detail: string | null;
  /**
   * True when a free-text detail was submitted but not stored because records
   * are not encrypted on this deployment. The request itself is still accepted.
   */
  detail_withheld?: boolean;
  status: DsrStatus;
  /**
   * True once an operator has confirmed the requester controls the address.
   *
   * The public intake is unauthenticated, so a submitted address proves
   * nothing. Only a verified request may suppress contact with that address
   * (see verified-actions); an unverified one is a claim, not an authority.
   */
  verified: boolean;
  /** Server timestamp of verification, null while unverified. */
  verified_at: string | null;
  /** Server timestamp of fulfilment (erasure completed), null until then. */
  fulfilled_at: string | null;
}

/**
 * Bounded in-memory cache of DSR records, in front of the JSONL log.
 *
 * DSR records are legal artifacts under TDPSA (45-day response SLA), so the
 * log on disk is authoritative; the cache is capped so a long-lived process
 * cannot grow without bound, and only records that were successfully
 * persisted are added to it.
 */
export const MAX_CACHED_DSR_RECORDS = 5000;
const dsrRecords = new BoundedLruCache<string, DsrRecord>(MAX_CACHED_DSR_RECORDS);

let loadPromise: Promise<void> | null = null;

/** Streams the JSONL log into the cache. */
async function loadDsrRecordsFromDisk(): Promise<void> {
  const logPath = config.dsrLogPath;
  const lines = await readJsonlLines(logPath);
  let skippedMissingKey = 0;
  let skippedUndecodable = 0;
  let skippedPlaintext = 0;

  for (const line of lines) {
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
        continue; // cannot decode — skip
      }
      const parsed = JSON.parse(plain) as Partial<DsrRecord>;
      if (parsed && parsed.request_id && parsed.request_type) {
        // Records written before verification existed carry no `verified`
        // field. Treat them as unverified rather than trusting a truthy
        // default: an old record must not silently gain suppression power.
        dsrRecords.set(parsed.request_id, {
          ...parsed,
          verified: parsed.verified === true,
          verified_at: typeof parsed.verified_at === 'string' ? parsed.verified_at : null,
          fulfilled_at: typeof parsed.fulfilled_at === 'string' ? parsed.fulfilled_at : null,
          status:
            parsed.status === 'verifying' || parsed.status === 'fulfilled'
              ? parsed.status
              : 'received',
        } as DsrRecord);
      }
    } catch {
      // skip malformed lines
    }
  }

  if (skippedMissingKey > 0) {
    console.warn(
      `WARNING: ${skippedMissingKey} encrypted DSR record(s) in ${logPath} were skipped because ` +
        'RECORD_ENCRYPTION_KEY is not configured. Set it to load existing records; without it, ' +
        'new writes fall back to plaintext (pilot mode only).',
    );
  }
  if (skippedUndecodable > 0) {
    console.warn(
      `WARNING: ${skippedUndecodable} encrypted DSR record(s) in ${logPath} could not be decoded ` +
        'with the configured key — the key may have changed or the data may be corrupt.',
    );
  }
  if (skippedPlaintext > 0) {
    console.warn(
      `WARNING: ${skippedPlaintext} unencrypted DSR record(s) in ${logPath} were refused because ` +
        'plaintext records are not accepted outside pilot mode. Run `npm run records:rekey` to ' +
        'encrypt them under RECORD_ENCRYPTION_KEY.',
    );
  }
}

/**
 * Resolves once the startup load from disk has finished. Submission awaits it
 * so a request recorded during startup is never ordered against a half-loaded
 * cache; tests await it before asserting on records that came from disk.
 */
export function ensureDsrRecordsLoaded(): Promise<void> {
  loadPromise ??= loadDsrRecordsFromDisk();
  return loadPromise;
}

// Hydration is explicit: the entry point (src/index.ts) starts it at boot and
// the first submission awaits it. Module evaluation itself stays free of I/O
// and of log output, so importing this module never races a console spy.

/**
 * Appends a DSR record to the JSONL log through an async stream.
 * Returns false on failure (or an ephemeral serverless filesystem) so the
 * caller can fail closed and never acknowledge a request that was not
 * durably stored.
 */
async function persistDsrRecord(record: DsrRecord): Promise<boolean> {
  const logPath = config.dsrLogPath;
  if (isEphemeralServerlessPath(logPath)) {
    return false;
  }
  try {
    const line = encryptRecordLine(JSON.stringify(record));
    // Belt for M-09: whatever the key state, a record carrying free text is
    // never written as anything but an authenticated envelope. If encryption
    // silently degraded, the write fails instead of the text going to disk.
    if (record.detail !== null && !isEncryptedRecordLine(line)) {
      console.error('[dsr] refusing to persist a free-text detail outside the encrypted envelope');
      return false;
    }
    return await appendJsonlLine(logPath, line);
  } catch {
    // Fail closed: any unexpected error is a failed write, never a rejection
    // that would surface as a hanging request under Express 4.
    return false;
  }
}

/**
 * Validates a DSR submission and creates a record.
 * Returns the record, or null with a reason when the input is invalid.
 */
export async function submitDsr(input: {
  requestType: string;
  contactEmail: string;
  detail?: string | null;
}): Promise<{ ok: true; record: DsrRecord } | { ok: false; reason: string }> {
  await ensureDsrRecordsLoaded();
  if (!DSR_REQUEST_TYPES.includes(input.requestType as DsrRequestType)) {
    return {
      ok: false,
      reason: `requestType must be one of: ${DSR_REQUEST_TYPES.join(', ')}`,
    };
  }
  if (!validateEmail(input.contactEmail)) {
    return { ok: false, reason: 'A valid contact email is required so we can respond' };
  }

  // M-09: the free text is the one field a consumer is invited to fill with
  // anything ("my SSN is ...", "I was diagnosed with ..."). Without a key the
  // whole record would be plaintext, so the request is kept and the text is
  // dropped — a TDPSA intake must still work — and the record says so.
  const requestedDetail = input.detail?.trim() ? input.detail.trim().slice(0, 2000) : null;
  const detail =
    requestedDetail !== null && isRecordEncryptionConfigured() ? requestedDetail : null;
  const detailWithheld = requestedDetail !== null && detail === null;

  const record: DsrRecord = {
    request_id: uuidv4(),
    created_at: new Date().toISOString(),
    request_type: input.requestType as DsrRequestType,
    contact_email: input.contactEmail,
    detail,
    ...(detailWithheld ? { detail_withheld: true } : {}),
    status: 'received',
    // Verification is an operator action, never something the intake creates.
    verified: false,
    verified_at: null,
    fulfilled_at: null,
  };

  // Fail closed: only acknowledge the request if it was durably persisted.
  if (!(await persistDsrRecord(record))) {
    return {
      ok: false,
      reason:
        'We could not securely store your request right now. Please try again later or email ' +
        `${config.dsrEmail} directly.`,
    };
  }

  dsrRecords.set(record.request_id, record);
  return { ok: true, record };
}

/**
 * Reads one DSR record straight from the JSONL log, decrypting each line and
 * taking the LAST line for the id.
 *
 * Verification is append-only: it writes a second line with the same
 * request_id. The bulk loader is last-wins, so a cache-miss lookup must be
 * too — otherwise an evicted record would read back as its original,
 * unverified version and an operator's confirmation would silently vanish.
 */
async function findDsrRecordOnDisk(requestId: string): Promise<DsrRecord | undefined> {
  return findLastJsonlRecord<DsrRecord>(config.dsrLogPath, (line) => {
    const plain = decryptRecordLine(line);
    if (plain === null) return null;
    const parsed = JSON.parse(plain) as Partial<DsrRecord>;
    if (!parsed || parsed.request_id !== requestId) return null;
    return {
      ...parsed,
      verified: parsed.verified === true,
      verified_at: typeof parsed.verified_at === 'string' ? parsed.verified_at : null,
    } as DsrRecord;
  });
}

/**
 * Gets a DSR record by id (admin/debug).
 *
 * Cache-first, log-backed: the cache is bounded, so a miss does not mean the
 * request does not exist. On a miss this streams the JSONL log for the id,
 * caches the match, and returns it — a DSR filed before this process started
 * (or written by another instance) is as findable as one filed here. A
 * TDPSA access/deletion request must never become invisible because of local
 * cache pressure.
 */
export async function getDsrRecord(requestId: string): Promise<DsrRecord | undefined> {
  const cached = dsrRecords.get(requestId);
  if (cached) return cached;

  // If startup hydration is still running, let it finish first; it may already
  // hold the record, and the cache must not be read half-loaded.
  await ensureDsrRecordsLoaded();

  const hydrated = dsrRecords.get(requestId);
  if (hydrated) return hydrated;

  const fromDisk = await findDsrRecordOnDisk(requestId);
  if (fromDisk) {
    dsrRecords.set(requestId, fromDisk);
  }
  return fromDisk;
}

/**
 * Marks a DSR as verified, which is what gives a deletion request the
 * authority to suppress contact (see hasPendingDeletion). Only an admin route
 * may call this: the public intake cannot prove the requester controls the
 * address, so self-verification would defeat the control.
 *
 * Appends an updated record; the loader is last-wins, so the most recent line
 * is authoritative. A failed append returns null and leaves the cached record
 * untouched — a verification must be durable, or it would silently disappear
 * on the next restart.
 */
export async function verifyDsrRecord(requestId: string): Promise<DsrRecord | null> {
  const existing = await getDsrRecord(requestId);
  if (!existing) return null;
  if (existing.verified === true) return existing;

  const verified: DsrRecord = {
    ...existing,
    status: 'verifying',
    verified: true,
    verified_at: new Date().toISOString(),
  };

  if (!(await persistDsrRecord(verified))) {
    return null;
  }

  dsrRecords.set(verified.request_id, verified);
  return verified;
}

/**
 * Re-reads the DSR log after an out-of-band rewrite (erasure or retention),
 * replacing the in-memory cache with what is actually on disk.
 *
 * Erasure runs in the request path of an admin call on the same instance, so a
 * stale cache would keep serving a record whose email was just deleted. The
 * reload is the same loader used at boot, so cache and log cannot disagree
 * about which records exist.
 */
export async function reloadDsrRecords(): Promise<void> {
  dsrRecords.clear();
  loadPromise = loadDsrRecordsFromDisk();
  await loadPromise;
}

/**
 * Lists cached DSR records, oldest first. The JSONL log remains the full
 * record set; this is capped at MAX_CACHED_DSR_RECORDS entries.
 */
export function listDsrRecords(): DsrRecord[] {
  return dsrRecords.values();
}

/**
 * Every DSR in the durable log, de-duplicated by request id.
 *
 * This is the suppression read path for the lead export. The serving cache is
 * bounded, so a missing entry there is not proof no deletion request exists,
 * and treating it as proof would show a suppressed address as contactable.
 * `unreadable` counts lines that could not be decoded so the caller can refuse
 * to guess rather than assume consent. A later line for the same request id
 * supersedes an earlier one, matching the append-only log's semantics.
 */
export async function listAllDsrRecords(): Promise<{
  records: DsrRecord[];
  unreadable: number;
}> {
  const lines = await readJsonlLines(config.dsrLogPath);
  const byId = new Map<string, DsrRecord>();
  let unreadable = 0;

  for (const line of lines) {
    let parsed: DsrRecord | null = null;
    try {
      const plain = decryptRecordLine(line);
      if (plain !== null) {
        parsed = JSON.parse(plain) as DsrRecord;
      }
    } catch {
      parsed = null;
    }
    if (
      !parsed ||
      typeof parsed.request_id !== 'string' ||
      parsed.request_id.length === 0 ||
      typeof parsed.contact_email !== 'string'
    ) {
      unreadable += 1;
      continue;
    }
    byId.set(parsed.request_id, parsed);
  }

  return { records: [...byId.values()], unreadable };
}

/**
 * Clears all DSR records (testing). Also removes the JSONL log file so
 * tests start with a clean slate on disk as well as in memory.
 */
export async function clearAllDsrRecords(): Promise<void> {
  dsrRecords.clear();
  await removeLogFile(config.dsrLogPath);
}
