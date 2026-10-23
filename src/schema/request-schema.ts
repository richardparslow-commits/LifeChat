/**
 * Runtime validation for the write endpoints.
 *
 * The chat and consent bodies are the two unauthenticated inputs that can
 * create records or reach the model, so the route parses them with Zod before
 * reading a single field. Unknown keys are stripped (Zod's default), which is
 * what makes the server-authoritative policy real: a client-supplied
 * `currentState` or `medicalConsentAffirmative` never even reaches the handler.
 *
 * Validation failures answer 400 with field names and messages only — never the
 * rejected values, which could be the PII the caller was trying to submit.
 */

import { z } from 'zod';

import { validateEmail, validatePhone } from '../consent/consent-model';
import { normalizeTopicCategory } from './topic-category';

/**
 * Session ids are client-generated but must be opaque and bounded: the prefix
 * namespaces them, and the character class keeps them safe to use as log keys
 * and map keys without escaping or injection concerns.
 */
export const SESSION_ID_PATTERN = /^lpp_[a-zA-Z0-9_-]{12,64}$/;

const SessionIdSchema = z
  .string()
  .regex(SESSION_ID_PATTERN, 'sessionId must match lpp_[A-Za-z0-9_-]{12,64}');

const OptionalTextSchema = (max: number) => z.string().trim().max(max).optional();

/**
 * POST /api/chat.
 *
 * `currentState` and `medicalConsentAffirmative` are deliberately absent: the
 * route derives both from the server-side session store, so sending them has
 * no effect (they are stripped with every other unknown key).
 */
export const ChatRequestSchema = z.object({
  sessionId: SessionIdSchema,
  message: z
    .string()
    .min(1, 'message is required')
    .max(2000, 'message must be 2000 characters or fewer'),
  sourceUrl: OptionalTextSchema(2048),
  articleId: OptionalTextSchema(128),
  // Categorical, not free text: unknown labels become 'other' before they can
  // reach analytics, the response, the lead record, or the abstention log.
  topicCategory: OptionalTextSchema(64).transform(
    (value) => normalizeTopicCategory(value) ?? undefined,
  ),
  /** Intent flags — they advance a flow, they never grant consent. */
  userAgreesToMedicalReview: z.boolean().optional(),
  medicalReviewComplete: z.boolean().optional(),
  userRequestsDimeEstimator: z.boolean().optional(),
  /** Contextual Content Bridge payload; validated separately as untrusted data. */
  page_context: z.unknown().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * POST /api/consent.
 *
 * `consentText` is the exact copy the visitor affirmed; the route stores its
 * SHA-256, never the copy itself. Contact format is enforced against the
 * selected channel so an email cannot be smuggled into the phone path (or
 * vice versa) and still create a lead.
 */
export const ConsentRequestSchema = z
  .object({
    contactConsentAffirmed: z.boolean().optional(),
    // A consent record with no reachable channel is not usable consent: the
    // broker cannot act on it, and TCPA proof requires the number/address the
    // consumer consented to be contacted at. The channel is therefore
    // required, and the matching value must be present for it.
    contactChannel: z.enum(['email', 'phone']),
    email: OptionalTextSchema(254),
    phone: OptionalTextSchema(32),
    firstName: OptionalTextSchema(100),
    sessionId: SessionIdSchema.optional(),
    sourceUrl: OptionalTextSchema(2048),
    articleId: OptionalTextSchema(128),
    topicCategory: OptionalTextSchema(64).transform(
      (value) => normalizeTopicCategory(value) ?? undefined,
    ),
    consentText: z
      .string()
      .min(1, 'consentText is required')
      .max(5000, 'consentText must be 5000 characters or fewer'),
    medicalProfile: z.unknown().optional().nullable(),
    medicalConsentAffirmed: z.boolean().optional(),
    medicalConsentVersion: OptionalTextSchema(32),
  })
  .strip()
  .superRefine((value, ctx) => {
    if (value.contactChannel === 'email' && !value.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['email'],
        message: 'email is required for the email channel',
      });
    }
    if (value.contactChannel === 'phone' && !value.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['phone'],
        message: 'phone is required for the phone channel',
      });
    }
  });

export type ConsentRequest = z.infer<typeof ConsentRequestSchema>;

/**
 * POST /api/scheduling/select.
 *
 * Records the visitor's choice of slot. The id is verified against the server
 * inventory by the route — selection alone never books anything, and a booking
 * may only name the slot recorded here.
 */
export const SlotSelectionSchema = z
  .object({
    sessionId: SessionIdSchema,
    slotId: z.string().trim().min(1, 'slotId is required').max(64, 'slotId is too long'),
  })
  .strip();

export type SlotSelection = z.infer<typeof SlotSelectionSchema>;

/** Field-level 400 payload; values are never echoed back. */
export function validationError(error: z.ZodError): {
  error: string;
  details: { field: string; message: string }[];
} {
  return {
    error: 'Invalid request',
    details: error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    })),
  };
}

/**
 * Channel-aware contact validation shared by the schema and the route.
 *
 * Returns false when the channel is absent or its value is missing/invalid —
 * the earlier `return true` fallback made a channel-less record look valid,
 * which is the opposite of what a consent artifact needs to be.
 */
export function contactFieldIsValid(data: ConsentRequest): boolean {
  if (data.contactChannel === 'email') {
    return typeof data.email === 'string' && data.email.length > 0 && validateEmail(data.email);
  }
  if (data.contactChannel === 'phone') {
    return typeof data.phone === 'string' && data.phone.length > 0 && validatePhone(data.phone);
  }
  return false;
}
