/**
 * Shared test helpers for the request-contract changes (SEC-02, SEC-04, SEC-06).
 *
 * `testSessionId` derives a schema-valid `lpp_...` id from a readable name, so
 * table-driven endpoint tests keep their descriptive naming without duplicating
 * the format in every case. `seedSession` writes the server-authoritative state
 * and medical consent the chat route now reads instead of the request body.
 */

import type { ConversationState } from '../../src/state-machine/state-machine';

/** The exact consent copy a test visitor affirmed; only its hash is stored. */
export const TEST_CONSENT_TEXT =
  'I agree to be contacted about my life-insurance inquiry. Consent is not a condition of purchase.';

/** A schema-valid session id derived from a readable test name. */
export function testSessionId(name: string): string {
  const slug = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50);
  return `lpp_${slug.padEnd(12, 'x')}`;
}

/**
 * Seeds the server-side session before a request. Imported dynamically so the
 * helper shares the module registry the freshly loaded app is using.
 */
export async function seedSession(
  sessionId: string,
  state: ConversationState,
  medicalConsent = false,
): Promise<void> {
  const store = await import('../../src/llm/session-store');
  store.setSessionState(sessionId, state);
  store.setMedicalConsentAffirmative(sessionId, medicalConsent);
}
