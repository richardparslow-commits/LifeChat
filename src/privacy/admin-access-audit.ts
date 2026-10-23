/**
 * Admin read-access audit (M-04).
 *
 * The lead export already records that a page of records left the process, but
 * the other operator reads — a conversation history, a DSR status, the system
 * prompt, a RAG query, the session count, the readiness facts — left no trace.
 * "Who read this conversation?" could not be answered, which is the
 * accountability gap GLBA and the TDPSA expect an operator to close.
 *
 * Every entry is PII-free by construction:
 *
 *   - `actor_key_id` is a hash prefix of the configured admin key, never the
 *     key itself, so entries from the same key can be correlated without
 *     turning the log into a credential store.
 *   - `record_id` is an opaque record key (session or DSR id), and only when it
 *     has the shape of one. Anything else — including an address a caller
 *     passed as a session id — is recorded as `unrecognized`, so free text
 *     cannot enter the log through a path parameter.
 *   - the route is a fixed label from `ADMIN_READ_ROUTES`; a query string, a
 *     RAG question, or a record's content is never included.
 *
 * Fail closed: the caller records the read before returning the payload, and a
 * failed write means the read is refused. An unlogged disclosure is treated the
 * same as an unauthorised one. The write is attempted rather than pre-refused
 * on a runtime with ephemeral storage: blocking the readiness read would hide
 * the very condition an operator needs to see, and a read-only filesystem
 * already fails the write. (Durability of that log shares M-05's RPO caveat.)
 */

import { createHash, randomUUID } from 'crypto';

import { config } from '../config/app-config';
import { appendJsonlLine } from '../persistence/jsonl-log';

/** Stable labels for the admin reads that are audited. */
export const ADMIN_READ_ROUTES = [
  'GET /api/admin/health',
  'GET /api/dsr/:requestId',
  'GET /api/rag/search',
  'GET /api/session/:sessionId/history',
  'GET /api/sessions',
  'GET /api/system-prompt',
] as const;

export type AdminReadRoute = (typeof ADMIN_READ_ROUTES)[number];

/** One PII-free admin access line. */
export interface AdminReadEntry {
  audit_id: string;
  event: 'admin_read';
  at: string;
  route: AdminReadRoute;
  /** Opaque session/DSR id, or null for a route with no single record. */
  record_id: string | null;
  /** Hash prefix of the admin key that was presented. */
  actor_key_id: string;
  status: number;
}

/**
 * A record id is only written when it looks like an opaque key. Session ids and
 * DSR ids are alphanumeric with `-`/`_`; an address, a query phrase, or a path
 * containing `@`, `.`, spaces or slashes never matches and is redacted.
 */
const OPAQUE_RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Stable, non-secret identifier for the configured admin key. */
export function adminKeyId(key: string = config.adminApiKey): string {
  const trimmed = key.trim();
  if (!trimmed) return 'unconfigured';
  return createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 12);
}

/** The auditable form of a path parameter. */
export function auditableRecordId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return OPAQUE_RECORD_ID.test(value) ? value : 'unrecognized';
}

/**
 * Appends one admin-read entry. Resolves false on any failure — including a
 * runtime whose storage cannot hold it — so the route can refuse the read.
 */
export async function recordAdminRead(input: {
  route: AdminReadRoute;
  recordId?: string | null;
  status?: number;
  now?: Date;
}): Promise<boolean> {
  const logPath = config.adminAccessLogPath;
  const now = input.now ?? new Date();
  const entry: AdminReadEntry = {
    audit_id: randomUUID(),
    event: 'admin_read',
    at: now.toISOString(),
    route: input.route,
    record_id: auditableRecordId(input.recordId),
    actor_key_id: adminKeyId(),
    status: input.status ?? 200,
  };

  try {
    return await appendJsonlLine(logPath, JSON.stringify(entry));
  } catch {
    return false;
  }
}
