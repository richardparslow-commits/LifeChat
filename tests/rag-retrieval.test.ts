/**
 * Tests for the RAG Retrieval Service (Section 4.6)
 *
 * Verifies retrieval ranking, sufficient-evidence threshold,
 * corpus coverage, formatting, and citation extraction.
 */

import {
  retrieveFromCorpus,
  formatRetrievedContext,
  passagesToCitations,
} from '../src/rag/retrieval';

describe('RAG Retrieval — retrieveFromCorpus', () => {
  test('returns passages for "term life insurance"', () => {
    const result = retrieveFromCorpus('What is term life insurance?');
    expect(result.passages.length).toBeGreaterThan(0);
    expect(result.hasSufficientEvidence).toBe(true);
  });

  test('returns passages for Texas advertising law queries', () => {
    const result = retrieveFromCorpus('What does Texas insurance law say about advertising?');
    expect(result.passages.length).toBeGreaterThan(0);
    expect(result.hasSufficientEvidence).toBe(true);
  });

  test('returns passages for privacy/health data queries', () => {
    const result = retrieveFromCorpus('What is sensitive data under Texas privacy law?');
    expect(result.passages.length).toBeGreaterThan(0);
    expect(result.hasSufficientEvidence).toBe(true);
  });

  test('returns passages for cost/premium queries', () => {
    const result = retrieveFromCorpus('What factors affect life insurance cost and premium?');
    expect(result.passages.length).toBeGreaterThan(0);
  });

  test('returns passages for legacy planning queries', () => {
    const result = retrieveFromCorpus('What is legacy planning?');
    expect(result.passages.length).toBeGreaterThan(0);
  });

  test('returns no passages for completely unrelated queries', () => {
    const result = retrieveFromCorpus('quantum physics supercollider');
    expect(result.passages.length).toBe(0);
    expect(result.hasSufficientEvidence).toBe(false);
  });

  test('returns no passages for empty query', () => {
    const result = retrieveFromCorpus('');
    expect(result.passages.length).toBe(0);
    expect(result.hasSufficientEvidence).toBe(false);
  });

  test('returns no passages for stop-word-only query', () => {
    const result = retrieveFromCorpus('the what is a of');
    expect(result.passages.length).toBe(0);
  });

  test('respects topK limit', () => {
    const result = retrieveFromCorpus('life insurance', 2);
    expect(result.passages.length).toBeLessThanOrEqual(2);
  });

  test('default topK is 3', () => {
    // A broad query that should match multiple docs
    const result = retrieveFromCorpus('life insurance policy coverage term whole');
    expect(result.passages.length).toBeLessThanOrEqual(3);
  });

  test('Texas law sources rank higher for regulatory queries', () => {
    const result = retrieveFromCorpus('Texas insurance advertising rules regulation');
    expect(result.passages.length).toBeGreaterThan(0);
    // The top passage should be a regulatory source (jurisdiction: Texas)
    expect(result.passages[0].jurisdiction).toBe('Texas');
  });

  test('term vs whole life article ranks high for product comparison queries', () => {
    const result = retrieveFromCorpus('difference between term and whole life insurance');
    // The term vs whole life article should be in the results
    const titles = result.passages.map((p) => p.title);
    expect(titles.some((t) => t.includes('Term vs. Whole Life'))).toBe(true);
  });

  test('all passages have required fields', () => {
    const result = retrieveFromCorpus('life insurance');
    for (const passage of result.passages) {
      expect(passage.title).toBeTruthy();
      expect(passage.url).toMatch(/^https?:\/\//);
      expect(passage.content).toBeTruthy();
      expect(passage.jurisdiction).toBeTruthy();
      expect(passage.score).toBeGreaterThan(0);
    }
  });

  test('passages are sorted by score descending', () => {
    const result = retrieveFromCorpus('Texas insurance law advertising rules regulation coverage');
    for (let i = 1; i < result.passages.length; i++) {
      expect(result.passages[i].score).toBeLessThanOrEqual(result.passages[i - 1].score);
    }
  });
});

describe('RAG Retrieval — formatRetrievedContext', () => {
  test('returns empty string for no passages', () => {
    expect(formatRetrievedContext([])).toBe('');
  });

  test('includes source markers for single passage', () => {
    const passages = retrieveFromCorpus('term life insurance').passages.slice(0, 1);
    const formatted = formatRetrievedContext(passages);
    expect(formatted).toContain('[Source 1]');
    expect(formatted).toContain('Title:');
    expect(formatted).toContain('URL:');
    expect(formatted).toContain('Content:');
  });

  test('separates passages with delimiters', () => {
    const passages = retrieveFromCorpus('life insurance Texas').passages.slice(0, 2);
    if (passages.length >= 2) {
      const formatted = formatRetrievedContext(passages);
      expect(formatted).toContain('---');
      expect(formatted).toContain('[Source 1]');
      expect(formatted).toContain('[Source 2]');
    }
  });
});

describe('RAG Retrieval — passagesToCitations', () => {
  test('converts passages to citation objects', () => {
    const passages = retrieveFromCorpus('term life').passages.slice(0, 2);
    const citations = passagesToCitations(passages);
    expect(citations.length).toBe(passages.length);
    for (let i = 0; i < passages.length; i++) {
      expect(citations[i].title).toBe(passages[i].title);
      expect(citations[i].url).toBe(passages[i].url);
    }
  });

  test('returns empty array for no passages', () => {
    expect(passagesToCitations([])).toEqual([]);
  });

  test('citations have valid URL format', () => {
    const passages = retrieveFromCorpus('life insurance').passages;
    const citations = passagesToCitations(passages);
    for (const c of citations) {
      expect(c.url).toMatch(/^https?:\/\//);
    }
  });
});
