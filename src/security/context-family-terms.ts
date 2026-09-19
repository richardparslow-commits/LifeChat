/**
 * The context-family gate registry — the one place a broad word with a medical
 * sense and an ordinary one is taught to the gate.
 *
 * `context-qualified-terms.ts` handles tokens that collide as *spellings*
 * ("Ms." is a title, "Tia" is a name). This registry handles the other shape:
 * whole words that ARE health words in one sense and ordinary words in another,
 * where which sense it is shows up in what sits beside them —
 *
 *   condition     a requirement attached to a product ("terms and conditions")
 *   treatment     how something is handled ("the tax treatment of the proceeds")
 *   heart         a metaphor for the centre of something ("the heart of the policy")
 *   symptom       a sign of a non-medical problem ("a symptom of a slow process")
 *   prescription  rhetorical advice ("the prescription of rates is regulated")
 *   disease       a metaphor for a systemic ill ("the disease of rising premiums")
 *   disorder      untidiness in a system ("the disorder of the ledger")
 *   diagnosis     a fault found by a mechanic or a support agent ("diagnosed as a
 *                 timing issue", "can you run a diagnosis on my account?")
 *   therapy       an idiom, a product or a joke ("retail therapy", "aromatherapy
 *                 candles", "wine is my therapy")
 *   therapist     an occupation ("I am a massage therapist", "a beauty therapist")
 *   medication    no ordinary sense measured at all — a negative result, recorded
 *                 as such; its informal form "meds" is a second spelling
 *
 * The first seven are one word with two senses. The last four are the words the
 * first measurement pass narrowed in place, moved here so the clauses that
 * narrow them are declared data like everything else.
 *
 * Each was matched bare by the disclosure patterns at some point, so any
 * sentence containing the word was classified as health data. The measurement
 * found three rule shapes, and each entry declares which one it needs:
 *
 *   context-required      the word is medical only next to declared context —
 *                         "my condition", "I have symptoms", "cancer treatment",
 *                         "treatment plan". The clauses that count are data,
 *                         listed in the order they were measured.
 *   of-metaphor-excluded  every use is medical EXCEPT the "<word> of
 *                         <something>" shape, which is the ordinary sense. That
 *                         is what keeps named conditions that END in the word
 *                         detectable: peripheral artery disease, chronic
 *                         obstructive pulmonary disease, post-traumatic stress
 *                         disorder, panic disorder.
 *   bare                  the word is medical in EVERY measured sense, so it is
 *                         matched as declared. Two optional controls carry what
 *                         the probe did find: `prefixExclusions` carves out the
 *                         compounds an ordinary reading hides inside ("retail
 *                         therapy", "aromatherapy candles", "a massage
 *                         therapist"), and `compounds` records that the word may
 *                         sit inside a longer word ("chemotherapy"), which is
 *                         why the pattern is not `\b`-anchored at the front.
 *
 * A context-required entry also declares what does NOT count. `excludeOf` on an
 * owner clause is how "the treatment of the claim" stays out while "the
 * treatment is working" stays in; the lookahead lives inside the generated
 * owner pattern, so a clause cannot be added without it. A
 * of-metaphor-excluded entry declares `medicalOf` — whether "<word> of my" and
 * "<word> of the <organ>" are medical. True for symptom, prescription, disease
 * and disorder ("symptoms of my condition", "a disease of the liver"); false
 * for heart, because for heart that same shape IS the metaphor ("the heart of
 * my plan").
 *
 * A `context-required` entry lists its clauses in the order they were measured.
 * The first seven words needed one clause vocabulary (owner, disclosure,
 * possessor, definite-article, qualifier, anchor, verb, example). Diagnosis
 * needed four more shapes, each of them a kind of context the mechanism sense
 * never has — `person` ("I was diagnosed last year", "was I diagnosed?"),
 * `clinician` ("the doctor's diagnosis"), `temporal` ("recently diagnosed",
 * "diagnosed last year") and `relative` (family history, in either word order) —
 * plus three controls that keep a clause exactly as wide as the measurement was:
 * `form` restricts a clause to a declared spelling group ("diagnosis date"
 * counts, "diagnosed date" does not), `intervening` allows only the declared
 * words into the gap ("my recent diagnosis" without opening "my mechanic
 * diagnosed"), and `stem` says the entry's word is a stem (diagnos + `\w*`). A
 * kind may appear more than once in one entry, but only with a `reason` saying
 * how that clause differs from its sibling.
 *
 * Adding the next word is one object in `CONTEXT_FAMILY_TERMS` — no new regex,
 * and no new place to forget a declared exclusion. Every entry carries the
 * measured corpora that justified it: a benign sentence proving the ordinary
 * sense stays silent, and a medical one proving the narrowing did not cost a
 * real disclosure. Those corpora live in tests/gate-road-test.test.ts
 * (`META_WORD_CASES`, plus the `META_WORD_COVERAGE` sweep for the four words the
 * first measurement pass handled), and tests/context-family-terms.test.ts
 * asserts the structural invariants — every clause is data, every generated
 * pattern watches the declared spellings, a repeated clause kind carries a
 * reason, and synthetic entries prove the machinery is data-driven.
 *
 * The shared wording builders below are used by this registry and by the
 * families still written directly in security-controls.ts (growth, discharge,
 * passing, pads), which is why they are exported rather than local.
 */

/** Escapes a plain string so it can be embedded in a pattern. */
export const escapeRegExp = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One clause of a `context-required` rule — a shape that, next to the family's
 * word, makes the medical reading the only one. All fields are data except the
 * word fragments themselves, which are patterns because some genuinely vary
 * (`chemo\w*` covers chemotherapy; `pre-?existing` covers both spellings).
 */
export type ContextClause = {
  /**
   * Required when an entry declares the same kind twice: how this clause differs
   * from its sibling. A duplicate without a reason is a pattern nobody can read.
   */
  readonly reason?: string;
} &
  /** "<owner> <word>": "my condition", "the treatment". */
  (
    | {
        readonly kind: 'owner';
        /** Owner fragments ("my", "the", "one"). */
        readonly words: readonly string[];
        /** Words allowed to sit between owner and word. Default 1. */
        readonly gap?: number;
        /** Exclude the "<word> of" shape — treatment's ordinary sense. */
        readonly excludeOf?: boolean;
        /**
         * Words that may — but need not — sit between owner and word. Declared
         * instead of a gap, because the measured collision forbids an open one:
         * "my recent diagnosis" is medical, "my mechanic diagnosed" is not. Only
         * meaningful with `gap: 0`, and required to be so.
         */
        readonly intervening?: readonly string[];
      }
    /** "I have <word>": the shared disclosure shape ("I have symptoms"). */
    | { readonly kind: 'disclosure' }
    /** "<someone>'s <word>": "my father's condition is stable". */
    | { readonly kind: 'possessor'; readonly gap?: number }
    /** "the <word>" — watches only the spellings named here, because the plural is ordinary ("the conditions of the policy"). */
    | {
        readonly kind: 'definite-article';
        readonly spellings: readonly string[];
        readonly gap?: number;
      }
    /** "<qualifier> <word>": "chronic conditions", "cancer treatment". */
    | {
        readonly kind: 'qualifier';
        readonly words: readonly string[];
        readonly gap?: number;
        /** Count only this spelling group ("two diagnoses", never "two diagnosed"). */
        readonly form?: string;
      }
    /** "<word> <anchor>": "treatment plan", "treatment costs". */
    | {
        readonly kind: 'anchor';
        readonly words: readonly string[];
        /** Count only this spelling group ("diagnosis date", never "diagnosed date"). */
        readonly form?: string;
      }
    /** "<verb> <word>": "receiving treatment", "I need treatment". */
    | {
        readonly kind: 'verb';
        readonly words: readonly string[];
        /** Count only this spelling group ("received a diagnosis"). */
        readonly form?: string;
        /** Words that may sit between verb and word ("received <a> diagnosis"). */
        readonly intervening?: readonly string[];
      }
    /** "<word> <introducer>": "conditions such as asthma". */
    | { readonly kind: 'example'; readonly introducers: readonly string[] }
    /**
     * "<person> ... <verb> ... <word>", or the reverse order: a person stating
     * their own diagnosis always carries a linking verb ("I was diagnosed last
     * year", "I've been diagnosed", "was I diagnosed?"). That verb is what clears
     * "they diagnosed the leak" — a practitioner diagnosing an object has none.
     */
    | {
        readonly kind: 'person';
        /** Person pronoun fragments ("i", "we", "he"). */
        readonly persons: readonly string[];
        /** Linking verbs ("was", "have", "got"). */
        readonly verbs: readonly string[];
        /** Which side of the verb the person stands on. Default 'person-first'. */
        readonly order?: 'person-first' | 'verb-first';
        /** Characters allowed between the steps, without crossing a sentence. Default 12. */
        readonly window?: number;
      }
    /**
     * "<clinician> ... <word>": "the doctor's diagnosis", "the hospital
     * diagnosis". Setting and source are the same shape, and so is a possessive —
     * the window is what covers it ("the doctor**'s** diag…"), which is why there
     * is no control for one: a flag that changed nothing would be data pretending
     * to be a rule.
     */
    | {
        readonly kind: 'clinician';
        readonly words: readonly string[];
        /** Characters allowed between the clinician and the word. Default 10. */
        readonly window?: number;
      }
    /**
     * "<marker> <word>" or "<word> <marker>": a time is medical context however it
     * is stated — "recently diagnosed", "diagnosed last year", "diagnosed in
     * 2019". Markers are fragments, so each carries the boundary its own shape
     * needs ("diagnosed in 3rd grade" matches the date form, "diagnosed last
     * years" does not match the calendar one).
     */
    | {
        readonly kind: 'temporal';
        readonly markers: readonly string[];
        readonly direction: 'before' | 'after';
        /** Words that may sit between the marker and the word ("recently <been> diagnosed"). */
        readonly linkers?: readonly string[];
      }
    /**
     * A relative's diagnosis is the visitor's family history, in either word
     * order: "my father was diagnosed", "diagnosed my father".
     */
    | {
        readonly kind: 'relative';
        readonly members: readonly string[];
        readonly direction: 'before' | 'after';
        /** Characters allowed between the relative and the word. Default 20. */
        readonly window?: number;
        /** Owners that sit between a word-first direction and the relative ("diagnosed <my> father"). */
        readonly owners?: readonly string[];
      }
  );

/** How a family separates its medical sense from its ordinary one. */
export type ContextFamilyRule = 'context-required' | 'of-metaphor-excluded' | 'bare';

/** One family in the registry. */
export interface ContextFamilyTerm {
  /** Stable id, used by tests and the docs. */
  readonly id: string;
  /** The word(s) as written; plain text, escaped when the patterns are built. */
  readonly spellings: readonly string[];
  /**
   * The spellings are stems, matched as `spelling + \w*` (diagnos covers
   * diagnosis, diagnoses, diagnosed, diagnosing). Declared rather than assumed:
   * a stem matches words the entry never listed, so it needs its own corpus.
   */
  readonly stem?: boolean;
  /**
   * Extra spelling groups a clause may restrict itself to with `form` — the noun
   * forms of a stem entry ("diagnosis date" is medical, "diagnosed date" is
   * not). Each group must be a subset of what the entry's own word matches, so a
   * group can narrow the word but never widen it.
   */
  readonly spellingGroups?: Readonly<Record<string, readonly string[]>>;
  /** Which rule shape this word's collision needs. */
  readonly rule: ContextFamilyRule;
  /** The ordinary sense this word collides with, in one line. */
  readonly ordinarySense: string;
  /** Clause list for `context-required`; absent for the other rules. */
  readonly context?: readonly ContextClause[];
  /**
   * `of-metaphor-excluded` only: whether "<word> of my" and "<word> of the
   * <organ>" count as medical. Required on that rule so the choice is always
   * declared rather than defaulted.
   */
  readonly medicalOf?: boolean;
  /**
   * `bare` only: words the word may hide inside, each with the reason it must
   * keep matching ("chemotherapy"). Declaring compounds is what turns off the
   * leading `\b`, so the list is the reason the boundary is missing — and a test
   * derives that every one of them still gates.
   */
  readonly compounds?: { readonly spellings: readonly string[]; readonly reason: string };
  /**
   * `bare` only: the compounds an ordinary reading hides inside, carved out with
   * a negative lookbehind ("retail therapy", "aromatherapy candles", "a massage
   * therapist"). Each carries the reason it is not the medical sense, and
   * whether it is written joined to the word or as a separate one — the
   * difference between `(?<!aroma)` and `(?<!retail\s)` is the whole exclusion.
   */
  readonly prefixExclusions?: readonly {
    readonly word: string;
    /** Written joined to the word ("aromatherapy"), not separated by a space. */
    readonly attached?: boolean;
    readonly reason: string;
  }[];
  /** Words gated unconditionally with the family, each with the reason it belongs here. */
  readonly extraWords?: readonly { readonly spelling: string; readonly reason: string }[];
}

/** Owners that point at one specific thing: "my treatment", "the symptoms". */
export const PERSONAL_OWNERS = String.raw`my|his|her|their|our|your`;

/**
 * Person pronouns a statement can belong to: "I was diagnosed", "I've been
 * smoking", "was she diagnosed?". Shared with the families still written in
 * security-controls.ts, which is why it is exported.
 */
export const PERSON_PRONOUNS = String.raw`i|we|he|she|they|you`;

/** Relatives whose diagnosis is the visitor's family history. */
export const FAMILY_MEMBERS = String.raw`father|mother|dad|mum|mom|brother|sister|son|daughter|wife|husband|spouse|partner|child|grandfather|grandmother|aunt|uncle|cousin`;

/** People and places a diagnosis comes from: "the doctor's diagnosis". */
export const CLINICIANS = String.raw`doctor|doctors|gp|physician|psychiatrist|psychologist|specialist|consultant|nurse|surgeon|hospital|clinic|therapist`;

/** The linking verbs a person stating their own diagnosis always carries. */
export const LINKING_VERBS = String.raw`was|were|been|being|am|is|are|had|has|have|got|get|gets`;

/**
 * Bodies and systems. "a disease of the liver" is medical; "the disease of
 * rising premiums" is not, and the only difference is what follows "of the".
 */
export const BODY_OR_SYSTEM = String.raw`liver|kidney|kidneys|heart|lung|lungs|brain|blood|skin|eye|eyes|joint|joints|bone|bones|nerve|nerves|nervous|immune|gut|bowel|stomach|spine|thyroid|artery|arteries|lymph|metabolism`;

/** Disclosure subjects — "I have symptoms", "we had treatment". */
const DISCLOSURE_SUBJECTS = String.raw`i|we`;

/** Words that carry ownership before the family word: "my condition", "the treatment". */
export const ownedWord = (
  word: string,
  owners: string,
  excludeOf = false,
  gap = 1,
  intervening?: readonly string[],
): RegExp =>
  new RegExp(
    String.raw`\b(?:${owners})\s+${
      intervening && intervening.length > 0
        ? interveningSource(intervening)
        : String.raw`(?:[a-z][a-z-]*\s+){0,${gap}}`
    }${word}\b${excludeOf ? String.raw`(?!\s+of\b)` : ''}`,
    'i',
  );

/** "I have <word>", with up to two words in between ("I have a chronic condition"). */
const disclosedWord = (word: string): RegExp =>
  new RegExp(
    String.raw`\b(?:${DISCLOSURE_SUBJECTS})\s+(?:also\s+|currently\s+|now\s+)?(?:have|had|has|got|get)\s+(?:[a-z][a-z-]*\s+){0,2}${word}\b`,
    'i',
  );

/** "<qualifier> <word>": "medical treatment", "chronic symptoms". */
export const qualifiedWord = (word: string, qualifiers: string, gap = 1): RegExp =>
  new RegExp(
    String.raw`\b(?:${qualifiers})\s+${
      gap > 0 ? String.raw`(?:[a-z][a-z-]*\s+){0,${gap}}` : ''
    }${word}\b`,
    'i',
  );

/** "<word> <anchor>": "heart attack", "treatment plan". */
const anchoredWord = (word: string, anchors: string): RegExp =>
  new RegExp(String.raw`\b${word}\s+(?:${anchors})\b`, 'i');

/** "<someone>'s <word>" — `\w+`, not `\w`: a one-letter possessor is not a person. */
const possessedWord = (word: string, gap = 2): RegExp =>
  new RegExp(String.raw`\b\w+['\u2019]s\s+(?:[a-z][a-z-]*\s+){0,${gap}}${word}\b`, 'i');

/** "the <word>", watching one named spelling. */
const theWord = (word: string, gap = 2): RegExp =>
  new RegExp(String.raw`\bthe\s+(?:[a-z][a-z-]*\s+){0,${gap}}${word}\b`, 'i');

/** "<word> <introducer>": "conditions such as asthma". */
const exampleWord = (word: string, introducers: string): RegExp =>
  new RegExp(String.raw`\b${word}\s+(?:${introducers})\b`, 'i');

/** "<verb> <word>": "receiving treatment", "I need treatment". */
const verbWord = (word: string, verbs: string, intervening?: readonly string[]): RegExp =>
  new RegExp(String.raw`\b(?:${verbs})\s+${interveningSource(intervening) ?? ''}${word}\b`, 'i');

/**
 * "<person> ... <verb> ... <word>", or the reverse with `order: 'verb-first'`.
 * The contraction group is orthography rather than vocabulary, so it is part of
 * the shape: "I've been diagnosed" is the same statement as "I have been".
 */
const personWord = (
  word: string,
  persons: string,
  verbs: string,
  order: 'person-first' | 'verb-first',
  window: number,
): RegExp =>
  order === 'verb-first'
    ? new RegExp(String.raw`\b(?:${verbs})\s+(?:${persons})\b[^.\n]{0,${window}}\b${word}`, 'i')
    : new RegExp(
        String.raw`\b(?:${persons})(?:['\u2019](?:ve|m|d|s))?\b[^.\n]{0,${window}}\b(?:${verbs})\b[^.\n]{0,${window}}\b${word}`,
        'i',
      );

/**
 * "<clinician> ... <word>": "the doctor's diagnosis", "the hospital
 * diagnosis". The possessive needs no group of its own: it is two characters
 * inside the window.
 */
const clinicianWord = (word: string, clinicians: string, window: number): RegExp =>
  new RegExp(String.raw`\b(?:${clinicians})\b[^.\n]{0,${window}}\b${word}`, 'i');

/**
 * "<marker> <word>" or "<word> <marker>". The markers are fragments so each can
 * carry its own trailing boundary: the calendar form needs one ("last years" is
 * not a statement of diagnosis), the date form must not have one ("diagnosed in
 * 3rd grade" is).
 */
const temporalWord = (
  word: string,
  markers: string,
  direction: 'before' | 'after',
  linkers?: readonly string[],
): RegExp =>
  direction === 'before'
    ? new RegExp(String.raw`\b(?:${markers})\s+(?:(?:${linkers ?? ''})\s+)?${word}`, 'i')
    : new RegExp(String.raw`\b${word}\s+(?:${markers})`, 'i');

/** "<relative> ... <word>", or "<word> <owner> <relative>" for the reverse order. */
const relativeWord = (
  word: string,
  members: string,
  direction: 'before' | 'after',
  window: number,
  owners: string,
): RegExp =>
  direction === 'before'
    ? new RegExp(String.raw`\b(?:${members})\b[^.\n]{0,${window}}\b${word}`, 'i')
    : new RegExp(String.raw`\b${word}\s+(?:${owners})\s+(?:${members})\b`, 'i');

/**
 * Words that may sit in the gap between a clause's words and the family word,
 * as `(?:word)?\s*` — optional, and only these: an open gap is what turns "my
 * recent diagnosis" into "my mechanic diagnosed".
 */
const interveningSource = (words?: readonly string[]): string | undefined =>
  words && words.length > 0
    ? String.raw`(?:(?:${words.map(escapeRegExp).join('|')})\s*)?`
    : undefined;

/**
 * The alternation for a term's spellings, escaped, plus the stem tail when the
 * entry declares that its spellings are stems.
 */
const wordSource = (term: ContextFamilyTerm): string =>
  `(?:${term.spellings.map(escapeRegExp).join('|')})${term.stem ? String.raw`\w*` : ''}`;

/** The alternation for one of an entry's declared spelling groups. */
const groupSource = (term: ContextFamilyTerm, form: string): string =>
  `(?:${(term.spellingGroups?.[form] ?? []).map(escapeRegExp).join('|')})`;

/** The word a clause watches: its declared group, or the entry's whole word. */
const clauseWord = (term: ContextFamilyTerm, form?: string): string =>
  form ? groupSource(term, form) : wordSource(term);

/** The alternation for a clause's word fragments. */
const clauseSource = (words: readonly string[]): string => words.join('|');

/**
 * The patterns generated from one entry — every one of them derived from the
 * entry's data. Order follows the declared clause order, which is the order the
 * clauses were measured in.
 */
export function buildContextFamilyPatterns(term: ContextFamilyTerm): RegExp[] {
  const word = wordSource(term);
  const patterns: RegExp[] = [];

  if (term.rule === 'of-metaphor-excluded') {
    patterns.push(new RegExp(String.raw`\b${word}\b(?!\s+of\b)`, 'i'));
    if (term.medicalOf) {
      patterns.push(
        new RegExp(String.raw`\b${word}\s+of\s+(?:${PERSONAL_OWNERS})\b`, 'i'),
        new RegExp(String.raw`\b${word}\s+of\s+the\s+(?:${BODY_OR_SYSTEM})\b`, 'i'),
      );
    }
  } else if (term.rule === 'bare') {
    // The whole pattern for this rule shape: the word as declared, with the
    // boundaries the entry's own data decides. `compounds` turns the leading
    // boundary off ("chemotherapy" must keep matching a word that never starts
    // with "therapy"); each `prefixExclusions` entry is a lookbehind, so a
    // sentence the probe found an ordinary reading for is carved out before the
    // word itself is considered.
    const lookbehinds = (term.prefixExclusions ?? [])
      .map(
        (exclusion) =>
          String.raw`(?<!${escapeRegExp(exclusion.word)}${exclusion.attached ? '' : String.raw`\s`})`,
      )
      .join('');
    patterns.push(
      new RegExp(String.raw`${lookbehinds}${term.compounds ? '' : String.raw`\b`}${word}\b`, 'i'),
    );
  } else {
    for (const clause of term.context ?? []) {
      switch (clause.kind) {
        case 'owner':
          patterns.push(
            ownedWord(
              word,
              clauseSource(clause.words),
              clause.excludeOf,
              clause.gap ?? 1,
              clause.intervening,
            ),
          );
          break;
        case 'disclosure':
          patterns.push(disclosedWord(word));
          break;
        case 'possessor':
          patterns.push(possessedWord(word, clause.gap ?? 2));
          break;
        case 'definite-article':
          patterns.push(
            theWord(`(?:${clause.spellings.map(escapeRegExp).join('|')})`, clause.gap ?? 2),
          );
          break;
        case 'qualifier':
          patterns.push(
            qualifiedWord(
              clauseWord(term, clause.form),
              clauseSource(clause.words),
              clause.gap ?? 1,
            ),
          );
          break;
        case 'anchor':
          patterns.push(anchoredWord(clauseWord(term, clause.form), clauseSource(clause.words)));
          break;
        case 'verb':
          patterns.push(
            verbWord(clauseWord(term, clause.form), clauseSource(clause.words), clause.intervening),
          );
          break;
        case 'example':
          patterns.push(exampleWord(word, clauseSource(clause.introducers)));
          break;
        case 'person':
          patterns.push(
            personWord(
              word,
              clauseSource(clause.persons),
              clauseSource(clause.verbs),
              clause.order ?? 'person-first',
              clause.window ?? 12,
            ),
          );
          break;
        case 'clinician':
          patterns.push(clinicianWord(word, clauseSource(clause.words), clause.window ?? 10));
          break;
        case 'temporal':
          patterns.push(
            temporalWord(word, clauseSource(clause.markers), clause.direction, clause.linkers),
          );
          break;
        case 'relative':
          patterns.push(
            relativeWord(
              word,
              clauseSource(clause.members),
              clause.direction,
              clause.window ?? 20,
              clauseSource(clause.owners ?? [PERSONAL_OWNERS]),
            ),
          );
          break;
      }
    }
  }

  for (const extra of term.extraWords ?? []) {
    patterns.push(new RegExp(String.raw`\b${escapeRegExp(extra.spelling)}\b`, 'i'));
  }

  return patterns;
}

/**
 * The registry — eleven words, three rule shapes, every clause declared.
 *
 * The comments carry the measurement: which ordinary senses were found, and
 * which medical phrasings the rule must not cost. The corpora that prove both
 * halves sentence by sentence are `META_WORD_CASES` in
 * tests/gate-road-test.test.ts.
 */
export const CONTEXT_FAMILY_TERMS: readonly ContextFamilyTerm[] = [
  {
    id: 'condition',
    spellings: ['condition', 'conditions'],
    rule: 'context-required',
    ordinarySense:
      'a requirement attached to a product ("terms and conditions", "conditions of sale")',
    context: [
      {
        kind: 'owner',
        // "my condition", "a condition", "this condition" — and the numerals and
        // quantity words, because "I have two conditions" and "I have some
        // conditions" are disclosures rather than contractual statements.
        // Deliberately absent: `any` ("are there any conditions on the payout?")
        // and `other` ("other conditions apply"), each idiomatic in the ordinary
        // sense.
        words: [
          'a',
          'an',
          'my',
          'his',
          'her',
          'their',
          'our',
          'your',
          'this',
          'that',
          'one',
          'two',
          'three',
          'several',
          'multiple',
          'both',
          'few',
          'some',
        ],
      },
      // "my father's condition is stable" — a whole-word possessor, which a
      // single `\w` never matched.
      { kind: 'possessor' },
      // Singular only: "the conditions of the policy" is contractual.
      { kind: 'definite-article', spellings: ['condition'] },
      {
        kind: 'qualifier',
        // Two words may sit between: "a chronic heart condition".
        words: [
          'medical',
          'health',
          'chronic',
          'serious',
          'severe',
          'underlying',
          'pre-?existing',
          'existing',
          'long-?term',
          'diagnosed',
          'mental',
          'physical',
          'heart',
          'lung',
          'kidney',
          'liver',
          'skin',
          'thyroid',
          'autoimmune',
          'genetic',
          'hereditary',
          'rare',
          'terminal',
        ],
        gap: 2,
      },
      { kind: 'example', introducers: ['like', String.raw`such\s+as`, 'including'] },
      // "I have other conditions", "I have conditions that are managed" — a bare
      // plural with no qualifier would otherwise fall through, and that is a real
      // disclosure phrasing. It cannot be the contractual sense: requirements
      // attached to a product are not something a person *has* about themselves.
      // ("I have no conditions" gates too, which is harmless.)
      { kind: 'disclosure' },
    ],
  },
  {
    id: 'treatment',
    spellings: ['treatment'],
    rule: 'context-required',
    ordinarySense:
      'how something is handled ("the tax treatment of the proceeds", "equal treatment for all applicants")',
    context: [
      {
        kind: 'owner',
        words: [...PERSONAL_OWNERS.split('|'), 'the', 'a', 'an', 'this', 'that'],
        // "the treatment of the claim" is the ordinary sense; "the treatment is
        // working" stays medical, and the lookahead is what separates them.
        excludeOf: true,
      },
      { kind: 'disclosure' },
      {
        kind: 'qualifier',
        words: [
          'medical',
          'clinical',
          'health',
          'hospital',
          'cancer',
          String.raw`chemo\w*`,
          'dialysis',
          'psychiatric',
          'mental',
          'surgical',
          'drug',
          'pain',
          'fertility',
        ],
      },
      {
        kind: 'anchor',
        words: [
          'plan',
          'options?',
          'programme',
          'program',
          'centre',
          'center',
          'costs?',
          'regimen',
          'course',
        ],
      },
      // "I am receiving treatment", "I am on treatment", "I need treatment" — the
      // verb carries the sense, so the noun needs no other help.
      {
        kind: 'verb',
        words: [
          'undergoing',
          'receiving',
          'getting',
          'started',
          'stopped',
          'continuing',
          'refused',
          'declined',
          'began',
          'needs?',
          'needed',
          'in',
          'on',
          'covers?',
          'covering',
          'paying for',
          'reimbursed?',
          'includes?',
          'included',
        ],
      },
    ],
  },
  {
    id: 'heart',
    spellings: ['heart', 'hearts'],
    rule: 'of-metaphor-excluded',
    ordinarySense: 'a metaphor for the centre of something ("the heart of the policy")',
    // "the heart of my plan" IS the metaphor, so heart takes only the bare
    // exclusion — the two medical "of" clauses stay off. Everything else is
    // medical: "my heart is fine", "heart attack", "heart disease", "I have a
    // bad heart", "congestive heart failure", "heart murmur", "I had a heart
    // scare".
    medicalOf: false,
    // `heartburn` is its own word: `\bheart\b` never matched it, and it is the
    // vocabulary's synonym for GERD.
    extraWords: [
      {
        spelling: 'heartburn',
        reason: 'a compound `\\bheart\\b` never matched; the vocabulary synonym for GERD',
      },
    ],
  },
  {
    id: 'symptom',
    spellings: ['symptom', 'symptoms'],
    rule: 'of-metaphor-excluded',
    ordinarySense: 'a sign of a non-medical problem ("a symptom of a slow claims process")',
    // "symptoms of my condition" and "symptoms of the liver" are medical; the
    // "of" clauses keep both while the bare exclusion clears "a symptom of a
    // wider problem with my coverage".
    medicalOf: true,
  },
  {
    id: 'prescription',
    spellings: ['prescription', 'prescriptions'],
    rule: 'of-metaphor-excluded',
    // Only one ordinary shape is measurable in this domain, and it is the same
    // "of" metaphor: in a compliance chat, "prescription" otherwise means drugs.
    // The plural matters — visitors write "my prescriptions are expensive".
    ordinarySense: 'rhetorical advice ("the prescription of rates is regulated")',
    medicalOf: true,
  },
  {
    id: 'disease',
    spellings: ['disease', 'diseases'],
    rule: 'of-metaphor-excluded',
    ordinarySense: 'a metaphor for a systemic ill ("the disease of rising premiums")',
    // "a disease of the liver" is medical; the exclusion exists so named
    // conditions ending in the word stay detectable (peripheral artery disease,
    // reactive airway disease, chronic obstructive pulmonary disease).
    medicalOf: true,
  },
  {
    id: 'disorder',
    spellings: ['disorder', 'disorders'],
    rule: 'of-metaphor-excluded',
    ordinarySense: 'untidiness in a system ("the disorder of the ledger")',
    // Same as disease: the exclusion keeps post-traumatic stress disorder, major
    // depressive disorder, panic disorder and "an eating disorder" detectable.
    medicalOf: true,
  },

  // ── The words the first measurement pass narrowed in place ─────────────────
  // These four were hand-written patterns in security-controls.ts until the
  // clause vocabulary above could express them. The clause order here is the
  // order of the patterns they replaced, so the two can be compared clause by
  // clause — and every comment that carried the measurement came across with it.
  //
  // What that measurement found, for provenance: `diagnosis` was the bare stem
  // `diagnos(?:ed|is)` and graded eight of twenty probe sentences wrong (seven
  // false handoffs, one miss — the plural "I have two diagnoses" the stem never
  // matched); `therapy` false-gated eight of ten benign probes, six of them the
  // two prefixes below; `therapist` was not matched by anything at all, because
  // the stem does not reach it; `medication` had no ordinary sense to find. The
  // sentences are in `META_WORD_CASES` and `META_WORD_COVERAGE`
  // (tests/gate-road-test.test.ts), both directions asserted.
  {
    id: 'diagnosis',
    // The word is a stem: `diagnos\w*` covers diagnosis, diagnoses, diagnosed,
    // diagnosing. The noun forms are a declared group because three clauses must
    // count the noun and not the verb: "diagnosis date" is medical, "diagnosed
    // date" is not.
    spellings: ['diagnos'],
    stem: true,
    spellingGroups: { noun: ['diagnosis', 'diagnoses'], past: ['diagnosed'] },
    rule: 'context-required',
    ordinarySense:
      'a fault found by a mechanic or a support agent ("the problem was diagnosed as a timing issue", "can you run a diagnosis on my account?")',
    context: [
      // "diagnosed with lupus" — the canonical medical form.
      {
        kind: 'anchor',
        words: ['with'],
        reason: 'the canonical form: a diagnosis is OF something',
      },
      {
        kind: 'person',
        persons: PERSON_PRONOUNS.split('|'),
        verbs: LINKING_VERBS.split('|'),
        reason:
          'person first, with a be/have verb between: "I was diagnosed last year", "I\'ve been diagnosed", "I have two diagnoses"',
      },
      {
        kind: 'person',
        persons: PERSON_PRONOUNS.split('|'),
        // The interrogative list as measured. The informal got/get/gets are
        // deliberately absent: they were measured in the declarative order, and
        // "have I diagnosed?" is the question form a visitor writes, not "got
        // I diagnosed".
        verbs: ['was', 'were', 'been', 'being', 'am', 'is', 'are', 'have', 'has', 'had'],
        order: 'verb-first',
        reason:
          'the interrogative order with the same verb: "was I diagnosed as a child?", "was she diagnosed?"',
      },
      {
        kind: 'owner',
        words: PERSONAL_OWNERS.split('|'),
        gap: 0,
        // The gap is closed and the adjectives are listed, because "my mechanic
        // diagnosed" is exactly the collision this clause has to clear.
        intervening: [
          'recent',
          'initial',
          'final',
          'official',
          'formal',
          'new',
          'primary',
          'second',
          'original',
          'latest',
          'own',
        ],
        reason: 'a possessed diagnosis: "my diagnosis", "his diagnosis changed my outlook"',
      },
      {
        kind: 'relative',
        members: FAMILY_MEMBERS.split('|'),
        direction: 'before',
        reason:
          'a relative\'s diagnosis is the visitor\'s family history: "my father was diagnosed with cancer"',
      },
      {
        kind: 'relative',
        members: FAMILY_MEMBERS.split('|'),
        direction: 'after',
        owners: PERSONAL_OWNERS.split('|'),
        reason: 'the same statement the other way round: "diagnosed my father last year"',
      },
      {
        kind: 'clinician',
        words: CLINICIANS.split('|'),
        reason: 'the source or the setting: "the doctor\'s diagnosis", "the hospital diagnosed me"',
      },
      {
        kind: 'temporal',
        direction: 'before',
        markers: [
          'recently',
          'newly',
          'already',
          'previously',
          'formerly',
          'formally',
          'officially',
          'never',
          'ever',
          'just',
          'finally',
        ],
        linkers: ['been'],
        reason:
          'the adverbial form with no subject: "recently diagnosed", "I\'ve just been diagnosed"',
      },
      {
        kind: 'anchor',
        words: [
          'date',
          'codes?',
          'records?',
          'letter',
          'report',
          'paperwork',
          'pending',
          'results?',
          'unknown',
        ],
        form: 'noun',
        reason: 'clinical artifacts: "diagnosis date", "diagnosis code", "diagnosis pending"',
      },
      {
        kind: 'qualifier',
        words: [
          'medical',
          'clinical',
          'official',
          'formal',
          'primary',
          'initial',
          'secondary',
          'dual',
          'psychiatric',
          'mental',
          'health',
          'terminal',
        ],
        gap: 0,
        form: 'noun',
        reason: 'a qualified diagnosis: "clinical diagnosis", "dual diagnosis"',
      },
      {
        kind: 'verb',
        words: [
          'received',
          'obtained',
          'got',
          'gotten',
          'given',
          'gave',
          'share',
          'shares',
          'shared',
          'sharing',
          'learned',
          'requested',
          'asked for',
          'waiting for',
          'awaiting',
          'seeking',
          'seek',
          'arrived at',
          'came to',
        ],
        intervening: ['a', 'an', 'my', 'his', 'her', 'their', 'our', 'your', 'the', 'any', 'no'],
        form: 'noun',
        // The verb list is the point: "run a diagnosis", "perform a diagnosis"
        // and "a diagnosis of the account" are the mechanism sense and stay out.
        reason: 'acquiring or sharing one: "I received a diagnosis", "I asked for a diagnosis"',
      },
      {
        kind: 'anchor',
        words: ['me', 'us', 'him', 'her', 'them'],
        reason: 'a person as the object: "they diagnosed me", "the doctor diagnosed me"',
      },
      {
        kind: 'anchor',
        words: ['but', 'and', 'then', 'since'],
        // The measured shape was the past participle, so the clause is limited to
        // it: "diagnosed but untreated" is a statement about a person, while
        // "diagnosis and treatment" is a phrase about care in general.
        form: 'past',
        reason: 'the connective form with no subject: "diagnosed but untreated"',
      },
      {
        kind: 'qualifier',
        words: ['two', 'three', 'four', 'several', 'multiple', 'many', 'both', 'any', 'no'],
        gap: 1,
        form: 'noun',
        reason: 'counted nouns: "two diagnoses" — the plural the old stem never matched at all',
      },
      {
        kind: 'temporal',
        direction: 'after',
        markers: [
          String.raw`(?:last|this)\s+(?:year|month|summer|winter|spring|autumn|fall|decade)\b`,
        ],
        reason: 'a calendar time after the word: "diagnosed last year", "diagnosed this month"',
      },
      {
        kind: 'temporal',
        direction: 'after',
        markers: [String.raw`(?:at|in|since)\s+\d`],
        // No trailing boundary on this one, so "diagnosed in 3rd grade" stays a
        // statement of diagnosis. "diagnosed in 3 minutes" gates too, which is
        // the safe direction for a sentence that is nearly always a diagnosis.
        reason: 'a date or an age after the word: "diagnosed at 30", "diagnosed in 2019"',
      },
    ],
  },
  {
    id: 'therapy',
    spellings: ['therapy', 'therapies'],
    rule: 'bare',
    ordinarySense:
      'an idiom, a product or a joke ("retail therapy", "aromatherapy candles", "wine is my therapy")',
    // Two word-initial prefixes carry the measurable ordinary senses, so the word
    // is carved out by them rather than by context: "I did some retail therapy at
    // the weekend", "I run an aromatherapy business on the side".
    prefixExclusions: [
      { word: 'retail', reason: 'retail therapy is an idiom, not care' },
      {
        word: 'aroma',
        attached: true,
        reason: 'aromatherapy is a product and a trade, and the prefix is joined to the word',
      },
    ],
    // The compounds are why this pattern is not anchored at the front: the stem
    // has to keep matching words that never start with "therapy".
    compounds: {
      spellings: ['chemotherapy', 'physiotherapy', 'psychotherapy'],
      reason: 'the clinical compounds carry the stem after a word character',
    },
  },
  {
    id: 'therapist',
    spellings: ['therapist', 'therapists'],
    rule: 'bare',
    ordinarySense: 'an occupation ("I am a massage therapist", "a beauty therapist")',
    // "therapist" is its own entry because the stem does not reach it: the word
    // contains "therap" but not "therapy". The carve-outs are the occupation
    // senses, the same shape as the "aromatherapy business" row — a visitor
    // answering an occupation question with "I'm a massage therapist" is not
    // disclosing care. "physical therapist" stays in: that is a treatment
    // relationship.
    prefixExclusions: [
      { word: 'massage', reason: 'massage therapist is an occupation' },
      { word: 'beauty', reason: 'beauty therapist is an occupation' },
      { word: 'nail', reason: 'nail therapist is an occupation' },
      { word: 'hair', reason: 'hair therapist is an occupation' },
      { word: 'spa', reason: 'spa therapist is an occupation' },
    ],
  },
  {
    id: 'medication',
    // The plural is spelled out rather than left to the stem: "my medications are
    // expensive" is a real disclosure, and the word as measured has no ordinary
    // sense to trade against. Its informal form is a second spelling — "I stopped
    // taking my meds", "my meds are expensive", "I am on meds" were all
    // travelling unclassified.
    spellings: ['medications', 'medication', 'meds'],
    rule: 'bare',
    ordinarySense:
      'none measured — "medicate the problem" and "medicated shampoo" do not even contain the word, which is the reason to leave it alone rather than qualify it',
  },
];

/** Every pattern the registry generates, in entry order — what the gate runs. */
export const CONTEXT_FAMILY_PATTERNS: readonly RegExp[] = CONTEXT_FAMILY_TERMS.flatMap(
  buildContextFamilyPatterns,
);
