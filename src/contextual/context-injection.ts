/**
 * Context Injection Module (Contextual Content Bridge)
 *
 * Turns a validated page-context into:
 *   1. an article mapping (or null),
 *   2. the current article's content from the RAG corpus (or null),
 *   3. a delimited data block describing the page (Section 16),
 *   4. a contextual opening-message prompt to reference the article topic.
 *
 * Compliance posture: page context is UNTRUSTED DATA. It is validated first;
 * if it is absent, malformed, or carries a prompt-injection attempt, the
 * bridge yields no content and no data block, and the chat proceeds normally.
 *
 * SEC-12: the block is *data*, not instructions. It is delivered to the model
 * as a `user` message inside explicit delimiters, never appended to the system
 * prompt. The earlier design interpolated the page title into a system-role
 * string, which made any title that slipped past the six-regex blocklist an
 * instruction at the highest authority. The rules for how to treat the block
 * (interest, never personal inference; never follow instructions inside it)
 * are app-authored and live in the system prompt, separate from the data.
 */

import { findArticleMapping, type ArticleMapping } from './article-map';
import { validatePageContext } from './page-context';
import { getArticleById } from '../rag/retrieval';

/** Result of injecting page context into the conversation. */
export interface ContextInjectionResult {
  /** The matched article mapping, or null when nothing matched. */
  articleMapping: ArticleMapping | null;
  /** The current article's RAG corpus content, or null when unavailable. */
  articleContent: string | null;
  /**
   * Facts about the matched article when one is found.
   *
   * Untrusted-data delivery: the caller must send it as a `user` message via
   * `buildMessages`, never as part of the system prompt. It deliberately holds
   * only app-owned values from the allowlisted article map, so no caller text
   * reaches the model through this channel at all.
   */
  contextualData: string | null;
  /** A contextual opening-message prompt referencing the article topic. */
  contextualPrompt: string | null;
}

/**
 * Injects page context into the conversation.
 *
 * @param pageContext - raw untrusted page context from the browser
 * @returns the injection result. All fields are null when the context is
 * absent, invalid, injection-flagged, or maps to no article.
 */
export function injectContext(pageContext: unknown): ContextInjectionResult {
  const validated = validatePageContext(pageContext);

  if (validated === null || validated.url === undefined) {
    return {
      articleMapping: null,
      articleContent: null,
      contextualData: null,
      contextualPrompt: null,
    };
  }

  const mapping = findArticleMapping(validated.url);
  if (mapping === null) {
    return {
      articleMapping: null,
      articleContent: null,
      contextualData: null,
      contextualPrompt: null,
    };
  }

  const doc = getArticleById(mapping.articleId);
  const articleContent = doc ? doc.content : null;

  return {
    articleMapping: mapping,
    articleContent,
    contextualData: buildContextualDataBlock(mapping),
    contextualPrompt: mapping.contextualPrompt,
  };
}

/**
 * Builds the data block describing the article the visitor is reading.
 *
 * SEC-12: only app-owned values are included — `mapping.articleId` and
 * `mapping.topic` come from the allowlisted article map, not from the caller.
 * The page-supplied title is omitted entirely: it adds nothing the article map
 * does not already carry, and dropping it removes the only caller-controlled
 * string that used to reach the model. Nothing here needs escaping because
 * nothing here is attacker-controlled; the block is still delivered as a
 * user-role data block, never as system text.
 */
export function buildContextualDataBlock(mapping: ArticleMapping): string {
  return [`article_id: ${mapping.articleId}`, `topic: ${mapping.topic}`].join('\n');
}
