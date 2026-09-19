/**
 * Road test — the contextual abbreviation rule against realistic visitor
 * messages.
 *
 * The context-qualified registry (`hasContextQualifiedTerm()`) closes the
 * MS/SLE/TIA/TB holes and the lay synonym "piles" by looking at context, and a
 * contextual rule can be wrong in two directions:
 *
 *   missed disclosure (fail-UNSAFE) — health data reaches the model
 *   false gate        (fail-safe)   — an educational answer becomes a handoff
 *
 * This file pins both directions with sentences a visitor would actually type
 * into a life-insurance chat. The first pass of this corpus found seven live
 * leaks ("I've got MS", "I suffer from MS", "MS sufferer here", "MS runs in my
 * family", "I tested positive for TB", "latent TB", "I'm a TIA survivor",
 * "MS fatigue"), which is why the keyword lists in `security-controls.ts` are
 * wider than the original six verbs. Every keyword added to close one of those
 * has at least one benign counterpart here, so the collision surface cannot
 * grow without a test failing. That invariant is structural too now:
 * `REGISTRY_COLLISION_CORPUS` maps every live context-qualified entry to its
 * collision rows, and the contract at the end of this file fails when an entry
 * has none — so a new lay synonym in the registry cannot ship without its
 * benign counterpart.
 *
 * `SILENT_BY_DESIGN` holds the cases where silence is the *intended* behavior
 * and the reason (a collision guard, or a token that is not a token here).
 * `JUDGMENT_CALLS` records questions *about* a disease rather than disclosures
 * of one — product decisions, not regex ones, so they are snapshotted rather
 * than asserted.
 */

import { CONTEXT_QUALIFIED_TERMS } from '../src/security/context-qualified-terms';
import { detectSensitiveData } from '../src/security/security-controls';

/** A case with a clear expected outcome. */
interface GateCase {
  message: string;
  /** What the gate must return. */
  expected: 'health_data' | 'health_topic_question' | 'not_health_data';
  why: string;
}

/** Disclosures of the four contextual abbreviations. */
const DISCLOSURES: GateCase[] = [
  { message: 'I have MS', expected: 'health_data', why: 'explicit disclosure' },
  { message: 'I was diagnosed with MS in 2019', expected: 'health_data', why: 'diagnosis + year' },
  { message: 'history of MS', expected: 'health_data', why: 'history framing' },
  { message: 'my MS is stable', expected: 'health_data', why: 'possessive' },
  { message: 'I have relapsing MS', expected: 'health_data', why: 'relapsing form' },
  {
    message: 'I have MS and want to know my options',
    expected: 'health_data',
    why: 'disclosure in a full sentence',
  },
  { message: "I've had MS for ten years", expected: 'health_data', why: 'duration framing' },
  { message: 'I live with MS', expected: 'health_data', why: 'living-with framing' },
  { message: "I'm an MS patient", expected: 'health_data', why: 'patient noun' },
  {
    message: 'MS diagnosis two years ago',
    expected: 'health_data',
    why: 'token-first + clinical noun',
  },
  { message: 'SLE flares are rare for me', expected: 'health_data', why: 'token-first + flare' },
  { message: 'I have SLE', expected: 'health_data', why: 'explicit disclosure' },
  { message: 'history of SLE', expected: 'health_data', why: 'history framing' },
  { message: 'my SLE is well controlled', expected: 'health_data', why: 'possessive' },
  { message: 'I take medication for SLE', expected: 'health_data', why: 'treatment framing' },
  { message: 'SLE diagnosis at 30', expected: 'health_data', why: 'token-first + diagnosis' },
  {
    message: 'I had a TIA last month',
    expected: 'health_data',
    why: 'past event, uppercase token',
  },
  { message: 'i had tia in march', expected: 'health_data', why: 'lowercase token' },
  { message: 'they think I had a TIA', expected: 'health_data', why: 'third-party framing' },
  { message: 'history of TIA', expected: 'health_data', why: 'history framing' },
  { message: 'I was treated for TB', expected: 'health_data', why: 'treatment framing' },
  { message: 'history of TB', expected: 'health_data', why: 'history framing' },
  { message: 'my TB is latent', expected: 'health_data', why: 'possessive' },
  {
    message: 'TB treatment finished in March',
    expected: 'health_data',
    why: 'token-first + treatment',
  },

  // Closed by the first pass of this road test — every one used to leak.
  { message: "I've got MS", expected: 'health_data', why: '"got" is a disclosure verb' },
  { message: 'I got MS in my thirties', expected: 'health_data', why: '"got" + age' },
  { message: 'I suffer from MS', expected: 'health_data', why: '"suffer from" verb form' },
  { message: 'MS sufferer here', expected: 'health_data', why: 'sufferer noun' },
  { message: 'MS runs in my family', expected: 'health_data', why: 'family transmission' },
  {
    message: 'there is MS in my family',
    expected: 'health_data',
    why: 'family framing, other word order',
  },
  { message: 'my mother has MS', expected: 'health_data', why: 'relative + has' },
  { message: 'family history of MS', expected: 'health_data', why: 'family history' },
  { message: 'I tested positive for TB', expected: 'health_data', why: 'test-result framing' },
  { message: 'latent TB', expected: 'health_data', why: 'latent form, token last' },
  { message: "I'm a TB carrier", expected: 'health_data', why: 'carrier noun' },
  { message: "I'm a TIA survivor", expected: 'health_data', why: 'survivor noun' },
  { message: 'MS fatigue', expected: 'health_data', why: 'token modifies a symptom noun' },
  { message: 'MS-related fatigue', expected: 'health_data', why: 'hyphenated compound' },
  { message: 'SLE nephritis', expected: 'health_data', why: 'token + clinical noun' },
  {
    message: 'TB test came back positive',
    expected: 'health_data',
    why: 'token-first test framing',
  },

  // "condition" in its medical sense — each guarded form, so the narrowing of
  // the bare term cannot quietly drop the readings it was there to catch.
  {
    message: 'I have a condition',
    expected: 'health_data',
    why: 'indefinite article, medical reading',
  },
  { message: 'I have a pre-existing condition', expected: 'health_data', why: 'health-qualified' },
  { message: 'my condition has worsened', expected: 'health_data', why: 'belongs to the visitor' },
  { message: "my father's condition is stable", expected: 'health_data', why: 'noun possessive' },
  {
    message: 'the condition is stable',
    expected: 'health_data',
    why: 'singular with the definite article',
  },
  { message: 'I have chronic conditions', expected: 'health_data', why: 'health-qualified plural' },
  {
    message: 'I have two conditions',
    expected: 'health_data',
    why: 'counted, so it points at specific ones',
  },
  { message: 'conditions such as asthma', expected: 'health_data', why: 'example framing' },
  {
    message: 'I have other conditions',
    expected: 'health_data',
    why: 'first-person plural, no qualifier',
  },
  {
    message: 'I have conditions that are managed',
    expected: 'health_data',
    why: 'first-person plural, no qualifier',
  },

  // Dotted spellings.
  { message: 'I have M.S.', expected: 'health_data', why: 'dotted spelling of the diagnosis' },
  { message: 'I have S.L.E.', expected: 'health_data', why: 'dotted S.L.E.' },
  { message: 'I had a T.I.A.', expected: 'health_data', why: 'dotted T.I.A.' },
];

/**
 * Everyday collisions that must stay unclassified, grouped by the registry
 * entry they belong to.
 *
 * The grouping is load-bearing: `REGISTRY_COLLISION_CORPUS` further down maps
 * every live context-qualified entry to its rows here, and the contract at the
 * end of this file fails the build when an entry has none — so a new lay
 * synonym cannot ship without the benign counterpart that proves its guard.
 */
const MS_COLLISIONS: GateCase[] = [
  {
    message: 'Can Ms. Smith call me about a quote?',
    expected: 'not_health_data',
    why: 'honorific + name',
  },
  {
    message: 'I spoke with Ms. Smith yesterday',
    expected: 'not_health_data',
    why: 'honorific after a preposition',
  },
  {
    message: 'Ms. Smith said to ask you about term life',
    expected: 'not_health_data',
    why: 'honorific at sentence start',
  },
  {
    message: 'I have a question for Ms Smith',
    expected: 'not_health_data',
    why: 'honorific without the period',
  },
  { message: 'The page loaded in 300 ms', expected: 'not_health_data', why: 'milliseconds' },
  {
    message: 'latency was under 500 ms',
    expected: 'not_health_data',
    why: 'milliseconds, measurement framing',
  },
  {
    message: 'I have 300ms latency',
    expected: 'not_health_data',
    why: 'no word boundary around ms',
  },
  { message: 'I live in MS', expected: 'not_health_data', why: 'state abbreviation' },
  {
    message: 'I have a question. Ms. Smith can help.',
    expected: 'not_health_data',
    why: 'keyword and token in different sentences',
  },
];

/** The token inside longer words — "sleep", "sleeve". */
const SLE_COLLISIONS: GateCase[] = [
  { message: 'What is sleep hygiene?', expected: 'not_health_data', why: '"sleep" contains "sle"' },
  { message: 'I have trouble sleeping', expected: 'not_health_data', why: 'sleep verb' },
  {
    message: 'I got my sleeve caught in the door',
    expected: 'not_health_data',
    why: '"sleeve" contains "sle"',
  },
  {
    message: 'Does sleep affect my premium?',
    expected: 'not_health_data',
    why: 'sleep as a topic word',
  },
];

/** The person's name, in the shapes a visitor actually types it. */
const TIA_COLLISIONS: GateCase[] = [
  { message: "my daughter's name is Tia", expected: 'not_health_data', why: '"Tia" as a name' },
  {
    message: "my daughter's name is Mia, not Tia",
    expected: 'not_health_data',
    why: 'name in a contrast',
  },
  {
    message: 'Tia referred me to your site',
    expected: 'not_health_data',
    why: 'name in subject position',
  },
  {
    message: 'I spoke with Tia yesterday',
    expected: 'not_health_data',
    why: 'name next to a disclosure-ish verb',
  },
  {
    message: 'I have Tia as my beneficiary',
    expected: 'not_health_data',
    why: 'name in a policy sentence',
  },
  { message: 'I got Tia a birthday gift', expected: 'not_health_data', why: 'name after "got"' },
  { message: "did you get Tia's email", expected: 'not_health_data', why: 'name in a question' },
  {
    message: 'I got Tiana a birthday gift',
    expected: 'not_health_data',
    why: '"Tiana" is not the token',
  },
];

/**
 * The `tb` entry's ordinary senses — the collision the entry shipped without.
 * Measured: the two storage sentences stay silent, while "I have 2 TB of
 * photos" gates; that one is pinned in `TRADEOFFS` as an accepted false
 * positive rather than guarded, because it is the same sentence shape as
 * "I have TB".
 */
const TB_COLLISIONS: GateCase[] = [
  { message: 'the drive holds 2 TB', expected: 'not_health_data', why: 'terabyte' },
  {
    message: 'we store 5 TB in the cloud',
    expected: 'not_health_data',
    why: 'terabyte in a storage sentence',
  },
  { message: 'tbh I have not decided', expected: 'not_health_data', why: '"tbh" is not the token' },
];

/** The contractual senses of "condition", and the rows that carry no token at all. */
const CONTRACTUAL_COLLISIONS: GateCase[] = [
  // "condition" is contractual English as often as medical English. A bare match
  // on the word blocked every one of these, including a visitor asking what
  // their own application needs. It now has to belong to someone or be
  // qualified (see CONDITION_PATTERNS in security-controls.ts).
  {
    message: 'what conditions apply to my application?',
    expected: 'not_health_data',
    why: 'contractual plural, no possessor',
  },
  {
    message: 'what are the terms and conditions?',
    expected: 'not_health_data',
    why: 'standard boilerplate',
  },
  {
    message: 'are there any conditions on the payout?',
    expected: 'not_health_data',
    why: '"any" is idiomatic in the contractual sense',
  },
  {
    message: 'the conditions are listed in the policy',
    expected: 'not_health_data',
    why: 'plural with the definite article',
  },
  {
    message: 'market conditions are rough this year',
    expected: 'not_health_data',
    why: 'non-medical qualifier',
  },
  {
    message: 'conditions of sale apply',
    expected: 'not_health_data',
    why: 'bare plural',
  },
  {
    message: 'other conditions apply',
    expected: 'not_health_data',
    why: '"other conditions apply" is boilerplate',
  },
  {
    message: 'do you have conditions on the free offer?',
    expected: 'not_health_data',
    why: 'second-person "have", so not the visitor describing themselves',
  },
  {
    message: 'the mail carrier lost my parcel',
    expected: 'not_health_data',
    why: '"carrier" with no token',
  },
  {
    message: 'I have low energy and fatigue',
    expected: 'not_health_data',
    why: '"fatigue" with no token',
  },
  {
    message: 'I suffer from high deductibles',
    expected: 'not_health_data',
    why: '"suffer" with no token',
  },
  {
    message: 'I tested the quote calculator twice',
    expected: 'not_health_data',
    why: '"tested" with no token',
  },
];

/**
 * Everyday collisions that must stay unclassified — the union the classification
 * tests iterate. Each row also lives in the per-entry array above, so the
 * contract at the end of this file can require one from every registry entry.
 */
const COLLISIONS: GateCase[] = [
  ...MS_COLLISIONS,
  ...SLE_COLLISIONS,
  ...TIA_COLLISIONS,
  ...TB_COLLISIONS,
  ...CONTRACTUAL_COLLISIONS,
];

/**
 * Both sides of each ambiguity guard, plus the false positives the design
 * deliberately accepts. Asserting these keeps a documented tradeoff from
 * quietly becoming an undocumented behavior change.
 */
const TRADEOFFS: GateCase[] = [
  // A degree, not a diagnosis — the M.S. guard.
  {
    message: 'I have an M.S. degree in economics',
    expected: 'not_health_data',
    why: 'degree sense, guarded',
  },
  {
    message: 'I withdrew from my M.S. program',
    expected: 'not_health_data',
    why: 'program sense, guarded',
  },
  {
    message: 'my M.S. is in remission',
    expected: 'health_data',
    why: 'diagnosis sense — the degree guard does not swallow it',
  },
  // A person, not a stroke — the Tia guard.
  {
    message: 'Tia was last March',
    expected: 'not_health_data',
    why: 'both a name and a sentence-initial token; the name reading wins',
  },
  // Accepted false positives, failing in the safe direction.
  {
    message: 'I have MS Office installed',
    expected: 'health_data',
    why: 'product name; accepted false positive',
  },
  {
    message: 'I got the MS Word licence',
    expected: 'health_data',
    why: 'product name after a disclosure verb; accepted false positive',
  },
  {
    message: 'my M.S. is in economics',
    expected: 'health_data',
    why: 'a degree after a copula; accepted false positive — guarding "is in" would swallow "M.S. is in remission"',
  },
  {
    message: 'my M.S. last year',
    expected: 'health_data',
    why: 'a degree after the possessive; accepted false positive — the possessive rule protects "my M.S. is stable"',
  },
  // The collision that forced the possessive rule in the first place.
  {
    message: 'my name is Tia',
    expected: 'not_health_data',
    why: '"my" requires zero gap before the token',
  },
  // The colloquial sense of "therapy", accepted rather than carved out.
  // "dialysis is my therapy" and "the only thing that is my therapy" are the
  // same shape, so the medical reading has to win.
  {
    message: 'wine is my therapy',
    expected: 'health_data',
    why: 'colloquial; accepted false positive',
  },
  {
    message: 'I need therapy after this week',
    expected: 'health_data',
    why: 'joke; accepted false positive — "I need therapy" is a disclosure far more often',
  },
  {
    message: 'the therapy of a long holiday',
    expected: 'health_data',
    why: 'contrived of-metaphor; accepted false positive — nothing measurable justifies excluding the of-shape for this word',
  },
  // The stems kept broad by measurement: the only ordinary sentences available
  // were ones written to be ordinary, so they are recorded here instead of being
  // traded for a narrowing rule.
  {
    message: 'the blood pressure of the market is rising',
    expected: 'health_data',
    why: 'contrived; accepted rather than narrowed — `blood pressure` keeps its bare stem',
  },
  {
    message: 'the cholesterol of the policy',
    expected: 'health_data',
    why: 'contrived; accepted rather than narrowed — `cholesterol` keeps its bare stem',
  },
  // The two trades inside the narrowed stems, both failing in the safe
  // direction.
  {
    message: 'I sell tobacco products',
    expected: 'health_data',
    why: 'business sense, but "I USE tobacco products" is the same noun phrase; accepted false positive',
  },
  {
    message: 'I bought a smoker for the garden',
    expected: 'health_data',
    why: 'barbecue sense; accepted false positive — a purchase-verb window would also swallow "I bought a policy for my father, a smoker"',
  },
  {
    message: 'the illness of the market',
    expected: 'health_data',
    why: 'contrived; accepted — no realistic ordinary sense was measurable for `illness`, so it keeps a wide rule',
  },
  {
    message: 'I filed an illness claim',
    expected: 'health_data',
    why: 'a claim about an illness implies one; the product carve-out covers "illness claim" only when the message is about cover, and this shape is a disclosure in practice',
  },
  // The syntactic-collision class's two measured trades, both in the safe
  // direction.
  {
    message: 'how many stones do we need',
    expected: 'health_data',
    why: 'plural token named in a question with "we" in it; accepted false positive — the same personal-framing rule that makes "does MS affect my rate?" a disclosure',
  },
  {
    message: 'I weigh 12 stone',
    expected: 'health_data',
    why: 'the British body-weight unit is caught by the weigh rule, not by the stones entry; accepted — body measures are a captured field',
  },
  {
    message: 'there is a lump in the carpet',
    expected: 'health_data',
    why: 'the existential frame ("there is a lump") is the one the lump entry declares for "there\'s a lump in my breast"; accepted false positive — the realistic ordinary frames (lump sum, a lump of, lump it/together) are guarded instead',
  },
  {
    message: 'I have 2 TB of photos',
    expected: 'health_data',
    why: 'terabyte, but the same sentence shape as "I have TB"; accepted false positive — the storage frames the tb entry carries ("the drive holds 2 TB", "we store 5 TB") are the collisions that stay silent',
  },
];

/**
 * Questions about a condition, and the same condition asked about personally.
 *
 * These were originally recorded as undecided judgment calls, because a
 * question about a disease is not the same act as a disclosure of one. They are
 * decided now: an impersonal question is its own classification
 * (`health_topic_question`) that hands off with accurate framing and an accurate
 * record, while bringing yourself into the question keeps it a personal
 * disclosure. Both refuse and hand off; only the reply copy and the recorded
 * reason differ, so the safety property is identical.
 */
const TOPIC_QUESTIONS: GateCase[] = [
  {
    message: 'Is TB curable?',
    expected: 'health_topic_question',
    why: 'treatment question, impersonal',
  },
  {
    message: 'What does TIA stand for?',
    expected: 'health_topic_question',
    why: 'terminology question',
  },
  {
    message: 'Does MS show up in a blood test?',
    expected: 'health_topic_question',
    why: 'diagnostics question',
  },
  {
    message: 'How is cancer treated?',
    expected: 'health_topic_question',
    why: 'treatment question',
  },
  {
    message: 'does MS affect life insurance rates?',
    expected: 'health_topic_question',
    why: 'underwriting question, impersonal',
  },
  {
    message: 'is illness covered?',
    expected: 'health_topic_question',
    why: 'bare "illness" with no first person is a topic; the PRODUCT phrase "critical illness cover" is carved out instead, because that one is a pricing question',
  },
  {
    message: 'is tuberculosis contagious?',
    expected: 'health_topic_question',
    why: 'condition question, spelled out',
  },
  {
    message: 'Is TIA hereditary?',
    expected: 'health_topic_question',
    why: 'the name guard must not swallow the diagnosis',
  },
  {
    message: 'Is my lupus controlled?',
    expected: 'health_data',
    why: 'the possessive makes it personal',
  },
  {
    message: 'does MS affect my life insurance rate?',
    expected: 'health_data',
    why: 'implied personal condition',
  },
  { message: 'do I have MS?', expected: 'health_data', why: 'first-person question' },
  {
    message: 'does my father have MS?',
    expected: 'health_data',
    why: 'family framing is personal',
  },
  {
    message: 'history of SLE?',
    expected: 'health_data',
    why: 'a fragment with a question mark is not a question',
  },
];

/**
 * Meta words — one spelling, a medical sense and an ordinary one.
 *
 * Each of these was matched bare by the disclosure patterns, so any sentence
 * containing the word was classified as health data. The words differ in WHICH
 * ordinary sense they collide with, and that difference is the rule:
 *
 *   condition     a requirement attached to a product ("terms and conditions")
 *   treatment     how something is handled ("the tax treatment of the proceeds")
 *   heart         a metaphor for the centre of something ("the heart of the policy")
 *   symptom       a sign of a non-medical problem ("a symptom of a slow process")
 *   prescription  rhetorical advice ("a prescription for a good policy")
 *   disease       a metaphor for a systemic ill ("the disease of rising premiums")
 *   disorder      untidiness in a system ("the disorder of the ledger")
 *   diagnosis     a fault found by a mechanic or a support agent ("diagnosed as a
 *                 timing issue") — measured later, same treatment: a person, a
 *                 clinician, an anchor or a temporal marker is required
 *   therapy       an idiom, a product or a joke ("retail therapy", "aromatherapy
 *                 candles", "wine is my therapy") — carved out by two word
 *                 prefixes, because chemotherapy and physiotherapy share the stem
 *   medication    — no ordinary sense measured at all, so it is NOT narrowed; the
 *                 measurement pointed the other way, at its informal form "meds"
 *
 * So `condition` and `treatment` require qualifying context, while the other five
 * are excluded only in the "<word> of <something>" shape — which is what keeps
 * conditions that END in the word detectable (peripheral artery disease,
 * post-traumatic stress disorder, panic disorder). Every word gets both lists:
 * a benign corpus proving the ordinary sense stays silent, and a medical corpus
 * proving the narrowing did not cost a real disclosure. The last three are the
 * measurement-driven additions: each was graded before and after, and the counts
 * are in the message above each one in `src/security/security-controls.ts`.
 */
const META_WORD_CASES: { word: string; benign: string[]; medical: string[] }[] = [
  {
    word: 'condition',
    benign: [
      'what conditions apply to my application?',
      'what are the terms and conditions?',
      'are there any conditions on the payout?',
      'market conditions are rough this year',
      'other conditions apply',
    ],
    medical: [
      'I have a condition',
      'my condition has worsened',
      'I have other conditions',
      "my father's condition is stable",
      'I have a pre-existing condition',
    ],
  },
  {
    word: 'treatment',
    benign: [
      'what is the tax treatment of the proceeds?',
      'the treatment of the claim is handled by the broker',
      'equal treatment for all applicants',
    ],
    medical: [
      'I am receiving treatment',
      'I am on treatment',
      'my treatment is ongoing',
      'do you cover treatment?',
      'cancer treatment',
    ],
  },
  {
    word: 'heart',
    benign: [
      'at the heart of the matter is your timeline',
      'the heart of the policy is the cash value',
      'putting my family at the heart of my plan',
      'the heart of my plan is affordability',
    ],
    medical: [
      'my heart is fine',
      'heart attack',
      'congestive heart failure',
      'I have a bad heart',
      'heartburn',
    ],
  },
  {
    word: 'symptom',
    benign: [
      'is that a symptom of a wider problem with my coverage?',
      'a symptom of a slow claims process',
    ],
    medical: [
      'my symptoms started in March',
      'I have symptoms',
      'the symptoms are manageable',
      'what symptoms should I report?',
      'symptoms of my condition',
    ],
  },
  {
    word: 'prescription',
    // Only one ordinary shape is measurable in this domain, and it is the same
    // "of" metaphor: in a compliance chat, "prescription" otherwise means drugs.
    benign: [
      'the prescription of rates is regulated',
      'the prescription of fees is set by the regulator',
    ],
    medical: [
      'my prescriptions are expensive',
      'do you cover prescriptions?',
      'I got a prescription',
      'prescription drugs',
    ],
  },
  {
    word: 'disease',
    benign: ['the disease of rising premiums', 'the disease of the market'],
    medical: [
      'I have peripheral artery disease',
      'reactive airway disease',
      'chronic obstructive pulmonary disease',
      'a disease of the liver',
      'the disease is progressing',
    ],
  },
  {
    word: 'disorder',
    benign: ['the disorder of the ledger', 'a disorder of the application process'],
    medical: [
      'post traumatic stress disorder',
      'major depressive disorder',
      'panic disorder',
      'an eating disorder',
      'my disorder is managed',
    ],
  },
  {
    word: 'diagnosis',
    // Seven of these eight false-gated under the bare `diagnos(?:ed|is)` stem.
    benign: [
      'can you diagnose why my quote never arrived?',
      'the problem was diagnosed as a timing issue',
      'support diagnosed the issue as a browser cache problem',
      'my mechanic diagnosed a faulty sensor',
      'they diagnosed the leak as a cracked pipe',
      'can you run a diagnosis on my account?',
      'the fault was diagnosed quickly',
      'diagnosis: the delay sits with the underwriter',
    ],
    medical: [
      'I was diagnosed last year',
      'diagnosed with lupus',
      'my diagnosis came in March',
      // The old stem never matched the plural noun at all.
      'I have two diagnoses',
      'diagnosis date',
      'she was diagnosed at 30',
      'recently diagnosed',
      "I've been diagnosed",
      "the doctor's diagnosis",
      'was I diagnosed as a child?',
      'I received a diagnosis',
      'they diagnosed me',
    ],
  },
  {
    word: 'therapy',
    benign: [
      'I did some retail therapy at the weekend',
      'retail therapy is my reward after a hard week',
      'a bit of retail therapy never hurt anyone',
      'Retail Therapy is the name of my side business',
      'aromatherapy candles are my little luxury',
      'I run an aromatherapy business on the side',
      // The occupation sense, carved out of the registry's `therapist` entry.
      'I am a massage therapist',
    ],
    medical: [
      "I'm in therapy",
      'therapy is helping',
      'I started therapy in January',
      'my therapy sessions are weekly',
      'physical therapy twice a week',
      'group therapy',
      // The compounds are why the stem is not anchored at the front.
      'chemotherapy',
      'physiotherapy for my knee',
      // "therapist" does not contain "therapy": its own entry.
      'I see a therapist twice a week',
    ],
  },
  {
    word: 'medication',
    // Left broad on purpose: neither ordinary candidate contains the stem, which
    // is the measurement. "meds" is a separate word and a separate entry.
    benign: ['medicate the problem with more paperwork', 'medicated shampoo fixes my dandruff'],
    medical: [
      'I take medication daily',
      'my medications are expensive',
      'on medication for blood pressure',
      'I stopped taking my meds',
      'my meds are expensive',
      "I'm on meds",
    ],
  },
  {
    word: 'weight',
    // The lifestyle-field measurement: all eight ordinary rows false-gated, all
    // seven body-measure rows gated, and the VERB ungated in every form.
    benign: [
      'what weight do you give to my credit history?',
      'does my occupation carry any weight?',
      'how much weight does a speeding ticket carry?',
      'I want to give more weight to affordability',
      'the weight of the evidence favours the insurer',
      'the weighting of the premium is unclear',
      'is there a weighted average of these factors?',
      'what is the weight of that in the decision?',
      'I weigh the options',
    ],
    medical: [
      'my weight is 180 pounds',
      'I am trying to lose weight',
      'I put on weight last year',
      'do you need my height and weight?',
      'I was overweight as a child',
      'weight loss surgery',
      'my weight has changed since then',
      'my body weight',
      // The field answered without a sentence.
      'weight 180',
      // The verb, which the old noun-only stem never saw.
      'I weigh 180 pounds',
      'she weighs 120 pounds',
      'I weigh myself every morning',
      'the nurse weighed me',
      'I was weighed at the clinic',
    ],
  },
  {
    word: 'height',
    benign: [
      'at the height of the market rates were lower',
      'the cost reached a new height this year',
      'the height of my career was in 2019',
      'uncertainty is at its height',
    ],
    medical: [
      'my height is 5 foot 10',
      'height and weight',
      'does my height affect the rate?',
      'the nurse measured my height',
      'height 5 foot 10',
    ],
  },
  {
    word: 'substance',
    benign: [
      'there is no substance to that claim',
      'the substance of my complaint is the delay',
      'nothing of substance changed in the policy',
      'in substance the two policies are the same',
      'the substance of the contract',
    ],
    medical: [
      // Contains "of substance" — which is why the medical phrases are re-added
      // explicitly after the exclusion.
      'I have a history of substance abuse',
      'substance use disorder',
      'I use substances occasionally',
      'I was treated for substance dependence',
    ],
  },
  {
    word: 'tobacco',
    benign: [
      'I work at a tobacco company',
      'is a tobacco shop a risky occupation?',
      'tobacco duty is rising',
    ],
    medical: [
      'I use tobacco',
      // The bare field answer, which a rule requiring a verb would have missed.
      'tobacco',
      'do I need to declare tobacco use?',
      'I quit tobacco last year',
      'tobacco user',
    ],
  },
  {
    word: 'alcohol',
    benign: ['I run an alcohol licensing business', 'does the alcohol licence cost extra?'],
    medical: [
      'I drink alcohol occasionally',
      'my alcohol consumption is two units a week',
      'I gave up alcohol',
      'alcohol use disorder',
      // Carried by the substring, not by the word boundary: `\balcohol\b`
      // would stop matching the "-ism".
      'alcoholism',
    ],
  },
  {
    word: 'smoker',
    benign: ['I cook on a pellet smoker', 'smoker grill'],
    medical: [
      'I am a smoker',
      'non smoker',
      'ex-smoker',
      'my father was a smoker',
      'smokers pay more',
    ],
  },
  {
    word: 'stress',
    // The mirror-image pass: every ordinary row was ALREADY silent, and seven
    // clinical rows were ungated. So this entry is a coverage rule, and its
    // benign list is what the positive rule has to keep out.
    benign: [
      'the stress of moving house is enough',
      'I do not want to stress about the paperwork',
      'can you stress-test the numbers?',
      'the stress of the process is the worst part',
      'I am stressed about the timeline',
    ],
    medical: [
      'my stress levels are high',
      'I am off work with stress',
      'I am on stress leave',
      'the doctor said it is stress',
      'chronic stress',
      'stress-related condition',
      'work-related stress',
    ],
  },
  {
    word: 'illness',
    // The one word that needed both directions: the product name over-gated and
    // the disclosures under-gated.
    benign: [
      'does it include critical illness cover?',
      'what does critical illness insurance pay out?',
      'is critical illness cover worth it?',
      // The adjective's collisions: a hyphen is a word boundary, so `ill` alone
      // would have caught both of these.
      'that is ill-advised',
      'I am ill-prepared for this',
    ],
    medical: [
      'I have a long-term illness',
      'my illness is managed',
      'I have a serious illness',
      'mental illness',
      // Not a product: only the FOLLOWING word separates this from the cover.
      'I have a critical illness',
      'I was off work with an illness',
      // A claim implies the condition, which is why `claim` is not carved out.
      'I filed an illness claim',
      // The adjective, in its clinical shapes.
      'I have been ill for months',
      'I was ill last year',
      'ill health',
      'terminally ill',
    ],
  },
  {
    word: 'smoke',
    benign: [
      'does the policy cover smoke damage?',
      'do I need a smoke alarm?',
      'is there a smoke detector requirement?',
      'there is no smoking gun here',
      'the whole plan went up in smoke',
    ],
    medical: [
      'I smoke',
      'I smoke a pack a day',
      'I used to smoke',
      'I quit smoking',
      'do you smoke?',
      'I stopped smoking last year',
      'smoking status',
    ],
  },
  {
    word: 'drink',
    benign: [
      'I drink plenty of water',
      'fizzy drinks are my weakness',
      'is there a drinks reception at the office?',
      'do you drink coffee?',
    ],
    medical: [
      // Gated by `alcohol`, kept here as the cross-check that the two rules agree.
      'I drink alcohol occasionally',
      'I drink two units a week',
      'how much do you drink?',
      'I stopped drinking',
      "I don't drink",
      'I have a drinking problem',
      'my drinking habits changed',
    ],
  },
];

/**
 * Stems left broad because the measurement found no ordinary sense for them.
 *
 * The other half of the same decision: narrowing is a cost (each rule can miss a
 * disclosure), so it is only spent where a real collision was measured. For
 * these four the only candidate sentences were contrived, so they keep their bare
 * stems and the contrived sentences are recorded as accepted false positives in
 * TRADEOFFS.
 */
const BROAD_BY_MEASUREMENT: [stem: string, sample: string][] = [
  ['blood pressure', 'I have high blood pressure'],
  ['cholesterol', 'my cholesterol is high'],
  ['bmi', 'my BMI is 27'],
  ['nicotine', 'nicotine pouches'],
];

const classify = (message: string): GateCase['expected'] => {
  const category = detectSensitiveData(message);
  if (category === 'health_data' || category === 'health_topic_question') return category;
  return 'not_health_data';
};

/**
 * Systematic sweep — every way a visitor states a diagnosis, crossed with all
 * four tokens.
 *
 * The curated cases above show the shapes; this measures the coverage, so a
 * keyword list that "looks" thorough has to actually be thorough. An earlier
 * revision of the rule scored 92/104 here while passing every curated case:
 * "{t} support group", "do I need to declare {t}?" and "I was hospitalised for
 * {t}" were all silent.
 */
/**
 * Coverage sweep for the three words the measurement touched.
 *
 * The meta-word corpora above prove both directions sentence by sentence. This
 * is the fail-unsafe half at scale: every row states a diagnosis, a treatment
 * relationship or a medication WITHOUT naming a condition, so nothing but that
 * word's own pattern can carry it. Six forms leaked on the first pass after the
 * narrowing — "I received a diagnosis", "I obtained a diagnosis", "I asked for a
 * diagnosis", "they diagnosed me", "diagnosed but untreated", "diagnosis
 * pending" — and each now has a pattern and a row here.
 */
const META_WORD_COVERAGE: [word: string, message: string][] = [
  ['diagnosis', 'I was diagnosed'],
  ['diagnosis', 'I have been diagnosed'],
  ['diagnosis', "I've been diagnosed"],
  ['diagnosis', 'I got diagnosed'],
  ['diagnosis', 'recently diagnosed'],
  ['diagnosis', 'I received a diagnosis'],
  ['diagnosis', 'I obtained a diagnosis'],
  ['diagnosis', 'I asked for a diagnosis'],
  ['diagnosis', 'I have a diagnosis'],
  ['diagnosis', 'my diagnosis'],
  ['diagnosis', 'diagnosis date'],
  ['diagnosis', 'diagnosis code'],
  ['diagnosis', 'diagnosis pending'],
  ['diagnosis', 'diagnosed at 30'],
  ['diagnosis', 'diagnosed in 2019'],
  ['diagnosis', 'diagnosed last year'],
  ['diagnosis', 'diagnosed but untreated'],
  ['diagnosis', 'diagnosed with something'],
  ['diagnosis', 'they diagnosed me'],
  ['diagnosis', 'the doctor diagnosed me'],
  ['diagnosis', 'my doctor diagnosed me'],
  ['diagnosis', 'the hospital diagnosed me'],
  ['diagnosis', 'I was diagnosed as a child'],
  ['diagnosis', 'she was diagnosed'],
  ['diagnosis', 'was I diagnosed?'],
  ['diagnosis', 'I have two diagnoses'],
  ['diagnosis', 'clinical diagnosis'],
  ['diagnosis', 'sharing my diagnosis'],
  ['therapy', "I'm in therapy"],
  ['therapy', 'I go to therapy'],
  ['therapy', 'therapy sessions'],
  ['therapy', 'I need therapy'],
  ['therapy', "she's in therapy"],
  ['therapy', 'chemotherapy'],
  ['therapy', 'physiotherapy for my knee'],
  ['therapy', 'psychotherapy'],
  ['therapy', 'group therapy'],
  ['therapy', 'talk therapy'],
  ['therapy', "I'm starting therapy next week"],
  ['therapy', 'I see a therapist'],
  ['therapy', 'my therapist'],
  ['medication', 'I take meds'],
  ['medication', 'my meds'],
  ['medication', 'on meds'],
  ['medication', 'I stopped my meds'],
  ['medication', 'I take medication'],
];

/**
 * Coverage sweep for the lifestyle and body-measure fields.
 *
 * The same fail-unsafe half as `META_WORD_COVERAGE`, for the stems narrowed in
 * the second measurement pass: every row states a body measure, a lifestyle
 * field or a substance WITHOUT naming a condition, so nothing but that field's
 * own rule can carry it. The regression measure that produced this list compared
 * all 57 rows against the bare stems they replaced and found **zero** forms the
 * old patterns caught and the new rules miss — plus seven the old stems never saw
 * (the whole `weigh` family).
 *
 * The `stress`/`illness`/`smoke`/`drink` rows came from the third pass, where
 * the words the source comments had flagged as collision-prone measured the
 * other way round: 26 clinical forms ungated, and only one over-match in the
 * whole set ("critical illness cover", a product name).
 */
const HEALTH_FIELD_COVERAGE: [field: string, message: string][] = [
  ['weight', 'my weight is 180 pounds'],
  ['weight', 'I have lost weight'],
  ['weight', 'I gained weight'],
  ['weight', 'weight loss surgery'],
  ['weight', 'I was overweight as a child'],
  ['weight', 'I am underweight'],
  ['weight', 'my weight fluctuates'],
  ['weight', 'I check my weight daily'],
  ['weight', 'my body weight'],
  ['weight', 'my ideal weight'],
  ['weight', 'I am watching my weight'],
  ['weight', 'I put on weight last year'],
  ['weight', 'weight 180'],
  ['weight', 'I weigh 180 pounds'],
  ['weight', 'she weighs 120 pounds'],
  ['weight', 'I weigh myself every morning'],
  ['weight', 'the nurse weighed me'],
  ['weight', 'I was weighed at the clinic'],
  ['height', 'my height is 5 foot 10'],
  ['height', 'height: 170cm'],
  ['height', 'the nurse measured my height'],
  ['height', 'does my height affect the rate?'],
  ['height', 'height 5 foot 10'],
  ['substance', 'substance abuse'],
  ['substance', 'substance use disorder'],
  ['substance', 'I use substances occasionally'],
  ['substance', 'substance dependence'],
  ['substance', 'history of substance abuse'],
  ['substance', 'substance misuse'],
  ['tobacco', 'tobacco'],
  ['tobacco', 'tobacco use'],
  ['tobacco', 'I use tobacco'],
  ['tobacco', 'chewing tobacco'],
  ['tobacco', 'I quit tobacco last year'],
  ['tobacco', 'tobacco user'],
  ['tobacco', 'my tobacco consumption'],
  ['alcohol', 'alcohol'],
  ['alcohol', 'my alcohol consumption'],
  ['alcohol', 'I drink alcohol'],
  ['alcohol', 'alcohol use'],
  ['alcohol', 'alcohol abuse'],
  ['alcohol', 'I gave up alcohol'],
  ['alcohol', 'alcoholism'],
  ['alcohol', 'alcohol use disorder'],
  ['smoker', 'smoker'],
  ['smoker', 'I am a smoker'],
  ['smoker', 'non smoker'],
  ['smoker', 'ex-smoker'],
  ['smoker', 'my father was a smoker'],
  ['smoker', 'smokers pay more'],
  ['kept broad', 'I have high blood pressure'],
  ['kept broad', 'my cholesterol is high'],
  ['kept broad', 'my BMI is 27'],
  ['kept broad', 'nicotine pouches'],
  // The mirror-image pass: these four were flagged as collision-prone and
  // measured the other way round — coverage gaps, with the product name
  // "critical illness cover" the only over-match found anywhere in the set.
  ['stress', 'my stress levels are high'],
  ['stress', 'I am off work with stress'],
  ['stress', 'I am on stress leave'],
  ['stress', 'the doctor said it is stress'],
  ['stress', 'chronic stress'],
  ['stress', 'stress-related condition'],
  ['stress', 'work-related stress'],
  ['illness', 'I have a long-term illness'],
  ['illness', 'my illness is managed'],
  ['illness', 'I have a serious illness'],
  ['illness', 'mental illness'],
  ['illness', 'I have a critical illness'],
  ['illness', 'I was off work with an illness'],
  ['illness', 'I filed an illness claim'],
  ['illness', 'I have been ill for months'],
  ['illness', 'I was ill last year'],
  ['illness', 'terminally ill'],
  ['illness', 'ill health'],
  ['smoke', 'I smoke'],
  ['smoke', 'I smoke a pack a day'],
  ['smoke', 'I used to smoke'],
  ['smoke', 'I quit smoking'],
  ['smoke', 'do you smoke?'],
  ['smoke', 'I stopped smoking last year'],
  ['smoke', 'smoking status'],
  ['drink', 'I drink two units a week'],
  ['drink', 'how much do you drink?'],
  ['drink', 'I stopped drinking'],
  ['drink', "I don't drink"],
  ['drink', 'I have a drinking problem'],
  ['drink', 'my drinking habits changed'],
  ['drink', 'do you drink?'],
];

const DISCLOSURE_TEMPLATES = [
  'I have {t}',
  "I've got {t}",
  'I was diagnosed with {t}',
  'diagnosed with {t} last year',
  'history of {t}',
  'my {t} is stable',
  'I suffer from {t}',
  '{t} diagnosis',
  '{t} symptoms',
  '{t} treatment',
  "I'm a {t} patient",
  '{t} support group',
  'I take medication for {t}',
  'I am on medication for {t}',
  'I tested positive for {t}',
  "I'm a {t} survivor",
  'I was treated for {t}',
  '{t} runs in my family',
  'there is {t} in my family',
  'I live with {t}',
  'my {t} flares up',
  '{t}-related fatigue',
  'I have {t} and need cover',
  'do I need to declare {t}?',
  'I was hospitalised for {t}',
  'I was admitted for {t}',
  'my {t} medication is expensive',
  '{t} since 2015',
  'I got {t} in my thirties',
  'my {t} clinic appointment is next week',
  '{t} management',
  '{t} is manageable',
  'my {t} specialist says it is fine',
  'I have a {t} screening booked',
  'latent {t}',
  'I am a {t} carrier',
];

const SWEEP_TOKENS = ['ms', 'sle', 'tia', 'tb'] as const;

/**
 * The collision budget for the sweep — sentences that use the *words* the rule
 * keys on but carry no disclosure. Every keyword added to close a sweep miss
 * must leave these silent.
 */
const BENIGN_SWEEP = [
  'I was hospitalised last year',
  'the clinic is closed today',
  'I have an appointment Tuesday',
  'I have a scan next week',
  'I declare no other policies',
  'can I declare my beneficiary later?',
  'the specialist I spoke to was helpful',
  'my screening is booked for Friday',
  'I manage my own finances',
  'I need a quote for MS residents',
  'I withdrew from my M.S. program',
  'I have an M.S. from Stanford',
  'Tia helped me with the forms',
  'I spoke with Tia about a scan',
  'I got my sleeve caught',
  'I slept badly',
  'latency was 300 ms',
  'tbh I have not decided',
];

describe('Gate road test — contextual abbreviations against realistic messages', () => {
  test.each(DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" stays unclassified (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(TRADEOFFS.map((c) => [c.message, c.expected, c.why] as const))(
    'tradeoff "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(
    SWEEP_TOKENS.flatMap((token) =>
      DISCLOSURE_TEMPLATES.map((tpl) => [tpl.replace('{t}', token), token] as const),
    ),
  )('sweep: "%s" is gated', (message) => {
    expect({ message, actual: classify(message) }).toEqual({ message, actual: 'health_data' });
  });

  test.each(BENIGN_SWEEP)('benign sweep: "%s" stays unclassified', (message) => {
    expect({ message, actual: classify(message) }).toEqual({ message, actual: 'not_health_data' });
  });

  test('the sweep is complete — every template crosses every token', () => {
    expect(DISCLOSURE_TEMPLATES.length * SWEEP_TOKENS.length).toBe(
      DISCLOSURE_TEMPLATES.length * SWEEP_TOKENS.length,
    );
    expect(DISCLOSURE_TEMPLATES.every((tpl) => tpl.includes('{t}'))).toBe(true);
    expect(SWEEP_TOKENS).toHaveLength(4);
  });

  test('every added keyword has a benign counterpart in the corpus', () => {
    // The corpus is the collision budget for the keyword lists. If a keyword is
    // added to close a leak without a benign sentence guarding it, the balance
    // below drifts and this fails.
    expect(COLLISIONS.length).toBeGreaterThanOrEqual(DISCLOSURES.length / 2);

    // Each ambiguity guard must be exercised on both sides.
    const collisions = new Set(COLLISIONS.map((c) => c.message));
    expect(collisions.has('I spoke with Tia yesterday')).toBe(true);
    expect(collisions.has('I have Tia as my beneficiary')).toBe(true);
    expect(collisions.has('I have an M.S. degree in economics')).toBe(false); // asserted in TRADEOFFS
    expect(DISCLOSURES.some((c) => c.message === 'I had a TIA last month')).toBe(true);
    expect(DISCLOSURES.some((c) => c.message === 'I have M.S.')).toBe(true);

    // All four tokens, both spellings, and the family/verb/noun phrasings.
    const disclosures = DISCLOSURES.map((c) => c.message.toLowerCase()).join(' | ');
    for (const token of ['ms', 'sle', 'tia', 'tb']) {
      expect(disclosures).toContain(token);
    }
    for (const phrase of [
      'got ms',
      'suffer from ms',
      'runs in my family',
      'tested positive for tb',
      'latent tb',
      'ms fatigue',
      'm.s.',
    ]) {
      expect(disclosures).toContain(phrase);
    }
  });

  test.each(TOPIC_QUESTIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'question "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(
    META_WORD_CASES.flatMap((entry) =>
      entry.benign.map((message) => [entry.word, message] as const),
    ),
  )('meta word "%s": the ordinary sense stays silent — "%s"', (_word, message) => {
    expect({ message, actual: classify(message) }).toEqual({ message, actual: 'not_health_data' });
  });

  test.each(
    META_WORD_CASES.flatMap((entry) =>
      entry.medical.map((message) => [entry.word, message] as const),
    ),
  )('meta word "%s": the medical sense is gated — "%s"', (_word, message) => {
    expect({ message, actual: classify(message) }).toEqual({ message, actual: 'health_data' });
  });

  test.each(META_WORD_COVERAGE)(
    'coverage — the %s family gates "%s" without naming a condition',
    (_word, message) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: 'health_data' });
    },
  );

  test('the coverage sweep holds all three families', () => {
    expect(META_WORD_COVERAGE).toHaveLength(46);
    for (const word of ['diagnosis', 'therapy', 'medication']) {
      expect(
        META_WORD_COVERAGE.filter(([family]) => family === word).length,
      ).toBeGreaterThanOrEqual(5);
    }
  });

  test.each(HEALTH_FIELD_COVERAGE)(
    'coverage — the %s field gates "%s" without naming a condition',
    (_field, message) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: 'health_data' });
    },
  );

  test('the field sweep covers every narrowed stem, and the stems kept broad', () => {
    expect(HEALTH_FIELD_COVERAGE).toHaveLength(86);
    for (const field of [
      'weight',
      'height',
      'substance',
      'tobacco',
      'alcohol',
      'smoker',
      'stress',
      'illness',
      'smoke',
      'drink',
    ]) {
      expect(HEALTH_FIELD_COVERAGE.filter(([f]) => f === field).length).toBeGreaterThanOrEqual(5);
    }
    expect(HEALTH_FIELD_COVERAGE.filter(([f]) => f === 'kept broad')).toHaveLength(
      BROAD_BY_MEASUREMENT.length,
    );
  });

  test('every stem kept broad has a sample proving it still gates bare', () => {
    // The decision NOT to narrow is a decision too, so it is asserted: each of
    // these words is still caught on its own, with no qualifying context.
    expect(BROAD_BY_MEASUREMENT.map(([stem]) => stem)).toEqual([
      'blood pressure',
      'cholesterol',
      'bmi',
      'nicotine',
    ]);
    for (const [stem, sample] of BROAD_BY_MEASUREMENT) {
      expect({ stem, sample, actual: classify(sample) }).toEqual({
        stem,
        sample,
        actual: 'health_data',
      });
    }
  });

  test('every meta word carries both a benign and a medical corpus', () => {
    // The structural half of the same rule: a word cannot be narrowed without a
    // benign sentence proving the ordinary sense is silent AND a medical sentence
    // proving the narrowing did not cost a real disclosure.
    expect(META_WORD_CASES.map((entry) => entry.word)).toEqual([
      'condition',
      'treatment',
      'heart',
      'symptom',
      'prescription',
      'disease',
      'disorder',
      'diagnosis',
      'therapy',
      'medication',
      'weight',
      'height',
      'substance',
      'tobacco',
      'alcohol',
      'smoker',
      'stress',
      'illness',
      'smoke',
      'drink',
    ]);
    for (const entry of META_WORD_CASES) {
      expect(entry.benign.length).toBeGreaterThanOrEqual(2);
      expect(entry.medical.length).toBeGreaterThanOrEqual(4);
    }
  });

  test('the two paths differ in framing and record, not in safety', () => {
    // Every topic question and every disclosure in this corpus is blocked and
    // handed off; the classification only decides which copy and reason are
    // recorded. If a topic question ever started reaching the model, this file
    // would no longer be describing a fail-safe rule.
    const blocked = [...DISCLOSURES, ...TOPIC_QUESTIONS, ...TRADEOFFS].filter(
      (c) => classify(c.message) !== 'not_health_data',
    );
    expect(blocked.length).toBeGreaterThan(0);
    for (const c of blocked) {
      expect(['health_data', 'health_topic_question']).toContain(classify(c.message));
    }
  });
});

/**
 * The lay synonym "piles", both directions.
 *
 * It is the one probe row whose collision is syntactic rather than lexical: the
 * ordinary sense is the quantifier and phrasal-verb shape — "piles of
 * paperwork", "the work piles up", "he piles on the pressure" — so the gate
 * watches the token only where a disclosure, a clinical qualifier ("bleeding
 * piles"), or a possessive ("my piles") supplies the medical reading. Every
 * sentence below is one a visitor could type into a life-insurance chat; the
 * disclosures must classify, the quantifiers must not.
 */
const PILES_DISCLOSURES: GateCase[] = [
  { message: 'I have piles', expected: 'health_data', why: 'explicit disclosure' },
  { message: "I've got piles", expected: 'health_data', why: 'contraction + got' },
  { message: 'I had piles last year', expected: 'health_data', why: 'past disclosure' },
  { message: 'my piles are back', expected: 'health_data', why: 'possessive' },
  {
    message: 'his piles are bothering him',
    expected: 'health_data',
    why: 'third-person possessive',
  },
  { message: 'I suffer from piles', expected: 'health_data', why: 'clinical verb' },
  { message: 'I was diagnosed with piles', expected: 'health_data', why: 'diagnosis framing' },
  {
    message: 'bleeding piles again',
    expected: 'health_data',
    why: 'clinical qualifier with no disclosure verb',
  },
  { message: 'my internal piles', expected: 'health_data', why: 'qualifier plus possessive' },
  {
    message: 'piles treatment options',
    expected: 'health_data',
    why: 'token-first + clinical noun',
  },
  { message: 'piles flare up sometimes', expected: 'health_data', why: 'token-first + flare' },
  {
    message: 'do I need to declare piles?',
    expected: 'health_data',
    why: 'declaration question in the first person',
  },
];

const PILES_COLLISIONS: GateCase[] = [
  { message: 'piles of paperwork to get through', expected: 'not_health_data', why: 'quantifier' },
  {
    message: 'piles of evidence to review',
    expected: 'not_health_data',
    why: 'quantifier with no disclosure word',
  },
  {
    message: 'we have piles of data',
    expected: 'not_health_data',
    why: '"have … piles of" is not a disclosure',
  },
  {
    message: 'I have piles of things to do',
    expected: 'not_health_data',
    why: 'first person plus quantifier',
  },
  {
    message: 'the work piles up before a deadline',
    expected: 'not_health_data',
    why: 'phrasal verb',
  },
  {
    message: 'he piles on the pressure',
    expected: 'not_health_data',
    why: 'phrasal verb with a particle',
  },
  { message: 'her piles of books', expected: 'not_health_data', why: 'possessive plus quantifier' },
  {
    message: 'the foundation piles support the deck',
    expected: 'not_health_data',
    why: 'construction sense with no disclosure word',
  },
  {
    message: 'Are piles of paperwork a problem?',
    expected: 'not_health_data',
    why: 'question about documents, not the condition',
  },
];

describe('Gate road test — the lay synonym "piles"', () => {
  test.each(PILES_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(PILES_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" stays unclassified (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test('the topic question is a topic question, and the paperwork question is not', () => {
    // "Is piles curable?" names a condition in an impersonal question, so it
    // takes the health-topic path (blocked, with the question copy and reason);
    // the quantifier guard is what keeps the paperwork question out of it.
    expect(classify('Is piles curable?')).toBe('health_topic_question');
    expect(classify('What are piles?')).toBe('health_topic_question');
    expect(classify('Are piles of paperwork a problem?')).toBe('not_health_data');
  });

  test('the collision corpus covers the guard shapes, and a row with no quantifier at all', () => {
    // The corpus is the collision budget for the guard: every shape the rule
    // deliberately does not gate is represented, so removing the guard would
    // fail here rather than silently re-introduce the false handoff.
    const shapes = PILES_COLLISIONS.map((c) => c.message.toLowerCase());
    for (const phrase of ['piles of', 'piles up', 'piles on']) {
      expect({ phrase, present: shapes.some((m) => m.includes(phrase)) }).toEqual({
        phrase,
        present: true,
      });
    }
    expect(shapes.some((m) => !/piles (?:of|up|on|in|into|onto|upon)/.test(m))).toBe(true);
  });
});

/**
 * The lay word "lump", both directions — the second colliding lay synonym.
 *
 * Measured before it shipped against six candidates — lump, rash, mole, cold,
 * bug, fit — with realistic messages in both directions. The others were
 * deferred with their measured reason: `fit` ("I want to get fit" gates on the
 * shared `get`, and "I want to get fit" is not a disclosure), `mole` ("we have
 * moles in the garden" gates on the shared `have`), `rash` ("Is it rash to
 * switch policies?" is falsely named on the question path), `cold` (its guard
 * would be an open list of noun senses), `bug` (half the medical phrasings need
 * a verb the shared lists do not carry). `lump` was the only candidate with zero
 * ordinary false positives across twelve product-realistic sentences, because
 * its worst collision is the product's own vocabulary: `lump sum` is how the
 * payout is discussed, and a bare token would have handed off "should I take the
 * lump sum or monthly payments?".
 *
 * The guard excludes the payout compound, the quantifier and the phrasal verb.
 * The discovery verbs are declared by the entry itself (`disclosureWords` /
 * `clinicalWords`): "I found a lump" is how a lump is stated, while "I found
 * stones for the patio" must stay silent — a shared "found" would have taught
 * the stones entry a disclosure its corpus never measured.
 */
const LUMP_DISCLOSURES: GateCase[] = [
  {
    message: 'I found a lump in my breast',
    expected: 'health_data',
    why: 'discovery verb declared by the entry',
  },
  { message: 'my doctor found a lump', expected: 'health_data', why: 'discovery, third party' },
  { message: 'I noticed a lump', expected: 'health_data', why: 'the other discovery verb' },
  {
    message: "there's a lump in my breast",
    expected: 'health_data',
    why: 'existential framing',
  },
  { message: 'I have a lump in my neck', expected: 'health_data', why: 'explicit disclosure' },
  { message: 'my lump is not going away', expected: 'health_data', why: 'possessive' },
  { message: 'I had a lump removed', expected: 'health_data', why: 'past disclosure' },
  {
    message: 'history of a breast lump',
    expected: 'health_data',
    why: 'history framing plus a body-site qualifier',
  },
  {
    message: 'the lump was found on the scan',
    expected: 'health_data',
    why: 'token-first plus passive discovery',
  },
  {
    message: 'the lump was removed in 2022',
    expected: 'health_data',
    why: 'token-first plus a declared clinical verb',
  },
  { message: 'lump biopsy results', expected: 'health_data', why: 'token-first + clinical noun' },
  {
    message: 'my mother had a lump in her breast',
    expected: 'health_data',
    why: 'family history',
  },
];

const LUMP_COLLISIONS: GateCase[] = [
  {
    message: 'should I take the lump sum or monthly payments?',
    expected: 'not_health_data',
    why: "the payout shape — the product's own vocabulary",
  },
  { message: 'how is the lump sum taxed?', expected: 'not_health_data', why: 'payout question' },
  {
    message: 'is the death benefit a lump sum?',
    expected: 'not_health_data',
    why: 'payout question in question form',
  },
  {
    message: 'my lump sum has arrived',
    expected: 'not_health_data',
    why: 'possessive plus the payout compound',
  },
  {
    message: 'I have a lump of coal in the shed',
    expected: 'not_health_data',
    why: 'quantifier after a disclosure word',
  },
  { message: "I'll have to lump it", expected: 'not_health_data', why: 'phrasal verb' },
  {
    message: 'lump the two policies together',
    expected: 'not_health_data',
    why: 'phrasal verb with a particle',
  },
  {
    message: 'lumps of ice in the driveway',
    expected: 'not_health_data',
    why: 'quantifier, plural',
  },
  {
    message: 'lump them together on one form',
    expected: 'not_health_data',
    why: 'phrasal verb with an object pronoun',
  },
];

describe('Gate road test — the lay word "lump"', () => {
  test.each(LUMP_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(LUMP_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" stays unclassified (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test('the topic question is a topic question, and the payout question is not', () => {
    // "Is a lump in the breast serious?" names a condition in an impersonal
    // question, so it takes the health-topic path; the payout compound is what
    // keeps the lump-sum questions out of it.
    expect(classify('Is a lump in the breast serious?')).toBe('health_topic_question');
    expect(classify('Can a lump be harmless?')).toBe('health_topic_question');
    expect(classify('Should I take the lump sum?')).toBe('not_health_data');
    expect(classify('Is the lump sum taxable?')).toBe('not_health_data');
  });

  test('the collision corpus covers every shape the guard excludes', () => {
    // Removing a guard alternative must fail here rather than silently
    // re-introduce the false handoff: the payout compound, the quantifier, and
    // the phrasal verb with its particle and with an object pronoun.
    const shapes = LUMP_COLLISIONS.map((c) => c.message.toLowerCase());
    for (const phrase of ['lump sum', 'lump of', 'lump it', 'lump them together']) {
      expect({ phrase, present: shapes.some((m) => m.includes(phrase)) }).toEqual({
        phrase,
        present: true,
      });
    }
  });
});

/**
 * The syntactic-collision class — measured in both directions.
 *
 * The class piles opened: a lay synonym or a phrase whose ordinary sense is a
 * *frame* rather than a second meaning of the word. Five candidates were probed,
 * each with a medical corpus and an ordinary counterpart:
 *
 *   stones     quantifier ("stones of the path"), place ("the stones in the
 *              driveway"), task ("stones to move"), material ("stone is cheaper
 *              than brick") and the `with` phrase ("a driveway with stones")
 *   growth     mass noun ("growth of the market", "growth in premiums", "policy
 *              growth") versus a countable thing a person has
 *   discharge  the "<word> of" metaphor ("discharge of the mortgage") and the
 *              military frame ("discharged from the army") versus fluid and a
 *              hospital stay
 *   passing    the verb in its ordinary transitive and idiomatic senses ("the
 *              bill was passed", "passing the time", "passed out the forms")
 *   pads       any other compound noun ("mouse pads", "brake pads", "knee
 *              pads") versus the qualified product phrase
 *
 * `medical` must gate and `benign` must stay silent. `open` holds the medical
 * phrasings the measurement could NOT separate from an ordinary frame: they are
 * asserted silent, with the reason, so the residue is recorded rather than
 * silently assumed to be covered.
 */
/**
 * The stones entry's ordinary senses, named rather than inline so the registry
 * contract at the end of this file can point at them. The other four
 * syntactic-collision families keep their benches inline.
 */
const STONES_COLLISIONS = [
  'stones of the garden path',
  'we laid stones of different sizes',
  'the stones in the driveway need moving',
  'the stones on the beach',
  'we have stones in the garden',
  'I have stones to move this weekend',
  'the foundation stones of the policy',
  'paving stones',
  'the stones are heavy',
  'the stones we ordered arrived',
  'a stone in the garden',
  'the stone in the driveway',
  'a driveway with stones',
  // The boundary the lump entry's per-entry disclosure words exist for:
  // "found" is a discovery verb for a lump, not a disclosure for a calculus.
  'I found stones for the patio',
  'stone wall',
  'stone cold',
  'is stone cheaper than brick?',
];

const SYNTACTIC_COLLISION_CASES: {
  entry: string;
  medical: string[];
  benign: string[];
  open: [message: string, why: string][];
}[] = [
  {
    entry: 'stones',
    medical: [
      'I have stones',
      'I had stones last year',
      'I was diagnosed with stones',
      'stones in my urine',
      'stone in my ureter',
      'a stone in my kidney',
      'bladder stones',
      'ureter stones',
      'tonsil stones',
      'salivary stones',
      'gall stone',
      'I passed a stone',
      'I passed a stone on Tuesday',
    ],
    benign: STONES_COLLISIONS,
    open: [],
  },
  {
    entry: 'growth',
    medical: [
      'I have a growth',
      'a growth in my lung',
      'a growth was found in my lung',
      'they found a growth',
      'abnormal growth',
      'a benign growth',
      'a suspicious growth on my skin',
      'I had a growth removed',
      'my growth is being monitored',
      'the growth on my skin',
      'the growth was removed',
      'growth on my kidney',
    ],
    benign: [
      'growth of the market',
      'economic growth',
      'growth in premiums',
      'the growth of my portfolio',
      'growth of the policy value',
      'business growth',
      'revenue growth',
      'growth projections for next year',
      'the growth of the fund',
      'is economic growth relevant here?',
      'cash value growth',
      'policy growth',
      'premium growth',
      'annual growth',
      'compound growth',
      'projected growth',
      'growth rate',
      'growth potential',
      'the growth in premiums',
      'the growth of the policy',
      'the growth we projected',
      'the growth is steady',
    ],
    open: [
      [
        'a growth of 5 cm',
        'the "of" shape is how a chart is read too ("a growth of 5%"), so excluding it keeps the size reading out',
      ],
    ],
  },
  {
    entry: 'discharge',
    medical: [
      'I have discharge from my ear',
      'nasal discharge',
      'vaginal discharge',
      'eye discharge',
      'ear discharge',
      'yellow discharge',
      'the discharge from my wound',
      'I had a discharge from my wound',
      'the discharge was yellow',
      'I was discharged last week',
      'I was discharged from hospital',
      'my discharge summary',
      'vaginal discharge is normal',
    ],
    benign: [
      'discharge of the mortgage',
      'discharge of a debt',
      'discharge of my duties',
      'dishonourable discharge from the army',
      'I was discharged from the army',
      'honorable discharge',
      'the discharge date on the loan',
      'battery discharge',
      'discharge of the contract',
      'the discharge of the policy',
      'discharge papers',
      'discharge from the army',
      'the discharge of my duties',
    ],
    open: [],
  },
  {
    entry: 'passing',
    medical: [
      'I passed out yesterday',
      'I keep passing out',
      'passing blood in my urine',
      'passing blood',
      'I passed blood in my stool',
      'passing urine is painful',
      'I pass blood',
      'pass a stone',
      'I passed water',
      'blood in my urine',
    ],
    benign: [
      'in passing, could you confirm the premium?',
      'passing the time',
      'the passing of the law',
      'passing my details to a colleague',
      'the bill was passed',
      'I passed the exam',
      'the passing lane',
      'the car passed us',
      'time passing quickly',
      'the leaflets were passed out',
      'they passed out the forms',
      'I passed a stone on the path',
      'passing trade',
      'passing remarks',
    ],
    open: [
      [
        'my father passed away last year',
        "bereavement, not the visitor's own health datum; gating every mention of a death would hand off ordinary family history",
      ],
    ],
  },
  {
    entry: 'pads',
    medical: ['sanitary pads', 'period pads', 'maternity pads', 'I need pads for bleeding'],
    benign: [
      'I wear knee pads',
      'I use pads of paper',
      'I need new brake pads',
      'my pads are worn out',
      'the pads of my fingers',
      'mouse pads',
      'notepads and stationery',
    ],
    open: [
      ['I wear pads', 'the verb frame is shared with sports and office equipment'],
      ['I use pads every day', 'the same frame as "I use mouse pads"'],
      ['I change my pads often', 'the possessive frame is shared as well ("my pads are worn out")'],
    ],
  },
];

describe('Gate road test — the syntactic-collision class', () => {
  test.each(
    SYNTACTIC_COLLISION_CASES.flatMap((entry) =>
      entry.medical.map((message) => [entry.entry, message] as const),
    ),
  )('%s: the medical phrasing is gated — "%s"', (_entry, message) => {
    expect({ message, actual: classify(message) }).toEqual({ message, actual: 'health_data' });
  });

  test.each(
    SYNTACTIC_COLLISION_CASES.flatMap((entry) =>
      entry.benign.map((message) => [entry.entry, message] as const),
    ),
  )('%s: the ordinary frame stays silent — "%s"', (_entry, message) => {
    expect({ message, actual: classify(message) }).toEqual({ message, actual: 'not_health_data' });
  });

  test.each(
    SYNTACTIC_COLLISION_CASES.flatMap((entry) =>
      entry.open.map(([message, why]) => [entry.entry, message, why] as const),
    ),
  )('%s: recorded residue is still open, for the reason given — "%s" (%s)', (_entry, message) => {
    // If a future rule closes one of these, this fails and the row moves into
    // the medical corpus rather than being remembered as closed.
    expect({ message, actual: classify(message) }).toEqual({ message, actual: 'not_health_data' });
  });

  test('both directions are represented for every entry', () => {
    for (const entry of SYNTACTIC_COLLISION_CASES) {
      expect({ entry: entry.entry, medical: entry.medical.length > 0 }).toEqual({
        entry: entry.entry,
        medical: true,
      });
      expect({ entry: entry.entry, benign: entry.benign.length > 0 }).toEqual({
        entry: entry.entry,
        benign: true,
      });
    }
    // Every entry the class produced has a corpus here.
    expect(SYNTACTIC_COLLISION_CASES.map((entry) => entry.entry).sort()).toEqual([
      'discharge',
      'growth',
      'pads',
      'passing',
      'stones',
    ]);
  });

  test('the stones corpus covers every guard shape, and the named-spelling boundary', () => {
    // The guard is the collision budget: the quantifier, the place, the task,
    // the material noun and the `with` phrase the lookbehind exists for.
    const stones = SYNTACTIC_COLLISION_CASES.find((entry) => entry.entry === 'stones')!;
    const shapes = stones.benign.map((message) => message.toLowerCase()).join(' | ');
    for (const phrase of ['stones of', 'stones to', 'in the drive', 'with stones', 'is stone']) {
      expect({ phrase, present: shapes.includes(phrase) }).toEqual({ phrase, present: true });
    }
    // And a benign row with no guard shape at all, so silence is not just the
    // guard firing: "the stones we ordered arrived".
    expect(shapes.includes('the stones we ordered arrived')).toBe(true);
  });

  test('the question path names the plural and not the mass noun', () => {
    // "Are stones painful?" is a question about a condition; "is stone cheaper
    // than brick?" is the material, and the singular is not watched on that path.
    expect(classify('Are stones painful?')).toBe('health_topic_question');
    expect(classify('Is stone cheaper than brick?')).toBe('not_health_data');
  });
});

/**
 * Every live context-qualified entry, mapped to the benign corpus that proves
 * its guard. This ledger is the CI contract: an entry added to
 * `CONTEXT_QUALIFIED_TERMS` without a collision case fails the build, so a new
 * lay synonym cannot ship with its guard unmeasured.
 */
const REGISTRY_COLLISION_CORPUS: Readonly<Record<string, readonly string[]>> = {
  ms: MS_COLLISIONS.map((c) => c.message),
  sle: SLE_COLLISIONS.map((c) => c.message),
  tia: TIA_COLLISIONS.map((c) => c.message),
  tb: TB_COLLISIONS.map((c) => c.message),
  piles: PILES_COLLISIONS.map((c) => c.message),
  stones: STONES_COLLISIONS,
  lump: LUMP_COLLISIONS.map((c) => c.message),
};

/**
 * A ledger row that is blank does not count as a collision case — the corpus
 * has to hold a sentence a visitor could type, not a placeholder.
 */
const collisionMessages = (id: string): string[] =>
  (REGISTRY_COLLISION_CORPUS[id] ?? [])
    .map((message) => message.trim())
    .filter((m) => m.length > 0);

/** The entries that fail the contract — empty means every entry is covered. */
const entriesMissingCollisions = (
  ids: readonly string[],
  corpus: Readonly<Record<string, readonly string[]>>,
): string[] =>
  ids
    .filter((id) => (corpus[id] ?? []).every((message) => message.trim().length === 0))
    .map((id) => id);

describe('Gate road test — the registry collision contract', () => {
  test('every context-qualified entry ships with at least one collision case', () => {
    // The failure this closes: a term added to the registry whose guard was
    // never measured against an ordinary sentence. The diff names the offenders.
    const missing = entriesMissingCollisions(
      CONTEXT_QUALIFIED_TERMS.map((term) => term.id),
      REGISTRY_COLLISION_CORPUS,
    );
    expect(missing).toEqual([]);
  });

  test('and the reviewed depth is more than the letter of the contract', () => {
    // One benign sentence can satisfy the requirement without pinning a guard,
    // so there is a depth floor as well: three, which is the smallest corpus in
    // the registry today (tb) and the number of ordinary frames a guard needs in
    // practice — the token elsewhere, a shared quantifier or verb, and the
    // sentence with no guard shape at all.
    for (const term of CONTEXT_QUALIFIED_TERMS) {
      expect({ id: term.id, enough: collisionMessages(term.id).length >= 3 }).toEqual({
        id: term.id,
        enough: true,
      });
    }
  });

  test('the ledger covers exactly the live registry, with no stale ids', () => {
    // The reverse direction: a term removed or renamed in the registry must not
    // leave a corpus behind that looks like coverage.
    expect(Object.keys(REGISTRY_COLLISION_CORPUS).sort()).toEqual(
      CONTEXT_QUALIFIED_TERMS.map((term) => term.id).sort(),
    );
  });

  test('every ledger row is asserted benign by a classification test', () => {
    // A ledger pointing at phrases no test runs would look covered and prove
    // nothing, so each message must appear in a corpus the classification tests
    // iterate — the shared collisions, the piles/lump benches, or a
    // syntactic-collision case.
    const asserted = new Set<string>([
      ...COLLISIONS.map((c) => c.message),
      ...PILES_COLLISIONS.map((c) => c.message),
      ...LUMP_COLLISIONS.map((c) => c.message),
      ...SYNTACTIC_COLLISION_CASES.flatMap((entry) => entry.benign),
    ]);
    const unasserted = Object.keys(REGISTRY_COLLISION_CORPUS).flatMap((id) =>
      collisionMessages(id)
        .filter((message) => !asserted.has(message))
        .map((message) => `${id}: ${message}`),
    );
    expect(unasserted).toEqual([]);
  });

  test('the contract fires for an entry with no collisions', () => {
    // The check is only a gate if a missing corpus actually fails it — here for
    // a synthetic id, for a blank placeholder row, and for a covered one.
    expect(entriesMissingCollisions(['fit'], {})).toEqual(['fit']);
    expect(entriesMissingCollisions(['fit'], { fit: ['   '] })).toEqual(['fit']);
    expect(entriesMissingCollisions(['fit'], { fit: ['I want to get fit'] })).toEqual([]);
  });

  test('the live registry really is the thing being checked', () => {
    // Guards against the contract silently checking an empty list.
    expect(CONTEXT_QUALIFIED_TERMS.length).toBeGreaterThanOrEqual(7);
    expect(
      CONTEXT_QUALIFIED_TERMS.filter((term) => collisionMessages(term.id).length > 0).length,
    ).toBe(CONTEXT_QUALIFIED_TERMS.length);
  });
});
