/**
 * The context-family registry — structural invariants, and proof it is
 * data-driven.
 *
 * The behavioural corpora for these families live in
 * tests/gate-road-test.test.ts (`META_WORD_CASES`: a benign sentence proving the
 * ordinary sense stays silent and a medical one proving the narrowing cost
 * nothing, for every word — including the four migrated from hand-written
 * patterns: diagnosis, therapy, therapist and medication). This file asserts the
 * properties that make those corpora sufficient — that the rules are generated
 * from declared data rather than hand-written per word, so the next word cannot
 * arrive with a clause forgotten:
 *
 *   - every family is declared, each with its ordinary sense written down
 *   - each rule shape carries only the data it uses, and a repeated clause kind
 *     has to say how the two clauses differ
 *   - every generated pattern watches the spellings it was declared for, and a
 *     clause restricted to a spelling group watches only that group
 *   - a declared exclusion (owner `excludeOf`, `medicalOf: false`, a `bare`
 *     entry's `prefixExclusions`) is inside the generated pattern, so a rule
 *     that watches the word cannot omit it
 *   - a synthetic entry, run through the production builder, changes what the
 *     builder matches while the live gate stays inert — the machinery is the
 *     data, and adding an object to a test is not a gate change
 *
 * Everything here is derived from the entries themselves: no sentence in this
 * file is a curated corpus row, so a change to the data moves the assertions
 * with it rather than leaving a second list to keep in step.
 */

import {
  CONTEXT_FAMILY_PATTERNS,
  CONTEXT_FAMILY_TERMS,
  buildContextFamilyPatterns,
  escapeRegExp,
  type ContextFamilyTerm,
} from '../src/security/context-family-terms';
import { detectSensitiveData } from '../src/security/security-controls';

/**
 * Every family the registry declares, in the documented order: the seven broad
 * two-sense words the phase-2 doc names first, then the four the first
 * measurement pass narrowed in place and moved here.
 */
const REGISTRY_IDS = [
  'condition',
  'treatment',
  'heart',
  'symptom',
  'prescription',
  'disease',
  'disorder',
  'diagnosis',
  'therapy',
  'therapist',
  'medication',
] as const;

/**
 * The word a clause watches, for the tests that have to prove something about
 * it: a `form` names one of the entry's spelling groups, otherwise the entry's
 * own word (stem tail included).
 */
const clauseWordSource = (entry: ContextFamilyTerm, form?: string): string => {
  if (form) return (entry.spellingGroups?.[form] ?? []).map(escapeRegExp).join('|');
  return entry.spellings
    .map((spelling) => `${escapeRegExp(spelling)}${entry.stem ? String.raw`\w*` : ''}`)
    .join('|');
};

/** A plain probe spelling for an entry — the noun form when it declares one. */
const probeSpelling = (entry: ContextFamilyTerm): string =>
  entry.spellingGroups?.noun?.[0] ?? entry.spellings[0];

const term = (id: string): ContextFamilyTerm => {
  const found = CONTEXT_FAMILY_TERMS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no registry entry for ${id}`);
  return found;
};

const sourcesOf = (entry: ContextFamilyTerm): string[] =>
  buildContextFamilyPatterns(entry).map((pattern) => pattern.source);

describe('context-family registry — the seven words are declared data', () => {
  it('declares exactly the documented families, in the documented order', () => {
    expect(CONTEXT_FAMILY_TERMS.map((entry) => entry.id)).toEqual([...REGISTRY_IDS]);
  });

  it('every entry declares its ordinary sense and plain-text spellings', () => {
    for (const entry of CONTEXT_FAMILY_TERMS) {
      expect({ id: entry.id, sense: entry.ordinarySense.trim().length > 0 }).toEqual({
        id: entry.id,
        sense: true,
      });
      expect({ id: entry.id, spellings: entry.spellings.length > 0 }).toEqual({
        id: entry.id,
        spellings: true,
      });
      for (const spelling of entry.spellings) {
        // Spellings are plain text — escaped when the patterns are built, never
        // fragments. A fragment here would silently become a literal.
        expect({ id: entry.id, spelling, plain: /^[a-z][a-z-]*$/.test(spelling) }).toEqual({
          id: entry.id,
          spelling,
          plain: true,
        });
      }
    }
  });

  it('each rule shape carries only the data it uses', () => {
    for (const entry of CONTEXT_FAMILY_TERMS) {
      if (entry.rule === 'context-required') {
        expect({ id: entry.id, clauses: (entry.context ?? []).length }).not.toEqual({
          id: entry.id,
          clauses: 0,
        });
        // `medicalOf` belongs to another rule, and the `bare` controls to the
        // rule that has no clauses at all; declaring either here would be data
        // the builder never reads.
        expect({ id: entry.id, medicalOf: entry.medicalOf ?? 'not-declared' }).toEqual({
          id: entry.id,
          medicalOf: 'not-declared',
        });
        expect({
          id: entry.id,
          bareControls: (entry.prefixExclusions ?? []).length + (entry.compounds ? 1 : 0),
        }).toEqual({ id: entry.id, bareControls: 0 });
      } else if (entry.rule === 'bare') {
        expect({ id: entry.id, context: entry.context ?? 'not-declared' }).toEqual({
          id: entry.id,
          context: 'not-declared',
        });
        expect({ id: entry.id, medicalOf: entry.medicalOf ?? 'not-declared' }).toEqual({
          id: entry.id,
          medicalOf: 'not-declared',
        });
        // Every carve-out and every compound says why it is one.
        for (const exclusion of entry.prefixExclusions ?? []) {
          expect({
            id: entry.id,
            word: exclusion.word,
            reason: exclusion.reason.trim().length > 0,
          }).toEqual({ id: entry.id, word: exclusion.word, reason: true });
        }
        if (entry.compounds) {
          expect({
            id: entry.id,
            spellings: entry.compounds.spellings.length > 0,
            reason: entry.compounds.reason.trim().length > 0,
          }).toEqual({ id: entry.id, spellings: true, reason: true });
        }
      } else {
        // Required on this rule, so the choice is always declared — not defaulted.
        expect({ id: entry.id, medicalOf: typeof entry.medicalOf }).toEqual({
          id: entry.id,
          medicalOf: 'boolean',
        });
        expect({ id: entry.id, context: entry.context ?? 'not-declared' }).toEqual({
          id: entry.id,
          context: 'not-declared',
        });
        expect({
          id: entry.id,
          bareControls: (entry.prefixExclusions ?? []).length + (entry.compounds ? 1 : 0),
        }).toEqual({ id: entry.id, bareControls: 0 });
      }
    }
  });

  it('a repeated clause kind says how the two clauses differ', () => {
    // One clause per shape is the rule; a second of the same kind is allowed
    // only with a reason, so a reader is never left to work out why two
    // "qualifier" clauses exist in one entry.
    for (const entry of CONTEXT_FAMILY_TERMS) {
      const byKind = new Map<string, number>();
      for (const clause of entry.context ?? []) {
        byKind.set(clause.kind, (byKind.get(clause.kind) ?? 0) + 1);
      }
      const repeated = [...byKind.entries()].filter(([, count]) => count > 1).map(([kind]) => kind);
      for (const kind of repeated) {
        const clauses = (entry.context ?? []).filter((clause) => clause.kind === kind);
        for (const clause of clauses) {
          expect({ id: entry.id, kind, reason: (clause.reason ?? '').trim().length > 0 }).toEqual({
            id: entry.id,
            kind,
            reason: true,
          });
        }
        expect({ id: entry.id, kind, reasons: new Set(clauses.map((c) => c.reason)).size }).toEqual(
          {
            id: entry.id,
            kind,
            reasons: clauses.length,
          },
        );
      }
    }
  });

  it('a clause that declares a spelling group names one the entry declares', () => {
    for (const entry of CONTEXT_FAMILY_TERMS) {
      const groups = entry.spellingGroups ?? {};
      const used = new Set<string>();
      for (const clause of entry.context ?? []) {
        const form = (clause as { form?: string }).form;
        if (!form) continue;
        used.add(form);
        expect({ id: entry.id, form, declared: form in groups }).toEqual({
          id: entry.id,
          form,
          declared: true,
        });
        // A group narrows the entry's word — never widens it: every spelling in
        // the group must match the entry's own word pattern.
        const word = new RegExp(`^(?:${clauseWordSource(entry)})$`, 'i');
        for (const spelling of groups[form] ?? []) {
          expect({ id: entry.id, form, spelling, ofWord: word.test(spelling) }).toEqual({
            id: entry.id,
            form,
            spelling,
            ofWord: true,
          });
        }
      }
      // And a declared group nobody reads is data pretending to be a rule.
      expect({ id: entry.id, groups: Object.keys(groups).sort() }).toEqual({
        id: entry.id,
        groups: [...used].sort(),
      });
    }
  });

  it('a clause declares only the controls its direction reads', () => {
    for (const entry of CONTEXT_FAMILY_TERMS) {
      for (const clause of entry.context ?? []) {
        if (clause.kind !== 'relative') continue;
        // The word-first direction is the one that takes an owner between the
        // word and the relative, and the relative-first direction is the one
        // that a window applies to.
        // An owner on the relative-first direction, or a window on the
        // word-first one, would be data the builder never reads.
        expect({
          id: entry.id,
          direction: clause.direction,
          ownersOnBefore: clause.direction === 'before' && clause.owners !== undefined,
          windowOnAfter: clause.direction === 'after' && clause.window !== undefined,
        }).toEqual({
          id: entry.id,
          direction: clause.direction,
          ownersOnBefore: false,
          windowOnAfter: false,
        });
      }
    }
  });

  it('an owner clause with intervening words closes its gap', () => {
    // The two controls are a pair: the listed words may sit between owner and
    // word, and nothing else may, which is only true at gap 0.
    for (const entry of CONTEXT_FAMILY_TERMS) {
      for (const clause of entry.context ?? []) {
        if (clause.kind !== 'owner' || !clause.intervening) continue;
        expect({
          id: entry.id,
          words: clause.intervening.length > 0,
          gap: clause.gap ?? 1,
        }).toEqual({ id: entry.id, words: true, gap: 0 });
      }
    }
  });

  it('a stem entry matches its own inflections, and nothing outside its groups', () => {
    for (const entry of CONTEXT_FAMILY_TERMS) {
      if (!entry.stem) continue;
      const word = new RegExp(String.raw`\b${clauseWordSource(entry)}\b`, 'i');
      for (const spelling of entry.spellings) {
        for (const inflection of [spelling, `${spelling}ed`, `${spelling}is`, `${spelling}ing`]) {
          expect({ id: entry.id, inflection, matches: word.test(inflection) }).toEqual({
            id: entry.id,
            inflection,
            matches: true,
          });
        }
      }
      // The stem is not unbounded: a word that merely starts with other letters
      // is untouched.
      expect(word.test(`${entry.spellings[0]}z`)).toBe(true);
      expect(word.test(`x${entry.spellings[0]}`)).toBe(false);
    }
  });

  it('every declared clause carries non-empty word data', () => {
    for (const entry of CONTEXT_FAMILY_TERMS) {
      for (const clause of entry.context ?? []) {
        const words = (() => {
          switch (clause.kind) {
            case 'definite-article':
              return clause.spellings;
            case 'example':
              return clause.introducers;
            case 'person':
              return clause.persons;
            case 'temporal':
              return clause.markers;
            case 'relative':
              return clause.members;
            // These two carry no word list of their own — the shape is the data.
            case 'possessor':
            case 'disclosure':
              return ['declared-shape'];
            default:
              return clause.words;
          }
        })();
        expect({ id: entry.id, kind: clause.kind, words: words.length > 0 }).toEqual({
          id: entry.id,
          kind: clause.kind,
          words: true,
        });
      }
    }
  });

  it('a definite-article clause may only name spellings the entry declares', () => {
    // The clause watches a subset because the plural is ordinary ("the
    // conditions of the policy"); a spelling not in the entry would be a pattern
    // watching a word the family does not own.
    for (const entry of CONTEXT_FAMILY_TERMS) {
      const declared = new Set(entry.spellings);
      for (const clause of entry.context ?? []) {
        if (clause.kind !== 'definite-article') continue;
        for (const spelling of clause.spellings) {
          expect({ id: entry.id, spelling, declared: declared.has(spelling) }).toEqual({
            id: entry.id,
            spelling,
            declared: true,
          });
        }
      }
    }
  });

  it('every generated pattern watches the spellings it was declared for', () => {
    for (const entry of CONTEXT_FAMILY_TERMS) {
      const escaped = entry.spellings.map(escapeRegExp);
      const patterns = buildContextFamilyPatterns(entry);
      const extras = entry.extraWords?.length ?? 0;
      const clausePatterns = patterns.slice(0, patterns.length - extras);
      for (const pattern of clausePatterns) {
        expect({
          id: entry.id,
          source: pattern.source,
          watches: escaped.some((spelling) => pattern.source.includes(spelling)),
        }).toEqual({
          id: entry.id,
          source: pattern.source,
          watches: true,
        });
      }
      // The extras watch their own declared spelling instead.
      for (const extra of entry.extraWords ?? []) {
        expect({
          id: entry.id,
          spelling: extra.spelling,
          reason: extra.reason.trim().length > 0,
        }).toEqual({ id: entry.id, spelling: extra.spelling, reason: true });
      }
    }
  });

  it('the patterns the gate runs are the registry flattened in entry order', () => {
    expect(CONTEXT_FAMILY_PATTERNS.map((pattern) => `${pattern.flags}:${pattern.source}`)).toEqual(
      CONTEXT_FAMILY_TERMS.flatMap(buildContextFamilyPatterns).map(
        (pattern) => `${pattern.flags}:${pattern.source}`,
      ),
    );
    for (const pattern of CONTEXT_FAMILY_PATTERNS) {
      expect(pattern.flags).toContain('i');
    }
  });
});

describe('context-family registry — a declared exclusion cannot be dropped', () => {
  it('the owner lookahead lives inside the generated owner pattern', () => {
    // The treatment collision is "the treatment of the claim": the exclusion is
    // part of the clause data, and the builder puts the lookahead in the pattern
    // itself. If it were applied beside the pattern, a future clause could be
    // added without it.
    const treatment = term('treatment');
    const owner = (treatment.context ?? []).find((clause) => clause.kind === 'owner');
    expect(owner).toBeDefined();
    expect((owner as { excludeOf?: boolean }).excludeOf).toBe(true);
    const ownerPattern = sourcesOf(treatment).find((source) => source.includes('(?!'));
    expect(ownerPattern).toBeDefined();
    expect(ownerPattern).toContain(String.raw`(?!\s+of\b)`);

    // The exclusive owner clause alone: "my treatment of the claim" is not the
    // medical sense, "my treatment is ongoing" is.
    const exclusive: ContextFamilyTerm = {
      id: 'synthetic-exclusive',
      spellings: ['care'],
      rule: 'context-required',
      ordinarySense: 'how something is handled ("the care of the paperwork")',
      context: [{ kind: 'owner', words: ['my'], excludeOf: true }],
    };
    const built = buildContextFamilyPatterns(exclusive);
    expect(built.some((pattern) => pattern.test('my care of the paperwork'))).toBe(false);
    expect(built.some((pattern) => pattern.test('my care is ongoing'))).toBe(true);
  });

  it('medicalOf decides whether the "of" clauses exist at all', () => {
    // heart takes only the bare exclusion — "the heart of my plan" IS the
    // metaphor. The four other of-metaphor words opt in, because "symptoms of my
    // condition" and "a disease of the liver" are medical.
    const heartSources = sourcesOf(term('heart')).join('\n');
    expect(heartSources).not.toContain(String.raw`\s+of\s+`);
    for (const id of ['symptom', 'prescription', 'disease', 'disorder']) {
      expect(sourcesOf(term(id)).join('\n')).toContain(String.raw`\s+of\s+the\s+`);
    }

    const heart = buildContextFamilyPatterns(term('heart'));
    expect(heart.some((pattern) => pattern.test('the heart of my plan'))).toBe(false);
    expect(heart.some((pattern) => pattern.test('my heart is fine'))).toBe(true);
    const symptom = buildContextFamilyPatterns(term('symptom'));
    expect(symptom.some((pattern) => pattern.test('symptoms of my condition'))).toBe(true);
    expect(symptom.some((pattern) => pattern.test('a symptom of a wider problem'))).toBe(false);
  });
});

describe('context-family registry — the machinery is the data', () => {
  it('a synthetic entry gates only through its declared clauses, and not the live gate', () => {
    const synthetic: ContextFamilyTerm = {
      id: 'synthetic-ailment',
      spellings: ['shard', 'shards'],
      rule: 'context-required',
      ordinarySense: 'a fragment of glass ("a shard of glass")',
      context: [{ kind: 'owner', words: ['my'], excludeOf: true }, { kind: 'disclosure' }],
    };
    const built = buildContextFamilyPatterns(synthetic);
    expect(built.some((pattern) => pattern.test('my shard is painful'))).toBe(true);
    expect(built.some((pattern) => pattern.test('I have shards'))).toBe(true);
    expect(built.some((pattern) => pattern.test('my shard of glass'))).toBe(false);
    expect(built.some((pattern) => pattern.test('a shard of glass on the path'))).toBe(false);
    // The live registry does not watch it — an object in a test is not a gate change.
    expect(CONTEXT_FAMILY_PATTERNS.some((pattern) => pattern.test('my shard is painful'))).toBe(
      false,
    );
  });

  it('the four added clause kinds match only what the entry declares', () => {
    // The shapes diagnosis needed, run through the production builder with a
    // word nobody bays: a person with the declared verb, a clinician with the
    // declared possessive, a time before or after, a relative.
    const synthetic: ContextFamilyTerm = {
      id: 'synthetic-timed',
      spellings: ['zonk'],
      rule: 'context-required',
      ordinarySense: 'a nonsense word, so the live gate must stay inert',
      context: [
        {
          kind: 'person',
          persons: ['i'],
          verbs: ['was'],
          reason: 'the declared person and verb only',
        },
        {
          kind: 'person',
          persons: ['i'],
          verbs: ['was'],
          order: 'verb-first',
          reason: 'the same statement as a question',
        },
        { kind: 'clinician', words: ['doctor'] },
        { kind: 'temporal', direction: 'before', markers: ['recently'] },
        { kind: 'temporal', direction: 'after', markers: ['last year'] },
        { kind: 'relative', members: ['father'], direction: 'before' },
        { kind: 'relative', members: ['father'], direction: 'after', owners: ['my'] },
        { kind: 'qualifier', words: ['two'], gap: 1, form: 'plural' },
      ],
      spellingGroups: { plural: ['zonks'] },
    };
    const built = buildContextFamilyPatterns(synthetic);
    const matches = (sentence: string): boolean => built.some((pattern) => pattern.test(sentence));

    for (const sentence of [
      'I was zonk last week',
      'was I zonk',
      "the doctor's zonk",
      'the doctor zonk',
      'recently zonk',
      'zonk last year',
      'my father zonk',
      'zonk my father',
      'two separate zonks',
    ]) {
      expect({ sentence, matches: matches(sentence) }).toEqual({ sentence, matches: true });
    }
    // The clinician clause takes the word with or without a possessive — both
    // are inside its window — and the person, time and relative clauses take
    // only the words they listed.
    for (const sentence of [
      'they were zonk',
      'a nurse zonk',
      'last week zonk',
      'zonk next year',
      'my mother zonk',
      'zonk my mother',
      'two zonk',
    ]) {
      expect({ sentence, matches: matches(sentence) }).toEqual({ sentence, matches: false });
    }
    // A word nobody bays, so the live registry is untouched by the test object.
    expect(CONTEXT_FAMILY_PATTERNS.some((pattern) => pattern.test('I was zonk last week'))).toBe(
      false,
    );
    expect(detectSensitiveData('recently zonk')).toBeNull();
  });

  it('a synthetic bare entry carves out its prefixes and keeps its compounds', () => {
    // The rule shape the three migrated bare words use, with both controls:
    // a carve-out written as a separate word and one joined to it, and a
    // compound that must keep matching because the leading boundary is off.
    const synthetic: ContextFamilyTerm = {
      id: 'synthetic-bare',
      spellings: ['zonk', 'zonks'],
      rule: 'bare',
      ordinarySense: 'a nonsense word, so the live gate must stay inert',
      prefixExclusions: [
        { word: 'retail', reason: 'an idiom, as declared' },
        { word: 'aroma', attached: true, reason: 'a product name, joined to the word' },
      ],
      compounds: {
        spellings: ['multizonk'],
        reason: 'the compound carries the word after a letter',
      },
    };
    const built = buildContextFamilyPatterns(synthetic);
    const matches = (sentence: string): boolean => built.some((pattern) => pattern.test(sentence));
    expect(matches('I tried zonk')).toBe(true);
    expect(matches('multizonk')).toBe(true);
    expect(matches('retail zonk')).toBe(false);
    expect(matches('aromazonk')).toBe(false);
    // The joined carve-out does not carve out the separate word, and vice versa:
    // "aroma zonk" was never the collision, "retailzonk" was never a word.
    expect(matches('aroma zonk')).toBe(true);
    expect(matches('retailzonk')).toBe(true);
    expect(CONTEXT_FAMILY_PATTERNS.some((pattern) => pattern.test('I tried zonk'))).toBe(false);
  });

  it('a synthetic of-metaphor entry follows its own declared medicalOf', () => {
    const build = (medicalOf: boolean): RegExp[] =>
      buildContextFamilyPatterns({
        id: 'synthetic-metaphor',
        spellings: ['ledger'],
        rule: 'of-metaphor-excluded',
        ordinarySense: 'a record of accounts ("the ledger of payments")',
        medicalOf,
      });
    expect(build(true).some((pattern) => pattern.test('the ledger of my accounts'))).toBe(true);
    expect(build(false).some((pattern) => pattern.test('the ledger of my accounts'))).toBe(false);
    for (const medicalOf of [true, false]) {
      expect(build(medicalOf).some((pattern) => pattern.test('my ledger is fine'))).toBe(true);
    }
  });

  it('the gate runs the registry: every family reaches detectSensitiveData', () => {
    // Wiring, derived from the entries themselves rather than a second sentence
    // list: a context-required word is not health data alone but is once its own
    // first declared owner word sits in front of it; an of-metaphor word is
    // health data alone (every use except "of" is medical); and each declared
    // extra word is health data outright.
    for (const entry of CONTEXT_FAMILY_TERMS) {
      if (entry.rule === 'of-metaphor-excluded') {
        for (const spelling of entry.spellings) {
          expect({ id: entry.id, spelling, gate: detectSensitiveData(spelling) }).toEqual({
            id: entry.id,
            spelling,
            gate: 'health_data',
          });
        }
      } else if (entry.rule === 'bare') {
        // The word is medical as declared ...
        for (const spelling of entry.spellings) {
          expect({ id: entry.id, spelling, gate: detectSensitiveData(spelling) }).toEqual({
            id: entry.id,
            spelling,
            gate: 'health_data',
          });
        }
        // ... except where an ordinary reading hides inside it, which is what
        // each carve-out claims — derived from the data, so a carve-out that
        // stops working fails here rather than in someone's memory.
        const probe = probeSpelling(entry);
        for (const exclusion of entry.prefixExclusions ?? []) {
          const phrase = exclusion.attached
            ? `${exclusion.word}${probe}`
            : `${exclusion.word} ${probe}`;
          expect({ id: entry.id, phrase, gate: detectSensitiveData(phrase) }).toEqual({
            id: entry.id,
            phrase,
            gate: null,
          });
        }
        // ... and the compounds it must keep matching are still caught.
        for (const compound of entry.compounds?.spellings ?? []) {
          expect({
            id: entry.id,
            compound,
            gate: detectSensitiveData(compound),
          }).toEqual({ id: entry.id, compound, gate: 'health_data' });
        }
      } else {
        const owner = (entry.context ?? []).find((clause) => clause.kind === 'owner');
        expect(owner).toBeDefined();
        const clause = owner as { words: readonly string[]; intervening?: readonly string[] };
        const probe = probeSpelling(entry);
        const phrase = `${clause.words[0]} ${probe}`;
        expect({ id: entry.id, phrase, gate: detectSensitiveData(phrase) }).toEqual({
          id: entry.id,
          phrase,
          gate: 'health_data',
        });
        // The bare word stays ordinary — that is the whole point of the clause data.
        expect({
          id: entry.id,
          phrase: probe,
          gate: detectSensitiveData(probe),
        }).toEqual({ id: entry.id, phrase: probe, gate: null });
        // Where the clause lists what may sit in the gap, the first listed word
        // gates and an unlisted one does not: "my recent diagnosis" is medical,
        // "my mechanic diagnosed" is not.
        if (clause.intervening && clause.intervening.length > 0) {
          const widened = `${clause.words[0]} ${clause.intervening[0]} ${probe}`;
          expect({ id: entry.id, phrase: widened, gate: detectSensitiveData(widened) }).toEqual({
            id: entry.id,
            phrase: widened,
            gate: 'health_data',
          });
          const unlisted = `${clause.words[0]} zzz ${probe}`;
          expect({ id: entry.id, phrase: unlisted, gate: detectSensitiveData(unlisted) }).toEqual({
            id: entry.id,
            phrase: unlisted,
            gate: null,
          });
        }
      }
      for (const extra of entry.extraWords ?? []) {
        expect({
          id: entry.id,
          spelling: extra.spelling,
          gate: detectSensitiveData(extra.spelling),
        }).toEqual({ id: entry.id, spelling: extra.spelling, gate: 'health_data' });
      }
    }
  });

  it('the registry has one entry per family, not one per spelling', () => {
    // The spellings are the entry's own data; a second entry for "conditions"
    // would be a second place to forget a clause.
    const seen = new Set<string>();
    for (const entry of CONTEXT_FAMILY_TERMS) {
      for (const spelling of entry.spellings) {
        expect({ spelling, first: !seen.has(spelling) }).toEqual({ spelling, first: true });
        seen.add(spelling);
      }
    }
    expect(CONTEXT_FAMILY_TERMS).toHaveLength(REGISTRY_IDS.length);
  });
});
