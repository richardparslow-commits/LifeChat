/**
 * The machine-readable PTSD phenome map — schema, rule checks, and the two
 * declared ledgers.
 *
 * This is the suite the map was built for (phases 0–3 of the phenome work): the
 * map is JSON so its tiers, conflicts, and verification status can be validated
 * automatically rather than read. What it pins:
 *
 *   - the committed map validates against the §14 row schema with zero errors;
 *   - every rule violation left in the map is *declared* — a row-level violation
 *     in `rule_tensions`, or a domain-coverage violation named in the §12
 *     coverage open item — so nothing is waived silently and nothing declared is
 *     unreal;
 *   - coverage, versions, and the verification ledger hold two ways.
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';

import {
  PHENOME_MAP_ID,
  PHENOME_MAP_VERSION,
  PHENOME_DOMAINS,
  validatePhenomeMap,
  auditTierAGateGaps,
  type PhenomeMap,
} from '../src/phenome/phenome-map-schema';

const MAP_PATH = path.join(__dirname, '..', 'src', 'phenome', 'ptsd-phenome-map.json');

function loadMap(): { raw: PhenomeMap; map: PhenomeMap } {
  const raw = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as PhenomeMap;
  const result = validatePhenomeMap(raw);
  expect(result.schemaErrors).toEqual([]);
  expect(result.map).not.toBeNull();
  return { raw, map: result.map as PhenomeMap };
}

describe('the committed phenome map', () => {
  it('validates against the §14 schema with zero errors', () => {
    const raw = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as PhenomeMap;
    const result = validatePhenomeMap(raw);
    expect(result.schemaErrors).toEqual([]);
    expect(result.map?.map_id).toBe(PHENOME_MAP_ID);
    expect(result.map?.map_version).toBe(PHENOME_MAP_VERSION);
    expect(result.map?.rules_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.map?.review.status).toBe('unsigned');
    expect(result.map?.claims_complete).toBe(false);
  });

  it('points at a rules document that exists', () => {
    const { map } = loadMap();
    expect(existsSync(path.join(__dirname, '..', map.rules_document))).toBe(true);
    expect(map.search_scope).toContain('Docs A, B, and C');
    expect(map.ascertainment_boundary.length).toBeGreaterThan(80);
  });

  it('declares every rule violation it still carries, and nothing more', () => {
    // The map's honesty rests on this: a reader can enumerate the deviations
    // and see the reason for each. A row-level violation must be declared in
    // rule_tensions with the same rule id; a domain-coverage violation must be
    // named in a coverage open item.
    const raw = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as PhenomeMap;
    const { violations } = validatePhenomeMap(raw);
    const coverageText = raw.open_items
      .filter((item) => item.category === 'coverage')
      .map((item) => item.item)
      .join('\n');

    const undeclared = violations
      .filter((violation) => {
        if (violation.row_id === null) {
          const domainMatch = /domain (\d+) \(/.exec(violation.message);
          if (violation.rule === 'R43' && domainMatch) {
            return !new RegExp(`\\b${domainMatch[1]}\\b`).test(coverageText);
          }
          return true;
        }
        return !raw.rule_tensions.some(
          (tension) => tension.row_id === violation.row_id && tension.rule === violation.rule,
        );
      })
      .map((violation) => `${violation.rule} ${violation.row_id ?? '(map)'}: ${violation.message}`);

    expect(undeclared).toEqual([]);

    // …and the other direction: every declared tension corresponds to a real
    // violation, so the ledger cannot accumulate fictional deviations.
    const violationKeys = new Set(violations.map((v) => `${v.rule}:${v.row_id}`));
    const fictional = raw.rule_tensions
      .filter((tension) => !violationKeys.has(`${tension.rule}:${tension.row_id}`))
      .map((tension) => `${tension.rule}:${tension.row_id}`);
    expect(fictional).toEqual([]);
  });

  it('covers every §12 domain, or declares the domain as a gap', () => {
    const raw = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as PhenomeMap;
    const covered = new Set(raw.rows.map((row) => row.domain));
    const coverageText = raw.open_items
      .filter((item) => item.category === 'coverage')
      .map((item) => item.item)
      .join('\n');

    const missing = PHENOME_DOMAINS.map((domain) => domain.number).filter(
      (number) => !covered.has(number),
    );
    expect(missing.length).toBeGreaterThan(0); // the map does not claim completeness yet
    // The coverage item lists the missing domains by number ("Domains 6, 14, …"),
    // so each one has to appear — as a word, not as a substring of another
    // number (that is what the boundaries are for).
    for (const number of missing) {
      expect(coverageText).toMatch(new RegExp(`\\b${number}\\b`));
    }
  });

  it('carries the mandatory trauma stratum (R7) and the R33 mortality split', () => {
    const { map } = loadMap();
    expect(map.rows.some((row) => row.exposure.stratum === 'trauma')).toBe(true);
    // No mortality row exists yet, so both windows are absent — the validator
    // allows that, and the coverage item declares the domain.
    const windows = new Set(
      map.rows
        .filter((row) => row.outcome_class === 'mortality')
        .map((row) => row.mortality_window),
    );
    expect(windows.size === 0 || windows.size === 2).toBe(true);
  });

  it('keeps ids unique and every ledger reference resolvable', () => {
    const { map } = loadMap();
    const ids = map.rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);

    const known = new Set(ids);
    for (const gap of map.verification_gaps) expect(known.has(gap.row_id)).toBe(true);
    for (const tension of map.rule_tensions) expect(known.has(tension.row_id)).toBe(true);
  });

  it('records the tier-A gates it cannot yet demonstrate', () => {
    // R20/R21/R24: a synthesis can assert events, absolute risk, and a full
    // adjustment set without printing any of them. The audit names those rows
    // so a later primary-source pass knows exactly what to look for (R1).
    const { map } = loadMap();
    const gaps = auditTierAGateGaps(map);
    for (const gap of gaps) {
      const row = map.rows.find((candidate) => candidate.id === gap.row_id);
      expect(row?.evidence_tier).toBe('A');
      expect(gap.missing.length).toBeGreaterThan(0);
    }
  });
});
