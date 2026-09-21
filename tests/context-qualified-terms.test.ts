/**
 * The context-qualified registry, tested as data.
 *
 * The behaviour of each term ("I have MS" gates, "Ms. Smith" does not) is pinned
 * by the two corpora that exist for it — tests/gate-road-test.test.ts for the
 * abbreviations and the lay synonym, tests/medical-condition-gate.test.ts for
 * the vocabulary parity. This file tests the *machinery* those corpora rely on:
 *
 *   - every entry's patterns are derived from its declared fields, so a new term
 *     is data rather than a new regex family;
 *   - a guard declared on an entry appears in every pattern that watches the
 *     token, so it cannot be forgotten on one path;
 *   - a synthetic entry, run through the same production functions, gates the
 *     sentences it should and leaves the collisions alone — which is the proof
 *     that the next lay synonym needs nothing but an object.
 */

import {
  CONTEXT_QUALIFIED_TERMS,
  buildContextQualifiedPatterns,
  hasContextQualifiedTerm,
  namesContextQualifiedTerm,
  withoutAmbiguousSpellings,
  type ContextQualifiedTerm,
} from '../src/security/context-qualified-terms';
import {
  GATE_EXCLUDED_TERMS,
  HEALTH_CONDITION_TERMS,
  HEALTH_CONDITION_WORD_TERMS,
  detectSensitiveData,
} from '../src/security/security-controls';

/** The dotted initialism spelling of a term, as a visitor would type it. */
const dotted = (spelling: string): string => `${spelling.split('').join('.')}.`;

describe('Context-qualified registry — the registry and the exclusion list agree', () => {
  test('every context-qualified term is a documented bare-token exclusion', () => {
    // A term is contextual *because* it collides when matched alone, and
    // GATE_EXCLUDED_TERMS is where that tradeoff is reviewed. An entry with no
    // counterpart there would be a term gated in context that the gate's own
    // audit trail does not know about.
    for (const term of CONTEXT_QUALIFIED_TERMS) {
      expect(GATE_EXCLUDED_TERMS).toContain(term.id);
    }
  });

  test('no context-qualified term is also a bare vocabulary term', () => {
    // The two lists must not overlap: a term in the vocabulary is already gated
    // without context, which is the opposite of what an entry here asserts.
    for (const term of CONTEXT_QUALIFIED_TERMS) {
      expect(HEALTH_CONDITION_TERMS).not.toContain(term.id);
      expect(HEALTH_CONDITION_WORD_TERMS).not.toContain(term.id);
    }
  });

  test('the registry carries exactly the reviewed entries, with unique ids', () => {
    const ids = CONTEXT_QUALIFIED_TERMS.map((term) => term.id);
    // The reviewed set, in the order the releases added them: the abbreviations
    // and lay words through 1.8.0, the tumour marker and the two symptom words
    // the Chapter XVIII closure measured in (1.11.0), the stomach-upset lay
    // word the re-measurement closed from the deferral ledger (`bug`), and the
    // hyperbole adjective whose disclosure form is a first-person state
    // (`manic`) — the 1.16.0 boundary the measurement finally separated.
    expect([...ids].sort()).toEqual([
      'bug',
      'lump',
      'manic',
      'ms',
      'pain',
      'piles',
      'psa',
      'rash',
      'sle',
      'stones',
      'tb',
      'tia',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Context-qualified registry — pattern derivation', () => {
  test('every strip is global, or it would strip only the first collision', () => {
    for (const term of CONTEXT_QUALIFIED_TERMS) {
      for (const strip of term.strips ?? []) {
        expect({ id: term.id, global: strip.pattern.global }).toEqual({
          id: term.id,
          global: true,
        });
      }
    }
  });

  test('the possessive, qualifier and question shapes exist exactly when declared', () => {
    for (const term of CONTEXT_QUALIFIED_TERMS) {
      const patterns = buildContextQualifiedPatterns(term);
      expect({ id: term.id, possessive: patterns.possessive !== null }).toEqual({
        id: term.id,
        possessive: term.possessives.length > 0,
      });
      expect({ id: term.id, qualifier: patterns.qualifier !== null }).toEqual({
        id: term.id,
        qualifier: term.qualifiers.length > 0,
      });
      // The question path is the one shape an entry can switch off, and an empty
      // namedSpellings is how it does it: a term whose bare form is ordinary in a
      // question ("is pads a problem?") is then gated only through its context.
      expect({ id: term.id, named: patterns.named !== null }).toEqual({
        id: term.id,
        named: (term.namedSpellings ?? term.spellings).length > 0,
      });
    }
  });

  test('the question path watches only the spellings an entry declares safe to name', () => {
    // `stones` names the plural and not the singular: "are stones painful?" is a
    // question about a condition, "is stone cheaper than brick?" is a question
    // about a building material.
    const stones = CONTEXT_QUALIFIED_TERMS.find((term) => term.id === 'stones');
    expect(stones?.namedSpellings).toEqual(['stones']);
    expect(namesContextQualifiedTerm('stones')).toBe(true);
    expect(namesContextQualifiedTerm('stone')).toBe(false);
    // The singular is still watched by every context shape it declares.
    expect(buildContextQualifiedPatterns(stones!).forward.test('I had a stone last year')).toBe(
      true,
    );
    expect(buildContextQualifiedPatterns(stones!).qualifier?.test('bladder stone')).toBe(true);
  });

  test('every declared guard appears in every pattern that watches the token', () => {
    // The failure this registry exists to prevent: a guard applied on the
    // disclosure path and forgotten on the possessive or the question path —
    // true of the fragment after the token and of the one before it. Asserted on
    // the generated sources, so it holds for any entry that declares a guard,
    // including the next one.
    for (const term of CONTEXT_QUALIFIED_TERMS) {
      const guards = [term.guard, term.precedingGuard].filter(
        (guard): guard is string => typeof guard === 'string',
      );
      if (guards.length === 0) continue;
      const patterns = buildContextQualifiedPatterns(term);
      const watched = [
        ['forward', patterns.forward],
        ['reverse', patterns.reverse],
        ['possessive', patterns.possessive],
        ['qualifier', patterns.qualifier],
        ['named', patterns.named],
      ] as const;
      for (const [shape, pattern] of watched) {
        if (!pattern) continue;
        for (const guard of guards) {
          expect({ id: term.id, shape, guard, present: pattern.source.includes(guard) }).toEqual({
            id: term.id,
            shape,
            guard,
            present: true,
          });
        }
      }
    }
  });

  test("an entry's declared extra words appear in its own patterns, and no other entry's", () => {
    // The per-entry adjacency vocabulary the lump measurement forced: the
    // discovery verbs ("I found a lump") belong to the lump entry, not to every
    // term — a shared "found" would have made "I found stones for the patio"
    // gate. Asserted structurally, so the scoping cannot be lost: each declared
    // word appears in the entry's own forward (disclosure) or reverse (clinical)
    // pattern and in no other entry's.
    const extras = CONTEXT_QUALIFIED_TERMS.flatMap((term) => [
      ...(term.disclosureWords ?? []).map((word) => ({
        id: term.id,
        word,
        shape: 'forward' as const,
      })),
      ...(term.clinicalWords ?? []).map((word) => ({
        id: term.id,
        word,
        shape: 'reverse' as const,
      })),
    ]);
    expect(extras.length).toBeGreaterThan(0);
    for (const { id, word, shape } of extras) {
      const own = CONTEXT_QUALIFIED_TERMS.find((term) => term.id === id);
      expect(own).toBeDefined();
      expect({
        id,
        word,
        shape,
        own: buildContextQualifiedPatterns(own!)[shape].source.includes(word),
      }).toEqual({
        id,
        word,
        shape,
        own: true,
      });
      for (const other of CONTEXT_QUALIFIED_TERMS) {
        if (other.id === id) continue;
        expect({
          id,
          word,
          shape,
          leakedInto: other.id,
          present: buildContextQualifiedPatterns(other)[shape].source.includes(word),
        }).toEqual({ id, word, shape, leakedInto: other.id, present: false });
      }
    }
  });

  test('every spelling is watched in context, and only the named ones are named', () => {
    for (const term of CONTEXT_QUALIFIED_TERMS) {
      const patterns = buildContextQualifiedPatterns(term);
      const namedSpellings = term.namedSpellings ?? term.spellings;
      expect({ id: term.id, named: patterns.named !== null }).toEqual({
        id: term.id,
        named: namedSpellings.length > 0,
      });
      for (const spelling of term.spellings) {
        expect({
          id: term.id,
          spelling,
          forward: patterns.forward.test(`I have ${spelling}`),
        }).toEqual({ id: term.id, spelling, forward: true });
        expect({ id: term.id, spelling, named: namesContextQualifiedTerm(spelling) }).toEqual({
          id: term.id,
          spelling,
          named: namedSpellings.includes(spelling),
        });
        if (term.dotted) {
          expect({
            id: term.id,
            spelling,
            dotted: namesContextQualifiedTerm(dotted(spelling)),
          }).toEqual({ id: term.id, spelling, dotted: namedSpellings.includes(spelling) });
        }
      }
    }
  });
});

describe('Context-qualified registry — every entry gates through every shape it declares', () => {
  test.each(CONTEXT_QUALIFIED_TERMS)('$id', (term) => {
    // The live gate, not the generated patterns: this is what a visitor's
    // message actually meets. One assertion per declared shape, so an entry
    // cannot ship with a possessive list nothing consumes.
    for (const spelling of term.spellings) {
      expect(detectSensitiveData(`I have ${spelling}`)).toBe('health_data');
      if (term.dotted) {
        // "diagnosed with T.I.A." — the initialism spelling, same token.
        expect(detectSensitiveData(`diagnosed with ${dotted(spelling)}`)).toBe('health_data');
      }
      // token → clinical noun.
      expect(detectSensitiveData(`${spelling} treatment options`)).toBe('health_data');
      // The question path's "names a condition" test, for the spellings the
      // entry declares safe to name and no others.
      const named = (term.namedSpellings ?? term.spellings).includes(spelling);
      expect({ spelling, named: namesContextQualifiedTerm(spelling) }).toEqual({ spelling, named });
      for (const possessive of term.possessives) {
        expect(detectSensitiveData(`${possessive} ${spelling} is a problem`)).toBe('health_data');
      }
      for (const qualifier of term.qualifiers) {
        expect(detectSensitiveData(`${qualifier} ${spelling} again`)).toBe('health_data');
      }
    }
  });
});

describe('Context-qualified registry — a new term is data', () => {
  /**
   * A term that is not in the live registry, declared the way the next lay
   * synonym would be. Everything below runs the *production* functions with
   * this list, so the test proves the machinery is data-driven rather than
   * asserting that the builder accepts an argument.
   */
  const SYNTHETIC: ContextQualifiedTerm = {
    id: 'test-only-shard',
    spellings: ['shard'],
    // The ordinary sense is a quantity and a phrasal verb, like "piles".
    guard: String.raw`(?!\s+(?:of|up)\b)`,
    possessives: ['my'],
    qualifiers: ['painful'],
    strips: [{ pattern: /\bShard\b/g, replacement: ' ' }],
  };
  const registry = [SYNTHETIC];

  test('the declared shapes gate', () => {
    expect(hasContextQualifiedTerm('I have shard', registry)).toBe(true);
    expect(hasContextQualifiedTerm('my shard is back', registry)).toBe(true);
    expect(hasContextQualifiedTerm('painful shard again', registry)).toBe(true);
    expect(hasContextQualifiedTerm('shard treatment', registry)).toBe(true);
    expect(namesContextQualifiedTerm('shard', registry)).toBe(true);
  });

  test('the declared guard excludes the ordinary sense from every path', () => {
    expect(hasContextQualifiedTerm('shard of glass', registry)).toBe(false);
    expect(hasContextQualifiedTerm('the shard up the road', registry)).toBe(false);
    expect(hasContextQualifiedTerm('my shard of glass', registry)).toBe(false);
    expect(namesContextQualifiedTerm('shard of glass', registry)).toBe(false);
  });

  test('the declared strips are what protect the colliding spelling', () => {
    // The capitalised spelling — the one the strip declares — is removed, so it
    // cannot gate even in a disclosure framing; the lowercase diagnosis spelling
    // is untouched.
    expect(hasContextQualifiedTerm('I have Shard', registry)).toBe(false);
    expect(hasContextQualifiedTerm('I have shard', registry)).toBe(true);
  });

  test('the live registry is the only source of what the gate watches', () => {
    // Same sentence, no list passed: an object in a test is not a gate change.
    expect(hasContextQualifiedTerm('I have shard')).toBe(false);
    expect(detectSensitiveData('I have shard')).toBeNull();
  });

  test('an entry can declare its own discovery vocabulary, scoped to itself', () => {
    // "I found a lump" is how a lump is stated, but "I found stones for the
    // patio" must stay silent — so the words belong to the entry, not to the
    // shared list. Declared the way the next such term would be.
    const withDiscovery: ContextQualifiedTerm = {
      ...SYNTHETIC,
      id: 'test-only-shard-found',
      disclosureWords: ['spotted'],
      clinicalWords: ['excised'],
    };
    expect(hasContextQualifiedTerm('I spotted a shard', [withDiscovery])).toBe(true);
    expect(hasContextQualifiedTerm('a shard was excised', [withDiscovery])).toBe(true);
    // The same sentences against the entry that declares nothing: the shared
    // lists do not carry them.
    expect(hasContextQualifiedTerm('I spotted a shard', registry)).toBe(false);
    expect(hasContextQualifiedTerm('a shard was excised', registry)).toBe(false);
    // The extras are additive: every shared disclosure word still gates.
    expect(hasContextQualifiedTerm('I have shard', [withDiscovery])).toBe(true);
  });

  test('an entry can switch the question path off, and only its context gates', () => {
    // The measured residue from the pads probe: a product word whose bare form is
    // an ordinary question. Declared the way the next such term would be.
    const unnamed: ContextQualifiedTerm = {
      ...SYNTHETIC,
      id: 'test-only-greave',
      spellings: ['greave'],
      guard: undefined,
      qualifiers: ['padded'],
      namedSpellings: [],
    };
    expect(buildContextQualifiedPatterns(unnamed).named).toBeNull();
    expect(hasContextQualifiedTerm('padded greave', [unnamed])).toBe(true);
    expect(hasContextQualifiedTerm('I have greave', [unnamed])).toBe(true);
    expect(namesContextQualifiedTerm('greave', [unnamed])).toBe(false);
    expect(namesContextQualifiedTerm('padded greave', [unnamed])).toBe(false);
  });
});

describe('Context-qualified registry — ambiguity stripping', () => {
  test('the non-clinical spelling is removed and the diagnosis spelling survives', () => {
    expect(withoutAmbiguousSpellings('I spoke with Ms. Smith about my MS')).not.toContain('Ms.');
    expect(withoutAmbiguousSpellings('I spoke with Ms. Smith about my MS')).toContain('MS');
    expect(withoutAmbiguousSpellings('Tia called about my TIA')).not.toMatch(/\bTia\b/);
    expect(withoutAmbiguousSpellings('Tia called about my TIA')).toContain('TIA');
  });

  test('a unit and a degree are not stripped from the diagnosis spelling', () => {
    expect(withoutAmbiguousSpellings('the page loaded in 300 ms')).not.toMatch(/300/);
    expect(withoutAmbiguousSpellings('an M.S. in economics')).not.toMatch(/M\.S\./);
    // The copula form stays a false positive rather than swallowing a real
    // disclosure — the documented, fail-safe side of that trade.
    expect(withoutAmbiguousSpellings('my M.S. is in remission')).toContain('M.S.');
  });
});
