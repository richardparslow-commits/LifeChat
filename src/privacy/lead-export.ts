/**
 * Admin lead export (SEC-08).
 *
 * The records this system collects are legal consent artifacts, but until this
 * module existed they were write-only from the API: the broker could not read a
 * lead without filesystem access *and* the record-encryption key. A handoff
 * that cannot reach the lead it promised is inert, so this is the read path.
 *
 * The rules that shape it:
 *
 *   1. Admin-only and expensive by nature: the route is behind `x-admin-key`,
 *      and the page size is bounded (`limit` 1–100) so one request cannot pull
 *      the whole log into a response.
 *   2. Complete or refused. `listAllLeadRecords()` reports lines it could not
 *      decode; if any exist the export fails rather than returning a subset
 *      that looks authoritative. A missing or wrong key is therefore visible,
 *      never an empty page.
 *   3. Every export is audited *before* the data is returned. The audit line
 *      carries the page size, offsets, record ids and suppression count — never
 *      a name, address, phone number, or medical detail. If the audit write
 *      fails the export is refused, so PII cannot leave unlogged.
 *   4. Suppression travels with the data. A lead whose address is covered by a
 *      *verified* deletion request is returned with `contactable: false` and a
 *      reason, so the broker sees the restriction in the same place they see
 *      the address. Unverified requests confer no authority (SEC-06).
 */

import { randomUUID } from 'crypto';

import { config, isRecordStorageSafe } from '../config/app-config';
import { listAllLeadRecords, type LeadRecord } from '../consent/consent-model';
import { appendJsonlLine } from '../persistence/jsonl-log';
import { ERASED_CONTACT_MARKER, listAllDsrRecords } from './dsr';

/** Page size used when the caller does not pass `limit`. */
export const LEAD_EXPORT_DEFAULT_LIMIT = 50;

/** Upper bound on one page, so an export is never an accidental bulk dump. */
export const LEAD_EXPORT_MAX_LIMIT = 100;

/** Why a lead may not be contacted, or null when nothing suppresses it. */
export type LeadSuppression = 'verified_deletion' | null;

/** A lead record plus the contact decision that applies to it. */
export interface ExportedLead extends LeadRecord {
  /** False when a verified deletion request covers this address. */
  contactable: boolean;
  suppression: LeadSuppression;
}

/** One page of the operator export. */
export interface LeadExportReceipt {
  exportedAt: string;
  /** Id of the audit line written for this export. */
  auditId: string;
  /** Records in this page. */
  count: number;
  /** Records in the whole export, across every page. */
  total: number;
  /** Offset for the next page, or null when this page is the last. */
  nextCursor: string | null;
  leads: ExportedLead[];
}

export type LeadExportErrorCode =
  | 'invalid_limit'
  | 'invalid_cursor'
  | 'storage_unavailable'
  | 'records_unreadable'
  | 'audit_unavailable'
  | 'export_failed';

/** Stable HTTP status for each failure class. */
export const LEAD_EXPORT_HTTP_STATUS: Record<LeadExportErrorCode, number> = {
  invalid_limit: 400,
  invalid_cursor: 400,
  storage_unavailable: 503,
  records_unreadable: 500,
  audit_unavailable: 503,
  export_failed: 500,
};

/**
 * A refusal the route can report safely: the message names the failure class
 * and never includes record content.
 */
export class LeadExportError extends Error {
  constructor(
    readonly code: LeadExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LeadExportError';
  }
}

function invalidLimit(): LeadExportError {
  return new LeadExportError(
    'invalid_limit',
    `limit must be an integer between 1 and ${LEAD_EXPORT_MAX_LIMIT}`,
  );
}

function invalidCursor(): LeadExportError {
  return new LeadExportError(
    'invalid_cursor',
    'cursor must be an offset returned by this endpoint',
  );
}

/**
 * Parses `limit`. Express query values may be arrays or objects when a caller
 * repeats a key; anything that is not a plain digit string is refused rather
 * than coerced, so a malformed query cannot silently change the page size.
 */
function parseLimit(raw: unknown): number {
  if (raw === undefined) return LEAD_EXPORT_DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) throw invalidLimit();
  const limit = Number(raw);
  if (limit < 1 || limit > LEAD_EXPORT_MAX_LIMIT) throw invalidLimit();
  return limit;
}

/** Parses the numeric offset cursor; defaults to the first page. */
function parseCursor(raw: unknown): number {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || !/^\d{1,7}$/.test(raw)) throw invalidCursor();
  return Number(raw);
}

/**
 * The addresses covered by a verified deletion request.
 *
 * Read from the log rather than the serving cache: suppression that silently
 * disappears under cache pressure would show a protected address as
 * contactable. Tombstoned DSRs carry the erased marker instead of an address
 * and therefore suppress nothing — the lead they referred to is already gone.
 * Only a verified request has authority; intake alone proves nothing.
 */
async function suppressedAddresses(): Promise<Set<string>> {
  const { records, unreadable } = await listAllDsrRecords().catch(() => {
    throw new LeadExportError('export_failed', 'the deletion-request log could not be read');
  });
  if (unreadable > 0) {
    throw new LeadExportError(
      'records_unreadable',
      `${unreadable} deletion-request line(s) could not be decoded, so contact suppression ` +
        'cannot be determined; refusing to return the export',
    );
  }

  const addresses = new Set<string>();
  for (const record of records) {
    if (record.request_type !== 'deletion' || record.verified !== true) continue;
    const address = record.contact_email.trim().toLowerCase();
    if (!address || address === ERASED_CONTACT_MARKER) continue;
    addresses.add(address);
  }
  return addresses;
}

/**
 * Returns one page of lead records, newest first, with an audit line written
 * for the access.
 *
 * @param input.limit  Page size (1–100, default 50); validated as untrusted.
 * @param input.cursor Offset returned as `nextCursor` by a previous call.
 * @param input.now    Injectable clock for tests.
 */
export async function exportLeads(
  input: { limit?: unknown; cursor?: unknown; now?: Date } = {},
): Promise<LeadExportReceipt> {
  // On a serverless runtime without durable storage the log is not there to
  // export; answering with an empty page would misrepresent that as "no leads".
  if (!isRecordStorageSafe()) {
    throw new LeadExportError(
      'storage_unavailable',
      'lead records are not available on this runtime because durable storage is not configured',
    );
  }

  const limit = parseLimit(input.limit);
  const offset = parseCursor(input.cursor);

  const { records, unreadable } = await listAllLeadRecords().catch(() => {
    throw new LeadExportError('export_failed', 'the lead log could not be read');
  });
  if (unreadable > 0) {
    throw new LeadExportError(
      'records_unreadable',
      `${unreadable} record line(s) could not be decoded with the configured key; ` +
        'refusing to return an incomplete export',
    );
  }

  const suppressed = await suppressedAddresses();
  const page: ExportedLead[] = records.slice(offset, offset + limit).map((record) => {
    // A parsed record is untrusted data: a hand-edited or corrupt line can
    // carry a non-string email, and one bad record must not fail the page.
    const address = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
    const isSuppressed = address.length > 0 && suppressed.has(address);
    return {
      ...record,
      contactable: !isSuppressed,
      suppression: isSuppressed ? 'verified_deletion' : null,
    };
  });

  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < records.length ? String(nextOffset) : null;
  const now = input.now ?? new Date();
  const auditId = randomUUID();

  // Fail closed: an export that cannot be audited is not served.
  let recorded = false;
  try {
    recorded = await appendJsonlLine(
      config.leadAccessLogPath,
      JSON.stringify({
        audit_id: auditId,
        event: 'lead_export',
        at: now.toISOString(),
        limit,
        offset,
        returned: page.length,
        total: records.length,
        suppressed: page.filter((lead) => !lead.contactable).length,
        lead_ids: page.map((lead) => lead.lead_id),
        more: nextCursor !== null,
      }),
    );
  } catch {
    recorded = false;
  }
  if (!recorded) {
    throw new LeadExportError(
      'audit_unavailable',
      'the export could not be recorded in the access audit log, so it was refused',
    );
  }

  return {
    exportedAt: now.toISOString(),
    auditId,
    count: page.length,
    total: records.length,
    nextCursor,
    leads: page,
  };
}
