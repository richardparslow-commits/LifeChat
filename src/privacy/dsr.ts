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
  findJsonlRecord,
  readJsonlLines,
  removeLogFile,
} from '../persistence/jsonl-log';
import {
  encryptRecordLine,
  decryptRecordLine,
  isEncryptedRecordLine,
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

export interface DsrRecord {
  /** Server-generated UUID */
  request_id: string;
  /** Server timestamp */
  created_at: string;
  request_type: DsrRequestType;
  /** Contact email where the response is sent */
  contact_email: string;
  /** Optional free-text detail — NOT used for analytics, never PII-logged */
  detail: string | null;
  status: 'received';
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
        }
        continue; // cannot decode — skip
      }
      const parsed = JSON.parse(plain) as DsrRecord;
      if (parsed && parsed.request_id && parsed.request_type) {
        dsrRecords.set(parsed.request_id, parsed);
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
    return await appendJsonlLine(logPath, encryptRecordLine(JSON.stringify(record)));
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

  const record: DsrRecord = {
    request_id: uuidv4(),
    created_at: new Date().toISOString(),
    request_type: input.requestType as DsrRequestType,
    contact_email: input.contactEmail,
    detail: input.detail?.trim() ? input.detail.trim().slice(0, 2000) : null,
    status: 'received',
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
 * Reads one DSR record straight from the JSONL log, decrypting each line.
 * Used only when the cache does not hold the id.
 */
async function findDsrRecordOnDisk(requestId: string): Promise<DsrRecord | undefined> {
  return findJsonlRecord<DsrRecord>(config.dsrLogPath, (line) => {
    const plain = decryptRecordLine(line);
    if (plain === null) return null;
    const parsed = JSON.parse(plain) as DsrRecord;
    return parsed && parsed.request_id === requestId ? parsed : null;
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
 * Lists cached DSR records, oldest first. The JSONL log remains the full
 * record set; this is capped at MAX_CACHED_DSR_RECORDS entries.
 */
export function listDsrRecords(): DsrRecord[] {
  return dsrRecords.values();
}

/**
 * Clears all DSR records (testing). Also removes the JSONL log file so
 * tests start with a clean slate on disk as well as in memory.
 */
export async function clearAllDsrRecords(): Promise<void> {
  dsrRecords.clear();
  await removeLogFile(config.dsrLogPath);
}
