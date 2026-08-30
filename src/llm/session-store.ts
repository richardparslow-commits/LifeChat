/**
 * Session Conversation History Store
 *
 * Stores conversation turns per session ID so the LLM receives prior
 * turns as context for follow-up questions.
 *
 * Design decisions:
 * - In-memory Map for the pilot phase (replace with Redis in production)
 * - Max 20 turns per session (10 user + 10 assistant) to limit token budget
 * - TTL of 30 minutes of inactivity (configurable)
 * - Assistant messages stored are the assistant_message field only —
 *   never lead_data, consent, or risk_flags (Section 8: no PII in logs)
 * - User messages stored after sanitization
 * - Sensitive data (health, PII) is NOT stored in history — if the
 *   security layer flagged it, the raw message is replaced with a
 *   redacted placeholder
 */

import type { LLMMessage } from './llm-client';

/** Maximum number of conversation turns to retain per session. */
const MAX_TURNS = 20;

/** Time-to-live for inactive sessions in milliseconds (30 minutes). */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Interval for cleaning up expired sessions. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionData {
  messages: LLMMessage[];
  lastActivity: number;
  /** Tracks which fields the user has declined to answer (loop control). */
  declinedFields: Set<string>;
  /** Whether qualification was already offered this session. */
  qualificationOffered: boolean;
  /** Whether contact/booking was already offered this session. */
  contactOffered: boolean;
  /** Count of consecutive failures for loop control. */
  consecutiveFailures: number;
}

const sessions = new Map<string, SessionData>();

/**
 * Gets the conversation history for a session as LLMMessage[].
 * Returns an empty array if the session doesn't exist.
 */
export function getHistory(sessionId: string): LLMMessage[] {
  const session = sessions.get(sessionId);
  if (!session) {
    return [];
  }
  // Update last activity time
  session.lastActivity = Date.now();
  return session.messages;
}

/**
 * Adds a user message to the session history.
 * The message should already be sanitized. If it contains sensitive
 * data (detected upstream), pass a redacted placeholder instead.
 *
 * @param sessionId - The session identifier
 * @param message - The sanitized user message
 * @param isSensitive - If true, store a redacted placeholder instead
 */
export function addUserMessage(sessionId: string, message: string, isSensitive: boolean = false): void {
  let session = getOrCreateSession(sessionId);

  const content = isSensitive
    ? '[USER MESSAGE REDACTED — contained sensitive data, not stored]'
    : message;

  session.messages.push({ role: 'user', content });

  // Enforce max turns — drop oldest messages
  if (session.messages.length > MAX_TURNS) {
    // Drop the oldest pair (user + assistant) to keep pairs intact
    session.messages.splice(0, session.messages.length - MAX_TURNS);
  }

  session.lastActivity = Date.now();
}

/**
 * Adds an assistant message to the session history.
 * Only the assistant_message text is stored — never lead_data,
 * consent fields, or risk_flags (Section 8: PII protection).
 *
 * @param sessionId - The session identifier
 * @param assistantMessage - The assistant_message field from the validated response
 */
export function addAssistantMessage(sessionId: string, assistantMessage: string): void {
  let session = getOrCreateSession(sessionId);

  session.messages.push({ role: 'assistant', content: assistantMessage });

  // Enforce max turns
  if (session.messages.length > MAX_TURNS) {
    session.messages.splice(0, session.messages.length - MAX_TURNS);
  }

  session.lastActivity = Date.now();
}

/**
 * Marks a field as declined by the user for this session.
 * Used for loop control (Section 7: never ask for the same declined field twice).
 */
export function markFieldDeclined(sessionId: string, field: string): void {
  const session = getOrCreateSession(sessionId);
  session.declinedFields.add(field);
  session.lastActivity = Date.now();
}

/**
 * Checks if a field has been declined this session.
 */
export function isFieldDeclined(sessionId: string, field: string): boolean {
  const session = sessions.get(sessionId);
  return session ? session.declinedFields.has(field) : false;
}

/**
 * Marks that qualification was offered this session.
 */
export function markQualificationOffered(sessionId: string): void {
  const session = getOrCreateSession(sessionId);
  session.qualificationOffered = true;
  session.lastActivity = Date.now();
}

/**
 * Checks if qualification was already offered this session.
 */
export function wasQualificationOffered(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return session ? session.qualificationOffered : false;
}

/**
 * Marks that contact/booking was offered this session.
 */
export function markContactOffered(sessionId: string): void {
  const session = getOrCreateSession(sessionId);
  session.contactOffered = true;
  session.lastActivity = Date.now();
}

/**
 * Checks if contact was already offered this session.
 */
export function wasContactOffered(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return session ? session.contactOffered : false;
}

/**
 * Increments consecutive failure count for loop control (Section 4.11).
 * Returns the new count.
 */
export function incrementFailures(sessionId: string): number {
  const session = getOrCreateSession(sessionId);
  session.consecutiveFailures++;
  session.lastActivity = Date.now();
  return session.consecutiveFailures;
}

/**
 * Resets consecutive failure count (called on success).
 */
export function resetFailures(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.consecutiveFailures = 0;
    session.lastActivity = Date.now();
  }
}

/**
 * Gets the consecutive failure count.
 */
export function getFailureCount(sessionId: string): number {
  const session = sessions.get(sessionId);
  return session ? session.consecutiveFailures : 0;
}

/**
 * Clears all history for a session (e.g., on explicit user request
 * or privacy withdrawal).
 */
export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Gets the number of active sessions (for monitoring/admin).
 */
export function getActiveSessionCount(): number {
  return sessions.size;
}

/**
 * Gets or creates a session.
 */
function getOrCreateSession(sessionId: string): SessionData {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      messages: [],
      lastActivity: Date.now(),
      declinedFields: new Set(),
      qualificationOffered: false,
      contactOffered: false,
      consecutiveFailures: 0,
    };
    sessions.set(sessionId, session);
  }
  return session;
}

/**
 * Periodic cleanup of expired sessions.
 * Runs on a timer to remove sessions inactive for longer than SESSION_TTL_MS.
 */
let cleanupTimer: NodeJS.Timeout | null = null;

export function startSessionCleanup(): void {
  if (cleanupTimer) {
    return; // Already running
  }
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        sessions.delete(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Don't keep the process alive just for the cleanup timer
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

/**
 * Stops the cleanup timer (for graceful shutdown / tests).
 */
export function stopSessionCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * Clears all sessions (for testing).
 */
export function clearAllSessions(): void {
  sessions.clear();
}
