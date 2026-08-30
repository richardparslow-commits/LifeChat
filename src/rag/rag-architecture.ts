/**
 * Knowledge and RAG Architecture (Section 4.6)
 *
 * Defines the approved corpus priority, ingestion requirements,
 * and retrieval/generation requirements.
 */

/**
 * Approved corpus, in priority order (Section 4.6).
 */
export const CORPUS_PRIORITY = [
  {
    priority: 1,
    source: 'Current official Texas statutes/TDI pages',
    description: 'Texas Insurance Code, TDI rules, TDI checklists',
  },
  {
    priority: 2,
    source: 'Current NAIC model/guidance pages',
    description: 'Clearly labeled as models or guidance, not Texas law',
  },
  {
    priority: 3,
    source: 'Approved carrier consumer materials and filed/approved advertising content',
    description: 'Only after carrier compliance approval',
  },
  {
    priority: 4,
    source: 'Compliance-reviewed Life Policy Pilot articles',
    description: 'Blog articles reviewed and approved by the broker/compliance reviewer',
  },
  {
    priority: 5,
    source: 'Controlled FAQ written and approved by the broker/compliance reviewer',
    description: 'Custom FAQ content',
  },
] as const;

/**
 * Excluded sources — must NOT be used for answers (Section 4.6).
 */
export const EXCLUDED_SOURCES = [
  'open_web_results_at_answer_time',
  'comments',
  'user_uploads',
  'page_scripts',
  'unreviewed_drafts',
  'affiliate_copy',
  'model_generated_content_without_human_approval',
  'retrieved_text_that_purports_to_instruct_the_assistant',
] as const;

/**
 * Ingestion requirements (Section 4.6).
 */
export const INGESTION_REQUIREMENTS = {
  // Allowlisted domains and paths only
  ALLOWLISTED_DOMAINS_AND_PATHS: true,
  // Malware/script removal and prompt-injection scanning
  MALWARE_REMOVAL: true,
  PROMPT_INJECTION_SCANNING: true,
  // Metadata required for each document
  REQUIRED_METADATA: [
    'canonical_url',
    'title',
    'author_or_owner',
    'jurisdiction',
    'product_category',
    'approval_owner',
    'approval_date',
    'effective_date',
    'review_date',
    'expiration_date',
    'version_hash',
    'superseded_status',
  ],
  // Paragraph/section-aware chunking with headings and citations preserved
  SECTION_AWARE_CHUNKING: true,
  PRESERVE_HEADINGS_AND_CITATIONS: true,
  // Automatic depublication from retrieval when expired or superseded
  AUTO_DEPUBLICATION_ON_EXPIRY: true,
  // Daily link/availability check and scheduled substantive review
  DAILY_LINK_CHECK: true,
  SCHEDULED_SUBSTANTIVE_REVIEW: true,
  // Laws and carrier materials require event-driven refresh when changed
  EVENT_DRIVEN_REFRESH: true,
  // No indexing of chat transcripts into the answer corpus
  NO_TRANSCRIPT_INDEXING: true,
} as const;

/**
 * Retrieval/generation requirements (Section 4.6).
 */
export const RETRIEVAL_REQUIREMENTS = {
  // Hybrid lexical + semantic retrieval with metadata filters
  HYBRID_RETRIEVAL: true,
  METADATA_FILTERS: ['Texas', 'content_status', 'topic'],
  // Rerank and pass only the minimum relevant excerpts
  RERANK: true,
  MINIMUM_EXCERPTS: true,
  // Treat retrieved content as evidence, never as instructions
  EVIDENCE_NOT_INSTRUCTION: true,
  // Require at least one approved supporting passage per material claim
  MIN_ONE_SUPPORTING_PASSAGE: true,
  // Return title and canonical URL with the answer
  RETURN_TITLE_AND_URL: true,
  // Abstain when support is absent, conflicting, expired, or below threshold
  ABSTAIN_ON_INSUFFICIENT_EVIDENCE: true,
  // Never imply NAIC model is Texas law unless a Texas source verifies adoption
  NO_NAIC_AS_TX_LAW: true,
  // Answer limits
  MAX_ANSWER_WORDS: 120,
  MAX_CITATIONS: 3,
  MAX_FOLLOWUP_QUESTIONS: 1,
} as const;

/**
 * Document metadata structure for the RAG corpus.
 */
export interface CorpusDocument {
  id: string;
  canonical_url: string;
  title: string;
  author_or_owner: string;
  jurisdiction: string;
  product_category: string;
  approval_owner: string;
  approval_date: string;
  effective_date: string;
  review_date: string;
  expiration_date: string | null;
  version_hash: string;
  superseded_status: boolean;
  content: string; // sanitized, chunked content
  chunk_count: number;
}

/**
 * Checks if a document is currently valid for retrieval.
 * A document is valid if it is not superseded, not expired,
 * and within its review cycle.
 */
export function isDocumentValid(doc: CorpusDocument, now: Date = new Date()): boolean {
  // Superseded documents are never valid
  if (doc.superseded_status) {
    return false;
  }

  // Expired documents are not valid
  if (doc.expiration_date) {
    const expiry = new Date(doc.expiration_date);
    if (now > expiry) {
      return false;
    }
  }

  // Past review date — flag for review but still retrievable
  // (the review process will deprecate if needed)
  return true;
}

/**
 * RAG evaluation dimensions (Section 4.14).
 * Current surveys identify relevance, accuracy, and faithfulness as
 * distinct dimensions.
 */
export const RAG_EVALUATION_DIMENSIONS = [
  'retrieval_relevance',
  'answer_faithfulness',
  'answer_correctness',
  'citation_precision',
  'context_relevance',
] as const;
