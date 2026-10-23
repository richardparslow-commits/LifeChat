/**
 * Citation mappings for corpus documents whose topic has no one-to-one
 * published article on the host site.
 *
 * The corpus is an educational summary set; the website is a blog. Six
 * summaries originally cited a page that no longer exists under the new domain,
 * and each now points at the closest approved article. Two things made that
 * dangerous to leave implicit:
 *
 *  1. the corpus `title` was the summary's own title, so a citation labelled
 *     "Accidental Death & Dismemberment — Overview" linked to an article about
 *     riders — the reader lands somewhere the label did not promise; and
 *  2. nothing recorded that the match is approximate, so a future editor could
 *     not tell a deliberate nearest match from a mistake.
 *
 * This registry is the record: one entry per document, the live article's own
 * title (the H1, checked 2026-10-23), the retired path, and why this page is
 * the closest match. `tests/citation-mappings.test.ts` proves each entry still
 * matches the corpus document it describes, so the two cannot drift silently.
 *
 * A mapping with `match: 'exact'` needs no rationale; everything else must
 * explain itself and carry an editorial sign-off.
 */

import { publicationUrl } from '../config/app-config';

export interface CitationMapping {
  /** Corpus document id (`CorpusDocument.id`). */
  documentId: string;
  /** The retired path this summary was written for, kept for provenance. */
  legacyPath: string;
  /** Site-relative path the document's `canonical_url` uses today. */
  publishedPath: string;
  /** The live article's own H1, so the citation label matches the destination. */
  publishedTitle: string;
  /** Whether the page covers the topic or is the closest approved page. */
  match: 'exact' | 'nearest';
  /** Why this page, and what it does and does not cover. */
  rationale: string;
  /** Editorial sign-off for the mapping. */
  reviewedBy: string;
  /** ISO date of that sign-off. */
  reviewedOn: string;
}

export const CITATION_MAPPINGS: readonly CitationMapping[] = [
  {
    documentId: 'add-overview',
    legacyPath: '/accidental-death-and-dismemberment/',
    publishedPath: 'blog/life-insurance-riders-texas',
    publishedTitle: 'Life Insurance Riders in Texas: Which Ones Are Worth Paying For',
    match: 'nearest',
    rationale:
      'AD&D is sold as a rider, and the riders article covers accidental death explicitly, including when it is poor value. It does not cover the corpus summary’s dismemberment benefit schedule, so the citation supports the rider framing, not those figures.',
    reviewedBy: 'Richard Parslow',
    reviewedOn: '2026-10-23',
  },
  {
    documentId: 'child-life-overview',
    legacyPath: '/child-life-insurance/',
    publishedPath: 'blog/life-insurance-what-texas-families-need-to-know',
    publishedTitle: 'Life Insurance: What Texas Families Actually Need to Know',
    match: 'nearest',
    rationale:
      'There is no child-life article on the site. The family guide covers dependent coverage and the child rider in the context of a family policy, which is what the summary describes; it does not price standalone juvenile policies.',
    reviewedBy: 'Richard Parslow',
    reviewedOn: '2026-10-23',
  },
  {
    documentId: 'pandemic-quarantine-overview',
    legacyPath: '/pandemic-quarantine/',
    publishedPath: 'blog/life-insurance-past-medical-conditions',
    publishedTitle:
      'Applying for Life Insurance With Past Medical Conditions: Why Resolved Issues Still Count',
    match: 'nearest',
    rationale:
      'The site has no pandemic-specific article. Underwriting of past and resolved conditions is the mechanism the summary explains (carriers price long-term risk from history), and this article covers that process; it does not make pandemic or quarantine claims.',
    reviewedBy: 'Richard Parslow',
    reviewedOn: '2026-10-23',
  },
  {
    documentId: 'insurable-interest-overview',
    legacyPath: '/insurable-interest/',
    publishedPath: 'blog/life-insurance-beneficiary-rules-texas',
    publishedTitle:
      'Life Insurance Beneficiary Rules in Texas: Community Property, Minors, and Divorce',
    match: 'nearest',
    rationale:
      'Insurable interest is discussed in the beneficiary context — who may be named and whose interest supports the policy — which this article covers for Texas (community property, minors, divorce). It is not a standalone insurable-interest treatise.',
    reviewedBy: 'Richard Parslow',
    reviewedOn: '2026-10-23',
  },
  {
    documentId: 'occupation-hobby-risk-overview',
    legacyPath: '/occupation-hobby-risk/',
    publishedPath: 'blog/how-life-insurance-underwriting-works-texas',
    publishedTitle: 'How Life Insurance Underwriting Works in Texas: APS, MIB, and Your Rate Class',
    match: 'nearest',
    rationale:
      'Occupational and avocational risk enters through underwriting: the application, the MIB file and the rate class. This article explains that pipeline; it does not publish a per-occupation table, so the summary’s examples are not restated there.',
    reviewedBy: 'Richard Parslow',
    reviewedOn: '2026-10-23',
  },
  {
    documentId: 'policy-lapse-and-reinstatement',
    legacyPath: '/policy-lapse-reinstatement/',
    publishedPath: 'blog/contestability-period-life-insurance-texas',
    publishedTitle:
      'The Texas Life Insurance Contestability Period: What the 2-Year Rule Really Means',
    match: 'nearest',
    rationale:
      'The weakest of the six. The contestability article does not cover lapse and reinstatement mechanics; it mentions the grace period only as statutory context (Texas Insurance Code §1131). A dedicated article is the right long-term fix; until one exists, this page is the closest approved source and the claim should stay general.',
    reviewedBy: 'Richard Parslow',
    reviewedOn: '2026-10-23',
  },
];

/** The mapping for a corpus document, or null when it cites its own page. */
export function citationMappingFor(documentId: string): CitationMapping | null {
  return CITATION_MAPPINGS.find((mapping) => mapping.documentId === documentId) ?? null;
}

/** The absolute URL a mapping's citation resolves to. */
export function citationMappingUrl(mapping: CitationMapping): string {
  return publicationUrl(mapping.publishedPath);
}
