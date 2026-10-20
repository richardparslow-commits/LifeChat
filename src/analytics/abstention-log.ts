/**
 * Abstention Logging for Content Strategy (Section 4.13 extension)
 *
 * Every time the RAG layer returns insufficient evidence and the assistant
 * abstains (orchestrator gate), we append one anonymized line to an append-only
 * JSONL file. This feeds the editorial calendar: which topics users ask about
 * that the approved corpus cannot yet answer.
 *
 * Privacy model (no PII is ever written):
 * - The raw question text is NEVER stored. Only a SHA-256 hash of the
 *   normalized text is kept (`question_text_hash`), which supports de-duplication
 *   and re-currence counting without being readable.
 * - The readable dimension is `question_category` — an allowlisted topic label
 *   derived from the existing `topicCategory` where meaningful, never free text
 *   the visitor typed.
 * - Cookie/session ids, names, emails, phones, and URL query strings are never
 *   logged. Only an optional sanitized `article_id` (from the Content Bridge
 *   URL→article map) may appear, and it is not user-specific.
 *
 * Written best-effort: any failure to write is swallowed so logging can never
 * crash a chat turn. Disable with ABSTENTION_LOGGING_ENABLED=false.
 */

import { createHash } from 'crypto';
import { config } from '../config/app-config';
import { appendJsonlLine, readJsonlLines } from '../persistence/jsonl-log';

export interface AbstentionLogEntry {
  event: 'abstention';
  /** Allowlisted topic label; '' when no category could be derived. */
  question_category: string;
  /** SHA-256 hex (64 chars) of the normalized question text. */
  question_text_hash: string;
  /** Sanitized article_id from the Content Bridge, or null. */
  article_id: string | null;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/** Normalizes a question so identical phrasing deduplicates to one hash. */
export function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** SHA-256 hex digest of a string (e.g. the normalized question text). */
export function sha256Hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Derives the allowlisted category used for readable content-strategy analytics.
 * Uses the existing topicCategory when meaningful; otherwise falls back to the
 * contextual article's topic or an empty placeholder. Never the raw query text.
 */
export function deriveQuestionCategory(
  topicCategory?: string | null,
  contextualArticleTopic?: string | null,
): string {
  const candidate = topicCategory || contextualArticleTopic;
  if (!candidate) return '';
  const cleaned = candidate.trim();
  if (!cleaned || cleaned === 'general') return '';
  // Cap length — a category label is never user free text.
  return cleaned.slice(0, 60);
}

/**
 * Writes in flight, so tests and shutdown can wait for them. Entries remove
 * themselves on completion; the set is bounded by concurrent traffic, not by
 * log size.
 */
const pendingWrites = new Set<Promise<void>>();

/**
 * Resolves once every abstention write started so far has finished.
 * The orchestrator fires and forgets (a chat turn must not wait on analytics),
 * so the end-to-end test uses this instead of sleeping.
 */
export async function settleAbstentionWrites(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites]);
  }
}

/**
 * Appends one abstention record to the JSONL log (best-effort, never throws).
 * No-op when ABSTENTION_LOGGING_ENABLED=false.
 *
 * Asynchronous on purpose: the write goes through a stream so an abstention
 * never blocks the chat turn that triggered it. The returned promise resolves
 * when this record is flushed, so a caller that cares can await it; the
 * orchestrator deliberately does not.
 */
export function logAbstention(input: {
  userMessage: string;
  topicCategory?: string | null;
  contextualArticleTopic?: string | null;
  articleId?: string | null;
  timestamp?: string;
}): Promise<void> {
  if (!config.abstentionLoggingEnabled) return Promise.resolve();

  const entry: AbstentionLogEntry = {
    event: 'abstention',
    question_category: deriveQuestionCategory(input.topicCategory, input.contextualArticleTopic),
    question_text_hash: sha256Hash(normalizeQuestion(input.userMessage)),
    article_id: input.articleId ?? null,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };

  // Best-effort only — logging must never break a chat turn. The catch is the
  // belt for anything unexpected, because a turn must never fail on logging.
  const write = appendJsonlLine(config.abstentionLogPath, JSON.stringify(entry))
    .catch(() => undefined)
    .then(() => undefined);
  pendingWrites.add(write);
  void write.then(() => pendingWrites.delete(write));
  return write;
}

/**
 * Reads up to `limit` abstention entries from the log (newest first) for
 * tooling / the editorial calendar. Returns an empty array when logging is
 * disabled or the file doesn't exist yet.
 */
export async function readAbstentionLog(limit = 200): Promise<AbstentionLogEntry[]> {
  if (!config.abstentionLoggingEnabled) return [];
  const lines = await readJsonlLines(config.abstentionLogPath);
  const entries: AbstentionLogEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as AbstentionLogEntry;
      if (parsed && parsed.event === 'abstention') entries.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return entries.slice(-limit);
}

/**
 * Aggregates abstention counts by category — the direct "editorial calendar"
 * feed: which content gaps exist and recur.
 */
export async function abstentionCountsByCategory(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of await readAbstentionLog(10000)) {
    const key = entry.question_category || '(uncategorized)';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
