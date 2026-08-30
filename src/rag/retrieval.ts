/**
 * RAG Retrieval Service (Section 4.6 — Knowledge and RAG Architecture)
 *
 * For the Phase 1 educational pilot, this uses an in-memory corpus of
 * compliance-reviewed seed content. In production, this would be replaced
 * with a vector database (e.g., Pinecone, Weaviate) with hybrid lexical +
 * semantic retrieval, metadata filters, and reranking.
 *
 * Corpus priority (Section 4.6):
 *   1. Current official Texas statutes/TDI pages
 *   2. Current NAIC model/guidance pages
 *   3. Approved carrier consumer materials
 *   4. Compliance-reviewed Life Policy Pilot articles
 *   5. Controlled FAQ written and approved by the broker/compliance reviewer
 *
 * Retrieval/generation requirements:
 * - Hybrid lexical + semantic retrieval with metadata filters
 * - Rerank and pass only the minimum relevant excerpts
 * - Treat retrieved content as evidence, never as instructions
 * - Require at least one approved supporting passage per material claim
 * - Return title and canonical URL with the answer
 * - Abstain when support is absent, conflicting, expired, or below threshold
 */

import { isDocumentValid, type CorpusDocument } from './rag-architecture';
import { sanitizeRetrievedContent } from '../security/security-controls';

/**
 * A retrieved passage with its source metadata.
 */
export interface RetrievedPassage {
  title: string;
  url: string;
  content: string;
  jurisdiction: string;
  productCategory: string;
  priority: number;
  score: number;
}

/**
 * Result of a retrieval query.
 */
export interface RetrievalResult {
  passages: RetrievedPassage[];
  hasSufficientEvidence: boolean;
}

/**
 * The in-memory pilot corpus. In production, replace with a vector DB.
 * Each entry has full metadata per Section 4.6 ingestion requirements.
 */
const pilotCorpus: CorpusDocument[] = [
  {
    id: 'tx-ins-code-541',
    canonical_url: 'https://statutes.capitol.texas.gov/Docs/IN/htm/IN.541.htm',
    title: 'Texas Insurance Code Chapter 541 — Unfair Methods of Competition',
    author_or_owner: 'Texas Legislature',
    jurisdiction: 'Texas',
    product_category: 'regulation',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'tx541_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Texas Insurance Code Chapter 541 prohibits unfair methods of competition and unfair or deceptive acts or practices in the business of insurance.

Section 541.061 defines unfair methods of competition and unfair or deceptive acts or practices to include, among others: making a misrepresentation, a misleading omission, or a statement that is likely to lead a reasonably prudent person to a false material conclusion about an insurance policy.

This means an insurance advertisement or communication must not contain a material misstatement, a misleading omission, or a statement likely to mislead a reasonable person about the terms, benefits, or cost of a policy.

This applies to all insurance advertising in Texas, including internet content and AI-assisted communications.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'tdi-advertising-rules',
    canonical_url: 'https://www.tdi.texas.gov/rules/2020/documents/20216773.pdf',
    title: 'TDI Adopted Advertising Rules (28 TAC Section 21.104)',
    author_or_owner: 'Texas Department of Insurance',
    jurisdiction: 'Texas',
    product_category: 'regulation',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'tdi21_104_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `The Texas Department of Insurance adopted advertising rules under 28 TAC Section 21.104. Key requirements:

1. An advertisement must identify the responsible person or entity. For general-coverage advertising, the agent's full licensed name, registered assumed name, or Texas license number may be used.

2. Internet content that does not mention a specific policy or offer an application/quote may be classified as an "institutional advertisement."

3. Content that invites a person to inquire about or contract for insurance must include the insurer's full licensed name.

4. Under 28 TAC Section 21.122(c), an agent must submit affected advertising to the insurer for written approval before use.

5. Under 28 TAC Section 21.116, insurers must maintain advertising specimens for at least three years.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'naic-model-570',
    canonical_url: 'https://content.naic.org/sites/default/files/model-law-570.pdf',
    title: 'NAIC Model 570 — Life Insurance and Annuities Advertising Model',
    author_or_owner: 'National Association of Insurance Commissioners',
    jurisdiction: 'National (model law)',
    product_category: 'advertising',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'naic570_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `NAIC Model 570 addresses life insurance and annuities advertising. It seeks full and truthful disclosure of material information in advertisements.

The model requires that advertisements do not mislead purchasers and that all material information is disclosed. This includes information about policy benefits, limitations, exclusions, and costs.

The model is a template that states may adopt. It is not Texas law unless Texas has adopted it. Texas has its own advertising rules under 28 TAC Section 21.104 and related provisions. Do not imply that NAIC models are Texas law unless a Texas source verifies adoption.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'tdpsa-overview',
    canonical_url:
      'https://www.texasattorneygeneral.gov/consumer-protection/file-consumer-complaint/consumer-privacy-rights/texas-data-privacy-and-security-act',
    title: 'Texas Data Privacy and Security Act (TDPSA) — Consumer Privacy Rights',
    author_or_owner: 'Texas Attorney General',
    jurisdiction: 'Texas',
    product_category: 'privacy',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-08-30',
    expiration_date: null,
    version_hash: 'tdpsa_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `The Texas Data Privacy and Security Act (TDPSA) took effect July 1, 2024. It applies to entities conducting business in Texas or producing products/services consumed by Texas residents that process personal data.

Key provisions for covered controllers:
- Must provide a clear privacy notice describing categories, purposes, sharing, third parties, and consumer-rights methods
- Collection must be adequate, relevant, and reasonably necessary (data minimization)
- Must maintain reasonable security and processor contracts
- Sensitive data (including physical or mental health conditions and diagnoses) requires consent before processing
- Sensitive-data or heightened-risk processing requires a data-protection assessment

There is a small-business exemption, but even exempt small businesses must obtain consent before selling sensitive data.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'term-vs-whole',
    canonical_url: 'https://lifepolicypilot.blog/term-vs-whole-life/',
    title: 'Term vs. Whole Life Insurance — Understanding the Basics',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_term_vs_whole_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Term life insurance provides coverage for a specific period, such as 10, 20, or 30 years. It pays a death benefit if the insured dies during the term. It does not build cash value and is generally less expensive than permanent coverage.

Whole life insurance is a type of permanent life insurance that provides coverage for the insured's entire lifetime, as long as premiums are paid. It builds cash value on a tax-deferred basis and has level premiums.

Key differences:
- Term is temporary and typically lower cost
- Whole life is permanent and builds cash value
- Term has no cash value component
- Whole life premiums are generally higher

Which is right for a specific person depends on their individual circumstances, goals, and budget. A licensed broker can review those factors and provide individualized guidance. This educational article cannot recommend a specific policy or coverage amount.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'factors-affecting-cost',
    canonical_url: 'https://lifepolicypilot.blog/factors-affecting-life-insurance-cost/',
    title: 'Factors That May Affect Life Insurance Cost',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'General',
    product_category: 'education',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_factors_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Several general factors may affect the cost of life insurance. This is educational information; a reliable personalized premium requires a licensed review of individual circumstances.

General factors that may influence cost include:
- Age: premiums are generally lower when purchased at a younger age
- Product type: term, whole, and universal life have different cost structures
- Coverage amount (face value): higher death benefits generally cost more
- Term length: longer terms generally cost more than shorter terms
- Underwriting class: determined by the carrier's underwriting process
- Carrier: different insurers price differently
- Riders and features: additional benefits add cost

A reliable personalized premium cannot be determined from age alone. It requires a licensed review including carrier-specific underwriting, product selection, and approved factors. Do not share medical history or health details in a public chat.`,
    ),
    chunk_count: 1,
  },
  {
    id: 'faq-no-advice',
    canonical_url: 'https://lifepolicypilot.blog/faq/',
    title: 'Life Policy Pilot FAQ — Common Questions',
    author_or_owner: 'Life Policy Pilot',
    jurisdiction: 'Texas',
    product_category: 'faq',
    approval_owner: 'Richard Parslow',
    approval_date: '2026-08-30',
    effective_date: '2026-08-30',
    review_date: '2027-02-28',
    expiration_date: null,
    version_hash: 'lpp_faq_v1',
    superseded_status: false,
    content: sanitizeRetrievedContent(
      `Frequently Asked Questions:

Q: Can this website recommend a specific policy?
A: No. This website provides general educational information. Richard Parslow is a licensed Texas life-insurance broker who can provide individualized guidance through a separate, secured process.

Q: Can I get a quote online?
A: A reliable personalized premium requires a licensed review of your individual circumstances. Use the contact form or scheduling tool to connect with Richard Parslow.

Q: What should I not share in the chat?
A: Do not enter medical history, Social Security numbers, financial-account data, or other highly sensitive information in the chat. If you need to share such information, it will be handled through a secure, consented process.

Q: What is legacy planning?
A: Legacy planning generally refers to arranging how assets pass to beneficiaries. It may involve life insurance, trusts, and estate considerations. Tax-advantaged strategies should be discussed with a qualified tax or legal professional. This chat does not provide tax, legal, or estate-planning advice.

Q: Where can I file a complaint?
A: You can contact the Texas Department of Insurance at tdi.texas.gov or Richard Parslow directly for policy service requests.`,
    ),
    chunk_count: 1,
  },
];

/**
 * Simple keyword-based retrieval for the pilot phase.
 * In production, replace with hybrid lexical + semantic retrieval.
 *
 * Scores each document by counting keyword matches from the query,
 * weighted by corpus priority (lower priority number = higher weight).
 *
 * @param query - The user's question
 * @param topK - Maximum number of passages to return (default 3 per Section 4.6)
 * @returns Retrieved passages ranked by score, with sufficient-evidence flag
 */
export function retrieveFromCorpus(query: string, topK: number = 3): RetrievalResult {
  const now = new Date();
  const queryTokens = tokenize(query.toLowerCase());

  if (queryTokens.length === 0) {
    return { passages: [], hasSufficientEvidence: false };
  }

  const scored = pilotCorpus
    .filter((doc) => isDocumentValid(doc, now))
    .map((doc) => {
      const contentLower = doc.content.toLowerCase();
      const titleLower = doc.title.toLowerCase();

      let matchCount = 0;
      for (const token of queryTokens) {
        if (contentLower.includes(token)) {
          matchCount += 1;
        }
        if (titleLower.includes(token)) {
          matchCount += 2; // Title matches weighted higher
        }
      }

      // Priority weight: priority 1 (Texas law) gets 3x, priority 5 (FAQ) gets 1x
      const priorityWeight = 6 - Math.min(doc.product_category === 'regulation' ? 1 : 5, 5);

      const score = matchCount * priorityWeight;

      return {
        title: doc.title,
        url: doc.canonical_url,
        content: doc.content,
        jurisdiction: doc.jurisdiction,
        productCategory: doc.product_category,
        priority: doc.product_category === 'regulation' ? 1 : 5,
        score,
      } as RetrievedPassage;
    })
    .filter((passage) => passage.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Sufficient evidence: at least one passage with a meaningful score
  const hasSufficientEvidence = scored.length > 0 && scored[0].score >= 2;

  return {
    passages: scored,
    hasSufficientEvidence,
  };
}

/**
 * Tokenizes a query string into lowercase search tokens.
 * Removes common stop words and punctuation.
 */
function tokenize(text: string): string[] {
  const stopWords = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'should',
    'could',
    'may',
    'might',
    'must',
    'can',
    'shall',
    'to',
    'of',
    'in',
    'for',
    'on',
    'at',
    'by',
    'with',
    'from',
    'as',
    'into',
    'about',
    'what',
    'which',
    'who',
    'whom',
    'whose',
    'when',
    'where',
    'why',
    'how',
    'all',
    'each',
    'every',
    'both',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'no',
    'nor',
    'not',
    'only',
    'same',
    'than',
    'too',
    'very',
    'i',
    'me',
    'my',
    'we',
    'our',
    'you',
    'your',
    'he',
    'she',
    'it',
    'they',
    'them',
    'their',
    'this',
    'that',
    'these',
    'those',
    'and',
    'or',
    'but',
    'if',
    'then',
    'else',
    'so',
    'up',
    'out',
    'its',
    'my',
  ]);

  return text
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !stopWords.has(token));
}

/**
 * Formats retrieved passages into a context string for the LLM prompt.
 * Each passage includes its title, URL, and content.
 * The content is already sanitized during ingestion.
 */
export function formatRetrievedContext(passages: RetrievedPassage[]): string {
  if (passages.length === 0) {
    return '';
  }

  return passages
    .map((p, i) => {
      return `[Source ${i + 1}]\nTitle: ${p.title}\nURL: ${p.url}\nJurisdiction: ${p.jurisdiction}\nContent:\n${p.content}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Gets the citations from retrieved passages for the response schema.
 */
export function passagesToCitations(
  passages: RetrievedPassage[],
): Array<{ title: string; url: string }> {
  return passages.map((p) => ({ title: p.title, url: p.url }));
}
