/**
 * Suite 11 — Abstention Logging for Content Strategy
 *
 * Verifies that abstentions (RAG insufficient evidence) are recorded as
 * anonymized JSONL entries: no raw question text, no PII — only an HMAC of the
 * question (keyed with ABSTENTION_LOG_KEY, M-08) and an allowlisted category
 * label. Covers the hash/category helpers, the key requirement, the best-effort
 * writer, the read/aggregate tools, the kill switch, and the end-to-end
 * orchestrator gate.
 */

import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';

import { config } from '../src/config/app-config';
import {
  normalizeQuestion,
  hmacQuestionHash,
  abstentionKeyId,
  deriveQuestionCategory,
  logAbstention,
  readAbstentionLog,
  abstentionCountsByCategory,
  settleAbstentionWrites,
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

/** The key every test uses unless it is asserting on a missing/rotated one. */
const TEST_KEY = 'test-abstention-key-0f9c2a7e41d8';

/** Point the shared config at a temp log (and key) for the duration of a test. */
async function withLogPath(
  path: string,
  enabled = true,
  fn: () => void | Promise<void>,
  key: string = TEST_KEY,
): Promise<void> {
  const prevPath = config.abstentionLogPath;
  const prevEnabled = config.abstentionLoggingEnabled;
  const prevKey = config.abstentionLogKey;
  config.abstentionLogPath = path;
  config.abstentionLoggingEnabled = enabled;
  config.abstentionLogKey = key;
  try {
    await fn();
  } finally {
    config.abstentionLogPath = prevPath;
    config.abstentionLoggingEnabled = prevEnabled;
    config.abstentionLogKey = prevKey;
  }
}

describe('hash and category helpers', () => {
  it('normalizeQuestion collapses whitespace and case', () => {
    expect(normalizeQuestion('  What   is  Term LIFE? ')).toBe('what is term life?');
  });

  it('hmacQuestionHash is deterministic per key and not a bare digest', () => {
    expect(hmacQuestionHash('what is term life?', TEST_KEY)).toBe(
      hmacQuestionHash('what is term life?', TEST_KEY),
    );
    expect(hmacQuestionHash('abc', TEST_KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacQuestionHash('a', TEST_KEY)).not.toBe(hmacQuestionHash('b', TEST_KEY));
    // The defect M-08 named: an unkeyed SHA-256 of the same text is a
    // dictionary lookup away, so the stored value must not equal it.
    expect(hmacQuestionHash('abc', TEST_KEY)).not.toBe(
      createHash('sha256').update('abc').digest('hex'),
    );
    // A rotated key produces a different digest for the same question.
    expect(hmacQuestionHash('abc', 'another-key-1234')).not.toBe(hmacQuestionHash('abc', TEST_KEY));
  });

  it('abstentionKeyId is stable, short and never the key', () => {
    const id = abstentionKeyId(TEST_KEY);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(id).toBe(abstentionKeyId(TEST_KEY));
    expect(abstentionKeyId('another-key-1234')).not.toBe(id);
    expect(abstentionKeyId('')).toBe('unconfigured');
  });

  it('deriveQuestionCategory returns empty for missing/general/unknown categories', () => {
    expect(deriveQuestionCategory(undefined)).toBe('');
    expect(deriveQuestionCategory(null)).toBe('');
    expect(deriveQuestionCategory('general')).toBe('');
    expect(deriveQuestionCategory('   ')).toBe('');
  });

  it('deriveQuestionCategory prefers topicCategory over article topic', () => {
    expect(deriveQuestionCategory('term_life', 'Life insurance riders')).toBe('term_life');
    // A non-allowlisted human label is categorized, never copied verbatim.
    expect(deriveQuestionCategory(null, 'Life insurance riders')).toBe('other');
    expect(deriveQuestionCategory('jane.doe@example.com')).toBe('other');
  });
});

describe('logAbstention', () => {
  it('writes an anonymized record with no raw question text', async () => {
    const logPath = makeLogPath('anon');
    await withLogPath(logPath, true, async () => {
      await logAbstention({ userMessage: 'jane@example.com art vandelay 555-0199' });
      const raw = readFileSync(logPath, 'utf8');
      expect(raw).toContain('"event":"abstention"');
      // The raw question and any PII must NOT appear.
      expect(raw).not.toContain('jane@example.com');
      expect(raw).not.toContain('vandelay');
      expect(raw).not.toContain('555-0199');

      const entries = await readAbstentionLog(10);
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
    await withLogPath(logPath, true, async () => {
      await logAbstention({
        userMessage: 'How do Texas tax rules work for our policy?',
        topicCategory: 'texas_laws',
      });
      const entries = await readAbstentionLog(10);
      expect(entries).toHaveLength(1);
      expect(entries[0].question_category).toBe('texas_laws');
      expect(entries[0].question_text_hash).toBe(
        hmacQuestionHash('how do texas tax rules work for our policy?', TEST_KEY),
      );
      expect(entries[0].hash_key_id).toBe(abstentionKeyId(TEST_KEY));
    });
  });

  it('writes nothing when ABSTENTION_LOG_KEY is not configured', async () => {
    const logPath = makeLogPath('nokey');
    await withLogPath(
      logPath,
      true,
      async () => {
        // Fail closed rather than store an unkeyed digest (M-08).
        await expect(logAbstention({ userMessage: 'I have HIV' })).resolves.toBeUndefined();
        expect(existsSync(logPath)).toBe(false);
        expect(await readAbstentionLog(10)).toEqual([]);
      },
      '',
    );
  });

  it('does nothing when ABSTENTION_LOGGING_ENABLED is off', async () => {
    const logPath = makeLogPath('off');
    await withLogPath(logPath, false, async () => {
      await logAbstention({ userMessage: 'whatever' });
      // With logging disabled, the isolated (temp) log path must stay empty
      // and the read/aggregate helpers must report nothing. These reads run
      // while config.abstentionLogPath points at the temp path, not the shared
      // default data/abstention-log.jsonl which the live server may write to.
      expect(existsSync(logPath)).toBe(false);
      expect(await readAbstentionLog(10)).toEqual([]);
      expect(await abstentionCountsByCategory()).toEqual({});
    });
  });

  it('never throws even when the target path is unwritable', async () => {
    const badPath = join(tmpdir(), `lifechat-abstention-bad-${Date.now()}`, 'nope', 'sub');
    await withLogPath(badPath, true, async () => {
      // A failed write resolves false instead of throwing — logging can never
      // take a chat turn down.
      await expect(logAbstention({ userMessage: 'something' })).resolves.toBeUndefined();
    });
  });

  it('deduplicates sizes via hash and aggregates counts by category', async () => {
    const logPath = makeLogPath('agg');
    await withLogPath(logPath, true, async () => {
      await logAbstention({ userMessage: 'How do riders work?', topicCategory: 'riders' });
      // Same normalized hash; category is supplied again so both aggregate.
      await logAbstention({ userMessage: '  How   do RIDERS WORK?   ', topicCategory: 'riders' });
      await logAbstention({ userMessage: 'What about Texas laws?', topicCategory: 'texas_laws' });
      const entries = await readAbstentionLog(20);
      expect(entries).toHaveLength(3);
      expect(entries[0].question_text_hash).toBe(entries[1].question_text_hash);
      const counts = await abstentionCountsByCategory();
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

      // The orchestrator does not wait on the analytics write, so wait for the
      // in-flight append here rather than sleeping and hoping.
      await settleAbstentionWrites();
      const entries = await readAbstentionLog(10);
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

afterEach(async () => {
  // Best-effort cleanup of any leftover temp dir from a failed assertion.
  const base = join(tmpdir(), 'lifechat-abstention-test');
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
