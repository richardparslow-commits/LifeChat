/**
 * The context-qualified gate registry — the one place a term that collides with
 * ordinary English is taught to the gate.
 *
 * Some condition names cannot be gated as bare tokens: "Ms." is a title,
 * "Tia" is a name, "sle" is a substring of "sleep", "tb" is under the
 * three-character minimum, and "piles" is a quantifier ("piles of paperwork").
 * Each such term is listed in `GATE_EXCLUDED_TERMS`, and each entry below says
 * what context makes the medical reading unmistakable.
 *
 * Every entry declares its own data, and the whole regex family is derived from
 * it. An entry supplies:
 *
 *   spellings        the word(s) as written; `dotted` adds the initialism spelling
 *   guard            a fragment excluding the ordinary reading, embedded in the
 *                    token so EVERY pattern that watches it inherits it
 *   possessives      determiners that make it personal ("my MS", "her piles")
 *   qualifiers       clinical nouns immediately before it ("bleeding piles")
 *   namedSpellings   which spellings may be named in a question at all
 *   disclosureWords  extra words THIS entry accepts before the token
 *   clinicalWords    extra words THIS entry accepts after the token
 *   strips           non-clinical senses removed from a copy of the message first
 *
 * From those, five shapes are generated (never hand-written):
 *
 *   forward      disclosure → token   "I have MS", "I've got piles"
 *   reverse      token → clinical     "MS diagnosis", "SLE flares"
 *   possessive   determiner → token   "my TB is latent", "her piles"
 *   qualifier    clinical → token     "bleeding piles"
 *   named        the token alone      the question path ("Is piles curable?")
 *
 * Adding the next lay synonym is therefore one object in
 * `CONTEXT_QUALIFIED_TERMS` — not a new pattern, and not a new place to forget
 * the guard: because the guard is embedded in the generated token, a rule that
 * watches the token cannot omit it, and
 * tests/context-qualified-terms.test.ts asserts that structurally for every
 * entry.
 *
 * The two adjacency word lists are shared by every entry: they describe how a
 * person states a diagnosis, not anything about a particular term. They were
 * widened by a road test over realistic visitor messages
 * (tests/gate-road-test.test.ts), which found seven phrasings a real person
 * types that the original six verbs missed — "I've got MS", "I suffer from MS",
 * "MS sufferer", "MS runs in my family", "I tested positive for TB", "latent
 * TB", "I'm a TIA survivor", "MS fatigue". Each of those was a live leak: health
 * data reaching the model unclassified. Every addition is paired with a benign
 * counterpart in that corpus, so the collision surface cannot grow without a
 * test noticing.
 *
 * Sharing is the default because a disclosure word usually says nothing about a
 * particular term. When the measurement shows otherwise, an entry declares
 * `disclosureWords` / `clinicalWords` of its own: the discovery verbs belong to
 * `lump` ("I found a lump", "a lump was found") and adding them to the shared
 * list would have made "I found stones for the patio" gate, because the stones
 * token would then accept a disclosure the gardens corpus never measured. An
 * entry's extras are appended to the shared list for that entry alone, so
 * widening one term's vocabulary cannot loosen another's.
 */

/**
 * One non-clinical sense of a spelling, removed from a copy of the text before
 * any pattern runs.
 *
 * Case-sensitive by design wherever the colliding spelling differs from the
 * diagnosis spelling: only "Ms." is stripped, so "MS" survives. The pattern
 * must carry the `g` flag — without it only the first occurrence of an
 * ambiguous sense would be removed — which
 * tests/context-qualified-terms.test.ts asserts for every entry.
 */
export interface AmbiguousSpelling {
  /** Global-flag pattern for the sense to remove. */
  readonly pattern: RegExp;
  /** What to leave in its place; a space, so word boundaries survive. */
  readonly replacement: string;
}

/**
 * A term that is gated only in context — one entry of the registry.
 *
 * All fields are data: nothing here is a regular expression except the guard,
 * which is a regex fragment because a guard is genuinely a pattern. Plain
 * spellings are escaped when the token is built.
 */
export interface ContextQualifiedTerm {
  /** Stable id, used by tests and the docs; must match the `GATE_EXCLUDED_TERMS` entry. */
  readonly id: string;
  /** The spelling(s) as a person writes them ("ms", "piles"). */
  readonly spellings: readonly string[];
  /** Also match the dotted initialism ("M.S.", "S.L.E."), with an optional trailing period. */
  readonly dotted?: boolean;
  /**
   * Regex fragment appended to the token, excluding this term's ordinary reading
   * when the shape follows it — a negative lookahead, usually ("piles of"). It
   * is part of the token, so every generated pattern inherits it.
   */
  readonly guard?: string;
  /**
   * Regex fragment placed immediately before the token, for an ordinary reading
   * that *precedes* it: "with stones" is the quantifier sense of a shared
   * disclosure word, and only a lookbehind sited here can see the word in front
   * of the token. Same inheritance as `guard`.
   */
  readonly precedingGuard?: string;
  /** Determiners that make the token personal; empty means the entry has no possessive rule. */
  readonly possessives: readonly string[];
  /** Clinical nouns that sit immediately before the token; empty means no qualifier rule. */
  readonly qualifiers: readonly string[];
  /**
   * The spellings that are unambiguous when a question names them.
   *
   * Defaults to every spelling. Declared narrower when one spelling has a
   * second, ordinary reading of its own that no guard can separate in a
   * question — the singular mass noun "stone" ("is stone cheaper than brick?")
   * versus the plural a person uses for a calculus. An empty array declares that
   * the term is never named on the question path at all.
   */
  readonly namedSpellings?: readonly string[];
  /**
   * Extra words this entry accepts in the disclosure position, appended to the
   * shared `CONTEXT_DISCLOSURE_WORDS` for this entry alone.
   *
   * Declared when the phrasing belongs to this word rather than to how people
   * state a diagnosis in general. `lump` declares the discovery verbs ("I found
   * a lump", "I noticed a lump", "there's a lump"), because they are how a lump
   * is stated — while "I found stones for the patio" must stay silent, so they
   * cannot go in the shared list.
   */
  readonly disclosureWords?: readonly string[];
  /**
   * Extra words this entry accepts after the token, appended to the shared
   * `CONTEXT_CLINICAL_WORDS` for this entry alone — the passive voice of the
   * same phrasing ("a lump was found", "the lump was removed").
   */
  readonly clinicalWords?: readonly string[];
  /** Non-clinical senses of this spelling, stripped from a copy of the text first. */
  readonly strips?: readonly AmbiguousSpelling[];
}

/** The patterns generated from one entry — five shapes, all derived from its data. */
export interface ContextQualifiedPatterns {
  /** Disclosure word before the token: "I have MS", "I was treated for TB". */
  readonly forward: RegExp;
  /** Clinical noun after the token: "MS diagnosis", "TB treatment". */
  readonly reverse: RegExp;
  /** Possessive determiner immediately before the token: "my SLE", "her piles". */
  readonly possessive: RegExp | null;
  /** Clinical qualifier immediately before the token: "bleeding piles". */
  readonly qualifier: RegExp | null;
  /**
   * The token alone, for the question path: "Is piles curable?".
   *
   * Null when the entry declares no spellings that are safe to name — the term
   * is then only ever gated through its context shapes.
   */
  readonly named: RegExp | null;
}

/** Gap between a token and its context word; never crosses a sentence. */
const CONTEXT_GAP = String.raw`[^.\n]{0,20}`;

/**
 * Words that state a diagnosis, a history of one, or a disclosure of it. The
 * keyword may sit before the token ("I have MS") or after it ("MS diagnosis").
 *
 * Grouped by the phrasing they cover: past/current state (had, has, have,
 * having, got, get), history framing (history of), clinical verbs (diagnosed,
 * suffer/suffers/suffered/suffering, survived, treated for, managed for), test
 * results (tested positive for, test positive for, positive for), the latent
 * form of TB, family transmission (runs in my family, in my family) and the
 * plain preposition (with).
 */
const CONTEXT_DISCLOSURE_WORDS = [
  String.raw`had|has|have|having|got|get|gets|getting`,
  String.raw`history of|diagnosed`,
  String.raw`suffer|suffers|suffered|suffering`,
  String.raw`survived|survivor of|carrier of`,
  String.raw`treated for|managed for|medication for|treatment for|therapy for|on medication`,
  String.raw`hospitali[sz]ed|hospital|admitted for|in hospital`,
  String.raw`declar\w*|disclos\w*`,
  String.raw`tested positive for|test positive for|tests positive for|positive for`,
  String.raw`latent`,
  String.raw`runs in (?:my|our|the) family|in (?:my|our|the) family`,
  String.raw`with`,
].join('|');

/**
 * Clinical nouns a visitor writes *after* the token when they name it first.
 *
 * The last four — sufferer, survivor, carrier, fatigue — are the phrasings the
 * road test found missing; `related` covers the hyphenated compound ("MS-
 * related fatigue"); `test\w*` covers "TB test came back positive"; the family
 * phrases cover "MS runs in my family".
 */
const CONTEXT_CLINICAL_WORDS = [
  String.raw`diagnos\w*|symptom\w*|flare\w*|relaps\w*`,
  String.raw`treatment|medication|infusion|since|patient`,
  String.raw`sufferer|survivor|carrier|fatigue|related|nephritis`,
  // Bodily and fluid words, added by the stones measurement: "stones in my
  // urine", "pads for bleeding" are how the symptoms are stated, and without
  // them the token-first direction had nothing to attach to.
  String.raw`urine|urinary|stool|bleeding|spotting|ureter|ureteral|ureteric`,
  String.raw`latent|test\w*|manag\w*|screening`,
  String.raw`support group|clinic|specialist|neurologist|rheumatolog\w*`,
  String.raw`appointment|check-?ups?|scans?|x-?rays?|surgery`,
  String.raw`in (?:my|our|the) family|runs in (?:my|our|the) family`,
].join('|');

/**
 * "my" and nothing else.
 *
 * Deliberately NOT the wider determiner set below: with a 20-character window,
 * "my name is Tia" would gate, so the abbreviations accept only the possessive
 * that normally precedes a condition a person owns. The remaining false
 * positive is an acronym that is not a diagnosis ("my MS Office license"),
 * which fails in the safe direction.
 */
const POSSESSIVE_MY = ['my'] as const;

/**
 * The full determiner set, for a term whose guard already excludes the ordinary
 * reading — "her piles of books" cannot gate, because the guard rejects the
 * quantifier before the possessive is even considered.
 */
const POSSESSIVE_DETERMINERS = ['my', 'his', 'her', 'their', 'your', 'our'] as const;

/**
 * Excludes the quantifier and phrasal-verb shapes: "piles of paperwork", "the
 * work piles up", "he piles on the pressure". Every ordinary use of "piles" has
 * one of these shapes and the medical reading never does, so the guard can be a
 * lookahead rather than a whole-word exclusion — which is what keeps "I have
 * piles" gating.
 */
const QUANTIFIER_AND_PARTICLE_EXCLUSION = String.raw`(?!\s+(?:of|up|on|in|into|onto|upon)\b)`;

/**
 * Excludes the token when a place follows: "the stones in the driveway", "the
 * stones on the beach". The medical phrase keeps a possessor or a body word
 * ("stones in my kidney"), so excluding the definite article is what separates
 * them — and it is the shape the garden-and-driveway sentences all have.
 */
const LOCATION_EXCLUSION = String.raw`(?!\s+(?:in|on|at|by|near|along|under)\s+the\b)`;

/**
 * For a term whose medical phrase keeps a preposition the ordinary one also uses
 * — "stones in my urine" is medical, "the stones in the driveway" is not — the
 * exclusion narrows to the frames that are always ordinary: the quantity
 * ("stones of the path"), the task ("stones to move this weekend") and the place
 * named with the definite article (`LOCATION_EXCLUSION`).
 */
const QUANTITY_AND_TASK_EXCLUSION = String.raw`(?!\s+(?:of|to|up|down)\b)`;

/**
 * Excludes the token when the shared disclosure word `with` is what precedes it.
 * "a driveway with stones" is not a disclosure, and no lookahead can tell it
 * from "living with stones" — but the difference is the word immediately before
 * the token, which is exactly what a lookbehind sees.
 */
const NOT_PRECEDED_BY_WITH = String.raw`(?<!\bwith\s)`;

/**
 * The registry. One object per context-qualified term; everything the gate
 * needs is derived from these fields.
 *
 * Order has no behavioral effect — each entry compiles to its own patterns —
 * and follows GATE_EXCLUDED_TERMS order for review, with the lay synonym last.
 */
export const CONTEXT_QUALIFIED_TERMS: readonly ContextQualifiedTerm[] = [
  {
    // "Ms." is a title and "an M.S. degree" is a qualification; the diagnosis
    // spelling is untouched by the strips.
    id: 'ms',
    spellings: ['ms'],
    dotted: true,
    possessives: POSSESSIVE_MY,
    qualifiers: [],
    strips: [
      // "Ms. Smith" — the honorific, not the diagnosis. Case-sensitive, so only
      // the honorific spelling is stripped and "MS"/"ms" survives.
      { pattern: /\bMs\.?\s+/g, replacement: ' ' },
      { pattern: /\bMs\.?$/g, replacement: ' ' },
      // "an M.S. degree", "an M.S. in economics" — the degree, not the
      // diagnosis. Lookahead only, so the rest of the sentence is left in
      // place. Deliberately limited to the noun that follows directly: extending
      // it to "M.S. is in ..." swallowed "my M.S. is in remission", a real
      // disclosure, so the copula form stays a false positive instead (fails
      // safe).
      {
        pattern:
          /\bM\.S\.?(?=\s+(?:degree|in|from|student|programme|program|thesis|dissertation))/g,
        replacement: ' ',
      },
      // A unit, not a diagnosis: "300 ms", "500ms". Without this, any question
      // about latency reads as a question about multiple sclerosis.
      { pattern: /\b\d+\s*ms\b/gi, replacement: ' ' },
    ],
  },
  {
    // `\bsle\b` cannot match inside "sleep", which is exactly why it needed no
    // strip — and why it was excluded as a bare token in the first place.
    id: 'sle',
    spellings: ['sle'],
    dotted: true,
    possessives: POSSESSIVE_MY,
    qualifiers: [],
  },
  {
    // "Tia" is a common first name ("I spoke with Tia yesterday", "I have Tia
    // as my beneficiary"), and in English it is always written with a leading
    // capital, while the diagnosis is written "TIA" or "tia". Case-sensitive
    // for that reason: the name is stripped, the diagnosis spelling survives.
    // Documented limitation: a sentence-initial "Tia" meaning the stroke ("Tia
    // was last March") is indistinguishable from the name and is not gated.
    id: 'tia',
    spellings: ['tia'],
    dotted: true,
    possessives: POSSESSIVE_MY,
    qualifiers: [],
    strips: [{ pattern: /\bTia\b/g, replacement: ' ' }],
  },
  {
    // Two characters, so it fails the minimum-length rule for a token;
    // "tuberculosis" is gated on its own.
    id: 'tb',
    spellings: ['tb'],
    dotted: true,
    possessives: POSSESSIVE_MY,
    qualifiers: [],
  },
  {
    // The lay synonym for hemorrhoids, and the only entry whose collision is
    // syntactic rather than lexical: it is a quantifier and a phrasal verb, so
    // its guard does the separating and its determiners can be the full set.
    // A clinical qualifier ("bleeding piles") gates it without even needing a
    // disclosure word.
    id: 'piles',
    spellings: ['piles'],
    guard: QUANTIFIER_AND_PARTICLE_EXCLUSION,
    possessives: POSSESSIVE_DETERMINERS,
    qualifiers: ['bleeding', 'external', 'internal', 'thrombosed', 'strangulated', 'prolapsed'],
  },
  {
    // The lay word for a lump — what a person says about a mass they can feel,
    // and the word a breast history is almost always stated with ("I found a
    // lump in my breast"). Its ordinary senses are the product's own vocabulary
    // and generic frames, so it is gated in context only:
    //
    //   lump sum          the payout shape ("should I take the lump sum or
    //                     monthly payments?", "how is the lump sum taxed?")
    //   a lump of X       the quantifier ("a lump of coal", "lumps of ice")
    //   lump it/together  the phrasal verb ("I'll have to lump it", "lump them
    //                     together")
    //
    // The guard is a lookahead for exactly those frames, so no possessive or
    // disclosure word can resurrect them: "my lump sum", "I have a lump of
    // coal" and "the lump sum option" all stay silent. The discovery verbs are
    // declared per entry rather than added to every term's shared list — see the
    // module comment: "I found stones for the patio" must stay silent.
    id: 'lump',
    spellings: ['lump', 'lumps'],
    guard: String.raw`(?!\s+(?:sum|of|it|them|together)\b)`,
    possessives: POSSESSIVE_DETERMINERS,
    qualifiers: ['breast', 'neck', 'armpit', 'underarm', 'collarbone', 'thyroid', 'skin'],
    // Discovery in the active voice, plus the existential a person uses when
    // they have not "found" anything yet: "there's a lump in my breast".
    disclosureWords: ['found', 'noticed', 'felt', 'can feel', String.raw`there(?:'s| is)`],
    // The passive voice of the same statement, and the clinical words a lump is
    // investigated with: "a lump was found on the scan", "the lump was removed
    // in 2022", "lump biopsy results".
    clinicalWords: ['found', 'noticed', 'seen', 'saw', 'removed', String.raw`biops\w*`],
  },
  {
    // The prostate tumour marker, stated by its abbreviation far more often than
    // by its name ("my PSA came back high"). Its rival reading is the
    // announcement — "PSA: check your beneficiaries", "a PSA campaign" — which
    // is why it is gated in context like every other three-letter abbreviation
    // here, and why the announcement frames are stripped outright.
    id: 'psa',
    spellings: ['psa'],
    possessives: POSSESSIVE_MY,
    qualifiers: ['elevated', 'raised', 'high', 'prostate', 'blood'],
    clinicalWords: [String.raw`test|level|reading|result|came back|score|screening|check`],
    strips: [
      { pattern: /\bpublic service announcement\b/gi, replacement: ' ' },
      { pattern: /\bpsa\s*:\s*/gi, replacement: ' ' },
      { pattern: /\bpsa\s+(?:campaign|video|post|announcement|message)\b/gi, replacement: ' ' },
    ],
  },
  {
    // The skin symptom a person describes, and the codebook's own word for it.
    // Its ordinary sense is adjectival and always takes a noun of judgment
    // ("a rash decision", "a rash promise"), which is what the guard excludes —
    // so "I have a rash", "my rash" and "a rash on my arm" gate, while the
    // decision-making sense does not. The possessive rule has to be the full
    // determiner set: "my rash decision" would otherwise read as a symptom, and
    // the guard is what makes the wider set safe here.
    id: 'rash',
    spellings: ['rash', 'rashes'],
    guard: String.raw`(?!\s+(?:decision|choice|promise|move|act|actions?|words?|judgment|judgement|assumption|bet)\b)`,
    possessives: POSSESSIVE_DETERMINERS,
    qualifiers: ['skin', 'itchy', 'red', 'allergic', 'nappy', 'diaper', 'heat'],
    // Where a rash is: "a rash on my arm", "a rash on her chest". Without this
    // the body-site phrasing has no anchor at all, since it carries no
    // disclosure verb and often no possessive.
    clinicalWords: [
      String.raw`on\s+(?:my|his|her|their|our|your|the)\s+(?:arm|arms|leg|legs|chest|back|face|neck|hand|hands|torso|stomach|abdomen|skin)`,
    ],
  },
  {
    // Pain stated as the thing a person has, rather than as a qualifier of a
    // body part ("chest pain" and "back pain" are gated as phrases in their own
    // right). Its ordinary senses are the business frames — the product's own
    // "pain points", and the idiom "a pain in the neck" — so it is gated in
    // context only, and those frames are stripped before matching because both
    // carry a determiner the possessive rule would otherwise accept.
    id: 'pain',
    spellings: ['pain', 'pains'],
    possessives: POSSESSIVE_DETERMINERS,
    qualifiers: ['chronic', 'severe', 'constant', 'sharp', 'dull', 'throbbing', 'nerve'],
    // Bodily locations, so "pain in my knee" and "pains in my legs" gate without
    // a disclosure word — the phrasings a person actually uses.
    clinicalWords: [
      // With an optional side or level between the determiner and the site: "the
      // pain is in my lower back" is how the complaint is stated, and the
      // descriptor is measured here rather than guessed at (the same list the
      // site words come from, so an undeclared organ still cannot reach it).
      String.raw`(?:is\s+)?in\s+(?:my|his|her|their|our|your|the)\s+(?:(?:lower|upper|mid|middle|left|right)\s+)?(?:back|neck|knee|knees|hip|hips|leg|legs|arm|arms|hand|hands|foot|feet|abdomen|stomach|chest|shoulder|shoulders|joint|joints|side|head)`,
    ],
    strips: [
      // The business frame, not a symptom: "the pain points of the process".
      { pattern: /\bpain\s+points?\b/g, replacement: ' ' },
      // The idiom keeps the definite article; the medical phrase keeps the
      // possessive ("a pain in my neck"), which is why only this form is
      // stripped.
      { pattern: /\bpains?\s+in\s+the\s+neck\b/g, replacement: ' ' },
    ],
  },
  {
    // The lay synonym for a calculus: "I have stones" is how a person states
    // kidney stones. The vocabulary carries the anatomical phrases ("kidney
    // stones", "gallstones") but not the bare word.
    //
    // Its ordinary sense is not a homonym but the same noun in a frame: the
    // quantifier ("stones of the path"), the location ("the stones in the
    // driveway"), the task ("stones to move"), the material mass noun ("stone is
    // cheaper than brick"), and the ``with`` phrase the shared disclosure list
    // would otherwise read as a disclosure ("a driveway with stones"). The first
    // two are guarded, the third and fifth by the guard and the lookbehind, and
    // the mass noun by naming only the plural on the question path.
    id: 'stones',
    spellings: ['stone', 'stones'],
    guard: `${QUANTITY_AND_TASK_EXCLUSION}${LOCATION_EXCLUSION}`,
    precedingGuard: NOT_PRECEDED_BY_WITH,
    // "my stones" is not how a calculus is stated, and the possessive frame
    // belongs to landscaping ("my stones are heavy"), so none are declared.
    possessives: [],
    qualifiers: [
      'bladder',
      'ureter',
      'ureteral',
      'ureteric',
      'tonsil',
      'tonsillar',
      'salivary',
      'gall',
    ],
    namedSpellings: ['stones'],
  },
  {
    // The lay word for a stomach upset — "I have a stomach bug", "there's a bug
    // going around". The 2026-09-19 lay-word measurement deferred it: half its
    // medical phrasings ("I caught a bug") need verbs the shared disclosure list
    // does not carry, and the ordinary sense ("a bug in the app") is the
    // product's own vocabulary. Re-measured after the registry grew per-entry
    // word lists and the two-sided guard, and the measurement now separates it
    // completely — 10 of 10 medical phrasings matched, 0 of 12 ordinary sentences
    // leaked, so the ledger row retired.
    //
    // The shapes:
    //
    //   illness verbs      caught / picked up / shaking off / getting over /
    //                      coming down with — how the illness is stated (the
    //                      verbs the ledger said were missing)
    //   going around       the epidemic frame, in either direction ("a bug that
    //                      is going around", "a bug going around the office")
    //   qualifiers         stomach, tummy, flu, vomiting, diarrhea — the compound
    //                      nouns the illness is named with
    //   clinical words     sick, fever, contagious, vomiting, symptoms
    //
    // The software and pest senses are excluded by shape, not by a list of noun
    // senses: the software bug sits in a technical frame ("a bug in the app",
    // "bug report/fix/tracker", "bug bounty"), and the pest bug in a control
    // frame ("bug spray", "bug zapper", "bug net", "bug-resistant"). The guard
    // is a lookahead for both frame families, and a lookbehind excludes the
    // compounds that hide the word ("debugging", "bed bug"). Both frames are
    // the product's own vocabulary or outdoor talk — no personal or clinical
    // reading shares them, which is what makes a shape guard sufficient where
    // the ledger assumed only an open list could work.
    id: 'bug',
    spellings: ['bug', 'bugs'],
    guard: String.raw`(?!\s+(?:in|reports?|fix\w*|tracker|tracking|squash\w*|repellent|repellant|spray|zapper|net|screen|bounty)\b)`,
    precedingGuard: String.raw`(?<!\b(?:debug|bed)\w*)`,
    possessives: [],
    qualifiers: ['stomach', 'tummy', 'flu', 'vomiting', 'diarrhea', 'diarrhoea'],
    disclosureWords: [
      'caught',
      'picked up',
      'shaking off',
      'getting over',
      'coming down with',
      String.raw`going around`,
    ],
    clinicalWords: [
      String.raw`going around`,
      'sick',
      String.raw`vomit\w*`,
      'diarrhea',
      'diarrhoea',
      'fever',
      'contagious',
      String.raw`quee\w*`,
    ],
  },
  {
    // The adjective whose disclosure form is a first-person state — "I am
    // manic", "I feel manic" — and whose ordinary sense is hyperbole with a
    // noun after it. The 1.16.0 record deferred it because every frame a guard
    // could use (copula, adjectival position) is shared by both readings; the
    // measurement that closed it found the separator is not the frame but the
    // COMPOUND: the ordinary sense nearly always names its noun (week, Monday,
    // laughter, pace, energy, the trope and the dye brand), so those compounds
    // are stripped, and what remains in an adjectival slot with a first-person
    // state in front of it is the disclosure.
    //
    //   strips        the measured compounds — "a manic week", "manic Monday",
    //                 "manic laughter", "manic pixie", "Manic Panic", "manic
    //                 energy/pace/schedule" — plus the television sense of
    //                 "episode" ("a manic episode of ..."): a medical episode
    //                 never takes 'of'. The strips run before every shape, so
    //                 a possessive cannot resurrect them ("my manic Monday").
    //   preceding     the hyperbolic verbs ("he got manic at the party", "the
    //                 crowd went manic") — the shared list would otherwise
    //                 read 'got' as a disclosure.
    //   disclosure    am / I'm / feel / feeling — per entry, because 'am' on
    //                 the shared list would gate "the problem is X" for every
    //                 other term.
    //   clinical      episode(s) and depression — "manic depression" is the
    //                 codebook's own wording, and the episode noun is what the
    //                 F30 row is titled with.
    //
    // The question path stays open ("Is manic depression treatable?", "Is a
    // manic episode dangerous?"), with the TV strip protecting it there too;
    // "Is he manic?" is a third-person question about a person's state and
    // takes the topic answer, which is where a question with no first-person
    // framing goes.
    id: 'manic',
    spellings: ['manic'],
    precedingGuard: String.raw`(?<!\b(?:got|went)\s)`,
    possessives: POSSESSIVE_DETERMINERS,
    qualifiers: [],
    namedSpellings: ['manic'],
    // `feel\w*` rather than the bare verb: the structural scoping test works on
    // raw fragments, and `lump`'s own "can feel" contains "feel" — the bounded
    // stem is both precise and the only form that cannot leak.
    disclosureWords: [String.raw`\bam\b`, String.raw`i'm`, String.raw`feel\w*`],
    clinicalWords: [String.raw`episodes?`, 'depression'],
    strips: [
      {
        pattern:
          /\bmanic\s+(?:mondays?|mornings?|days?|weeks?|pace|schedule|energy|spree|cleaning|laughter)\b/gi,
        replacement: ' ',
      },
      { pattern: /\bmanic\s+pixie\b/gi, replacement: ' ' },
      { pattern: /\bmanic\s+panic\b/gi, replacement: ' ' },
      // The television sense: "a manic episode of ..." — the medical phrase
      // never takes 'of', so removing the frame removes the reading.
      { pattern: /\bmanic\s+episodes?\s+of\b/gi, replacement: ' ' },
    ],
  },
];

/** Escapes a plain spelling so it can be embedded in a generated pattern. */
const regexLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The dotted initialism for a spelling — "ms" → `m\.s\.?`, tolerate the trailing
 * period. Used only for entries that set `dotted`.
 */
const dottedSource = (spelling: string): string =>
  `${spelling.split('').map(regexLiteral).join('\\.')}\\.?`;

/**
 * The token fragment for an entry: every spelling it declares, plus the guard
 * when it has one.
 *
 * The guard lives *inside* the token rather than beside it in each pattern, so
 * it applies wherever the token is watched — the failure mode this registry
 * exists to prevent.
 */
function tokenSource(term: ContextQualifiedTerm): string {
  const spellings = term.spellings.flatMap((spelling) =>
    term.dotted ? [regexLiteral(spelling), dottedSource(spelling)] : [regexLiteral(spelling)],
  );
  const token = `(?:${spellings.join('|')})`;
  return `${term.precedingGuard ?? ''}${token}${term.guard ?? ''}`;
}

/**
 * The token fragment for a subset of an entry's spellings — used for the
 * question path, where an entry can narrow which spellings are safe to name.
 */
function namedTokenSource(term: ContextQualifiedTerm): string | null {
  const spellings = term.namedSpellings ?? term.spellings;
  if (spellings.length === 0) return null;
  return tokenSource({ ...term, spellings });
}

/**
 * Derives all five shapes from one entry. Pure and exported: the test suite
 * builds patterns for a synthetic entry through this same function, so "adding
 * a term is data" is proven against the production derivation rather than a
 * test-only copy of it.
 */
export function buildContextQualifiedPatterns(
  term: ContextQualifiedTerm,
): ContextQualifiedPatterns {
  const token = tokenSource(term);
  const namedToken = namedTokenSource(term);
  // Shared list plus anything this entry declares — joined the same way, so an
  // entry that declares none compiles to exactly the shared pattern.
  const disclosureWords = [CONTEXT_DISCLOSURE_WORDS, ...(term.disclosureWords ?? [])].join('|');
  const clinicalWords = [CONTEXT_CLINICAL_WORDS, ...(term.clinicalWords ?? [])].join('|');
  return {
    forward: new RegExp(String.raw`\b(?:${disclosureWords})\b${CONTEXT_GAP}\b${token}\b`, 'i'),
    reverse: new RegExp(String.raw`\b${token}\b${CONTEXT_GAP}\b(?:${clinicalWords})\b`, 'i'),
    possessive: term.possessives.length
      ? new RegExp(String.raw`\b(?:${term.possessives.join('|')})\s+${token}\b`, 'i')
      : null,
    qualifier: term.qualifiers.length
      ? new RegExp(String.raw`\b(?:${term.qualifiers.join('|')})\s+${token}\b`, 'i')
      : null,
    named: namedToken ? new RegExp(String.raw`\b${namedToken}\b`, 'i') : null,
  };
}

/** Compiled patterns per entry, so each registry entry compiles once. */
const patternCache = new WeakMap<ContextQualifiedTerm, ContextQualifiedPatterns>();

function patternsFor(term: ContextQualifiedTerm): ContextQualifiedPatterns {
  const cached = patternCache.get(term);
  if (cached) return cached;
  const compiled = buildContextQualifiedPatterns(term);
  patternCache.set(term, compiled);
  return compiled;
}

/**
 * Removes the non-clinical sense of each ambiguous spelling from a copy of the
 * text — the honorific "Ms.", the name "Tia", the degree sense of "M.S.", a
 * latency unit — so the patterns only ever see the diagnosis spelling.
 *
 * The caller's text is never modified, and the strips are declared by the entry
 * that owns the collision, so the registry is the only place that knows about
 * an ambiguous spelling.
 */
export function withoutAmbiguousSpellings(
  userInput: string,
  terms: readonly ContextQualifiedTerm[] = CONTEXT_QUALIFIED_TERMS,
): string {
  let text = userInput;
  for (const term of terms) {
    for (const strip of term.strips ?? []) {
      text = text.replace(strip.pattern, strip.replacement);
    }
  }
  return text;
}

/**
 * True when any entry in `terms` appears next to a disclosure or history word,
 * a clinical noun, a possessive, or a clinical qualifier: the rule that lets
 * "I have MS" and "I have piles" gate while "Ms. Smith", "sleep", and "piles of
 * paperwork" do not.
 *
 * `terms` defaults to the live registry; it is a parameter so a new entry can
 * be exercised before it ships, and so the machinery is provably data-driven.
 */
export function hasContextQualifiedTerm(
  userInput: string,
  terms: readonly ContextQualifiedTerm[] = CONTEXT_QUALIFIED_TERMS,
): boolean {
  const sanitized = withoutAmbiguousSpellings(userInput, terms);
  return terms.some((term) => {
    const patterns = patternsFor(term);
    return (
      patterns.forward.test(sanitized) ||
      patterns.reverse.test(sanitized) ||
      patterns.possessive?.test(sanitized) === true ||
      patterns.qualifier?.test(sanitized) === true
    );
  });
}

/**
 * True when any entry in `terms` names its condition on its own — the test the
 * health-topic-question path uses, where "Is piles curable?" is a question about
 * a condition and "Are piles of paperwork a problem?" is not.
 *
 * The guard still applies, because it is part of the token.
 */
export function namesContextQualifiedTerm(
  userInput: string,
  terms: readonly ContextQualifiedTerm[] = CONTEXT_QUALIFIED_TERMS,
): boolean {
  const sanitized = withoutAmbiguousSpellings(userInput, terms);
  return terms.some((term) => patternsFor(term).named?.test(sanitized) === true);
}
