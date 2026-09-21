/**
 * Canonical medical-condition crosswalk.
 *
 * Two things are locked here:
 *   1. The mapping behavior — exact matching only, verbatim preservation of
 *      unmapped text, dedupe, ordering, and the vocabulary's build hygiene.
 *   2. The consent gate — `mapConsentedMedicalConditions()` is fail-closed, and
 *      the /api/consent endpoint refuses to store a medical profile without an
 *      enabled flow plus affirmative, versioned medical consent.
 */

import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';
import {
  CANONICAL_CONDITIONS,
  CONDITION_DATA_CLASSIFICATION,
  CONDITION_SYSTEMS,
  CONDITION_VOCABULARY_CHANGELOG,
  CONDITION_VOCABULARY_ID,
  CONDITION_VOCABULARY_VERSION,
  findCanonicalCondition,
  findDuplicateAliases,
  getCanonicalConditionByCode,
  groupConditionsBySystem,
  listCanonicalConditions,
  conditionSexFromGender,
  mapConsentedMedicalConditions,
  normalizeConditionText,
  searchCanonicalConditions,
  toCanonicalRef,
  type CanonicalConditionRef,
} from '../src/medical/condition-crosswalk';

/** Numeric semver comparison: negative, zero, or positive. */
function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
  const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

/** Consent state in the shape the gate expects. */
function consent(
  overrides: Partial<{
    medical_consent_affirmed: boolean;
    medical_consent_version: string | null;
  }> = {},
) {
  return {
    medical_consent_affirmed: true,
    medical_consent_version: '1.0.0',
    ...overrides,
  };
}

/**
 * Maps through the gated entry point with capture enabled. `sex` mirrors what the
 * endpoint passes from the consented profile's gender field; omitting it is the
 * same as a profile that recorded neither male nor female.
 */
function mapConditions(conditions: string[], sex?: 'male' | 'female') {
  return mapConsentedMedicalConditions({
    medicalConditions: conditions,
    consent: consent(),
    healthDataCollectionDisabled: false,
    sex: sex ?? null,
  });
}

describe('Condition crosswalk — vocabulary hygiene', () => {
  test('every ICD-10-CM code is unique', () => {
    const codes = CANONICAL_CONDITIONS.map((c) => c.icd10_cm);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('every canonical name is unique', () => {
    const names = CANONICAL_CONDITIONS.map((c) => c.name.toUpperCase());
    expect(new Set(names).size).toBe(names.length);
  });

  test('no alias is claimed by two different conditions', () => {
    expect(findDuplicateAliases()).toEqual([]);
  });

  test('every entry has a code, a name, a system, and at least one synonym', () => {
    for (const condition of CANONICAL_CONDITIONS) {
      expect(condition.icd10_cm).toMatch(/^[A-Z]\d{2}(\.\d+)?$/);
      expect(condition.name.trim().length).toBeGreaterThan(0);
      expect(CONDITION_SYSTEMS).toContain(condition.system);
      expect(condition.synonyms.length).toBeGreaterThan(0);
      for (const synonym of condition.synonyms) {
        expect(synonym.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('every curated alias reaches its own row', () => {
    // The global reachability invariant, now that a row may be qualified: a
    // stated code always resolves to its row, a stated wording resolves to its
    // row under that row's own qualifier — and the two deliberate exceptions are
    // the *generic* spellings a qualifier exists to split: a site-generic
    // wording ("calculus", "lump") names no organ, and a marker-generic one
    // ("history of abuse", "history of self harm") names no setting and no
    // intent. Both are meant to stay unresolved on their own. Without this, a
    // qualifier could make a curated alias unreachable and nothing would notice.
    const misses: string[] = [];
    for (const condition of CANONICAL_CONDITIONS) {
      const context = condition.appliesWhen?.sex ? { sex: condition.appliesWhen.sex[0] } : {};
      for (const alias of [condition.name, condition.icd10_cm, ...condition.synonyms]) {
        const resolved = findCanonicalCondition(alias, context)?.icd10_cm ?? null;
        if (resolved === condition.icd10_cm) continue;
        const site = condition.appliesWhen?.site;
        if (site && !synonymNamesSite([alias], site)) continue;
        const words = condition.appliesWhen?.words;
        if (words && !synonymNamesSite([alias], words)) continue;
        misses.push(`${condition.icd10_cm} "${alias}" → ${resolved ?? 'nothing'}`);
      }
    }
    expect(misses).toEqual([]);
  });

  test('the vocabulary is versioned and classified as sensitive health data', () => {
    expect(CONDITION_VOCABULARY_ID).toBe('lifechat-condition-v1');
    expect(CONDITION_VOCABULARY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CONDITION_DATA_CLASSIFICATION).toBe('tdpsa_sensitive_health');
  });

  test('the release history is append-only, newest first, and semver-ordered', () => {
    const versions = CONDITION_VOCABULARY_CHANGELOG.map((revision) => revision.version);
    expect(new Set(versions).size).toBe(versions.length);
    // The published version and the history can never disagree.
    expect(versions[0]).toBe(CONDITION_VOCABULARY_VERSION);
    for (const revision of CONDITION_VOCABULARY_CHANGELOG) {
      expect(revision.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(revision.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(revision.summary.trim().length).toBeGreaterThan(0);
    }
    for (let i = 1; i < versions.length; i++) {
      expect(compareVersions(versions[i - 1], versions[i])).toBeGreaterThan(0);
    }
  });

  test('the release history accounts for the whole vocabulary and its alias moves', () => {
    // Chained counts: each release's total must be the previous total plus what
    // it added. This is what makes an unrecorded vocabulary edit impossible —
    // add or remove a condition and the newest count no longer matches.
    const [newest] = CONDITION_VOCABULARY_CHANGELOG;
    expect(newest.condition_count).toBe(CANONICAL_CONDITIONS.length);
    for (let i = 1; i < CONDITION_VOCABULARY_CHANGELOG.length; i++) {
      const newer = CONDITION_VOCABULARY_CHANGELOG[i - 1];
      const older = CONDITION_VOCABULARY_CHANGELOG[i];
      expect(newer.condition_count).toBe(older.condition_count + newer.added.length);
    }

    const addedCodes = CONDITION_VOCABULARY_CHANGELOG.flatMap((revision) => revision.added);
    expect(new Set(addedCodes).size).toBe(addedCodes.length);
    for (const code of addedCodes) {
      expect(getCanonicalConditionByCode(code)).not.toBeNull();
    }

    // A moved alias is a claim about behavior, so it is checked as behavior:
    // the alias resolves to the new code and no longer to the old one.
    for (const revision of CONDITION_VOCABULARY_CHANGELOG) {
      for (const move of revision.aliases_moved) {
        expect(getCanonicalConditionByCode(move.from)).not.toBeNull();
        expect(getCanonicalConditionByCode(move.to)).not.toBeNull();
        expect(findCanonicalCondition(move.alias)?.icd10_cm).toBe(move.to);
        expect(findCanonicalCondition(move.alias)?.icd10_cm).not.toBe(move.from);
      }
    }
  });

  test('the PTSD phenome outcomes in the review literature are represented', () => {
    // The conditions the attached reviews treat as the strongest PTSD
    // outcomes — a spot check that the vocabulary covers the intended domains.
    const required = [
      'I10', // hypertension
      'I25.10', // coronary heart disease
      'I21.9', // myocardial infarction
      'I50.9', // heart failure
      'I63.9', // stroke
      'E11.9', // type 2 diabetes
      'E88.81', // metabolic syndrome
      'G47.33', // obstructive sleep apnea
      'G47.00', // insomnia
      'G30.9', // Alzheimer's
      'G20', // Parkinson's
      'M32.9', // lupus
      'M06.9', // rheumatoid arthritis
      'G35', // multiple sclerosis
      'M79.7', // fibromyalgia
      'G93.32', // ME/CFS
      'K58.9', // IBS
      'F43.10', // PTSD
    ];
    for (const code of required) {
      expect(getCanonicalConditionByCode(code)).not.toBeNull();
    }
  });

  test('listCanonicalConditions returns a copy, not the live vocabulary', () => {
    const before = listCanonicalConditions().length;
    listCanonicalConditions().pop();
    expect(listCanonicalConditions().length).toBe(before);
  });
});

describe('Condition crosswalk — normalization and exact matching', () => {
  test('normalization lowercases, strips punctuation/separators, and drops leading articles', () => {
    expect(normalizeConditionText('  Type 2 Diabetes  ')).toBe('type 2 diabetes');
    expect(normalizeConditionText('High Blood-Pressure')).toBe('high blood pressure');
    expect(normalizeConditionText("Crohn's disease")).toBe('crohns disease');
    expect(normalizeConditionText('a heart attack')).toBe('heart attack');
    expect(normalizeConditionText('COPD (emphysema)')).toBe('copd emphysema');
    expect(normalizeConditionText('Sjögren syndrome')).toBe('sjogren syndrome');
  });

  test('resolves stated wording, abbreviations, and synonyms to a canonical entry', () => {
    const cases: [string, string][] = [
      ['high blood pressure', 'I10'],
      ['HTN', 'I10'],
      ['type 2 diabetes', 'E11.9'],
      ['insulin dependent diabetes', 'E10.9'],
      ['heart attack', 'I21.9'],
      ['PTSD', 'F43.10'],
      ['complex PTSD', 'F43.10'],
      ['lupus', 'M32.9'],
      ['sleep apnea', 'G47.33'],
      ['CPAP', 'G47.33'],
      ['chronic fatigue syndrome', 'G93.32'],
      ['Parkinsons disease', 'G20'],
      ["Crohn's disease", 'K50.90'],
      ['Sjögren syndrome', 'M35.00'],
      ['high cholesterol', 'E78.5'],
      ['dialysis', 'N18.6'],
    ];
    for (const [stated, expectedCode] of cases) {
      expect(findCanonicalCondition(stated)?.icd10_cm).toBe(expectedCode);
    }
  });

  test('accepts a normalized plural of a curated alias', () => {
    expect(findCanonicalCondition('migraines')?.icd10_cm).toBe('G43.909');
    expect(findCanonicalCondition('migraine')?.icd10_cm).toBe('G43.909');
  });

  test('accepts an ICD-10-CM code as stated input', () => {
    expect(findCanonicalCondition('E11.9')?.name).toBe(
      'Type 2 diabetes mellitus without complications',
    );
  });

  test('never guesses: unmatched or near-miss text resolves to null', () => {
    expect(findCanonicalCondition('chronic lyme disease')).toBeNull();
    expect(findCanonicalCondition('broken left femur')).toBeNull();
    expect(findCanonicalCondition('diabetesss')).toBeNull();
    // "sugar diabetes" is a real lay term but does not say type 1 or 2, so it
    // stays unmapped rather than being coerced onto the type 2 code.
    expect(findCanonicalCondition('sugar diabetes')).toBeNull();
    // No substring matching — a longer phrase containing an alias does not match.
    expect(findCanonicalCondition('high blood pressure reading of 150')).toBeNull();
    expect(findCanonicalCondition('')).toBeNull();
    expect(findCanonicalCondition('   ')).toBeNull();
  });

  test('lookup by code is exact and null-safe', () => {
    expect(getCanonicalConditionByCode('I10')?.system).toBe('cardiovascular');
    expect(getCanonicalConditionByCode(' i10 ')?.icd10_cm).toBe('I10');
    expect(getCanonicalConditionByCode('I10.9')).toBeNull();
  });

  test('vocabulary search matches names, synonyms, and codes (vocabulary only)', () => {
    expect(searchCanonicalConditions('sleep').map((c) => c.icd10_cm)).toEqual(
      expect.arrayContaining(['G47.00', 'G47.33']),
    );
    // "narcolepsy" carries no "sleep" in its name or aliases, so it only
    // surfaces on a term that is actually in the vocabulary.
    expect(searchCanonicalConditions('narcolepsy').map((c) => c.icd10_cm)).toContain('G47.419');
    expect(searchCanonicalConditions('I10').map((c) => c.icd10_cm)).toContain('I10');
    expect(searchCanonicalConditions('')).toEqual([]);
    expect(searchCanonicalConditions('zzzzz')).toEqual([]);
  });

  test('canonical refs are vocabulary-tagged', () => {
    const entry = getCanonicalConditionByCode('E11.9');
    expect(entry).not.toBeNull();
    const ref = toCanonicalRef(entry!);
    expect(ref).toEqual({
      icd10_cm: 'E11.9',
      name: 'Type 2 diabetes mellitus without complications',
      system: 'metabolic',
      vocabulary: CONDITION_VOCABULARY_ID,
      vocabulary_version: CONDITION_VOCABULARY_VERSION,
    });
  });
});

describe('Condition crosswalk — qualifier-aware rows (1.10.0)', () => {
  const qualified = CANONICAL_CONDITIONS.filter((condition) => condition.appliesWhen);

  test('the codebook split resolves per the sex on the consented profile', () => {
    // FY2026 split urethral stricture into sex-specific codes. One set of words,
    // two codes, chosen by what the person answered in the gender field.
    expect(findCanonicalCondition('urethral stricture', { sex: 'male' })?.icd10_cm).toBe('N35.919');
    expect(findCanonicalCondition('urethral stricture', { sex: 'female' })?.icd10_cm).toBe(
      'N35.92',
    );
    expect(findCanonicalCondition('stricture of urethra', { sex: 'male' })?.icd10_cm).toBe(
      'N35.919',
    );
    expect(getCanonicalConditionByCode('N35.919')?.name).toBe(
      'Unspecified urethral stricture, male, unspecified site',
    );
    // The male member beneath the N35.91 header is the billable unspecified-site
    // one: the header itself is not carried, because a code that cannot go on a
    // claim is not the most specific code the vocabulary can honestly hold.
    expect(getCanonicalConditionByCode('N35.91')).toBeNull();
  });

  test('an unknown sex defers instead of choosing a sibling', () => {
    // The rule the deferral is made of, and the reason this release keeps the
    // 1.9.0 outcome for a visitor who answered nothing: no context, no code.
    expect(findCanonicalCondition('urethral stricture')).toBeNull();
    expect(findCanonicalCondition('urethral stricture', {})).toBeNull();
    expect(findCanonicalCondition('urethral stricture', { sex: null })).toBeNull();

    // "other" and "prefer_not_to_say" are unknown too — they are not coerced.
    expect(conditionSexFromGender('male')).toBe('male');
    expect(conditionSexFromGender('female')).toBe('female');
    expect(conditionSexFromGender('other')).toBeNull();
    expect(conditionSexFromGender('prefer_not_to_say')).toBeNull();
    expect(conditionSexFromGender(null)).toBeNull();
    expect(conditionSexFromGender(undefined)).toBeNull();

    // And the sex never comes from the prose: an uncurated phrase that carries a
    // sex adjective by hand stays unmapped whichever sex the profile records.
    expect(findCanonicalCondition('male urethral stricture', { sex: 'male' })).toBeNull();
    expect(findCanonicalCondition('urethral stricture in a woman', { sex: 'female' })).toBeNull();
  });

  test('the consented mapping carries the sex through to the refs', () => {
    const male = mapConditions(['urethral stricture', 'diabetes'], 'male');
    expect(male?.canonical.map((ref) => ref.icd10_cm)).toEqual(['N35.919', 'E11.9']);
    expect(male?.unmapped).toEqual([]);

    const female = mapConditions(['urethral stricture'], 'female');
    expect(female?.canonical.map((ref) => ref.icd10_cm)).toEqual(['N35.92']);

    // No sex: the words come back the way the person wrote them, uncoded.
    const unknown = mapConditions(['urethral stricture']);
    expect(unknown?.canonical).toEqual([]);
    expect(unknown?.unmapped).toEqual(['urethral stricture']);
  });

  test('a site in the person’s own words chooses between sibling organs', () => {
    // The 1.8.0 residue's qualifying rule: the codebook spellings a person writes
    // name the stone by its organ, so the row is reachable exactly when the organ
    // is in the words — including the forms the corpus carried without matching.
    for (const [phrase, code] of [
      ['bladder calculus', 'N21.0'],
      ['vesical calculus', 'N21.0'],
      ['calculus in my bladder', 'N21.0'],
      ['ureteric calculus', 'N20.1'],
      ['ureteral calculus', 'N20.1'],
      ['calculus in the ureter', 'N20.1'],
      ['renal calculus', 'N20.0'],
      ['kidney calculus', 'N20.0'],
      ['stones in my kidney', 'N20.0'],
      ['stones in my bladder', 'N21.0'],
    ] as const) {
      expect(findCanonicalCondition(phrase)?.icd10_cm).toBe(code);
    }

    // The organ is what selects it, so the same word without an organ is still
    // unmapped — never a coin-flip between kidney, ureter and bladder.
    expect(findCanonicalCondition('calculus')).toBeNull();
    expect(findCanonicalCondition('calculi')).toBeNull();
    expect(findCanonicalCondition('stone')).toBeNull();
    expect(findCanonicalCondition('stones')).toBeNull();

    // And a site word cannot borrow a neighbour: the residual is only accepted
    // when the phrase really names that row's own site.
    expect(findCanonicalCondition('calculus in my breast')).toBeNull();
    expect(findCanonicalCondition('lump in my kidney')).toBeNull();
  });

  test('the lump row takes the site and refuses the side', () => {
    // The row the lump context rule needed, now site-qualified both ways.
    expect(findCanonicalCondition('lump in my breast')?.icd10_cm).toBe('N63.0');
    expect(findCanonicalCondition('lump in the breast')?.icd10_cm).toBe('N63.0');
    expect(findCanonicalCondition('breast lump')?.icd10_cm).toBe('N63.0');

    // A bare lump could be anywhere, so it stays unmapped (the gate protects the
    // chat disclosure separately, in context).
    expect(findCanonicalCondition('lump')).toBeNull();
    expect(findCanonicalCondition('a lump')).toBeNull();

    // A side is not enough either: FY2026's side members are quadrant-specific
    // (N63.11–N63.14 right, N63.2x left), so mapping "left breast" onto the
    // side-free N63.0 would contradict what the person said. This deferral is
    // deliberate and documented, not an oversight.
    expect(findCanonicalCondition('lump in my left breast')).toBeNull();
    expect(findCanonicalCondition('lump in my right breast')).toBeNull();
    expect(getCanonicalConditionByCode('N63.11')).toBeNull();
    expect(getCanonicalConditionByCode('N63.12')).toBeNull();
  });

  test('every qualifier is well-formed and every synonym reaches its own row', () => {
    expect(qualified.length).toBeGreaterThan(0);
    for (const condition of qualified) {
      const qualifier = condition.appliesWhen!;
      const dimensions = [qualifier.sex, qualifier.site, qualifier.words].filter(Boolean);
      expect(dimensions.length).toBeGreaterThan(0);
      for (const sex of qualifier.sex ?? []) {
        expect(['male', 'female']).toContain(sex);
      }
      for (const site of qualifier.site ?? []) {
        expect(site.length).toBeGreaterThan(2);
        expect(site).toBe(site.toLowerCase());
      }
      for (const word of qualifier.words ?? []) {
        expect(word.length).toBeGreaterThan(2);
        expect(word).toBe(word.toLowerCase());
        // A marker is matched against the normalized phrase, where punctuation is
        // already a space: a hyphenated value would never be found in it.
        expect(word).not.toContain('-');
      }

      // A curated alias can never be unreachable through its own qualifier. A
      // sex-qualified row resolves under its declared sex; a site-qualified row's
      // site-bearing wording resolves as written; a marker-qualified row's
      // intent- or setting-naming wording does too. A *generic* wording (the
      // "calculus" shared by three rows, the "history of abuse" shared by two) is
      // deliberately unresolved alone — the deferral tests pin that — so it is
      // not required to resolve here, and the row must not claim it either.
      for (const synonym of condition.synonyms) {
        if (qualifier.sex) {
          expect(findCanonicalCondition(synonym, { sex: qualifier.sex[0] })?.icd10_cm).toBe(
            condition.icd10_cm,
          );
          continue;
        }
        if (synonymNamesSite([synonym], qualifier.site ?? [])) {
          expect(findCanonicalCondition(synonym)?.icd10_cm).toBe(condition.icd10_cm);
        }
        if (qualifier.words) {
          if (synonymNamesSite([synonym], qualifier.words)) {
            expect(findCanonicalCondition(synonym)?.icd10_cm).toBe(condition.icd10_cm);
          } else {
            expect(findCanonicalCondition(synonym)?.icd10_cm).not.toBe(condition.icd10_cm);
          }
        }
      }
      // And a site- or marker-qualified row always carries at least one spelling
      // that names its own qualifier, so it is never reachable only through a
      // residual.
      if (qualifier.site) {
        expect(synonymNamesSite(condition.synonyms, qualifier.site)).toBe(true);
      }
      if (qualifier.words) {
        expect(synonymNamesSite(condition.synonyms, qualifier.words)).toBe(true);
      }
    }
  });

  test('sibling rows stay distinct under their own qualifiers', () => {
    // The failure a small family invites: three rows that differ only by organ
    // collapsing onto one code. Each is asked with its own site.
    const sites: Record<string, string> = {
      'N20.0': 'kidney stones',
      'N20.1': 'ureteric stones',
      'N21.0': 'bladder stones',
    };
    for (const [code, phrase] of Object.entries(sites)) {
      expect(findCanonicalCondition(phrase)?.icd10_cm).toBe(code);
    }
    // The split rows likewise: no context resolves neither of them, and exactly
    // two rows claim the shared wording.
    expect(findCanonicalCondition('urethral stricture')).toBeNull();
    expect(qualified.filter((c) => c.synonyms.includes('urethral stricture'))).toHaveLength(2);
  });

  test('no qualifier widens the vocabulary: unqualified rows resolve exactly as before', () => {
    // The behavior-neutrality claim in one assertion: a sample of rows that carry
    // no qualifier resolves the same with and without a context, and a context
    // can never change which code an unqualified alias lands on.
    const sample = ['diabetes', 'high blood pressure', 'migraine', 'asthma', 'kidney failure'];
    for (const phrase of sample) {
      const bare = findCanonicalCondition(phrase)?.icd10_cm;
      expect(bare).toBeDefined();
      expect(findCanonicalCondition(phrase, { sex: 'male' })?.icd10_cm).toBe(bare);
      expect(findCanonicalCondition(phrase, { sex: 'female' })?.icd10_cm).toBe(bare);
    }
  });
});

describe('Condition crosswalk — the Chapter XXI closure (1.13.0)', () => {
  test('the setting names the row: childhood and adult abuse both resolve', () => {
    // The deferral 1.12.0 recorded, closed the way the codebook splits it. Each
    // pair is asked in both directions, including the long form that only the
    // marker residual path can reach.
    for (const [phrase, code] of [
      ['abused as a child', 'Z62.819'],
      ['childhood abuse', 'Z62.819'],
      ['history of abuse as a child', 'Z62.819'],
      ['my parents abused me', 'Z62.819'],
      ['physical abuse as a child', 'Z62.810'],
      ['emotional abuse as a child', 'Z62.811'],
      ['neglected as a child', 'Z62.812'],
      ['childhood neglect', 'Z62.812'],
      // 1.18.0: the codebook's other lay order — the same both-orders shape
      // the sibling abuse row carries.
      ['child neglect', 'Z62.812'],
      ['history of child neglect', 'Z62.812'],
      ['abused as an adult', 'Z91.419'],
      ['history of abuse as an adult', 'Z91.419'],
      ['domestic violence', 'Z91.419'],
      // Moved to Z91.414 in 1.14.0, when the specific adult intimate-partner
      // row arrived; see the 1.14.0 block below.
      ['my partner abused me', 'Z91.414'],
      ['physical abuse as an adult', 'Z91.410'],
      ['psychological abuse as an adult', 'Z91.411'],
      ['neglected by my partner', 'Z91.412'],
    ] as const) {
      expect(findCanonicalCondition(phrase)?.icd10_cm).toBe(code);
    }
  });

  test('the intent names the self-harm row, and the parent title names neither', () => {
    for (const [phrase, code] of [
      ['history of suicidal behavior', 'Z91.51'],
      ['history of attempted suicide', 'Z91.51'],
      ['history of parasuicide', 'Z91.51'],
      ['history of self poisoning', 'Z91.51'],
      ['history of self mutilation', 'Z91.52'],
      ['history of self injury', 'Z91.52'],
      ['history of nonsuicidal self injury', 'Z91.52'],
      ['self inflicted injury without suicidal intent', 'Z91.52'],
      ['history of cutting', 'Z91.52'],
    ] as const) {
      expect(findCanonicalCondition(phrase)?.icd10_cm).toBe(code);
    }

    // Z91.5's own title is what the two members split, and the index routes it
    // only *with* a qualifier: "history of self-harm" unspecified belongs to the
    // non-billable header, so it — and a version of it that adds a setting but no
    // intent — asserts neither member.
    for (const phrase of [
      'history of self harm',
      'history of self-harm',
      'history of self harm as a child',
    ]) {
      expect(findCanonicalCondition(phrase)).toBeNull();
    }
  });

  test('an abuse history of unstated setting asserts neither setting', () => {
    // 1.12.0 resolved "history of abuse" to Z91.49 — "other psychological
    // trauma" — which asserted that the abuse was not nameable as childhood or
    // adult. Z91.419 is titled "unspecified *adult* abuse" and Z62.819
    // "unspecified abuse *in childhood*", so the phrase now resolves to neither,
    // and the same is true of a phrase that names both settings, where a pick
    // would be an invented one. The trauma rows are untouched.
    for (const phrase of [
      'history of abuse',
      'history of abuse as a child and as an adult',
      'abuse',
    ]) {
      expect(findCanonicalCondition(phrase)).toBeNull();
    }
    expect(findCanonicalCondition('history of psychological trauma')?.icd10_cm).toBe('Z91.49');
    expect(findCanonicalCondition('history of childhood trauma')?.icd10_cm).toBe('Z91.49');
  });

  test('the maltreatment rows are filed as psychosocial, not as a psychiatric history', () => {
    // The release's own classification rule: the rows that name a *behavior* or
    // a psychiatric history are mental_health; the rows that name a maltreatment
    // circumstance are psychosocial, which is where the codebook's Z62 section
    // (socioeconomic and psychosocial circumstances) files them.
    for (const code of [
      'Z62.810',
      'Z62.811',
      'Z62.812',
      'Z62.819',
      'Z91.410',
      'Z91.411',
      'Z91.412',
      'Z91.419',
    ]) {
      expect(getCanonicalConditionByCode(code)?.system).toBe('psychosocial');
    }
    for (const code of ['Z91.51', 'Z91.52']) {
      expect(getCanonicalConditionByCode(code)?.system).toBe('mental_health');
    }
  });
});

describe('Condition crosswalk — the abuse family completed (1.14.0)', () => {
  test('each new pair splits on the setting its own words name', () => {
    // The kinds the 1.13.0 rows deferred, asked in both directions, including
    // the long forms only the marker residual path reaches.
    for (const [phrase, code] of [
      ['financial abuse as a child', 'Z62.814'],
      ['financially abused as a child', 'Z62.814'],
      ['childhood financial abuse', 'Z62.814'],
      ['history of financial abuse as a child', 'Z62.814'],
      ['financial abuse as an adult', 'Z91.413'],
      ['financially abused as an adult', 'Z91.413'],
      ['adult financial abuse', 'Z91.413'],
      ['financial abuse by my partner', 'Z91.413'],
      ['history of financial abuse as an adult', 'Z91.413'],
      ['intimate partner abuse as a child', 'Z62.815'],
      ['intimate partner abuse in childhood', 'Z62.815'],
      ['abused by my partner as a child', 'Z62.815'],
      ['history of intimate partner abuse as a child', 'Z62.815'],
      ['intimate partner abuse as an adult', 'Z91.414'],
      ['intimate partner abuse in adulthood', 'Z91.414'],
      ['history of intimate partner abuse as an adult', 'Z91.414'],
    ] as const) {
      expect(findCanonicalCondition(phrase)?.icd10_cm).toBe(code);
    }
  });

  test('the bare wording of each new pair asserts neither setting', () => {
    // The same rule 1.13.0 established for "history of abuse": both titles are
    // setting-qualified, so the phrase that names no setting resolves to
    // neither row — and a phrase that names both defers rather than picking
    // whichever row is read first.
    for (const phrase of [
      'financial abuse',
      'history of financial abuse',
      'intimate partner abuse',
      'history of intimate partner abuse',
      'financial abuse as a child and as an adult',
      'intimate partner abuse as a child and as an adult',
    ]) {
      expect(findCanonicalCondition(phrase)).toBeNull();
    }
  });

  test('the forced-labor pair is the family’s one asymmetry, and the index is why', () => {
    // Z91.42's title carries no setting word at all, so the bare phrase has a
    // billable home and resolves to it; the childhood row requires the setting
    // word. That is the opposite of the shared-generic pairs above, decided by
    // the codebook rather than by making the family uniform.
    for (const [phrase, code] of [
      ['forced labor', 'Z91.42'],
      ['forced labour', 'Z91.42'],
      ['trafficked', 'Z91.42'],
      ['sex trafficking', 'Z91.42'],
      ['sexual exploitation', 'Z91.42'],
      ['forced to work', 'Z91.42'],
      ['forced into labor', 'Z91.42'],
      ['forced labor as a child', 'Z62.813'],
      ['forced labour as a child', 'Z62.813'],
      ['childhood forced labor', 'Z62.813'],
      ['trafficked as a child', 'Z62.813'],
      ['sexually exploited as a child', 'Z62.813'],
      ['forced to work as a child', 'Z62.813'],
      ['history of forced labor as a child', 'Z62.813'],
    ] as const) {
      expect(findCanonicalCondition(phrase)?.icd10_cm).toBe(code);
    }
    // A phrase that names both settings still resolves to nothing.
    expect(findCanonicalCondition('forced labor as a child and as an adult')).toBeNull();
  });

  test('the two moved aliases name the adult intimate-partner row, and “my ex” stays', () => {
    expect(findCanonicalCondition('abused by my partner')?.icd10_cm).toBe('Z91.414');
    expect(findCanonicalCondition('my partner abused me')?.icd10_cm).toBe('Z91.414');
    // Not moved: an ex is not necessarily named as an intimate partner, and the
    // unspecified adult row is where it has always landed.
    expect(findCanonicalCondition('abused by my ex')?.icd10_cm).toBe('Z91.419');
  });

  test('the completed rows are filed as psychosocial like the rest of the family', () => {
    for (const code of ['Z62.813', 'Z62.814', 'Z62.815', 'Z91.413', 'Z91.414', 'Z91.42']) {
      expect(getCanonicalConditionByCode(code)?.system).toBe('psychosocial');
    }
  });
});

/** True when any of a row's own wordings names one of the sites it declares. */
function synonymNamesSite(synonyms: readonly string[], sites: readonly string[]): boolean {
  return synonyms.some((synonym) => {
    const normalized = normalizeConditionText(synonym);
    return sites.some((site) => new RegExp(`\\b${site}`).test(normalized));
  });
}

describe('Condition crosswalk — gated mapping (fail-closed)', () => {
  test('returns null when Phase 2 capture is disabled', () => {
    expect(
      mapConsentedMedicalConditions({
        medicalConditions: ['diabetes'],
        consent: consent(),
        healthDataCollectionDisabled: true,
      }),
    ).toBeNull();
  });

  test('returns null without affirmative medical consent', () => {
    expect(
      mapConsentedMedicalConditions({
        medicalConditions: ['diabetes'],
        consent: consent({ medical_consent_affirmed: false }),
        healthDataCollectionDisabled: false,
      }),
    ).toBeNull();
  });

  test('returns null without a current consent version (unversioned consent is not consent)', () => {
    for (const version of [null, '']) {
      expect(
        mapConsentedMedicalConditions({
          medicalConditions: ['diabetes'],
          consent: consent({ medical_consent_version: version }),
          healthDataCollectionDisabled: false,
        }),
      ).toBeNull();
    }
  });

  test('returns null when the conditions field is not an array', () => {
    expect(
      mapConsentedMedicalConditions({
        medicalConditions: 'diabetes' as unknown as string[],
        consent: consent(),
        healthDataCollectionDisabled: false,
      }),
    ).toBeNull();
  });

  test('maps, dedupes, and preserves first-stated order', () => {
    const result = mapConditions(['type 2 diabetes', 'hypertension', 'diabetes', 'HTN']);
    expect(result).not.toBeNull();
    expect(result!.canonical.map((r) => r.icd10_cm)).toEqual(['E11.9', 'I10']);
    expect(result!.unmapped).toEqual([]);
    expect(result!.vocabulary).toBe(CONDITION_VOCABULARY_ID);
    expect(result!.vocabulary_version).toBe(CONDITION_VOCABULARY_VERSION);
  });

  test('keeps unmatched conditions verbatim instead of coercing them onto a code', () => {
    // "brain fog" and "a torn meniscus" are deliberately outside the
    // vocabulary: the first is a symptom, the second an injury detail with no
    // curated code, and neither may be coerced onto a nearby condition.
    const result = mapConditions(['diabetes', 'brain fog', 'a torn meniscus']);
    expect(result!.canonical.map((r) => r.icd10_cm)).toEqual(['E11.9']);
    expect(result!.unmapped).toEqual(['brain fog', 'a torn meniscus']);
  });

  test('ignores blank and non-string entries, and dedupes repeated unmapped text', () => {
    const result = mapConditions([
      '  ',
      'diabetes',
      'unknown condition',
      'unknown condition',
      'diabetes',
    ]);
    expect(result!.canonical).toHaveLength(1);
    expect(result!.unmapped).toEqual(['unknown condition']);
  });

  test('an empty consented profile maps to an empty result, not null', () => {
    const result = mapConditions([]);
    expect(result).not.toBeNull();
    expect(result!.canonical).toEqual([]);
    expect(result!.unmapped).toEqual([]);
  });

  test('no single entry is lost — every stated condition is matched or flagged', () => {
    const stated = ['diabetes', 'PTSD', 'something unlisted', 'migraines'];
    const result = mapConditions(stated);
    expect(result!.canonical.length + result!.unmapped.length).toBe(stated.length);
  });
});

describe('Condition crosswalk — system rollups', () => {
  test('groups refs by body system, most-represented first then alphabetically', () => {
    const refs: CanonicalConditionRef[] = ['E11.9', 'I10', 'I25.10', 'M79.7'].map((code) =>
      toCanonicalRef(getCanonicalConditionByCode(code)!),
    );
    const groups = groupConditionsBySystem(refs);
    expect(groups[0]).toEqual({
      system: 'cardiovascular',
      count: 2,
      icd10_cm: ['I10', 'I25.10'],
    });
    expect(groups.map((g) => g.system)).toEqual(['cardiovascular', 'metabolic', 'musculoskeletal']);
  });

  test('an empty ref list produces no groups', () => {
    expect(groupConditionsBySystem([])).toEqual([]);
  });
});

// ── Endpoint gating ──────────────────────────────────────────────────────────

interface LoadedApp {
  app: Express;
  cleanup: () => Promise<void>;
}

/** Loads a fresh app with the given health-capture flag and a temp lead log. */
async function loadApp(flagValue: string): Promise<LoadedApp> {
  jest.resetModules();
  const previous = { ...process.env };
  process.env.HEALTH_DATA_COLLECTION_DISABLED = flagValue;
  process.env.LIFECHAT_PORT = '0';
  process.env.LLM_API_KEY = '';
  const leadLogPath = tempLogPath('lead-crosswalk-test');
  process.env.LEAD_LOG_PATH = leadLogPath;

  const { app, server } = (await import('../src/index')) as {
    app: Express;
    server: Server;
  };

  return {
    app,
    cleanup: () =>
      new Promise<void>((resolve) => {
        // Remove the record log this instance wrote, then restore the env.
        cleanupTempLogs(leadLogPath);
        for (const key of [
          'HEALTH_DATA_COLLECTION_DISABLED',
          'LIFECHAT_PORT',
          'LLM_API_KEY',
          'LEAD_LOG_PATH',
        ]) {
          if (previous[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = previous[key];
          }
        }
        server.close(() => resolve());
      }),
  };
}

const consentBody = {
  contactConsentAffirmed: true,
  contactChannel: 'email',
  email: 'visitor@example.com',
  firstName: 'Sam',
};

const medicalProfile = {
  date_of_birth: '1985-06-15',
  gender: 'female',
  height_inches: 66,
  weight_lbs: 150,
  tobacco_nicotine_use: 'none',
  medical_conditions: ['diabetes', 'high blood pressure', 'a torn meniscus'],
  medications: ['metformin'],
  diabetes: { diabetes_type: 'type2', treatment_method: 'pills', last_a1c: '6.8' },
  cancer: null,
};

describe('/api/consent — medical profile is refused while capture is disabled', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp('');
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  test('rejects a consented medical payload with 400 and stores nothing', async () => {
    const res = await request(loaded.app)
      .post('/api/consent')
      .send({
        ...consentBody,
        medicalProfile,
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.0.0',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Medical capture is disabled');
    expect(res.body.leadId).toBeUndefined();

    const { listLeadRecords } = (await import('../src/consent/consent-model')) as {
      listLeadRecords: () => unknown[];
    };
    expect(listLeadRecords()).toHaveLength(0);
  });

  test('still accepts an ordinary contact-only submission', async () => {
    const res = await request(loaded.app).post('/api/consent').send(consentBody);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('created');
  });
});

describe('/api/consent — consented medical profile is crosswalked and stored', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp('false');
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  test('refuses a medical payload without affirmative, versioned consent', async () => {
    const { listLeadRecords } = (await import('../src/consent/consent-model')) as {
      listLeadRecords: () => unknown[];
    };
    const before = listLeadRecords().length;

    for (const body of [
      { medicalProfile, medicalConsentAffirmed: false, medicalConsentVersion: '1.0.0' },
      { medicalProfile, medicalConsentAffirmed: true },
      {
        medicalProfile: { diabetes: 'yes' },
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.0.0',
      },
    ]) {
      const res = await request(loaded.app)
        .post('/api/consent')
        .send({ ...consentBody, ...body });
      expect(res.status).toBe(400);
      expect(res.body.leadId).toBeUndefined();
    }

    expect(listLeadRecords().length).toBe(before);
  });

  test('stores the consented profile with canonical refs, keeping stated wording verbatim', async () => {
    const res = await request(loaded.app)
      .post('/api/consent')
      .send({
        ...consentBody,
        medicalProfile,
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.0.0',
      });
    expect(res.status).toBe(200);
    expect(res.body.leadId).toBeTruthy();

    const { getLeadRecord } = (await import('../src/consent/consent-model')) as {
      getLeadRecord: (id: string) =>
        | {
            medical_consent_version: string | null;
            medical_consent_timestamp: string | null;
            medical_profile: {
              medical_conditions: string[];
              canonical_conditions: { icd10_cm: string; vocabulary: string }[];
            } | null;
          }
        | undefined;
    };

    const lead = getLeadRecord(res.body.leadId);
    expect(lead).toBeDefined();
    expect(lead!.medical_consent_version).toBe('1.0.0');
    expect(lead!.medical_consent_timestamp).toBeTruthy();
    // Stated wording is preserved verbatim — the crosswalk is additive.
    expect(lead!.medical_profile!.medical_conditions).toEqual(medicalProfile.medical_conditions);
    expect(lead!.medical_profile!.canonical_conditions.map((c) => c.icd10_cm)).toEqual([
      'E11.9',
      'I10',
    ]);
    expect(lead!.medical_profile!.canonical_conditions[0].vocabulary).toBe(CONDITION_VOCABULARY_ID);

    // The response never echoes medical data back to the client.
    expect(JSON.stringify(res.body)).not.toContain('E11.9');
    expect(JSON.stringify(res.body)).not.toContain('diabetes');
  });

  test('the profile’s gender decides a qualifier-split code, and an unanswered one defers', async () => {
    // The end-to-end version of the 1.10.0 rule: the same stated words, three
    // profiles that differ only in the gender field. The codebook splits
    // urethral stricture by sex, so this is the only place the resolution can
    // come from — and a profile that answered neither male nor female stores the
    // words uncoded instead of guessing a sibling.
    const { getLeadRecord } = (await import('../src/consent/consent-model')) as {
      getLeadRecord: (id: string) =>
        | {
            medical_profile: {
              medical_conditions: string[];
              canonical_conditions: { icd10_cm: string }[];
            } | null;
          }
        | undefined;
    };

    for (const [gender, expected] of [
      ['male', ['N35.919']],
      ['female', ['N35.92']],
      ['prefer_not_to_say', []],
      [null, []],
    ] as const) {
      const res = await request(loaded.app)
        .post('/api/consent')
        .send({
          ...consentBody,
          medicalProfile: {
            ...medicalProfile,
            gender,
            medical_conditions: ['urethral stricture'],
          },
          medicalConsentAffirmed: true,
          medicalConsentVersion: '1.0.0',
        });
      expect(res.status).toBe(200);

      const lead = getLeadRecord(res.body.leadId);
      expect(lead!.medical_profile!.medical_conditions).toEqual(['urethral stricture']);
      expect(lead!.medical_profile!.canonical_conditions.map((c) => c.icd10_cm)).toEqual(expected);
    }
  });

  test('stores a setting-named abuse row coded and the generic one verbatim', async () => {
    // The closure at the consent boundary: the same profile, three statements.
    // The two that name what the codebook splits on get a canonical ref; the one
    // that names neither setting keeps its wording and no code — a deferral, not
    // a guess, and the wording is stored exactly as stated either way.
    const stated = ['history of abuse as a child', 'history of abuse', 'domestic abuse'];
    const res = await request(loaded.app)
      .post('/api/consent')
      .send({
        ...consentBody,
        medicalProfile: { ...medicalProfile, medical_conditions: stated },
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.0.0',
      });
    expect(res.status).toBe(200);

    const { getLeadRecord } = (await import('../src/consent/consent-model')) as {
      getLeadRecord: (id: string) =>
        | {
            medical_profile: {
              medical_conditions: string[];
              canonical_conditions: { icd10_cm: string }[];
            } | null;
          }
        | undefined;
    };
    const lead = getLeadRecord(res.body.leadId);
    expect(lead!.medical_profile!.medical_conditions).toEqual(stated);
    expect(lead!.medical_profile!.canonical_conditions.map((c) => c.icd10_cm)).toEqual([
      'Z62.819',
      'Z91.419',
    ]);
  });

  test('a contact-only submission stores no medical profile and no medical consent', async () => {
    const res = await request(loaded.app).post('/api/consent').send(consentBody);
    expect(res.status).toBe(200);

    const { getLeadRecord } = (await import('../src/consent/consent-model')) as {
      getLeadRecord: (id: string) =>
        | {
            medical_consent_version: string | null;
            medical_profile: unknown;
          }
        | undefined;
    };
    const lead = getLeadRecord(res.body.leadId);
    expect(lead!.medical_profile).toBeNull();
    expect(lead!.medical_consent_version).toBeNull();
  });
});
