/**
 * Canonical consent copy, owned by the server.
 *
 * The consent artefact must prove *which disclosure* the visitor affirmed.
 * Hashing whatever string a caller supplied proves only that the caller sent
 * some text: a one-character body becomes a current-version consent record.
 * The route therefore compares the submitted copy with the approved copy for
 * the selected channel and persists the hash of the canonical text.
 *
 * Both strings were approved for use by the principal owner and licensed Texas
 * broker, Richard Parslow, on 2026-10-23 and recorded at version 1.1.0 (the
 * LifeChat / Life Insurance Broker Advocate naming). `GET /api/consent-text`
 * serves them so a form can render exactly what the server will verify.
 */

/** Approved email/web-form contact-consent disclosure. */
export const RECOMMENDED_EMAIL_CONSENT_COPY =
  'I agree to be contacted about my life-insurance inquiry. Consent is not a condition of purchase.';

/**
 * The phone-consent copy (Section 2.3), approved at version 1.1.0.
 *
 * Brand note: the provider is named here, not the assistant. A visitor is
 * consenting to contact from the brokerage that answers, so naming LifeChat
 * would misstate who may call. Any rewording requires a CONTACT_CONSENT_VERSION
 * bump, because the stored consent artefact is a hash of exactly this copy.
 */
export const RECOMMENDED_PHONE_CONSENT_COPY = `Optional: I agree that Life Insurance Broker Advocate and Richard Parslow may call or text the number I provide about my life-insurance inquiry, including using automated technology or an artificial/prerecorded voice if applicable. Consent is not a condition of purchase. Message and data rates may apply. Reply STOP to stop texts. See the Privacy Notice.`;

/**
 * Normalizes copy for comparison: trims, collapses internal whitespace, and
 * normalizes line endings. Meaning is unchanged; presentation differences
 * (a form that wraps the paragraph, extra spaces) do not invalidate consent.
 */
export function normalizeConsentCopy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/[ \t]+/g, ' ');
}

/** Returns the canonical copy for a contact channel. */
export function canonicalContactConsentCopy(channel: 'email' | 'phone'): string {
  return channel === 'phone' ? RECOMMENDED_PHONE_CONSENT_COPY : RECOMMENDED_EMAIL_CONSENT_COPY;
}

/**
 * True when the submitted copy matches the channel's approved disclosure.
 * Comparing normalized text keeps a wrapped form submission valid while
 * rejecting a different, shortened, or unrelated statement.
 */
export function isApprovedContactConsentCopy(
  submitted: string,
  channel: 'email' | 'phone',
): boolean {
  return (
    normalizeConsentCopy(submitted) === normalizeConsentCopy(canonicalContactConsentCopy(channel))
  );
}
