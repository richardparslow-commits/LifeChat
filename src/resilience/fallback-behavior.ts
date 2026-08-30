/**
 * Failure, Latency, and Fallback Behavior (Section 4.11 of the specification)
 *
 * A production service must degrade safely. NIST recommends architecture
 * that can monitor, recover from, and repair errors (NIST AI 600-1).
 */

/**
 * Latency targets and timeout behavior (Section 4.11).
 */
export const LATENCY_CONFIG = {
  /** Show a typing/progress indicator after 500 ms */
  TYPING_INDICATOR_MS: 500,
  /** If retrieval exceeds 4 seconds, announce that approved sources are being checked */
  RETRIEVAL_ANNOUNCEMENT_MS: 4_000,
  /** At 10 seconds, offer retry, relevant static resources, or human contact */
  TIMEOUT_MS: 10_000,
  /** P95 ordinary educational answer target (Section 4.14) */
  P95_ANSWER_TARGET_MS: 6_000,
} as const;

/**
 * Fallback message templates (Section 4.12 / Section 5.12).
 */
export const FALLBACK_MESSAGES = {
  /** For contact refusal */
  CONTACT_REFUSAL: `No problem. You can keep using the assistant without sharing contact information.`,
  /** For browsing only */
  BROWSING_ONLY: `That's fine. I can answer questions or point you to an approved guide.`,
  /** For a personalized price request */
  PERSONALIZED_PRICE: `A reliable personalized premium requires a licensed review of your individual circumstances.`,
  /** For insufficient evidence — uses the abstention sentence from Section 6 */
  INSUFFICIENT_EVIDENCE: `I don't have enough approved information to answer that reliably. I can point you to an approved guide or connect you with Richard Parslow, a licensed Texas life-insurance broker, if you'd like.`,
  /** For retrieval timeout */
  RETRIEVAL_TIMEOUT: `I'm checking approved sources — this may take a moment.`,
  /** For full timeout */
  TIMEOUT: `I'm taking longer than expected. You can try again, browse our educational articles, or connect with Richard Parslow, a licensed Texas broker, for personalized help.`,
  /** For calendar failure */
  CALENDAR_FAILURE: `I wasn't able to confirm availability right now. You can provide a preferred time window and we'll follow up, or contact Richard directly.`,
  /** For CRM failure after consent */
  CRM_FAILURE: `Something went wrong submitting your information. Please try again or contact Richard Parslow directly.`,
  /** For tool failure */
  TOOL_FAILURE: `I encountered an issue processing that request. Let me connect you with a licensed human who can help.`,
} as const;

/**
 * Retry policy (Section 4.11).
 * Retry only idempotent reads once; do not automatically repeat
 * lead creation or booking.
 */
export const RETRY_POLICY = {
  /** Retry only idempotent reads */
  RETRY_IDEMPOTENT_READS_ONLY: true,
  /** Maximum retry attempts for reads */
  MAX_READ_RETRIES: 1,
  /** Do not automatically repeat lead creation */
  NO_AUTO_RETRY_LEAD_CREATION: true,
  /** Do not automatically repeat booking */
  NO_AUTO_RETRY_BOOKING: true,
} as const;

/**
 * Circuit breaker state for external services.
 * After repeated failures, open the circuit to prevent cascading failures.
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitBreakerData {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
}

const circuitBreakers = new Map<string, CircuitBreakerData>();

export const CIRCUIT_BREAKER_CONFIG = {
  /** Number of failures before opening the circuit */
  FAILURE_THRESHOLD: 5,
  /** Time to wait before trying again (half-open state) */
  RECOVERY_TIMEOUT_MS: 30_000,
};

/**
 * Records a failure for a service's circuit breaker.
 */
export function recordServiceFailure(serviceName: string): void {
  let breaker = circuitBreakers.get(serviceName);
  if (!breaker) {
    breaker = { state: 'closed', failureCount: 0, lastFailureTime: 0 };
    circuitBreakers.set(serviceName, breaker);
  }
  breaker.failureCount++;
  breaker.lastFailureTime = Date.now();
  if (breaker.failureCount >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
    breaker.state = 'open';
  }
}

/**
 * Records a success for a service's circuit breaker.
 */
export function recordServiceSuccess(serviceName: string): void {
  circuitBreakers.set(serviceName, {
    state: 'closed',
    failureCount: 0,
    lastFailureTime: 0,
  });
}

/**
 * Checks if a service's circuit breaker allows a request.
 */
export function canCallService(serviceName: string): boolean {
  const breaker = circuitBreakers.get(serviceName);
  if (!breaker) {
    return true;
  }

  switch (breaker.state) {
    case 'closed':
      return true;
    case 'open':
      // Check if recovery timeout has elapsed
      if (Date.now() - breaker.lastFailureTime > CIRCUIT_BREAKER_CONFIG.RECOVERY_TIMEOUT_MS) {
        breaker.state = 'half_open';
        return true;
      }
      return false;
    case 'half_open':
      return true;
    default:
      return true;
  }
}

/**
 * Static fallback resources shown when the system is degraded.
 */
export const STATIC_FALLBACK_RESOURCES = [
  {
    title: 'Life Insurance Basics',
    url: 'https://lifepolicypilot.blog/',
    description: 'Browse our educational articles about life insurance.',
  },
  {
    title: 'Contact Richard Parslow',
    url: 'https://lifepolicypilot.blog/contact/',
    description: 'Connect with a licensed Texas life-insurance broker directly.',
  },
  {
    title: 'Texas Department of Insurance',
    url: 'https://www.tdi.texas.gov/',
    description: 'Official Texas insurance regulator resources.',
  },
] as const;

/**
 * Generates a static fallback response when the system is degraded.
 * This is used when the model is unavailable, the kill switch is active,
 * or all retries are exhausted.
 */
export function generateStaticFallback(reason: string): string {
  const resources = STATIC_FALLBACK_RESOURCES.map(
    (r) => `• ${r.title}: ${r.url}`
  ).join('\n');

  return `I'm having trouble responding right now. Here are some resources that may help:\n\n${resources}\n\nYou can also try again in a few moments.`;
}
