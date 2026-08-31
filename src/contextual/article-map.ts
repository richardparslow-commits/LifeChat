/**
 * URL → Article Mapping (Contextual Content Bridge)
 *
 * Maps the URL a user is reading to a known Life Policy Pilot article so the
 * bridge can prioritize its content in RAG retrieval and build a contextual
 * opening message. All text here is compliance-reviewed educational prompts:
 * they reference the article TOPIC as a signal of interest, never the user's
 * personal circumstances.
 *
 * articleId values align with ids in the RAG corpus (src/rag/retrieval.ts)
 * where the article content exists. Article ids with no matching corpus doc
 * still yield a contextual opening prompt (content is simply absent).
 */

/** A single URL→article mapping. */
export interface ArticleMapping {
  /** Regex tested against the page URL. */
  urlPattern: RegExp;
  /** Corpus/editorial identifier for the article. */
  articleId: string;
  /** Human topic label (education, not personal). */
  topic: string;
  /** Compliance-reviewed contextual opening prompt. */
  contextualPrompt: string;
}

/** Ordered list of URL→article mappings. First match wins. */
const articleMappings: ArticleMapping[] = [
  {
    urlPattern: /life-insurance-for-diabetics/i,
    articleId: 'article_diabetes_texas',
    topic: 'Diabetes and life insurance underwriting',
    contextualPrompt:
      "I see you're reading about life insurance for diabetics in Texas. I can answer questions about how general typing and underwriting categories work, or we can explore something else like policy types, coverage needs, or Texas-specific rules.",
  },
  {
    urlPattern: /term-vs-whole-life/i,
    articleId: 'term-vs-whole',
    topic: 'Term vs. whole life insurance',
    contextualPrompt:
      "I see you're reading about term vs. whole life insurance. I can explain the general differences, or we can explore coverage needs, riders, or Texas-specific rules.",
  },
  {
    urlPattern: /coverage-needs|how-much-life-insurance/i,
    articleId: 'coverage-needs-dime',
    topic: 'Coverage needs estimation (DIME method)',
    contextualPrompt:
      "I see you're reading about how much life insurance people might need. I can walk you through the DIME method, or we can explore policy types or Texas-specific rules.",
  },
  {
    urlPattern: /texas-life-insurance-laws|texas-regulatio/i,
    articleId: 'tx-ins-code-541',
    topic: 'Texas life insurance regulations',
    contextualPrompt:
      "I see you're reading about Texas life insurance laws. I can answer questions about state-specific rules, or we can explore policy types or coverage needs.",
  },
  {
    urlPattern: /life-insurance-for-cancer-survivors|after-cancer/i,
    articleId: 'article_cancer_survivors',
    topic: 'Life insurance for cancer survivors',
    contextualPrompt:
      "I see you're reading about life insurance after cancer. I can explain how underwriting and timelines are generally considered, or we can explore other topics like policy types or Texas-specific rules.",
  },
  {
    urlPattern: /life-insurance-riders/i,
    articleId: 'article_riders',
    topic: 'Life insurance riders',
    contextualPrompt:
      "I see you're reading about life insurance riders. I can explain what riders are in general, or we can explore policy types or coverage needs.",
  },
  {
    urlPattern: /final-expense|burial-insurance/i,
    articleId: 'article_final_expense',
    topic: 'Final expense insurance',
    contextualPrompt:
      "I see you're reading about final expense insurance. I can explain the general idea, or we can explore term life or coverage needs.",
  },
  {
    urlPattern: /underwriting/i,
    articleId: 'article_underwriting',
    topic: 'Life insurance underwriting',
    contextualPrompt:
      "I see you're reading about life insurance underwriting. I can explain how the general process works, or we can explore policy types or coverage needs.",
  },
  {
    urlPattern: /beneficiaries/i,
    articleId: 'article_beneficiaries',
    topic: 'Life insurance beneficiaries',
    contextualPrompt:
      "I see you're reading about life insurance beneficiaries. I can answer questions about that topic, or we can explore policy types or Texas-specific rules.",
  },
  {
    urlPattern: /life-insurance-for-seniors|senior-citizens/i,
    articleId: 'article_seniors',
    topic: 'Life insurance considerations in later years',
    contextualPrompt:
      "I see you're reading about life insurance for older adults. I can answer general questions about that topic, or we can explore final expense coverage or Texas-specific rules.",
  },
];

/**
 * Finds the first mapping whose URL pattern matches the given URL.
 * Returns null when no article matches.
 */
export function findArticleMapping(url: string): ArticleMapping | null {
  for (const mapping of articleMappings) {
    if (mapping.urlPattern.test(url)) {
      return mapping;
    }
  }
  return null;
}

export { articleMappings };
