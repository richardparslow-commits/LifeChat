/**
 * Tests for the Session Conversation History Store
 *
 * Verifies session creation, message storage, turn limits, sensitive
 * data redaction, declined-field tracking, and TTL cleanup.
 */

import {
  getHistory,
  addUserMessage,
  addAssistantMessage,
  markFieldDeclined,
  isFieldDeclined,
  markQualificationOffered,
  wasQualificationOffered,
  markContactOffered,
  wasContactOffered,
  incrementFailures,
  resetFailures,
  getFailureCount,
  clearSession,
  clearAllSessions,
  getActiveSessionCount,
  startSessionCleanup,
  stopSessionCleanup,
} from '../src/llm/session-store';
// Imported to pin the /api/chat aliasing regression: session history feeds
// buildMessages, so a live-array reference would send the current turn twice.
import { buildMessages } from '../src/llm/llm-client';

// Ensure clean state before each test
beforeEach(() => {
  clearAllSessions();
  stopSessionCleanup();
});

afterAll(() => {
  stopSessionCleanup();
});

describe('Session Store — basic message storage', () => {
  test('returns empty array for non-existent session', () => {
    expect(getHistory('nonexistent')).toEqual([]);
  });

  test('stores a user message', () => {
    addUserMessage('s1', 'What is term life insurance?');
    const history = getHistory('s1');
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('What is term life insurance?');
  });

  test('stores an assistant message', () => {
    addAssistantMessage('s2', 'Term life provides coverage for a specific period.');
    const history = getHistory('s2');
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('assistant');
    expect(history[0].content).toContain('Term life');
  });

  test('stores multiple turns in order', () => {
    addUserMessage('s3', 'Question 1');
    addAssistantMessage('s3', 'Answer 1');
    addUserMessage('s3', 'Question 2');
    addAssistantMessage('s3', 'Answer 2');

    const history = getHistory('s3');
    expect(history).toHaveLength(4);
    expect(history[0].content).toBe('Question 1');
    expect(history[1].content).toBe('Answer 1');
    expect(history[2].content).toBe('Question 2');
    expect(history[3].content).toBe('Answer 2');
  });

  test('different sessions have independent histories', () => {
    addUserMessage('session_a', 'Message A');
    addUserMessage('session_b', 'Message B');

    expect(getHistory('session_a')).toHaveLength(1);
    expect(getHistory('session_b')).toHaveLength(1);
    expect(getHistory('session_a')[0].content).toBe('Message A');
    expect(getHistory('session_b')[0].content).toBe('Message B');
  });

  test('getHistory returns a snapshot, not the live array (prevents turn duplication)', () => {
    // Mirrors /api/chat: capture history, then record the current user turn.
    addUserMessage('alias', 'prior question');
    addAssistantMessage('alias', 'prior answer');

    const history = getHistory('alias');
    // Appending to the session must NOT mutate the already-returned history.
    addUserMessage('alias', '__CURRENT__');

    expect(history).toHaveLength(2);
    expect(history.some((m) => m.content.includes('__CURRENT__'))).toBe(false);
    expect(getHistory('alias')).toHaveLength(3);
  });

  test('buildMessages sees the current turn exactly once after capture-then-record', () => {
    addUserMessage('e2e', 'prior question');
    addAssistantMessage('e2e', 'prior answer');

    // Exact /api/chat ordering (post-fix): read history first, then record.
    const conversationHistory = getHistory('e2e');
    addUserMessage('e2e', '__CURRENT__');

    const msgs = buildMessages({
      systemPrompt: 'SYS',
      ragContext: '',
      userMessage: '__CURRENT__',
      conversationHistory,
    });
    const occurrences = msgs.filter((m) => m.content?.includes('__CURRENT__')).length;
    expect(occurrences).toBe(1);
  });
});

describe('Session Store — sensitive data redaction', () => {
  test('redacts user message when isSensitive is true', () => {
    addUserMessage('s4', 'I have diabetes and my SSN is 123-45-6789', true);
    const history = getHistory('s4');
    expect(history).toHaveLength(1);
    expect(history[0].content).not.toContain('diabetes');
    expect(history[0].content).not.toContain('123-45-6789');
    expect(history[0].content).toContain('REDACTED');
  });

  test('does not redact when isSensitive is false (default)', () => {
    addUserMessage('s5', 'What is term life insurance?', false);
    const history = getHistory('s5');
    expect(history[0].content).toBe('What is term life insurance?');
  });

  test('stores only assistant_message text, never lead_data or consent', () => {
    addAssistantMessage('s6', 'Here is my answer');
    const history = getHistory('s6');
    // The content should be just the message text — no JSON, no lead fields
    expect(history[0].content).toBe('Here is my answer');
    expect(history[0].content).not.toContain('lead_data');
    expect(history[0].content).not.toContain('consent');
  });
});

describe('Session Store — turn limits', () => {
  test('enforces max 20 turns by dropping oldest', () => {
    // Add 25 turns
    for (let i = 0; i < 25; i++) {
      addUserMessage('s7', `User message ${i}`);
      addAssistantMessage('s7', `Assistant response ${i}`);
    }

    const history = getHistory('s7');
    // Should be capped at 20
    expect(history.length).toBeLessThanOrEqual(20);
    // The oldest messages should have been dropped
    expect(history[0].content).not.toContain('User message 0');
  });
});

describe('Session Store — declined field tracking', () => {
  test('marks a field as declined', () => {
    markFieldDeclined('s8', 'phone');
    expect(isFieldDeclined('s8', 'phone')).toBe(true);
  });

  test('returns false for non-declined field', () => {
    expect(isFieldDeclined('s9', 'email')).toBe(false);
  });

  test('tracks multiple declined fields', () => {
    markFieldDeclined('s10', 'phone');
    markFieldDeclined('s10', 'email');
    expect(isFieldDeclined('s10', 'phone')).toBe(true);
    expect(isFieldDeclined('s10', 'email')).toBe(true);
    expect(isFieldDeclined('s10', 'first_name')).toBe(false);
  });
});

describe('Session Store — qualification/contact offer tracking', () => {
  test('marks qualification as offered', () => {
    expect(wasQualificationOffered('s11')).toBe(false);
    markQualificationOffered('s11');
    expect(wasQualificationOffered('s11')).toBe(true);
  });

  test('marks contact as offered', () => {
    expect(wasContactOffered('s12')).toBe(false);
    markContactOffered('s12');
    expect(wasContactOffered('s12')).toBe(true);
  });
});

describe('Session Store — failure tracking', () => {
  test('increments failure count', () => {
    expect(getFailureCount('s13')).toBe(0);
    incrementFailures('s13');
    incrementFailures('s13');
    expect(getFailureCount('s13')).toBe(2);
  });

  test('resets failure count', () => {
    incrementFailures('s14');
    incrementFailures('s14');
    incrementFailures('s14');
    expect(getFailureCount('s14')).toBe(3);
    resetFailures('s14');
    expect(getFailureCount('s14')).toBe(0);
  });
});

describe('Session Store — session management', () => {
  test('clearSession removes all history for a session', () => {
    addUserMessage('s15', 'Hello');
    addAssistantMessage('s15', 'Hi there');
    expect(getHistory('s15')).toHaveLength(2);

    clearSession('s15');
    expect(getHistory('s15')).toEqual([]);
  });

  test('clearSession also clears declined fields and offer flags', () => {
    markFieldDeclined('s16', 'phone');
    markQualificationOffered('s16');
    clearSession('s16');
    expect(isFieldDeclined('s16', 'phone')).toBe(false);
    expect(wasQualificationOffered('s16')).toBe(false);
  });

  test('getActiveSessionCount reflects active sessions', () => {
    const initial = getActiveSessionCount();
    addUserMessage('s17', 'Test');
    expect(getActiveSessionCount()).toBe(initial + 1);
    clearSession('s17');
    expect(getActiveSessionCount()).toBe(initial);
  });

  test('startSessionCleanup can be called without error', () => {
    expect(() => startSessionCleanup()).not.toThrow();
  });

  test('startSessionCleanup is idempotent', () => {
    startSessionCleanup();
    expect(() => startSessionCleanup()).not.toThrow();
  });

  test('stopSessionCleanup can be called without error', () => {
    startSessionCleanup();
    expect(() => stopSessionCleanup()).not.toThrow();
  });
});
