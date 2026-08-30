/**
 * Security and Prompt-Injection Controls (Section 4.9 of the specification)
 *
 * Prompt text alone is not a security boundary. OWASP notes that prompt
 * injection can be direct or indirect and that foolproof prevention is not
 * established (OWASP LLM01:2025). Implement defense in depth.
 */

/**
 * Trust zone markers — system instructions, developer policy, user text,
 * article context, and tool results must be marked as separate trust zones.
 */
export type TrustZone =
  'system_instructions' | 'developer_policy' | 'user_text' | 'article_context' | 'tool_result';

/**
 * Defense-in-depth controls from Section 4.9.
 */
export const SECURITY_CONTROLS = {
  // Mark content with separate trust zones
  TRUST_ZONE_MARKING: true,

  // Never place credentials, private CRM records, or other users' data in model context
  NO_CREDENTIALS_IN_CONTEXT: true,
  NO_PRIVATE_RECORDS_IN_CONTEXT: true,
  NO_OTHER_USERS_DATA_IN_CONTEXT: true,

  // Sanitize and allowlist RAG inputs
  SANITIZE_RAG_INPUTS: true,
  ALLOWLIST_RAG_DOMAINS: true,

  // Remove scripts, hidden text, comments, and instruction-like content
  REMOVE_SCRIPTS: true,
  REMOVE_HIDDEN_TEXT: true,
  REMOVE_COMMENTS: true,
  REMOVE_INSTRUCTION_LIKE_CONTENT: true,

  // Enforce server-side authorization and schema validation
  SERVER_SIDE_AUTHORIZATION: true,
  SERVER_SIDE_SCHEMA_VALIDATION: true,

  // Use read-only retrieval credentials and separate write credentials per tool
  READ_ONLY_RETRIEVAL_CREDENTIALS: true,
  SEPARATE_WRITE_CREDENTIALS_PER_TOOL: true,

  // Add input/output classifiers
  INPUT_OUTPUT_CLASSIFIERS: true,

  // Rate-limit by session/IP risk signals; cap token/tool budgets
  RATE_LIMITING: true,
  TOKEN_BUDGET_CAP: true,
  TOOL_BUDGET_CAP: true,

  // Perform adversarial tests
  ADVERSARIAL_TESTING: true,

  // Provide a kill switch, incident owner, evidence preservation,
  // vendor notification path, and rollback to a static FAQ
  KILL_SWITCH: true,
  INCIDENT_OWNER: true,
  EVIDENCE_PRESERVATION: true,
  VENDOR_NOTIFICATION_PATH: true,
  ROLLBACK_TO_STATIC_FAQ: true,
} as const;

/**
 * Input classification categories for input/output classifiers.
 */
export const INPUT_CLASSIFICATION_CATEGORIES = [
  'prompt_exfiltration',
  'pii',
  'health_data',
  'unsafe_advice',
  'prohibited_recommendations',
] as const;

/**
 * Adversarial test categories (Section 4.9).
 */
export const ADVERSARIAL_TEST_CATEGORIES = [
  'direct_injection',
  'retrieved_document_injection',
  'data_exfiltration',
  'tool_misuse',
  'encoded_text',
  'multilingual_attacks',
  'denial_of_wallet',
] as const;

/**
 * Sanitizes retrieved content before it enters the model context.
 * Removes scripts, hidden text, comments, and instruction-like content.
 *
 * @param content - The raw retrieved text from a RAG source
 * @returns Sanitized content safe for model context
 */
export function sanitizeRetrievedContent(content: string): string {
  let sanitized = content;

  // Remove <script> tags and their contents
  sanitized = sanitized.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove HTML comments
  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');

  // Remove hidden text (display:none, visibility:hidden, etc.)
  sanitized = sanitized.replace(
    /<[^>]*style="[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
    '',
  );
  sanitized = sanitized.replace(/<[^>]*hidden[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // Remove instruction-like patterns that could be prompt injection
  // e.g., "Ignore previous instructions", "You are now", "System:"
  sanitized = sanitized.replace(
    /(?:ignore|disregard)\s+(?:previous|all|above)\s+instructions?/gi,
    '',
  );
  sanitized = sanitized.replace(/(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s/gi, '');
  sanitized = sanitized.replace(/^system\s*:/gim, '');

  // Remove null bytes and other control characters
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized.trim();
}

/**
 * Checks if user input appears to contain prompt injection attempts.
 * This is a classifier heuristic, not a guarantee.
 *
 * @param userInput - The text entered by the user
 * @returns True if prompt injection is suspected
 */
export function detectPromptInjection(userInput: string): boolean {
  const injectionPatterns = [
    /(?:ignore|disregard|forget)\s+(?:previous|all|above|your)\s+instructions?/i,
    /(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|role[\s-]?play\s+as)/i,
    /^(?:system|admin|developer)\s*:/i,
    /(?:reveal|show|print|output)\s+(?:your|the|system)\s+(?:prompt|instructions?|rules?|policy)/i,
    /(?:override|disable|bypass)\s+(?:safety|content|system|filter)/i,
    /(?:translate|encode|base64|rot13|hex)\s+(?:this|the|your)\s+(?:prompt|instructions?|rules?)/i,
    /<\/?(?:script|iframe|object|embed|svg)/i,
    /(?:DROP\s+TABLE|UNION\s+SELECT|;\s*DELETE)/i,
  ];

  return injectionPatterns.some((pattern) => pattern.test(userInput));
}

/**
 * Checks if user input appears to contain PII or health data.
 *
 * @param userInput - The text entered by the user
 * @returns The category of sensitive data detected, or null
 */
export function detectSensitiveData(
  userInput: string,
): (typeof INPUT_CLASSIFICATION_CATEGORIES)[number] | null {
  // Health data patterns
  const healthPatterns = [
    /(?:diagnos(?:ed|is)|medication|prescription|treatment|therapy|symptom|condition|disease|disorder)/i,
    /(?:blood\s+pressure|cholesterol|diabetes|cancer|heart|depression|anxiety|ptsd)/i,
    /(?:height|weight|bmi|tobacco|smoker|nicotine|alcohol|substance)/i,
    /(?:family\s+history|medical\s+history|health\s+history)/i,
  ];

  if (healthPatterns.some((p) => p.test(userInput))) {
    return 'health_data';
  }

  // PII patterns
  const piiPatterns = [
    /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/, // SSN
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // Phone
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // Email
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/, // Credit card
    /\b\d{3}-\d{2}-\d{4}\b/, // SSN formatted
  ];

  if (piiPatterns.some((p) => p.test(userInput))) {
    return 'pii';
  }

  return null;
}

/**
 * Prohibited promotional/free-offer phrases (marketing-review gate).
 *
 * The word "free" alone is not flagged — only promotional offers whose terms
 * are not approved. Until FREE_OFFER_MARKETING_APPROVED=true after marketing
 * review, the assistant must never claim a free quote, free consultation,
 * free estimate, or no-obligation review.
 */
export const PROMOTIONAL_OFFER_PATTERNS = [
  /\bfree\s+(?:quote|consultation|estimate|review|assessment|evaluation)\b/i,
  /\b(?:100\s*%|totally|absolutely|completely)\s+free\b/i,
  /\bfree\s+of\s+charge\b/i,
  /\bno[\s-]?obligation\b/i,
] as const;

/**
 * Returns true when the text contains a promotional free-offer claim whose
 * terms are not approved (free quote / free consultation / no-obligation).
 * Used as an output guard while FREE_OFFER_MARKETING_APPROVED is false.
 *
 * @param text - The assistant message or other text to inspect
 */
export function detectProhibitedPromotionalOffer(text: string): boolean {
  return PROMOTIONAL_OFFER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Rate limiting state tracking (per session/IP).
 * In production, this should use Redis or a similar shared store.
 */
interface RateLimitState {
  sessionId: string;
  requestCount: number;
  windowStart: number;
  tokenCount: number;
  toolCallCount: number;
}

const rateLimitStore = new Map<string, RateLimitState>();

/**
 * Rate limit configuration.
 */
export const RATE_LIMIT_CONFIG = {
  /** Max requests per session per minute */
  MAX_REQUESTS_PER_MINUTE: 20,
  /** Max tokens per session */
  MAX_TOKENS_PER_SESSION: 50000,
  /** Max tool calls per session */
  MAX_TOOL_CALLS_PER_SESSION: 15,
  /** Window size in milliseconds (1 minute) */
  WINDOW_MS: 60_000,
} as const;

/**
 * Checks rate limits for a session.
 * Returns true if the request is allowed, false if rate-limited.
 */
export function checkRateLimit(sessionId: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  let state = rateLimitStore.get(sessionId);

  if (!state) {
    state = {
      sessionId,
      requestCount: 0,
      windowStart: now,
      tokenCount: 0,
      toolCallCount: 0,
    };
    rateLimitStore.set(sessionId, state);
  }

  // Reset window if expired
  if (now - state.windowStart > RATE_LIMIT_CONFIG.WINDOW_MS) {
    state.requestCount = 0;
    state.windowStart = now;
  }

  if (state.requestCount >= RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_MINUTE) {
    return { allowed: false, reason: 'rate_limit_exceeded' };
  }

  if (state.tokenCount >= RATE_LIMIT_CONFIG.MAX_TOKENS_PER_SESSION) {
    return { allowed: false, reason: 'token_budget_exceeded' };
  }

  if (state.toolCallCount >= RATE_LIMIT_CONFIG.MAX_TOOL_CALLS_PER_SESSION) {
    return { allowed: false, reason: 'tool_budget_exceeded' };
  }

  state.requestCount++;
  return { allowed: true };
}

/**
 * Increments the tool call count for a session.
 */
export function incrementToolCallCount(sessionId: string): void {
  const state = rateLimitStore.get(sessionId);
  if (state) {
    state.toolCallCount++;
  }
}

/**
 * The kill switch. When activated, the system immediately stops serving
 * model responses and falls back to a static FAQ.
 */
let killSwitchActive = false;

export function activateKillSwitch(): void {
  killSwitchActive = true;
}

export function deactivateKillSwitch(): void {
  killSwitchActive = false;
}

export function isKillSwitchActive(): boolean {
  return killSwitchActive;
}
