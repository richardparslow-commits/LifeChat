/**
 * The vocabulary ↔ phenome crosswalk — every condition 1.4.0 added, marked
 * against the PTSD phenome map.
 *
 * What this suite pins, in the order the rules demand:
 *   - the crosswalk covers exactly the codes the 1.4.0 changelog added, both
 *     directions, so a new release cannot skip the check and a stale entry
 *     cannot linger;
 *   - a `graded_row` verdict points at a row that exists and repeats that row's
 *     tier, so the crosswalk cannot drift from the map it is reading;
 *   - a mark is never bare: it names a deciding rule, and a `not_a_sequela`
 *     exclusion says why the condition cannot follow a later exposure;
 *   - a condition the §12 sweep cannot place carries the gap in words rather
 *     than being forced into an unrelated domain.
 */

import { readFileSync } from 'fs';
import path from 'path';

import {
  CANONICAL_CONDITIONS,
  CONDITION_SYSTEMS,
  getCanonicalConditionByCode,
} from '../src/medical/condition-crosswalk';
import {
  SEQUELAE_CROSSWALK,
  SEQUELAE_CROSSWALK_RELEASE,
  SEQUELAE_CROSSWALK_VERSION,
  isPhenomeDomain,
  sequelaeCrosswalkFor,
  summarizeSequelaeCrosswalk,
  vocabularyReleaseCodes,
} from '../src/phenome/sequelae-crosswalk';
import type { PhenomeMap } from '../src/phenome/phenome-map-schema';

const MAP_PATH = path.join(__dirname, '..', 'src', 'phenome', 'ptsd-phenome-map.json');

function phenomeMap(): PhenomeMap {
  return JSON.parse(readFileSync(MAP_PATH, 'utf8')) as PhenomeMap;
}

describe('the vocabulary release the crosswalk claims to cover', () => {
  it('is exactly the 30 codes 1.4.0 added', () => {
    const releaseCodes = vocabularyReleaseCodes(SEQUELAE_CROSSWALK_RELEASE);
    expect(releaseCodes).toHaveLength(30);
    const crosswalkCodes = SEQUELAE_CROSSWALK.map((entry) => entry.icd10_cm);
    expect(new Set(crosswalkCodes).size).toBe(crosswalkCodes.length);
    expect([...crosswalkCodes].sort()).toEqual([...releaseCodes].sort());
    expect(SEQUELAE_CROSSWALK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('names conditions that exist in the vocabulary, with real systems', () => {
    for (const entry of SEQUELAE_CROSSWALK) {
      const condition = getCanonicalConditionByCode(entry.icd10_cm);
      expect(condition).not.toBeNull();
      expect((CONDITION_SYSTEMS as readonly string[]).includes(entry.system)).toBe(true);
      expect(entry.name.length).toBeGreaterThan(3);
    }
    // The crosswalk is a subset of one release — it must never grow past it.
    expect(SEQUELAE_CROSSWALK.length).toBeLessThanOrEqual(CANONICAL_CONDITIONS.length);
  });
});

describe('every mark', () => {
  it('is one of the three verdicts, and each verdict is earned', () => {
    for (const entry of SEQUELAE_CROSSWALK) {
      const label = `${entry.icd10_cm} ${entry.name}`;
      expect(['graded_row', 'd_no_studies', 'not_a_sequela']).toContain(entry.verdict);
      expect(entry.rationale.length).toBeGreaterThan(60);
      expect(entry.next_step.length).toBeGreaterThan(30);

      if (entry.verdict === 'graded_row') {
        expect(entry.phenome_rows.length).toBeGreaterThan(0);
        expect(entry.phenome_tier).not.toBeNull();
      }
      if (entry.verdict === 'd_no_studies') {
        // R43 — a "no studies" mark must name the rule it rests on rather than
        // asserting an absence in prose.
        expect(entry.rationale).toMatch(/R\d+|§12|§3|§11/);
      }
      if (entry.verdict === 'not_a_sequela') {
        // An exclusion is about onset or etiology, and says so.
        expect(entry.rationale).toMatch(
          /onset|birth|conception|hereditary|developmental|precedes/i,
        );
      }
      expect(label).toBeTruthy();
    }
  });

  it('places the condition in a §12 domain or states the sweep gap', () => {
    for (const entry of SEQUELAE_CROSSWALK) {
      if (entry.domain === null) {
        expect(entry.domain_gap).not.toBeNull();
        expect((entry.domain_gap ?? '').length).toBeGreaterThan(30);
      } else {
        expect(isPhenomeDomain(entry.domain)).toBe(true);
        expect(entry.domain_gap).toBeNull();
      }
    }
  });

  it('resolves every referenced phenome row, and repeats its tier', () => {
    const map = phenomeMap();
    const rows = new Map(map.rows.map((row) => [row.id, row]));
    for (const entry of SEQUELAE_CROSSWALK) {
      for (const rowId of entry.phenome_rows) {
        const row = rows.get(rowId);
        expect(row).toBeDefined();
        expect(row?.direction).toBe('index_to_outcome');
      }
      if (entry.phenome_tier !== null) {
        // The tier is the row's own grade, not the crosswalk's opinion of it.
        const tiers = entry.phenome_rows
          .map((rowId) => rows.get(rowId)?.evidence_tier)
          .filter((tier): tier is NonNullable<typeof tier> => tier !== undefined);
        expect(tiers).toContain(entry.phenome_tier);
      }
    }
  });
});

describe('what the first cross-check actually found', () => {
  const summary = summarizeSequelaeCrosswalk();

  it('is one covered condition, twenty-three study gaps, and six exclusions', () => {
    // Pinned deliberately: the headline is that the questionnaire sweep and the
    // phenome literature barely touch, and a future release that changes that
    // should have to say so here.
    expect(summary.total).toBe(30);
    expect(summary.byVerdict).toEqual({ graded_row: 1, d_no_studies: 23, not_a_sequela: 6 });
  });

  it('covers one condition with one row — and that row is tier D', () => {
    const covered = SEQUELAE_CROSSWALK.filter((entry) => entry.verdict === 'graded_row');
    expect(covered.map((entry) => entry.icd10_cm)).toEqual(['I47.9']);
    expect(covered[0].phenome_rows).toEqual(['ptsd-to-arrhythmia-sudden-cardiac-death']);
    expect(covered[0].phenome_tier).toBe('D');
  });

  it('lists the conditions the §12 sweep cannot place, with the gap', () => {
    const gaps = summary.domainGaps;
    expect(gaps).toHaveLength(9);
    expect(gaps.map((gap) => gap.icd10_cm).sort()).toEqual(
      ['H33.20', 'I86.1', 'I89.0', 'L70.0', 'L91.0', 'Q35.9', 'Q66.89', 'Q96.9', 'Q99.2'].sort(),
    );
    for (const gap of gaps) expect(gap.domain_gap.length).toBeGreaterThan(30);
  });

  it('excludes only conditions whose onset precedes the index exposure', () => {
    const excluded = SEQUELAE_CROSSWALK.filter((entry) => entry.verdict === 'not_a_sequela');
    expect(excluded.map((entry) => entry.icd10_cm).sort()).toEqual(
      ['F95.2', 'G71.0', 'Q35.9', 'Q66.89', 'Q96.9', 'Q99.2'].sort(),
    );
    for (const entry of excluded) expect(entry.phenome_rows).toEqual([]);
  });

  it('marks the infectious condition against the graded row it cannot inherit', () => {
    // Herpes simplex sits in domain 15, whose row is severe infection at tier B
    // — the one graded row any of the 30 codes can see. The mark records why it
    // still does not inherit that estimate (R8/R11).
    const herpes = sequelaeCrosswalkFor('b00.9');
    expect(herpes?.verdict).toBe('d_no_studies');
    expect(herpes?.phenome_rows).toEqual(['ptsd-to-severe-infection']);
    expect(herpes?.phenome_tier).toBe('B');
    expect(herpes?.rationale).toMatch(/severe|hospitalized/i);
  });
});
