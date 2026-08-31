/**
 * Page Context Validation (Contextual Content Bridge)
 *
 * Reads and validates the page a user is viewing (URL, title, category,
 * article id) when they start a chat. Treats all of it as UNTRUSTED DATA:
 * it originates in the browser/CMS and is validated strictly so it can never
 * be used to inject instructions, exfiltrate secrets, or — critically — infer
 * anything about the user personally.
 *
 * Rules:
 * - Length caps on every field (URL ≤ 2048, title ≤ 500, category/article id ≤ 100).
 * - Titles and categories carrying prompt-injection patterns are REJECTED and a
 *   contextual_injection risk flag is set so the bridge ignores the context.
 * - This module never logs page content verbatim.
 */

/** Validated page context carried into the bridge once it passes checks. */
export interface PageContext {
  url?: string;
  title?: string;
  category?: string | null;
  article_id?: string | null;
}

/** Length caps per Section 3.2. */
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 100;
const MAX_ARTICLE_ID_LENGTH = 100;

/**
 * Prompt-injection patterns that, when found in a page title or category,
 * cause the bridge to IGNORE the context entirely (Section 16.4).
 */
const CONTEXTUAL_INJECTION_PATTERNS = [
  /(?:ignore|disregard|forget)\s+(?:previous|all|above|system)?\s*instructions?/i,
  /(?:reveal|show|print|output|disclose)\s+(?:(?:your|the)\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|policy|secrets?)/i,
  /(?:override|disable|bypass)\s+(?:safety|content|system|all|rules?|policy)/i,
  /(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|role[-\s]?play\s+as)/i,
  /^system\s*:/im,
  /<[^>]*script/i,
] as const;

/**
 * Returns true when the given page-context text (title or category) contains a
 * prompt-injection attempt. Used to set risk_flags contextual_injection and
 * make the bridge ignore the context.
 */
export function detectContextualInjection(text: string): boolean {
  return CONTEXTUAL_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Validates an unknown page_context value against the rules in Section 3.2.
 *
 * Returns a normalized PageContext when valid, or null when the input is
 * malformed / fails validation / contains a prompt-injection attempt. When the
 * input is entirely absent (undefined/null), returns null (no context).
 */
export function validatePageContext(pageContext: unknown): PageContext | null {
  if (pageContext === undefined || pageContext === null) {
    return null;
  }
  if (typeof pageContext !== 'object') {
    return null;
  }

  const source = pageContext as Record<string, unknown>;
  const validated: PageContext = {};

  if (source.url !== undefined) {
    if (typeof source.url !== 'string') return null;
    if (source.url.length > MAX_URL_LENGTH) return null;
    if (!source.url.startsWith('http')) return null;
    validated.url = source.url;
  }

  if (source.title !== undefined) {
    if (typeof source.title !== 'string') return null;
    if (source.title.length > MAX_TITLE_LENGTH) return null;
    if (detectContextualInjection(source.title)) return null;
    validated.title = source.title;
  }

  if (source.category !== undefined) {
    if (source.category === null) {
      validated.category = null;
    } else if (typeof source.category === 'string') {
      if (source.category.length > MAX_CATEGORY_LENGTH) return null;
      if (detectContextualInjection(source.category)) return null;
      validated.category = source.category;
    } else {
      return null;
    }
  }

  if (source.article_id !== undefined) {
    if (source.article_id === null) {
      validated.article_id = null;
    } else if (typeof source.article_id === 'string') {
      if (source.article_id.length > MAX_ARTICLE_ID_LENGTH) return null;
      validated.article_id = source.article_id;
    } else {
      return null;
    }
  }

  return validated;
}
