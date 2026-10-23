/**
 * Record lifecycle: subject erasure and retention.
 *
 * The consent/lead and DSR logs are append-only, encrypted JSONL files. Until
 * this module existed they were write-only: a deletion request could be
 * accepted and acknowledged but never fulfilled, and no record ever expired.
 * Erasure and retention are rewrites, not appends, because the point is to
 * remove the plaintext rather than supersede it:
 *
 *   1. Every line is decoded and parsed BEFORE anything is written. A line that
 *      cannot be decoded (wrong/missing key) or parsed aborts the operation and
 *      leaves both files untouched — reporting success while PII remains would
 *      be worse than a visible failure.
 *   2. Changed files are replaced atomically on a local volume (write and fsync
 *      a sibling temp file, rename, then fsync the directory) or with a single
 *      object put on Archil. Kept lines are copied unchanged, so their
 *      ciphertext is not rewritten.
 *   3. The subject's lead records are removed outright. Their DSR records are
 *      replaced with tombstones that keep the request id, type, timestamps and
 *      status but drop the address and free-text detail, so the deletion itself
 *      remains auditable without retaining the PII.
 *   4. A PII-free audit line is appended to ERASURE_LOG_PATH: counts, times and
 *      the request id only.
 *   5. Both in-memory caches are reloaded, so the process stops serving the
 *      records it just deleted.
 *
 * Authority comes from the DSR, never from the caller's arguments: erasure
 * takes a request id, requires that request to be a *verified deletion*, and
 * derives the address from the stored record. A caller cannot use one verified
 * request to erase somebody else's data.
 */

import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { config, isRecordStorageSafe } from '../config/app-config';
import { isArchilStorageConfigured, readArchilJsonlLines } from '../archil/disk';
import { appendJsonlLine, replaceJsonlLines } from '../persistence/jsonl-log';
import {
  decryptRecordLine,
  encryptRecordLine,
  isLegacyPlaintextRecordAllowed,
  isLegacyPlaintextRecordLine,
  isRecordEncryptionConfigured,
} from './record-encryption';
import {
  DSR_REQUEST_TYPES,
  ERASED_CONTACT_MARKER,
  getDsrRecord,
  reloadDsrRecords,
  type DsrRecord,
  type DsrRequestType,
} from './dsr';
import { reloadLeadRecords } from '../consent/consent-model';

/** Stable failure classes, safe to map to HTTP status codes. */
export type ErasureErrorCode =
  | 'storage_unavailable'
  | 'request_not_found'
  | 'not_a_deletion'
  | 'not_verified'
  | 'already_fulfilled'
  | 'undecodable_record'
  | 'malformed_record'
  | 'write_failed';

/**
 * A lifecycle operation that did not complete. The message is safe to show an
 * operator: it names files and failure classes, never record content.
 */
export class ErasureIncompleteError extends Error {
  constructor(
    public readonly code: ErasureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ErasureIncompleteError';
  }
}

export interface ErasureReceipt {
  requestId: string;
  erasedAt: string;
  leadRecordsErased: number;
  dsrRecordsRedacted: number;
  auditRecorded: boolean;
}

export interface RetentionReceipt {
  dryRun: boolean;
  cutoff: string;
  retentionDays: number;
  leadRecordsRemoved: number;
  dsrRecordsRemoved: number;
  /** Records without a parseable timestamp are never deleted automatically. */
  undatedRecordsKept: number;
  auditRecorded: boolean;
}

/** Reads a log's non-empty lines from local disk or the Archil disk. */
async function readLogLines(filePath: string): Promise<string[]> {
  if (isArchilStorageConfigured()) {
    return readArchilJsonlLines(filePath);
  }
  try {
    const source = await readFile(filePath, 'utf8');
    return source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new ErasureIncompleteError(
      'storage_unavailable',
      `could not read ${filePath}; no records were changed`,
    );
  }
}

/**
 * Replaces a log's contents through the shared durable rewrite (M-05): a
 * sibling temp file is written and fsynced, renamed over the original, and the
 * directory is fsynced so a crash cannot resurrect the erased version.
 */
async function replaceLogLines(filePath: string, lines: readonly string[]): Promise<void> {
  if (!(await replaceJsonlLines(filePath, lines))) {
    throw new ErasureIncompleteError(
      'write_failed',
      `could not replace ${filePath}; the log was left unchanged`,
    );
  }
}

/** Decodes one line, failing closed rather than guessing at its contents. */
function decodeRecord(line: string, filePath: string): Record<string, unknown> {
  const plain = decryptRecordLine(line);
  if (plain === null) {
    if (isLegacyPlaintextRecordLine(line) && !isLegacyPlaintextRecordAllowed()) {
      throw new ErasureIncompleteError(
        'undecodable_record',
        `a record in ${filePath} is unencrypted, and plaintext records are refused outside ` +
          'pilot mode; run `npm run records:rekey` to encrypt it and retry. No records were changed.',
      );
    }
    const keyState = isRecordEncryptionConfigured()
      ? 'with the configured RECORD_ENCRYPTION_KEY'
      : 'because RECORD_ENCRYPTION_KEY is not configured';
    throw new ErasureIncompleteError(
      'undecodable_record',
      `a record in ${filePath} could not be decoded ${keyState}; restore the key and retry. No records were changed.`,
    );
  }
  try {
    const parsed = JSON.parse(plain) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ErasureIncompleteError(
      'malformed_record',
      `a record in ${filePath} is not valid JSON; no records were changed.`,
    );
  }
}

function normalizedEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Removes every lead record whose address matches. Returns the kept lines and
 * the number removed.
 */
function eraseLeadRecords(
  lines: readonly string[],
  target: string,
): { kept: string[]; erased: number } {
  const kept: string[] = [];
  let erased = 0;

  for (const line of lines) {
    const record = decodeRecord(line, config.leadLogPath);
    const address = normalizedEmail(record.email);
    if (address === '') {
      kept.push(line);
      continue;
    }
    if (address === target) {
      erased += 1;
      continue;
    }
    kept.push(line);
  }

  return { kept, erased };
}

/**
 * Replaces the subject's DSR records with PII-free tombstones.
 *
 * The authorizing request becomes `fulfilled`; other requests keep their
 * status so an open access/correction request is not silently marked done.
 */
function tombstoneDsrRecords(
  lines: readonly string[],
  target: string,
  authorizingRequestId: string,
  fulfilledAt: string,
): { kept: string[]; redacted: number } {
  const kept: string[] = [];
  const seenRequestIds = new Set<string>();
  let redacted = 0;

  for (const line of lines) {
    const record = decodeRecord(line, config.dsrLogPath);
    const address = normalizedEmail(record.contact_email);

    if (address !== target) {
      kept.push(line);
      continue;
    }

    const requestId = typeof record.request_id === 'string' ? record.request_id : '';
    const requestType = record.request_type;
    const createdAt = typeof record.created_at === 'string' ? record.created_at : '';
    if (
      requestId === '' ||
      createdAt === '' ||
      !DSR_REQUEST_TYPES.includes(requestType as DsrRequestType)
    ) {
      throw new ErasureIncompleteError(
        'malformed_record',
        `a DSR record in ${config.dsrLogPath} is missing its id, type or timestamp; ` +
          'no records were changed.',
      );
    }

    const authorizing = requestId === authorizingRequestId;
    const tombstone: DsrRecord = {
      request_id: requestId,
      created_at: createdAt,
      request_type: requestType as DsrRequestType,
      contact_email: ERASED_CONTACT_MARKER,
      detail: null,
      status: authorizing ? 'fulfilled' : normalizedStatus(record.status),
      verified: record.verified === true,
      verified_at: typeof record.verified_at === 'string' ? record.verified_at : null,
      fulfilled_at: authorizing
        ? fulfilledAt
        : typeof record.fulfilled_at === 'string'
          ? record.fulfilled_at
          : null,
    };

    kept.push(encryptRecordLine(JSON.stringify(tombstone)));
    // Verification appends a second line for the same request; count the
    // record once, not once per line.
    if (!seenRequestIds.has(requestId)) {
      seenRequestIds.add(requestId);
      redacted += 1;
    }
  }

  return { kept, redacted };
}

/** Keeps only the three statuses this system defines. */
function normalizedStatus(value: unknown): DsrRecord['status'] {
  return value === 'verifying' || value === 'fulfilled' ? value : 'received';
}

/** Appends one PII-free audit entry. Never throws. */
async function recordAudit(entry: Record<string, unknown>): Promise<boolean> {
  try {
    return await appendJsonlLine(config.erasureLogPath, JSON.stringify(entry));
  } catch {
    return false;
  }
}

/**
 * Fulfils a verified deletion request.
 *
 * Throws `ErasureIncompleteError` with a stable code; the admin route maps
 * those codes to 404/409/503/500. On success the receipt is returned after the
 * audit line is attempted and the caches are reloaded.
 */
export async function eraseSubject(input: {
  requestId: string;
  now?: Date;
}): Promise<ErasureReceipt> {
  if (!isRecordStorageSafe()) {
    throw new ErasureIncompleteError(
      'storage_unavailable',
      'erasure is unavailable on this runtime because durable storage is not configured',
    );
  }

  const request = await getDsrRecord(input.requestId);
  if (!request) {
    throw new ErasureIncompleteError('request_not_found', 'no DSR exists with that request id');
  }
  if (request.request_type !== 'deletion') {
    throw new ErasureIncompleteError(
      'not_a_deletion',
      'only a deletion request can authorise an erasure',
    );
  }
  if (request.verified !== true) {
    throw new ErasureIncompleteError(
      'not_verified',
      'the deletion request must be verified before it can erase records',
    );
  }
  if (request.status === 'fulfilled' || request.contact_email === ERASED_CONTACT_MARKER) {
    throw new ErasureIncompleteError(
      'already_fulfilled',
      'this deletion request has already been fulfilled',
    );
  }

  const target = normalizedEmail(request.contact_email);
  if (target === '') {
    throw new ErasureIncompleteError('not_verified', 'the deletion request has no contact address');
  }

  const fulfilledAt = (input.now ?? new Date()).toISOString();

  // Plan every rewrite before writing either file: a decode failure on the
  // second log must not leave the first one erased.
  const leadLines = await readLogLines(config.leadLogPath);
  const dsrLines = await readLogLines(config.dsrLogPath);

  const leads = eraseLeadRecords(leadLines, target);
  const dsrs = tombstoneDsrRecords(dsrLines, target, request.request_id, fulfilledAt);

  if (leads.erased > 0) {
    await replaceLogLines(config.leadLogPath, leads.kept);
  }
  if (dsrs.redacted > 0) {
    await replaceLogLines(config.dsrLogPath, dsrs.kept);
  }

  const auditRecorded = await recordAudit({
    event: 'subject_erasure',
    audit_id: randomUUID(),
    request_id: request.request_id,
    erased_at: fulfilledAt,
    lead_records_erased: leads.erased,
    dsr_records_redacted: dsrs.redacted,
  });

  // The deletion is durable at this point; reload so this process stops
  // serving the erased records. A reload failure must not turn a completed
  // deletion into an error response.
  await reloadLeadRecords().catch(() => undefined);
  await reloadDsrRecords().catch(() => undefined);

  return {
    requestId: request.request_id,
    erasedAt: fulfilledAt,
    leadRecordsErased: leads.erased,
    dsrRecordsRedacted: dsrs.redacted,
    auditRecorded,
  };
}

/** Parses a record timestamp; null when absent or unparseable. */
function recordTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Removes records older than the configured retention period.
 *
 * Leads expire by `created_at`. DSR records expire only once they are
 * `fulfilled` tombstones — an open request is evidence of an outstanding legal
 * obligation, so it is never swept. Records without a parseable timestamp are
 * kept: expiry cannot be proven, and deletion is irreversible.
 *
 * `dryRun` computes the counts without writing, auditing or reloading.
 */
export async function sweepExpiredRecords(options: {
  now?: Date;
  retentionDays?: number;
  dryRun?: boolean;
}): Promise<RetentionReceipt> {
  if (!isRecordStorageSafe()) {
    throw new ErasureIncompleteError(
      'storage_unavailable',
      'the retention sweep is unavailable on this runtime because durable storage is not configured',
    );
  }

  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? config.dataRetentionDays;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new ErasureIncompleteError('write_failed', 'retentionDays must be a positive number');
  }

  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs).toISOString();
  const dryRun = options.dryRun === true;

  const leadLines = await readLogLines(config.leadLogPath);
  const dsrLines = await readLogLines(config.dsrLogPath);

  const keptLeads: string[] = [];
  let leadRecordsRemoved = 0;
  let undatedRecordsKept = 0;

  for (const line of leadLines) {
    const record = decodeRecord(line, config.leadLogPath);
    const createdAt = recordTimestamp(record.created_at);
    if (createdAt === null) {
      undatedRecordsKept += 1;
      keptLeads.push(line);
      continue;
    }
    if (createdAt < cutoffMs) {
      leadRecordsRemoved += 1;
      continue;
    }
    keptLeads.push(line);
  }

  const keptDsrs: string[] = [];
  let dsrRecordsRemoved = 0;

  for (const line of dsrLines) {
    const record = decodeRecord(line, config.dsrLogPath);
    const createdAt = recordTimestamp(record.created_at);
    const fulfilled = record.status === 'fulfilled';
    if (createdAt === null) {
      if (fulfilled) undatedRecordsKept += 1;
      keptDsrs.push(line);
      continue;
    }
    if (fulfilled && createdAt < cutoffMs) {
      dsrRecordsRemoved += 1;
      continue;
    }
    keptDsrs.push(line);
  }

  let auditRecorded = false;

  if (!dryRun) {
    if (leadRecordsRemoved > 0) {
      await replaceLogLines(config.leadLogPath, keptLeads);
    }
    if (dsrRecordsRemoved > 0) {
      await replaceLogLines(config.dsrLogPath, keptDsrs);
    }

    auditRecorded = await recordAudit({
      event: 'retention_sweep',
      audit_id: randomUUID(),
      swept_at: now.toISOString(),
      cutoff,
      retention_days: retentionDays,
      lead_records_removed: leadRecordsRemoved,
      dsr_records_removed: dsrRecordsRemoved,
      undated_records_kept: undatedRecordsKept,
    });

    if (leadRecordsRemoved > 0 || dsrRecordsRemoved > 0) {
      await reloadLeadRecords().catch(() => undefined);
      await reloadDsrRecords().catch(() => undefined);
    }
  }

  return {
    dryRun,
    cutoff,
    retentionDays,
    leadRecordsRemoved,
    dsrRecordsRemoved,
    undatedRecordsKept,
    auditRecorded,
  };
}
