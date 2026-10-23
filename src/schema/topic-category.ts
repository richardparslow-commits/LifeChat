/**
 * Allowlisted topic categories.
 *
 * `topicCategory` originates in the browser (and, via the Content Bridge, in
 * the CMS page context). It reaches the GA4 dataLayer, the lead record, the
 * response envelope, and the abstention JSONL — all of which promise never to
 * carry PII or free text. A length cap alone does not keep that promise: a
 * caller can send an email address or a health phrase in a 64-character field.
 *
 * Only these values may flow onward. Everything else is mapped to `'other'`
 * before it reaches analytics or storage, and `null`/empty stays absent.
 */
import { z } from 'zod';

export const TOPIC_CATEGORIES = [
  'term_life',
  'whole_life',
  'final_expense',
  'iul',
  'riders',
  'underwriting',
  'beneficiaries',
  'health_classes',
  'texas_laws',
  'costs',
  'coverage_needs',
  'dime_estimator',
  'product_comparison',
  'broker',
  'other',
] as const;

export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

/** Response-schema view of the allowlist. Invalid model output becomes null. */
export const TopicCategorySchema = z.enum(TOPIC_CATEGORIES).nullable().catch(null);

/** Normalizes a candidate into the allowlist, or `'other'` when unknown. */
export function normalizeTopicCategory(value: unknown): TopicCategory | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!cleaned) return null;
  return (TOPIC_CATEGORIES as readonly string[]).includes(cleaned)
    ? (cleaned as TopicCategory)
    : 'other';
}
