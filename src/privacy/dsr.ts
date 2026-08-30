/**
 * Data Subject Request (DSR) Process — TDPSA Consumer Rights (Section 4.7)
 *
 * TDPSA grants Texas consumers the right to access, delete, correct, and
 * port their personal data. This module implements a minimal DSR intake:
 * a validated record is created for each request and an acknowledgment is
 * returned with the TDPSA response window.
 *
 * The consumer-facing contact is served through config.dsrEmail and the
 * disclosure/consent copy; this endpoint is the structured intake route
 * (in-memory for the pilot — persist to the operational lead/CRM store in
 * production, alongside the retention schedule).
 */

import { v4 as uuidv4 } from 'uuid';
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

/** In-memory store for the pilot phase (mirrors session-store pattern). */
const dsrRecords: DsrRecord[] = [];

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

/** Clears all DSR records (testing). */
export function clearAllDsrRecords(): void {
  dsrRecords.length = 0;
}
