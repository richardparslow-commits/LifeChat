/**
 * Editorial sign-off for the six corpus documents with no one-to-one article.
 *
 * A citation is a promise about where the reader is going, and the citation
 * label is what they read before clicking. The audit found six summaries
 * pointing at the closest live page with the summary's own title on the link —
 * accurate as a URL, misleading as a label. `src/rag/citation-mappings.ts` is
 * now the record; these tests prove it still describes the corpus it claims to
 * describe, and that no corpus document cites an orphaned or legacy URL.
 */

import { config } from '../src/config/app-config';
import {
  CITATION_MAPPINGS,
  citationMappingFor,
  citationMappingUrl,
} from '../src/rag/citation-mappings';
import {
  CORPUS_DOCUMENTS,
  getArticleById,
  passagesToCitations,
  type RetrievedPassage,
} from '../src/rag/retrieval';

const EXPECTED_DOCUMENT_IDS = [
  'add-overview',
  'child-life-overview',
  'insurable-interest-overview',
  'occupation-hobby-risk-overview',
  'pandemic-quarantine-overview',
  'policy-lapse-and-reinstatement',
];

const PUBLICATION_ORIGIN = config.websiteUrl.replace(/\/+$/, '');

describe('citation mapping registry', () => {
  it('covers exactly the six proxy-cited documents', () => {
    expect(CITATION_MAPPINGS.map((mapping) => mapping.documentId).sort()).toEqual(
      EXPECTED_DOCUMENT_IDS.slice().sort(),
    );
  });

  it('has one mapping per document and one document per destination', () => {
    const ids = CITATION_MAPPINGS.map((mapping) => mapping.documentId);
    const paths = CITATION_MAPPINGS.map((mapping) => mapping.publishedPath);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('keeps the retired path on file for provenance', () => {
    for (const mapping of CITATION_MAPPINGS) {
      expect(mapping.legacyPath.startsWith('/')).toBe(true);
      expect(mapping.legacyPath.endsWith('/')).toBe(true);
    }
  });
});

describe.each(CITATION_MAPPINGS)('mapping $documentId', (mapping) => {
  it('describes a corpus document that exists', () => {
    const document = getArticleById(mapping.documentId);
    expect(document).not.toBeNull();
    expect(document!.id).toBe(mapping.documentId);
  });

  it('resolves to the same URL the corpus document cites', () => {
    const document = getArticleById(mapping.documentId)!;
    expect(citationMappingUrl(mapping)).toBe(document.canonical_url);
    expect(document.canonical_url.startsWith(`${PUBLICATION_ORIGIN}/`)).toBe(true);
    expect(document.canonical_url).not.toContain('lifepolicypilot.blog');
    expect(mapping.publishedPath).not.toMatch(/^\/|\?|#/);
  });

  it('carries the live article title, so the link label matches the destination', () => {
    const document = getArticleById(mapping.documentId)!;
    expect(document.citation_title).toBe(mapping.publishedTitle);
    expect(mapping.publishedTitle).not.toMatch(/\bOverview \(Educational\)/);
  });

  it('records who signed the editorial call and when', () => {
    expect(mapping.reviewedBy.trim().length).toBeGreaterThan(0);
    expect(mapping.reviewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mapping.match === 'exact' || mapping.match === 'nearest').toBe(true);
    // Every one of the six is an approximation today, so each must explain
    // itself: what the page covers and what it does not.
    if (mapping.match === 'nearest') {
      expect(mapping.rationale.length).toBeGreaterThan(80);
      expect(mapping.rationale).toMatch(/does not|not a|no .* article/i);
    }
  });
});

describe('citation output', () => {
  it('shows the published title for a mapped document', () => {
    for (const mapping of CITATION_MAPPINGS) {
      const document = getArticleById(mapping.documentId)!;
      const passage: RetrievedPassage = {
        title: document.citation_title ?? document.title,
        url: document.canonical_url,
        content: document.content,
        jurisdiction: document.jurisdiction,
        productCategory: document.product_category,
        priority: 4,
        score: 1,
      };
      expect(passagesToCitations([passage])).toEqual([
        { title: mapping.publishedTitle, url: document.canonical_url },
      ]);
      // The summary's own title is still the internal one, so retrieval
      // scoring and the editorial record are not rewritten by the display fix.
      expect(document!.title).not.toBe(mapping.publishedTitle);
    }
  });

  it('leaves unmapped documents using their own title', () => {
    const unmapped = CORPUS_DOCUMENTS.find(
      (document) =>
        citationMappingFor(document.id) === null && document.citation_title === undefined,
    );
    expect(unmapped).toBeDefined();
    expect(unmapped!.title.length).toBeGreaterThan(0);
  });
});

describe('corpus citations', () => {
  it('gives every document an absolute https URL with no legacy host', () => {
    expect(CORPUS_DOCUMENTS.length).toBeGreaterThan(0);
    for (const document of CORPUS_DOCUMENTS) {
      // Primary sources (statutes, TDI, NAIC) are cited on their own official
      // hosts; the education documents are cited on the published site.
      expect(document.canonical_url).toMatch(/^https:\/\//);
      expect(document.canonical_url).not.toMatch(/\s/);
      expect(document.canonical_url).not.toContain('lifepolicypilot.blog');
    }
  });

  it('keeps every education citation on the published site', () => {
    const education = CORPUS_DOCUMENTS.filter(
      (document) => document.product_category === 'education',
    );
    expect(education.length).toBeGreaterThan(0);
    for (const document of education) {
      expect(document.canonical_url.startsWith(`${PUBLICATION_ORIGIN}/`)).toBe(true);
    }
  });

  it('has no mapping whose destination is missing from the corpus', () => {
    const urls = new Set(CORPUS_DOCUMENTS.map((document) => document.canonical_url));
    for (const mapping of CITATION_MAPPINGS) {
      expect(urls.has(citationMappingUrl(mapping))).toBe(true);
    }
  });
});
