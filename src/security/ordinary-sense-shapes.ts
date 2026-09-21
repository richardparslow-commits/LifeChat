/**
 * The ordinary-sense-shapes registry — the one place a *frame* that collides
 * with the gate's vocabulary is taught to the gate.
 *
 * Three strips grew up hand-written in the gate: the product-provision strip
 * (1.13.0 — "the suicide clause" is the contract's word, not a disclosure),
 * the topic-mention frames (1.14.0 — "the report mentions forced labor" is the
 * report's subject, not the visitor's), and the maltreatment-compound strip
 * ("child abuse policy for our staff" is a policy topic). Each was measured,
 * each carries guards that keep the disclosure direction alive, and each lived
 * as its own regex family — so the next collision meant hand-writing another
 * family and hoping the guards transferred.
 *
 * They are one mechanism. An entry declares:
 *
 *   terms    the watched word or words, as an alternation fragment
 *   shapes   the frames the term collides in, as template fragments over
 *            `T` (the entry's terms), the shared guard vocabulary (`@NAME`),
 *            and `@GUARDS` (the entry's own guards, expanded in place)
 *   guards   lookaheads/lookbehinds that keep the disclosure direction alive;
 *            every shape must consume them exactly once via `@GUARDS`, so a
 *            rule that watches the entry cannot omit them (the same
 *            structural rule the context-qualified registry applies to its
 *            `guard` field)
 *   consumes which earlier entries' output this entry is matched on —
 *            honoured by declaration order, which is part of the record
 *
 * `buildOrdinarySensePatterns` composes the patterns from the entries — never
 * hand-written — and tests/ordinary-sense-shapes.test.ts pins the composed
 * sources byte-exact against the last hand-written generation (the fold is
 * provable, not assumed), asserts the `@GUARDS` invariant for every entry,
 * and binds each entry to a two-directional corpus: the stripped sense and
 * the disclosure form its guards must keep.
 *
 * The guard vocabulary is shared on purpose and listed once: a personal
 * clause is a personal clause whatever the frame. Widening one is a decision
 * about English, not about a particular entry — the compound strip's
 * reach-guard and the mention frames' first-person guard share
 * `FIRST_PERSON_SINGULAR` for exactly that reason.
 */

/** Possessives that make a clause personal. "Our" is included where the
 * frame is about whose family was harmed, and excluded by shape where an
 * organisation speaks through it ("our child abuse policy" strips). */
const PERSONAL_POSSESSIVES = `(?:my|our|his|her|their|them|us)`;

/** The personal nouns a possessive can point at ("forced labor in my family"). */
const PERSONAL_NOUNS =
  `(?:famil(?:y|ies)|homes?|households?|childhoods?|experiences?|lives?|story|stories|` +
  `histories|history|abuse|trafficking|health|bodies?|workplaces?|communit(?:y|ies))`;

/** The first-person singular — the mark of the disclosure direction. */
const FIRST_PERSON_SINGULAR = `(?:i|me|my|mine)`;

/** Pronouns that can reach for a thing ("I called the child abuse hotline"). */
const REACH_PRONOUNS = `(?:i|we|she|he|they|you)`;

/** The verbs of reaching for help: calling, filing, contacting. */
const REACH_VERBS = `(?:calle?d|phon?ed|rang|used|contacted|reached|fil(?:le)?d)`;

/** The childhood frames that make "forced to work overtime" a disclosure. */
const CHILDHOOD_FRAMES = `(?:as\\s+a\\s+child|in\\s+childhood|when\\s+i\\s+was\\s+(?:a\\s+)?(?:child|young))`;

/** The nouns a provision of the product is named by (the contract's parts). */
const PROVISION_NOUNS = `(?:clauses?|exclusions?|riders?|provisions?|waiting\\s+periods?|exclusion\\s+periods?)`;

/** The artefact nouns a maltreatment term modifies when the sentence is about
 * a document or a programme rather than about a person. Deliberately tight —
 * "history" stays out because "my child abuse history" is a disclosure frame. */
const ARTEFACT_NOUNS =
  `(?:polic(?:y|ies)|procedures?|protocols?|guidelines?|guidance|training|awareness|prevention|` +
  `campaigns?|strateg(?:y|ies)|frameworks?|programmes?|programs?|laws?|legislation|` +
  `statistics|stats|courses?|charters?|workshops?|seminars?|leaflets?|posters?|` +
  `hotlines?|helplines?|report(?:ing)?\\s+forms?)`;

/** The subjects a reporting act can have: documents, organisations, audits. */
const REPORTING_SUBJECTS =
  `(?:reports?|articles?|documentar(?:y|ies)|films?|books?|podcasts?|studies|study|research|` +
  `charit(?:y|ies)|news|briefings?|audits?|investigations?|regulators?|reviews?|` +
  `suppliers?|supply\\s+chains?|polic(?:y|ies)|practices|campaigns?)`;

/** The verbs of reporting/dramatising ("the report describes …", "is about …"). */
const REPORTING_VERBS =
  `(?:mentions?|describes?|documents?|details?|covers?|discusses?|examines?|highlights?|fights?|` +
  `addresses?|is\\s+about|was\\s+about|accused\\s+of|found)`;

/** The connector after a subject ("a study *of* forced labor"). */
const REPORTING_CONNECTOR = `(?:of|on|about)`;

/** The optional article before a term ("about *the* trafficking"). */
const REPORTING_ARTICLE = `(?:the\\s+|no\\s+|any\\s+)?`;

/** Shape vocabulary an entry's templates may reference by `@NAME`. */
const SHAPE_VOCABULARY: Readonly<Record<string, string>> = {
  PERSONAL_POSSESSIVES,
  PERSONAL_NOUNS,
  FIRST_PERSON_SINGULAR,
  REACH_PRONOUNS,
  REACH_VERBS,
  CHILDHOOD_FRAMES,
  PROVISION_NOUNS,
  ARTEFACT_NOUNS,
  REPORTING_SUBJECTS,
  REPORTING_VERBS,
  REPORTING_CONNECTOR,
  REPORTING_ARTICLE,
};

/**
 * One ordinary-sense shape family — a term whose watchable wording shares
 * frames with a sense the gate must not treat as a disclosure.
 */
export interface OrdinarySenseEntry {
  /** Stable identifier, used by the corpus-binding test. */
  readonly id: string;
  /** What this entry's ordinary sense is, in one line. */
  readonly description: string;
  /** The watched term(s), as an alternation fragment (`T` in the shapes). */
  readonly terms: string;
  /** The frames the term collides in, over `T`, `@NAME` refs and `@GUARDS`. */
  readonly shapes: readonly string[];
  /** Guards every shape must consume exactly once, via `@GUARDS`. */
  readonly guards?: readonly string[];
  /** Earlier entries whose stripped output this entry is matched on. */
  readonly consumes?: readonly string[];
}

/**
 * Expand a shape or guard template: `@NAME` vocabulary refs first, then `T` —
 * the entry's terms, substituted as declared. A multi-alternative fragment
 * declares its own group (`(?:a|b)`), exactly as the composed source must
 * read; the pin proves the substitution byte-exact.
 */
function expand(template: string, terms: string): string {
  let out = template;
  for (const [name, fragment] of Object.entries(SHAPE_VOCABULARY)) {
    out = out.split(`@${name}`).join(fragment);
  }
  return out.split('T').join(terms);
}

/** The abuse/exploitation/self-harm terms both mention frames share — the
 * alternation declares its own group, which is how the composed source reads.
 * Exported because the question paths blank these compounds before their
 * personal-framing test: "child" inside "child abuse" is the condition's
 * modifier, not a person reference, and the compound is the declared unit. */
export const MALTREATMENT_TERMS =
  '(?:forced\\s+labo[u]?r|human\\s+trafficking|sex\\s+trafficking|trafficking|trafficked|' +
  'sexual\\s+exploitation|sexually\\s+exploited|financial\\s+abuse|financial\\s+exploitation|' +
  'child\\s+abuse|childhood\\s+abuse|child\\s+neglect|childhood\\s+neglect|domestic\\s+abuse|' +
  'domestic\\s+violence|elder\\s+abuse|intimate\\s+partner\\s+abuse|physical\\s+abuse|' +
  'sexual\\s+abuse|emotional\\s+abuse|psychological\\s+abuse|verbal\\s+abuse|abused|neglect|' +
  'self[-\\s]?harm|overdos\\w*|self[-\\s]?poison\\w*|self[-\\s]?mutilation\\w*|' +
  '(?:para)?suicid\\w*)';

/**
 * The registry. Order matters and is part of the record: the mention and
 * compound entries declare `consumes: ['product-provision']` and are matched
 * on text the provision entry has already stripped — a suicide *provision*
 * inside a report's sentence is product vocabulary first.
 */
export const ORDINARY_SENSE_ENTRIES: readonly OrdinarySenseEntry[] = [
  {
    id: 'product-provision',
    description:
      'The product-provision reading of the suicide words: "the suicide clause", ' +
      '"suicide exclusion" and "suicide rider" are the contract\'s own vocabulary, ' +
      'not a disclosure of ideation.',
    terms: 'suicid\\w*',
    shapes: [`\\bT\\s+@PROVISION_NOUNS\\b@GUARDS`],
  },
  {
    id: 'topic-mention',
    description:
      'The topic-mention reading of the abuse, exploitation and self-harm words: ' +
      'when one of them is the object of a reporting or documentary act by an ' +
      'artefact, an organisation or an investigation, the sentence is about the ' +
      'document, not about the person.',
    terms: MALTREATMENT_TERMS,
    shapes: [
      // <subject> of|on|about [the] <term> — "a study of forced labor" — or
      // <subject> … <reporting verb> [the] <term> — "the audit found no
      // forced labour". The guards sit inside each branch: a personal clause
      // inside the mention survives because the term must be the direct
      // object ("the report mentions that I was trafficked as a child").
      `\\b@REPORTING_SUBJECTS\\b(?:\\s+@REPORTING_CONNECTOR\\s+@REPORTING_ARTICLET\\b@GUARDS` +
        `|[^.!?]{0,40}?\\b@REPORTING_VERBS\\b\\s+@REPORTING_ARTICLET\\b@GUARDS)`,
    ],
    guards: [
      // A possessive followed by a personal noun ("forced labor in my
      // family", "trafficking in my community") is the disclosure ...
      `(?!\\s+(?:of|in|at|by|for|to|against)\\s+@PERSONAL_POSSESSIVES\\s+@PERSONAL_NOUNS\\b)`,
      // ... and so is a first-person singular within two words of the term
      // ("the trafficking I experienced"); "in our supply chain" is business
      // talk and stays strippable.
      `(?!\\s+(?:\\w+\\s+){0,1}@FIRST_PERSON_SINGULAR\\b)`,
    ],
    consumes: ['product-provision'],
  },
  {
    id: 'maltreatment-compound',
    description:
      'A maltreatment term directly modifying an artefact noun — "child abuse ' +
      'policy for our staff", "elder abuse training", "child abuse statistics", ' +
      '"the child abuse hotline" — is the term as a modifier of a thing a person ' +
      'reads, attends, runs or reaches for as a resource.',
    terms: MALTREATMENT_TERMS,
    shapes: [`\\bT\\b\\s+@ARTEFACT_NOUNS\\b@GUARDS`],
    guards: [
      // The reach-guard: a personal pronoun reaching for the thing ("I called
      // the child abuse hotline", "she called the domestic abuse hotline") is
      // a person in need, not a resource lookup — the fail-safe direction
      // 1.13.0 recorded, enforced by shape. The lookbehind sits after the
      // compound, so it must assert the whole reach-parse *including the
      // compound as its tail* ending there; an imperative ("call the child
      // abuse hotline") names no person and stays strippable.
      `(?<!\\b@REACH_PRONOUNS\\b[^.!?]{0,40}?\\b@REACH_VERBS\\b(?:\\s+\\w+){0,3}\\s+` +
        `(?:the|a|an|their|his|her|our)?\\s+T\\b\\s+@ARTEFACT_NOUNS\\b)`,
      // A possessive before the compound ("my suicide prevention plan") is a
      // person's own safety plan — a disclosure frame, not a programme.
      `(?<!^my\\s.{0,80})`,
      // A first-person singular anywhere in the sentence makes it personal
      // ("the domestic abuse policy did not help me"); "our" stays strippable
      // because an organisation speaks through it.
      `(?![^.!?]*\\b@FIRST_PERSON_SINGULAR\\b)`,
    ],
    consumes: ['product-provision'],
  },
  {
    id: 'trafficking-of-goods',
    description:
      '"Trafficking of (illegal) goods" is a crime statistic or a supply-chain ' +
      "sentence, not a person's history.",
    terms: 'trafficking\\s+of\\s+(?:illegal\\s+)?goods',
    shapes: [`\\bT\\b@GUARDS`],
  },
  {
    id: 'financial-abuse-of-system',
    description:
      '"Financial abuse of the system/process/trust" is gaming a system, not ' +
      'the Z91.413 family.',
    terms: 'financial\\s+abuse\\s+of\\s+the\\s+(?:system|process|trust)',
    shapes: [`\\bT\\b@GUARDS`],
  },
  {
    id: 'forced-to-work-overtime',
    description:
      '"Forced to work overtime/late/weekends/nights/shifts" is an ordinary ' +
      'complaint about a rota — unless the same sentence places it in childhood, ' +
      'which is the Z62.811 disclosure.',
    terms: 'forced\\s+to\\s+work',
    shapes: [`\\bT\\s+(?:overtime|late|weekends?|nights?|shifts?)\\b@GUARDS`],
    guards: [`(?!\\s+@CHILDHOOD_FRAMES)`],
  },
];

/**
 * Compose the strip patterns from the entries. Every declared guard is
 * expanded into each of the entry's shapes at its `@GUARDS` slot, so a rule
 * that watches the entry cannot omit one; an entry with guards and a shape
 * without the slot is a registration error, not a silent omission. The
 * entries parameter lets the invariant tests register a broken entry and
 * watch the builder abort.
 */
export function buildOrdinarySensePatterns(
  entries: readonly OrdinarySenseEntry[] = ORDINARY_SENSE_ENTRIES,
): readonly RegExp[] {
  const patterns: RegExp[] = [];
  for (const entry of entries) {
    const guards = entry.guards ?? [];
    for (const shape of entry.shapes) {
      if (guards.length > 0 && !shape.includes('@GUARDS')) {
        throw new Error(
          `ordinary-sense entry "${entry.id}" declares guards but its shape ` +
            `does not consume them via @GUARDS: ${shape}`,
        );
      }
      const withGuards = shape.split('@GUARDS').join(guards.join(''));
      patterns.push(new RegExp(expand(withGuards, entry.terms), 'gi'));
    }
  }
  return patterns;
}

/**
 * The input with every declared ordinary-sense shape removed (a space each).
 * Entries are applied in declaration order — `consumes` is honoured by that
 * order, so the mention and compound entries are matched on text the
 * provision entry already stripped. The strips remove a frame, never a term
 * on its own: "forced labor" and "I was trafficked as a child" are untouched.
 */
export function stripOrdinarySenseShapes(userInput: string): string {
  return buildOrdinarySensePatterns().reduce(
    (text, pattern) => text.replace(pattern, ' '),
    userInput,
  );
}
