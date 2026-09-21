/**
 * The declared spelling-variant mechanism (1.15.0).
 *
 * The vocabulary used to carry a British/American spelling pair as two curated
 * aliases — `['anemia', 'anaemia']`, `['hemorrhage', 'haemorrhage']` and 39 more.
 * Those duplicates are gone: `SPELLING_VARIANT_GROUPS` declares the spelling of
 * the word once and the resolver claims every alias in every declared spelling of
 * it, word by word with the plural carried across.
 *
 * Four things are locked here:
 *   1. Preservation — every spelling deleted from `synonyms` still resolves to
 *      exactly the code it resolved to before. The table is frozen, so the
 *      release's claim is checked as behaviour rather than believed.
 *   2. The declaration is a table of word spellings, not a rewrite rule: the
 *      look-alikes a blanket "-our → -or" would mangle are asserted untouched.
 *   3. The declaration stays honest — a group is word-shaped and lexical, no
 *      alias is curated twice for its spellings, and no declared spelling is
 *      dead data.
 *   4. The reach is the declared one: the phrases that became reachable in their
 *      other spelling are named, and so is what stayed silent.
 */

import {
  CANONICAL_CONDITIONS,
  SPELLING_VARIANT_GROUPS,
  findCanonicalCondition,
  findDuplicateAliases,
  normalizeConditionText,
  spellingVariantKeys,
} from '../src/medical/condition-crosswalk';

/**
 * Every spelling 1.15.0 deleted from `synonyms`, with the code it resolved to
 * before the release. Frozen: the mechanism replaced these entries, so each has
 * to resolve to exactly this code or the refactor lost coverage.
 */
const REMOVED_SPELLINGS: readonly (readonly [string, string])[] = [
  ['coeliac disease', 'K90.0'],
  ['transient ischaemic attack', 'G45.9'],
  ['sleep apnoea', 'G47.33'],
  ['apnoea', 'G47.33'],
  ['brain tumour', 'C71.9'],
  ['leukaemia', 'C95.90'],
  ['anaemia', 'D64.9'],
  ['iron deficiency anaemia', 'D50.9'],
  ['haemorrhoids', 'K64.9'],
  ['haemorrhoid', 'K64.9'],
  ['thalassaemia', 'D56.9'],
  ['haemophilia', 'D66'],
  ['oesophageal cancer', 'C15.9'],
  ['hyperkalaemia', 'E87.5'],
  ['haemochromatosis', 'E83.110'],
  ['haemangioma', 'D18.00'],
  ['goitre', 'E04.9'],
  ['barretts oesophagus', 'K22.70'],
  ['dysmenorrhoea', 'N94.6'],
  ['seborrhoeic dermatitis', 'L21.9'],
  ['hypertriglyceridaemia', 'E78.1'],
  ['hyponatraemia', 'E87.1'],
  ['hypercalcaemia', 'E83.52'],
  ['hyperuricaemia', 'E79.0'],
  ['polycythaemia', 'D45'],
  ['lymphoedema', 'I89.0'],
  ['aplastic anaemia', 'D61.9'],
  ['benign brain tumor', 'D33.2'],
  ['subarachnoid haemorrhage', 'I60.9'],
  ['intracerebral haemorrhage', 'I61.9'],
  ['nontraumatic intracranial haemorrhage', 'I62.9'],
  ['intracranial haemorrhage', 'I62.9'],
  ['oedema', 'R60.9'],
  ['family history of leukaemia', 'Z80.6'],
  ['forced labour as a child', 'Z62.813'],
  ['forced labour in childhood', 'Z62.813'],
  ['childhood forced labour', 'Z62.813'],
  ['forced into labour as a child', 'Z62.813'],
  ['history of forced labour as a child', 'Z62.813'],
  ['forced labour', 'Z91.42'],
  ['forced into labour', 'Z91.42'],
];

/**
 * Phrases the curated list wrote in only one spelling that became reachable in
 * the other — the release's measured, intended widening. Each is a word the
 * vocabulary already carried both ways somewhere, reached in a different alias.
 */
const NEWLY_REACHABLE: readonly (readonly [string, string])[] = [
  ['ischaemic heart disease', 'I25.10'],
  ['ischaemic stroke', 'I63.9'],
  ['history of transient ischaemic attack', 'Z86.73'],
  ['obstructive sleep apnoea', 'G47.33'],
  ['sickle cell anaemia', 'D57.1'],
  ['cancer of the oesophagus', 'C15.9'],
  ['barrett oesophagus', 'K22.70'],
  ['polycythaemia vera', 'D45'],
];

/**
 * Look-alikes the mechanism must not touch: each contains a substring a blanket
 * "-our → -or" / "-ae- → -e-" rewrite would corrupt, and none of them is a
 * declared word. This is the boundary of a word-declared table.
 */
const UNDECLARED_LOOKALIKES = [
  'four hours',
  'your results',
  'sour cream',
  'flavour of the month',
  'therapeutic massage',
  'aerial view',
];

/**
 * Curated alias → the spelling the mechanism derives from it, with the code both
 * are the same claim about. A derived spelling that resolved somewhere else — or
 * nowhere — would mean the pair is not one claim after all.
 */
const CURATED_TWINS: readonly (readonly [string, string, string])[] = [
  ['anemia', 'anaemia', 'D64.9'],
  ['hemorrhoids', 'haemorrhoids', 'K64.9'],
  ['edema', 'oedema', 'R60.9'],
  ['goiter', 'goitre', 'E04.9'],
  ['brain tumor', 'brain tumour', 'C71.9'],
  ['subarachnoid hemorrhage', 'subarachnoid haemorrhage', 'I60.9'],
  ['forced labor', 'forced labour', 'Z91.42'],
  ['forced labor as a child', 'forced labour as a child', 'Z62.813'],
];

/** Every key a condition curates and every key those aliases derive. */
function aliasKeysOf(condition: (typeof CANONICAL_CONDITIONS)[number]): string[] {
  const aliases = [condition.name, condition.icd10_cm, ...condition.synonyms];
  return aliases.flatMap((alias) => [normalizeConditionText(alias), ...spellingVariantKeys(alias)]);
}

describe('the declared spelling-variant mechanism', () => {
  test('every spelling deleted from synonyms still resolves to its code', () => {
    // The refactor's whole claim: the declaration replaced the duplicates rather
    // than dropping them.
    const failures = REMOVED_SPELLINGS.filter(
      ([phrase, code]) => findCanonicalCondition(phrase)?.icd10_cm !== code,
    ).map(([phrase, code]) => ({
      phrase,
      expected: code,
      got: findCanonicalCondition(phrase)?.icd10_cm ?? 'nothing',
    }));
    expect(failures).toEqual([]);
    expect(REMOVED_SPELLINGS.length).toBe(41);
  });

  test('the deleted spellings are no longer curated as aliases', () => {
    // Otherwise the test above could pass on the duplicates the release removed.
    const stillCurated = new Set(
      CANONICAL_CONDITIONS.flatMap((condition) => [condition.name, ...condition.synonyms]).map(
        (alias) => normalizeConditionText(alias),
      ),
    );
    const leftovers = REMOVED_SPELLINGS.map(([phrase]) => normalizeConditionText(phrase)).filter(
      (key) => stillCurated.has(key),
    );
    expect(leftovers).toEqual([]);
  });

  test('the phrases that became reachable in their other spelling are the measured ones', () => {
    for (const [phrase, code] of NEWLY_REACHABLE) {
      expect({ phrase, code: findCanonicalCondition(phrase)?.icd10_cm }).toEqual({ phrase, code });
    }
  });

  test('the mechanism rewrites declared words and nothing else', () => {
    // Declared: the phrase comes back in the other spelling, plural carried.
    expect(spellingVariantKeys('anaemia')).toEqual(['anemia']);
    expect(spellingVariantKeys('forced labour')).toEqual(['forced labor']);
    expect(spellingVariantKeys('childhood forced labour')).toEqual(['childhood forced labor']);
    expect(spellingVariantKeys('haemorrhoids')).toEqual(['hemorrhoids']);
    expect(spellingVariantKeys('haemorrhoid')).toEqual(['hemorrhoid']);
    expect(spellingVariantKeys('transient ischaemic attack')).toEqual([
      'transient ischemic attack',
    ]);
    // Two declared words in one phrase combine.
    expect(spellingVariantKeys('ischaemic heart disease with oedema').sort()).toEqual([
      'ischaemic heart disease with edema',
      'ischemic heart disease with edema',
      'ischemic heart disease with oedema',
    ]);

    // Undeclared: an ordinary word that merely ends in "-our" is left alone.
    for (const phrase of UNDECLARED_LOOKALIKES) {
      expect({ phrase, variants: spellingVariantKeys(phrase) }).toEqual({ phrase, variants: [] });
      expect({ phrase, resolved: findCanonicalCondition(phrase) }).toEqual({
        phrase,
        resolved: null,
      });
    }
  });

  test('the declaration is a table of word spellings, one spelling per group', () => {
    const seen = new Set<string>();
    for (const group of SPELLING_VARIANT_GROUPS) {
      expect(group.length).toBeGreaterThanOrEqual(2);
      for (const word of group) {
        // One plain lowercase token — a phrase or a hyphenated form could never
        // be substituted for a token by the resolver.
        expect({ word, plain: /^[a-z]+$/.test(word) }).toEqual({ word, plain: true });
        expect({ word, unique: !seen.has(word) }).toEqual({ word, unique: true });
        seen.add(word);
      }
      expect({ group, distinct: new Set(group).size }).toEqual({ group, distinct: group.length });
    }
  });

  test('every declared spelling is reached by the vocabulary, never dead data', () => {
    // A declaration earns its place by being used: the word has to appear in some
    // alias (curated, or derived from a curated sibling) or it is a rewrite rule
    // with nothing to rewrite, which is what the attested-only rule prevents.
    const tokens = new Set<string>();
    for (const condition of CANONICAL_CONDITIONS) {
      for (const key of aliasKeysOf(condition)) {
        for (const token of key.split(' ')) tokens.add(token);
      }
    }
    const unattested = SPELLING_VARIANT_GROUPS.flatMap((group) => group).filter(
      (word) => !tokens.has(word) && !tokens.has(`${word}s`),
    );
    expect(unattested).toEqual([]);
  });

  test('no alias is curated twice for its spellings', () => {
    // The duplicate entries are what this release deleted, so a row carrying two
    // spellings of the same declared word is the regression this locks out — a
    // curated "hemorrhoids" beside a curated "haemorrhoids" would claim the same
    // condition twice for one word.
    const offenders: string[] = [];
    for (const condition of CANONICAL_CONDITIONS) {
      const aliases = [condition.name, condition.icd10_cm, ...condition.synonyms];
      for (const group of SPELLING_VARIANT_GROUPS) {
        // Every spelling of the word this row writes down. One is fine (that is
        // what the mechanism derives the other from); two is the deleted
        // duplication growing back.
        const spellings = new Set<string>();
        for (const alias of aliases) {
          for (const token of normalizeConditionText(alias).split(' ')) {
            for (const word of group) {
              if (token === word || token === `${word}s`) spellings.add(word);
            }
          }
        }
        if (spellings.size > 1) {
          offenders.push(`${condition.icd10_cm}: ${[...spellings].join(' | ')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every derived spelling resolves rather than silently deferring', () => {
    // A spelling that produced a key nothing claims would be a hole a British
    // visitor falls into — exactly the failure the 1.7.0 sweep measured. A future
    // release that makes a derived key defer has to record the decision here.
    const silent: string[] = [];
    for (const condition of CANONICAL_CONDITIONS) {
      for (const alias of [condition.name, ...condition.synonyms]) {
        for (const key of spellingVariantKeys(alias)) {
          if (!findCanonicalCondition(key)) silent.push(`${key} (from "${alias}")`);
        }
      }
    }
    expect(silent).toEqual([]);
  });

  test('the widened spellings introduce no ambiguity', () => {
    // Derived keys go through the same claim-and-check path as curated aliases,
    // so a spelling shared by two rows without a qualifier is a build failure.
    expect(findDuplicateAliases()).toEqual([]);
    // A curated alias and its derived spelling are one claim, so the pair has to
    // land on the same row rather than on whichever spelling is read first.
    for (const [curated, derived, code] of CURATED_TWINS) {
      expect({
        curated,
        derived,
        resolved: [
          findCanonicalCondition(curated)?.icd10_cm,
          findCanonicalCondition(derived)?.icd10_cm,
        ],
      }).toEqual({ curated, derived, resolved: [code, code] });
    }
  });
});
