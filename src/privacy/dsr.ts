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
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { dirname as pathDirname } from 'path';
import { config } from '../config/app-config';
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
 * In-memory store for the pilot phase (mirrors session-store pattern).
 * Backed by an append-only JSONL file so records survive process restarts —
 * DSR records are legal artifacts under TDPSA (45-day response SLA) and must
 * not be lost when the server restarts. Only records that were successfully
 * persisted are added to this in-memory store.
 */
const dsrRecords: DsrRecord[] = [];

/** Loads existing DSR records from the JSONL log at startup. */
function loadDsrRecordsFromDisk(): void {
  const logPath = config.dsrLogPath;
  if (!existsSync(logPath)) return;
  let skippedEncrypted = 0;
  try {
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const plain = decryptRecordLine(line);
        if (plain === null) {
          // Encrypted line with no key configured is an operational trap:
          // records silently vanish on startup. Count them so we can warn.
          if (isEncryptedRecordLine(line) && !isRecordEncryptionConfigured()) {
            skippedEncrypted++;
          }
          continue; // cannot decode — skip
        }
        const parsed = JSON.parse(plain) as DsrRecord;
        if (parsed && parsed.request_id && parsed.request_type) {
          dsrRecords.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // Best-effort — don't block startup if the log can't be read
  }
  if (skippedEncrypted > 0) {
    console.warn(
      `WARNING: ${skippedEncrypted} encrypted DSR record(s) in ${logPath} were skipped because ` +
        'RECORD_ENCRYPTION_KEY is not configured. Set it to load existing records; without it, ' +
        'new writes fall back to plaintext (pilot mode only).',
    );
  }
}

// Load persisted records on module init so they survive restarts
loadDsrRecordsFromDisk();

/**
 * Appends a DSR record to the JSONL log.
 * Returns true on success. Returns false (and pushes nothing) on failure so
 * the caller can fail closed and never acknowledge a request that was not
 * durably stored.
 */
function persistDsrRecord(record: DsrRecord): boolean {
  try {
    const logPath = config.dsrLogPath;
    const dir = pathDirname(logPath);
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, `${encryptRecordLine(JSON.stringify(record))}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a DSR submission and creates a record.
 * Returns the record, or null with a reason when the input is invalid.
 */
export function submitDsr(input: {
  requestType: string;
  contactEmail: string;
  detail?: string | null;
}): { ok: true; record: DsrRecord } | { ok: false; reason: string } {
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
  if (!persistDsrRecord(record)) {
    return {
      ok: false,
      reason:
        'We could not securely store your request right now. Please try again later or email ' +
        `${config.dsrEmail} directly.`,
    };
  }

  dsrRecords.push(record);
  return { ok: true, record };
}

/** Gets a DSR record by id (admin/debug). */
export function getDsrRecord(requestId: string): DsrRecord | undefined {
  return dsrRecords.find((r) => r.request_id === requestId);
}

/** Lists all DSR records (admin). */
export function listDsrRecords(): DsrRecord[] {
  return dsrRecords.slice();
}

/**
 * Clears all DSR records (testing). Also removes the JSONL log file so
 * tests start with a clean slate on disk as well as in memory.
 */
export function clearAllDsrRecords(): void {
  dsrRecords.length = 0;
  try {
    if (existsSync(config.dsrLogPath)) {
      unlinkSync(config.dsrLogPath);
    }
  } catch {
    // Best-effort — test cleanup must not throw
  }
}
