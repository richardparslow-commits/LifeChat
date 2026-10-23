/**
 * Session Conversation History Store
 *
 * Stores conversation turns per session ID so the LLM receives prior
 * turns as context for follow-up questions.
 *
 * Design decisions:
 * - Bounded LRU cache for the pilot phase (replace with Redis in production);
 *   session ids are client-supplied, so an unbounded Map would let an
 *   unauthenticated caller grow the process without limit
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
import { BoundedLruCache } from '../persistence/bounded-lru';
import { EMPTY_DIME_INPUTS, type DimeInputs } from '../estimator/dime-estimator';
import type { PageContext } from '../contextual/page-context';
import {
  EMPTY_LOOP_CONTROLS,
  type ConversationState,
  type LoopControlState,
} from '../state-machine/state-machine';

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
  /** Clarifying questions already asked in the current ambiguity streak. */
  clarificationFailures: number;
  /** Qualification questions the assistant has asked this session. */
  qualificationQuestionsAsked: number;
  /**
   * The visitor declined an optional offer; automatic re-offers are suppressed
   * for the rest of the session (Section 4.4).
   */
  offerDeclined: boolean;
  /** Whether contact/booking was already offered this session. */
  contactOffered: boolean;
  /** Count of consecutive failures for loop control. */
  consecutiveFailures: number;
  /** Collected DIME estimator inputs (educational sub-flow, Section 9.2). */
  dimeInputs: DimeInputs;
  /**
   * Validated page context (Contextual Content Bridge). Set on the first
   * user message of a session and reused thereafter so the current article
   * stays prioritized for the whole conversation (Section 3.2: page context
   * is sent once with the first message).
   */
  pageContext: PageContext | null;
  /**
   * Sanitized canonical path of the page the user was on when they started
   * the chat (query params stripped — never raw window.location.href). Set
   * on the first message that carries a sourceUrl and reused thereafter.
   */
  sourceUrl: string | null;
  /**
   * Authoritative server-side conversation state (Section 4.4). Derived from
   * server-verified state transitions rather than trusting the client payload.
   */
  currentState: ConversationState;
  /**
   * Authoritative server-side medical consent flag (Phase 2, Section 9.1).
   * Only set to true when medical consent is affirmed during the medical_offer
   * flow with medical capture enabled, or via a verified /api/consent record.
   */
  medicalConsentAffirmative: boolean;
  /**
   * The slot the visitor selected through POST /api/scheduling/select.
   *
   * A booking may only name this slot: the model cannot choose an appointment
   * time on the visitor's behalf, and a slot id it invents never matches.
   * Null until the visitor picks one.
   */
  selectedSlotId: string | null;
}

/**
 * Upper bound on resident sessions. Reaching it evicts the least-recently-used
 * session, which is the correct trade for a pilot: an evicted session loses
 * its in-memory context (the conversation is not persisted) while the process
 * keeps serving instead of growing until it is OOM-killed.
 */
export const MAX_SESSION_CACHE_ENTRIES = 5000;

const sessions = new BoundedLruCache<string, SessionData>(MAX_SESSION_CACHE_ENTRIES);

/**
 * Gets the conversation history for a session as LLMMessage[].
 * Returns an empty array if the session doesn't exist.
 *
 * Returns a SNAPSHOT (copy), not the live array: otherwise a caller that
 * holds the reference and then appends to the session (e.g. /api/chat records
 * the current user turn into history) would have ``buildMessages`` read the
 * current turn twice — once via history and once as ``userMessage``.
 */
export function getHistory(sessionId: string): LLMMessage[] {
  const session = sessions.get(sessionId);
  if (!session) {
    return [];
  }
  // Update last activity time
  session.lastActivity = Date.now();
  return session.messages.slice();
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
export function addUserMessage(
  sessionId: string,
  message: string,
  isSensitive: boolean = false,
): void {
  const session = getOrCreateSession(sessionId);

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
  const session = getOrCreateSession(sessionId);

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
 * Returns the session's loop-control counters (Section 4.4). A session that
 * has not tripped any control yet reads as zeroes.
 */
export function getLoopControlState(sessionId: string): LoopControlState {
  const session = sessions.get(sessionId);
  if (!session) return { ...EMPTY_LOOP_CONTROLS };
  session.lastActivity = Date.now();
  return {
    clarificationFailures: session.clarificationFailures,
    qualificationQuestionsAsked: session.qualificationQuestionsAsked,
    offerDeclined: session.offerDeclined,
  };
}

/** Records one completed clarifying question for the ambiguity streak. */
export function recordClarificationAttempt(sessionId: string): void {
  const session = getOrCreateSession(sessionId);
  session.clarificationFailures += 1;
  session.lastActivity = Date.now();
}

/** Clears the ambiguity streak once the conversation leaves `clarify`. */
export function resetClarificationAttempts(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.clarificationFailures = 0;
  session.lastActivity = Date.now();
}

/** Records one qualification question asked (cap: MAX_QUALIFICATION_QUESTIONS). */
export function recordQualificationQuestion(sessionId: string): void {
  const session = getOrCreateSession(sessionId);
  session.qualificationQuestionsAsked += 1;
  session.lastActivity = Date.now();
}

/** Marks that the visitor declined an optional offer this session. */
export function recordOfferDeclined(sessionId: string): void {
  const session = getOrCreateSession(sessionId);
  session.offerDeclined = true;
  session.lastActivity = Date.now();
}

/**
 * Gets the DIME estimator inputs collected so far this session.
 * Returns a fresh copy so callers cannot mutate the session record.
 */
export function getDimeInputs(sessionId: string): DimeInputs {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ...EMPTY_DIME_INPUTS };
  }
  session.lastActivity = Date.now();
  return { ...session.dimeInputs };
}

/**
 * Sets the DIME estimator inputs for a session (called after each turn that
 * carries an active dime_estimator block).
 */
export function setDimeInputs(sessionId: string, inputs: DimeInputs): void {
  const session = getOrCreateSession(sessionId);
  session.dimeInputs = { ...inputs };
  session.lastActivity = Date.now();
}

/**
 * Returns the session's stored page context, or null when the session has
 * not supplied one (Contextual Content Bridge). Returns a reference to the
 * stored validated object; it is read-only to callers.
 */
export function getPageContext(sessionId: string): PageContext | null {
  const session = sessions.get(sessionId);
  return session ? session.pageContext : null;
}

/**
 * Stores validated page context on a session (Contextual Content Bridge).
 * Called on the first user message so the article stays prioritized for the
 * rest of the conversation. Passing null clears it.
 */
export function setPageContext(sessionId: string, pageContext: PageContext | null): void {
  const session = getOrCreateSession(sessionId);
  session.pageContext = pageContext;
  session.lastActivity = Date.now();
}

/**
 * Returns the session's stored sanitized source URL (query params stripped),
 * or null when no source URL was provided. Set on the first message that
 * carries a sourceUrl so the canonical path is available for handoff and
 * lead records without ever sending raw window.location.href to the model.
 */
export function getSourceUrl(sessionId: string): string | null {
  const session = sessions.get(sessionId);
  return session ? session.sourceUrl : null;
}

/**
 * Stores the sanitized canonical path on the session. Called on the first
 * message that carries a sourceUrl; subsequent messages reuse it. The
 * value must already be sanitized (query params stripped) before calling.
 */
export function setSourceUrl(sessionId: string, sourceUrl: string | null): void {
  const session = getOrCreateSession(sessionId);
  session.sourceUrl = sourceUrl;
  session.lastActivity = Date.now();
}

/**
 * Returns the authoritative server-side conversation state for the session.
 * Defaults to 'education' for a new session (after the initial disclosure).
 */
export function getSessionState(sessionId: string): ConversationState {
  const session = sessions.get(sessionId);
  return session ? session.currentState : 'education';
}

/**
 * Updates the authoritative server-side conversation state for the session.
 */
export function setSessionState(sessionId: string, state: ConversationState): void {
  const session = getOrCreateSession(sessionId);
  session.currentState = state;
  session.lastActivity = Date.now();
}

/**
 * Returns whether the session has affirmed medical consent on the server.
 */
export function getMedicalConsentAffirmative(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return session ? session.medicalConsentAffirmative : false;
}

/**
 * Records server-side medical consent status for the session.
 */
export function setMedicalConsentAffirmative(sessionId: string, affirmed: boolean): void {
  const session = getOrCreateSession(sessionId);
  session.medicalConsentAffirmative = affirmed;
  session.lastActivity = Date.now();
}

/**
 * Returns the slot the visitor selected in this session, or null.
 */
export function getSelectedSlot(sessionId: string): string | null {
  const session = sessions.get(sessionId);
  return session ? session.selectedSlotId : null;
}

/**
 * Records the slot the visitor selected (server-verified by the scheduling
 * route before this is called). Passing null clears the selection.
 */
export function setSelectedSlot(sessionId: string, slotId: string | null): void {
  const session = getOrCreateSession(sessionId);
  session.selectedSlotId = slotId;
  session.lastActivity = Date.now();
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
      clarificationFailures: 0,
      qualificationQuestionsAsked: 0,
      offerDeclined: false,
      contactOffered: false,
      consecutiveFailures: 0,
      dimeInputs: { ...EMPTY_DIME_INPUTS },
      pageContext: null,
      sourceUrl: null,
      currentState: 'education',
      medicalConsentAffirmative: false,
      selectedSlotId: null,
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
    for (const [id, session] of sessions) {
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
