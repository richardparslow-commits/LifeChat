/**
 * Safe server logging (M-06).
 *
 * A server log is a second, unencrypted copy of whatever reaches it — kept
 * outside the record-encryption boundary, shipped to the platform's log store,
 * and retained on the platform's schedule rather than ours. Two paths used to
 * put visitor text there:
 *
 *   - Express's terminal error handler logged the whole error object. A
 *     body-parser failure embeds a fragment of the rejected body in its
 *     message, so a visitor who typed an address or a diagnosis into a
 *     malformed request wrote it into the log.
 *   - The orchestrator logged the validator's `detail` string, which is built
 *     from the model's own output as the checks grow.
 *
 * Nothing here attempts to scrub text. Redaction by pattern is a losing game
 * against free-form input; the rule is that content never enters the call in the
 * first place. What may be logged is the identity of a failure (`name`, `code`,
 * `status`, `type`), a fingerprint of a payload (`length` plus a truncated
 * SHA-256), and a path only when it has the shape of one of our own routes.
 */

import { createHash } from 'crypto';

/** Facts about a failure that carry no caller or model text. */
export interface ErrorFacts {
  name: string;
  code?: string;
  status?: number;
  type?: string;
}

/**
 * Reduces anything thrown to its identity.
 *
 * `message` and `stack` are deliberately absent: both can embed input (Node's
 * `JSON.parse` quotes the offending text, and a stack carries absolute paths).
 */
export function describeError(error: unknown): ErrorFacts {
  if (!(error instanceof Error)) {
    return { name: `NonError:${typeof error}` };
  }

  const candidate = error as Error & {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  const facts: ErrorFacts = { name: error.name || 'Error' };

  if (typeof candidate.code === 'string' && candidate.code.length > 0) {
    facts.code = candidate.code;
  }
  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined;
  if (status !== undefined) facts.status = status;
  if (typeof candidate.type === 'string' && candidate.type.length > 0) {
    facts.type = candidate.type;
  }
  return facts;
}

/**
 * A machine-readable code, when the value has that shape.
 *
 * Error codes are the one string that may be logged, and only because they
 * come from a closed vocabulary (`api_error_500`, `timeout`). A value carrying
 * spaces, punctuation or a long tail is not a code — it is text that arrived
 * from somewhere else, and it is replaced rather than printed.
 */
export function safeCode(value: string | null | undefined, fallback = 'unrecognized'): string {
  if (typeof value !== 'string') return fallback;
  return /^[a-z][a-z0-9_]{0,47}$/.test(value) ? value : fallback;
}

/**
 * A correlatable stand-in for a string that must not be logged: its length and
 * the first 12 hex characters of its SHA-256. Two identical rejected payloads
 * share a fingerprint, so a pattern can still be recognised without the text.
 */
export function fingerprint(text: string): string {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  return `len=${text.length} sha=${digest}`;
}

/**
 * The request path, when it looks like one of our routes.
 *
 * Callers can put anything in a path segment (the DSR and session routes take a
 * record id), so a path is printed only when every character is one our route
 * table and opaque ids use; anything else is reduced to a fingerprint. Query
 * strings are never part of `req.path` and are not passed here.
 */
export function safeRequestPath(pathname: string): string {
  if (/^\/[A-Za-z0-9/_.:-]{0,120}$/.test(pathname)) return pathname;
  return `unrecognized(${fingerprint(pathname)})`;
}

/** Logs a failure as one JSON line of facts, never the error itself. */
export function logServerError(
  label: string,
  error: unknown,
  context: Record<string, string | number | boolean> = {},
): void {
  console.error(`${label} ${JSON.stringify({ ...describeError(error), ...context })}`);
}
