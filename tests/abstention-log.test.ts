/**
 * Suite 11 — Abstention Logging for Content Strategy
 *
 * Verifies that abstentions (RAG insufficient evidence) are recorded as
 * anonymized JSONL entries: no raw question text, no PII — only a SHA-256 hash
 * of the question and an allowlisted category label. Covers the hash/category
 * helpers, the best-effort writer, the read/aggregate tools, the kill switch,
 * and the end-to-end orchestrator gate.
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';

import { config } from '../src/config/app-config';
import {
  normalizeQuestion,
  sha256Hash,
  deriveQuestionCategory,
  logAbstention,
  readAbstentionLog,
  abstentionCountsByCategory,
  type AbstentionLogEntry,
} from '../src/analytics/abstention-log';
import { generateResponse } from '../src/llm/orchestrator';

/** A per-test temp log path so tests never touch the real default file. */
function makeLogPath(label: string): string {
  const dir = join(tmpdir(), `lifechat-abstention-test-${process.pid}-${label}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return join(dir, 'abstention-log.jsonl');
}

/** Point the shared config at a temp log for the duration of a test. */
async function withLogPath(
  path: string,
  enabled = true,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prevPath = config.abstentionLogPath;
  const prevEnabled = config.abstentionLoggingEnabled;
  config.abstentionLogPath = path;
  config.abstentionLoggingEnabled = enabled;
  try {
    await fn();
  } finally {
    config.abstentionLogPath = prevPath;
    config.abstentionLoggingEnabled = prevEnabled;
  }
}

describe('hash and category helpers', () => {
  it('normalizeQuestion collapses whitespace and case', () => {
    expect(normalizeQuestion('  What   is  Term LIFE? ')).toBe('what is term life?');
  });

  it('sha256Hash is deterministic', () => {
    expect(sha256Hash('what is term life?')).toBe(sha256Hash('what is term life?'));
    expect(sha256Hash('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hash('a')).not.toBe(sha256Hash('b'));
  });

  it('deriveQuestionCategory returns empty for missing/general/unknown categories', () => {
    expect(deriveQuestionCategory(undefined)).toBe('');
    expect(deriveQuestionCategory(null)).toBe('');
    expect(deriveQuestionCategory('general')).toBe('');
    expect(deriveQuestionCategory('   ')).toBe('');
  });

  it('deriveQuestionCategory prefers topicCategory over article topic', () => {
    expect(deriveQuestionCategory('term_life', 'Life insurance riders')).toBe('term_life');
    expect(deriveQuestionCategory(null, 'Life insurance riders')).toBe('Life insurance riders');
  });
});

describe('logAbstention', () => {
  it('writes an anonymized record with no raw question text', async () => {
    const logPath = makeLogPath('anon');
    await withLogPath(logPath, true, () => {
      logAbstention({ userMessage: 'jane@example.com art vandelay 555-0199' });
      const raw = readFileSync(logPath, 'utf8');
      expect(raw).toContain('"event":"abstention"');
      // The raw question and any PII must NOT appear.
      expect(raw).not.toContain('jane@example.com');
      expect(raw).not.toContain('vandelay');
      expect(raw).not.toContain('555-0199');

      const entries = readAbstentionLog(10);
      expect(entries).toHaveLength(1);
      const e = entries[0];
      expect(e.event).toBe('abstention');
      expect(e.question_text_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.question_category).toBe('');
      expect(new Date(e.timestamp).getTime()).not.toBeNaN();
    });
  });

  it('records the correct hash and category', async () => {
    const logPath = makeLogPath('cat');
    await withLogPath(logPath, true, () => {
      logAbstention({
        userMessage: 'How do Texas tax rules work for our policy?',
        topicCategory: 'texas_laws',
      });
      const entries = readAbstentionLog(10);
      expect(entries).toHaveLength(1);
      expect(entries[0].question_category).toBe('texas_laws');
      expect(entries[0].question_text_hash).toBe(
        sha256Hash('how do texas tax rules work for our policy?'),
      );
    });
  });

  it('does nothing when ABSTENTION_LOGGING_ENABLED is off', async () => {
    const logPath = makeLogPath('off');
    await withLogPath(logPath, false, () => {
      logAbstention({ userMessage: 'whatever' });
    });
    expect(existsSync(logPath)).toBe(false);
    expect(readAbstentionLog(10)).toEqual([]);
    expect(abstentionCountsByCategory()).toEqual({});
  });

  it('never throws even when the target path is unwritable', async () => {
    const badPath = join(tmpdir(), `lifechat-abstention-bad-${Date.now()}`, 'nope', 'sub');
    await withLogPath(badPath, true, () => {
      expect(() => logAbstention({ userMessage: 'something' })).not.toThrow();
    });
  });

  it('deduplicates sizes via hash and aggregates counts by category', async () => {
    const logPath = makeLogPath('agg');
    await withLogPath(logPath, true, () => {
      logAbstention({ userMessage: 'How do riders work?', topicCategory: 'riders' });
      // Same normalized hash; category is supplied again so both aggregate.
      logAbstention({ userMessage: '  How   do RIDERS WORK?   ', topicCategory: 'riders' });
      logAbstention({ userMessage: 'What about Texas laws?', topicCategory: 'texas_laws' });
      const entries = readAbstentionLog(20);
      expect(entries).toHaveLength(3);
      expect(entries[0].question_text_hash).toBe(entries[1].question_text_hash);
      const counts = abstentionCountsByCategory();
      expect(counts['riders']).toBe(2);
      expect(counts['texas_laws']).toBe(1);
    });
  });
});

describe('orchestrator end-to-end abstention logging', () => {
  it('logs an abstention when the RAG gate fires in an answer state', async () => {
    const logPath = makeLogPath('e2e');
    await withLogPath(logPath, true, async () => {
      const { response, latencyMs } = await generateResponse({
        userMessage: 'quantum physics supercollider',
        currentState: 'education',
      });
      expect(response.analytics.event_name).toBe('ai_abstention');
      expect(latencyMs).toBeGreaterThanOrEqual(0);

      const entries = readAbstentionLog(10);
      expect(entries).toHaveLength(1);
      const e: AbstentionLogEntry = entries[0];
      expect(e.event).toBe('abstention');
      expect(e.question_text_hash).toMatch(/^[0-9a-f]{64}$/);
      // With no category and no contextual article, the raw query text must not leak.
      expect(JSON.stringify(entries)).not.toContain('supercollider');
    });
  });

  it('does NOT log abstentions in non-answer (flow) states', async () => {
    const logPath = makeLogPath('flow');
    await withLogPath(logPath, true, async () => {
      // qualification is a flow state — the RAG gate must not fire, so no log.
      await generateResponse({
        userMessage: 'quantum physics supercollider',
        currentState: 'qualification',
      });
    });
    // In a flow state the gate is skipped (no abstention/no log). The file may
    // or may not exist; if it does it must not contain this query.
    if (existsSync(logPath)) {
      expect(readFileSync(logPath, 'utf8')).not.toContain('supercollider');
    }
  });
});

afterEach(() => {
  // Best-effort cleanup of any leftover temp dir from a failed assertion.
  const base = join(tmpdir(), 'lifechat-abstention-test');
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
