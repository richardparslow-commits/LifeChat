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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findCanonicalCondition } from '../src/medical/condition-crosswalk';
import { CONTEXT_QUALIFIED_TERMS } from '../src/security/context-qualified-terms';
import { detectContractQuestion, detectSensitiveData } from '../src/security/security-controls';

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
  // ICD-10 Chapter XVIII (1.11.0) — the four symptom words whose medical sense
  // had to win over a real ordinary one, each recorded rather than traded for a
  // narrowing rule that would have cost a disclosure.
  {
    message: 'I am on pins and needles waiting for the decision',
    expected: 'health_data',
    why: 'the anxious-waiting idiom; accepted false positive — "pins and needles in my hands" is the same noun phrase, and the idiom is rare here',
  },
  {
    message: 'this whole application is a headache',
    expected: 'health_data',
    why: 'predicate metaphor; accepted false positive — a guard for "is a headache" would also swallow "my headache is a problem"',
  },
  {
    message: 'donor fatigue is real',
    expected: 'health_data',
    why: 'the "X fatigue" metaphor; accepted — the compounds are open-ended (compassion, voter, application) and `fatigue` is a genuine symptom word',
  },
  {
    message: 'the fever for whole life policies has cooled',
    expected: 'health_data',
    why: 'the craze sense; accepted false positive — gating `fever` protects "I have a fever" and "fever of unknown origin"',
  },
  {
    message: 'breathing room in the budget',
    expected: 'health_data',
    why: 'the idiom; accepted false positive — `breathing` is what "difficulty breathing" and "my breathing" are stated with',
  },
  {
    message: 'I need some breathing space',
    expected: 'health_data',
    why: 'the same idiom, second frame; accepted false positive',
  },
  {
    message: 'throat clearing at the meeting',
    expected: 'health_data',
    why: 'the only ordinary sentence measurable for `throat`; accepted false positive — the word is medical everywhere else ("sore throat", "my throat hurts")',
  },
  {
    message: 'I have low energy and fatigue',
    expected: 'health_data',
    why: 'tiredness stated with a symptom word the chapter gated; accepted — this row was the `tb` corpus\'s "fatigue" collision and moved here when `fatigue` itself became a gate term, since the sentence is a health complaint either way',
  },
  {
    // The trade the Chapter XXI sweep accepted rather than traded away: gating
    // the pregnancy state protects "I am pregnant", and the cost is that the
    // product's own copy about it — "pregnancy is not covered" — is gated too.
    // The alternative would be a rule that only recognises first-person
    // pregnancy, which is the shape the measurement said not to narrow (the
    // symptom words keep their broad rules for the same reason).
    message: 'pregnancy is not covered',
    expected: 'health_data',
    why: 'product copy about the pregnancy state; accepted false positive — "I am pregnant" was silent before the term existed',
  },
  // The Chapter XXI vocabulary's measurable ordinary senses, each one accepted
  // rather than guarded: the words are rare in this product's subject matter and
  // every guard that removed them would also remove a real disclosure.
  {
    message: 'the building has asbestos in the ceiling',
    expected: 'health_data',
    why: 'exposure to a hazardous substance; accepted — the visitor is stating an exposure fact, which is what a life application asks about',
  },
  {
    message: 'asbestos removal costs',
    expected: 'health_data',
    why: 'a maintenance topic with the exposure word in it; accepted false positive (the safe direction), since "I was exposed to asbestos" is the same two words',
  },
  {
    message: 'the gestation period of the new regulations',
    expected: 'health_data',
    why: 'the business metaphor for how long something takes to develop; accepted false positive — guarding it would cost "weeks of gestation"',
  },
  {
    message: 'the ventilator in the office is broken',
    expected: 'health_data',
    why: 'a ventilation system, not the medical device; accepted false positive — "I am on a ventilator" is the disclosure the word carries',
  },
  {
    message: 'coral polyp',
    expected: 'health_data',
    why: 'the marine organism; accepted false positive — "polyps" is how the colon finding is stated, and the family-history row depends on it',
  },
  {
    message: 'the stoma of a leaf',
    expected: 'health_data',
    why: 'the botanical pore; accepted false positive — "I have a stoma" is the surgical state',
  },
  {
    message: 'the bill was abused by lobbyists',
    expected: 'health_data',
    why: 'the passive of the bare noun; accepted false positive — "I was abused" is the disclosure, and a guard that separated them would have to parse who the object was',
  },
  // The Chapter XXI closure (1.13.0). Each row is the ordinary sense of a word
  // the ten new rows are reached by, and each is measured rather than assumed.
  // (The provision sense of the suicide words — "the suicide clause in the
  // policy" — was pinned here as a trade in 1.13.0 and is *guarded* now; see
  // the provision corpus below. The question form of the same wording remains a
  // health topic question, the documented decision for an impersonal condition
  // question.) The rest of the window was taken deliberately — the alternative
  // is a guard per phrase, and every guard that separated these from the
  // disclosure also silenced a sentence a visitor really writes.
  {
    message: 'I would kill myself if I had to fill that in again',
    expected: 'health_data',
    why: 'hyperbole; accepted false positive — the phrase is watched as a statement in its own right',
  },
  {
    message: 'an overdose of caffeine',
    expected: 'health_data',
    why: 'a figure of speech; accepted false positive — "I overdosed" is the medical event',
  },
  {
    message: 'the company has a history of cutting corners',
    expected: 'health_data',
    why: 'a business sense; accepted false positive — "I have a history of cutting" is the self-harm row',
  },
  {
    message: 'the noise assaulted my ears',
    expected: 'health_data',
    why: 'a metaphor; accepted false positive — "I was assaulted" is the disclosure',
  },
  {
    message: 'she was molested by the crowds at the sale',
    expected: 'health_data',
    why: 'a metaphor; accepted false positive — the word is otherwise always the abuse sense',
  },
];

/**
 * The product/topic compound sense of the maltreatment words, both directions.
 *
 * "child abuse policy for our staff" was 1.13.0's accepted false positive. It is
 * the same class the suicide-clause fix separated: the word is *modifying* a
 * thing rather than naming what happened to a person, and the shape says so — a
 * maltreatment term directly in front of a document or programme noun (policy,
 * procedure, guidance, training, awareness, prevention, campaign, strategy,
 * framework, hotline, law, statistics, course, charter, workshop) is a topic.
 * Only that compound is removed, so the terms themselves are untouched, and the
 * measured guard — a first-person singular after the compound makes it personal
 * — keeps "the domestic abuse policy did not help me" and "the child abuse
 * awareness training I attended after my own abuse" gated.
 *
 * What the shapes do not separate stays a recorded trade at the endpoint: a
 * charity's name, a document named by a word the list deliberately does not
 * carry ("report", "hotline", "form" — a person files those rather than reads
 * them), and two boundary sentences whose only watched wording was the topic
 * compound, with the person named in words the gate has never watched ("my own
 * abuse").
 */
const MALTREATMENT_TOPIC_COMPOUNDS: GateCase[] = [
  {
    message: 'child abuse policy for our staff',
    expected: 'not_health_data',
    why: 'the pinned trade this closes — a policy topic, not a disclosure',
  },
  { message: 'our child abuse policy', expected: 'not_health_data', why: 'the same compound' },
  { message: 'the child abuse policy', expected: 'not_health_data', why: 'the same compound' },
  {
    message: 'child abuse training for staff',
    expected: 'not_health_data',
    why: 'a training course, not a history',
  },
  {
    message: 'child abuse awareness training',
    expected: 'not_health_data',
    why: 'a programme',
  },
  {
    message: 'child abuse prevention policy',
    expected: 'not_health_data',
    why: 'a document',
  },
  {
    message: 'child abuse guidance for schools',
    expected: 'not_health_data',
    why: 'guidance',
  },
  {
    message: 'child abuse statistics',
    expected: 'not_health_data',
    why: 'figures, not a person',
  },
  { message: 'domestic abuse policy', expected: 'not_health_data', why: 'the same shape' },
  { message: 'elder abuse training', expected: 'not_health_data', why: 'the same shape' },
  {
    message: 'sexual abuse awareness campaign',
    expected: 'not_health_data',
    why: 'the same shape',
  },
  {
    message: 'self harm awareness training',
    expected: 'not_health_data',
    why: 'the self-harm words take the same reading',
  },
  {
    message: 'child neglect policy',
    expected: 'not_health_data',
    why: 'neglect takes the same reading',
  },
  {
    message: 'child abuse law reform',
    expected: 'not_health_data',
    why: 'legislation',
  },
  {
    message: 'child abuse prevention charity',
    expected: 'not_health_data',
    why: 'a programme noun, even when a charity runs it',
  },
  {
    message: 'I work for a child abuse prevention charity',
    expected: 'not_health_data',
    why: 'employment in the field, with no first-person claim about the person',
  },
  {
    message: 'the policy on child abuse',
    expected: 'not_health_data',
    why: 'the 1.14.0 mention frame, now reaching the maltreatment words',
  },
  {
    message: 'a study of child abuse',
    expected: 'not_health_data',
    why: 'the same mention frame',
  },
  {
    message: 'a report on elder abuse',
    expected: 'not_health_data',
    why: 'the same mention frame',
  },
  {
    message: 'the charity fights child abuse',
    expected: 'not_health_data',
    why: 'the same mention frame',
  },
  {
    message: 'the awareness campaign about child abuse',
    expected: 'not_health_data',
    why: 'the campaign is the subject',
  },
  {
    message: 'the child abuse hotline',
    expected: 'not_health_data',
    why: 'a published resource — the reach-guard keeps the caller’s sentence gated',
  },
  {
    message: 'the domestic abuse hotline',
    expected: 'not_health_data',
    why: 'the same resource shape, family vocabulary',
  },
  {
    message: 'child abuse report form',
    expected: 'not_health_data',
    why: 'the blank form is a document, not a disclosure',
  },
  {
    message: 'child neglect policy for our staff',
    expected: 'not_health_data',
    why: 'the compound frame — the term as a modifier, the organisation’s possessive',
  },
  {
    message: 'the child neglect report form',
    expected: 'not_health_data',
    why: 'the report-form artifact, strippable since the reach-guard closure',
  },
  {
    message: 'a study of child neglect',
    expected: 'not_health_data',
    why: 'the mention frame — the study is the subject, not the visitor',
  },
];

const MALTREATMENT_DISCLOSURES_KEPT: GateCase[] = [
  {
    message: 'I was abused as a child',
    expected: 'health_data',
    why: 'the Z62.819 wording the compound must not touch',
  },
  { message: 'history of child abuse', expected: 'health_data', why: 'the Z62.819 row' },
  {
    message: 'I have a history of child abuse',
    expected: 'health_data',
    why: 'the same row, stated personally',
  },
  { message: 'child abuse happened to me', expected: 'health_data', why: 'personal frame' },
  { message: 'I suffered child abuse', expected: 'health_data', why: 'personal frame' },
  {
    message: 'I was a victim of child abuse',
    expected: 'health_data',
    why: 'personal frame',
  },
  {
    message: 'the child abuse I experienced',
    expected: 'health_data',
    why: 'first person after the term blocks any strip',
  },
  {
    message: 'the child abuse I went through',
    expected: 'health_data',
    why: 'the same guard',
  },
  {
    message: 'child abuse by my father',
    expected: 'health_data',
    why: 'the term is not modifying an artefact noun',
  },
  {
    message: 'my child abuse history',
    expected: 'health_data',
    why: '"history" is deliberately not an artefact noun',
  },
  {
    message: 'I witnessed child abuse',
    expected: 'health_data',
    why: 'a personal claim',
  },
  {
    message: 'I have a history of domestic abuse',
    expected: 'health_data',
    why: 'the family row’s wording',
  },
  {
    message: 'I have a history of childhood neglect',
    expected: 'health_data',
    why: 'the neglect row’s wording',
  },
  {
    message: 'I have a history of child neglect',
    expected: 'health_data',
    why: 'the 1.18.0 wording — the codebook’s other lay order',
  },
  {
    message: 'child neglect happened to me',
    expected: 'health_data',
    why: 'the same phrase in a personal frame',
  },
  {
    message: 'I am a survivor of elder abuse',
    expected: 'health_data',
    why: 'personal frame',
  },
  {
    message: 'I was sexually abused as a child',
    expected: 'health_data',
    why: 'the Z62.810 wording',
  },
  {
    message: 'the report mentions that I was abused as a child',
    expected: 'health_data',
    why: 'a personal clause inside a mention — the 1.14.0 property, restated',
  },
  {
    message: 'I was abused as a child and now I run child abuse awareness training',
    expected: 'health_data',
    why: 'only the compound is removed, so the disclosure survives',
  },
  {
    message: 'the study of child abuse I took part in',
    expected: 'health_data',
    why: 'first person after the term',
  },
  {
    message: 'the training about child abuse I went to as a survivor',
    expected: 'health_data',
    why: 'first person after the term',
  },
  {
    message: 'the domestic abuse policy did not help me',
    expected: 'health_data',
    why: 'the measured guard — a first-person singular after the compound',
  },
  {
    message: 'the child abuse awareness training I attended after my own abuse',
    expected: 'health_data',
    why: 'the same guard, and the reason it was added',
  },
  {
    message: 'the child abuse report form I filed',
    expected: 'health_data',
    why: '"report"/"form" are what a person files, not what they read',
  },
  {
    message: 'the child abuse charity helped my family',
    expected: 'health_data',
    why: 'a charity the person turned to, with a possessive clause',
  },
  {
    message: 'I called the child abuse hotline',
    expected: 'health_data',
    why: 'a person reaching for help — the reach-guard’s fail-safe direction',
  },
  {
    message: 'I filled out the domestic abuse report form',
    expected: 'health_data',
    why: 'the filer’s first-person reach before the compound',
  },
];

/**
 * The sense no declared shape separates — recorded at the endpoint too. The
 * hotline and report-form artefacts used to sit here; the reach-guard closure
 * (a reach-verb parse before the compound, a first-person clause after)
 * separated the bare artefacts from the caller, so the artefacts moved into
 * MALTREATMENT_TOPIC_COMPOUNDS and the caller sentences into DISCLOSURES_KEPT.
 */
const MALTREATMENT_TOPIC_TRADES: GateCase[] = [
  {
    message: 'the child abuse charity',
    expected: 'health_data',
    why: 'a charity’s name reads exactly like a person’s disclosure',
  },
];

/**
 * Two boundaries the measurement recorded rather than closed, asserted so they
 * stay decisions: each sentence's only *watched* wording was the topic compound,
 * and the personal clause names the bare noun the gate has never watched (the
 * 1.13.0 decision that bare "abuse" collides with the product's own vocabulary).
 */
const MALTREATMENT_RECORDED_BOUNDARY: GateCase[] = [
  {
    message: 'the article about the abuse I suffered',
    expected: 'not_health_data',
    why: 'bare "abuse" is unwatched by design; naming it "child abuse" gates',
  },
  {
    message: 'I attended training after my own abuse',
    expected: 'not_health_data',
    why: 'the same boundary, without any topic compound involved',
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
    message: 'If someone takes their own life, does the policy pay out?',
    expected: 'health_topic_question',
    why: 'the act-as-subject payout question: it names no condition, so only the question opener\u2019s conditional branch reaches it \u2014 silent before the three-reading audit; the act\u2019s generic pronoun keeps it impersonal',
  },
  {
    message: 'If I kill myself, does the policy pay out?',
    expected: 'health_data',
    why: 'the act\u2019s pronoun decides the person: first person is a disclosure, not a topic question',
  },
  {
    message: 'If my husband takes his own life, does the policy pay out?',
    expected: 'health_data',
    why: 'family framing inside the conditional stays a disclosure',
  },
  {
    message: 'does child abuse affect premiums?',
    expected: 'health_topic_question',
    why: '"child" inside the compound is the condition\u2019s modifier, not a family frame \u2014 the compound is blanked before the personal test',
  },
  {
    message: 'What does child neglect mean?',
    expected: 'health_topic_question',
    why: 'the same compound blanking on the terminology question',
  },
  {
    message: 'does child abuse affect my premium?',
    expected: 'health_data',
    why: 'the possessive outside the compound is still the visitor\u2019s own',
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

/**
 * The three entries the Chapter XVIII closure added, each measured in both
 * directions before it shipped.
 *
 *   rash  → "a rash decision" (the adjectival sense always takes a noun of
 *            judgment, which the guard lists)
 *   pain  → "the pain points of the process" and "a pain in the neck"
 *            (the product's own vocabulary and the idiom, both stripped)
 *   psa   → "our PSA campaign", "PSA: update your beneficiaries" (an
 *            announcement, not a marker)
 */
const RASH_DISCLOSURES: GateCase[] = [
  { message: 'I have a rash', expected: 'health_data', why: 'explicit disclosure' },
  { message: 'I have had a rash for a week', expected: 'health_data', why: 'duration' },
  { message: 'my rash is spreading', expected: 'health_data', why: 'possessive' },
  { message: 'an itchy rash', expected: 'health_data', why: 'declared qualifier' },
  { message: 'a skin rash', expected: 'health_data', why: 'declared qualifier' },
  { message: 'a rash on my arm', expected: 'health_data', why: 'body-site anchor' },
  { message: 'the doctor said it was an allergic rash', expected: 'health_data', why: 'qualifier' },
];

const RASH_COLLISIONS: GateCase[] = [
  {
    message: 'that would be a rash decision',
    expected: 'not_health_data',
    why: 'the adjectival sense with a noun of judgment',
  },
  {
    message: 'I do not want to make a rash choice',
    expected: 'not_health_data',
    why: 'same frame, the adjective before a different noun',
  },
  {
    message: 'a rash promise to the client',
    expected: 'not_health_data',
    why: 'same frame, third noun',
  },
  {
    message: 'his advice was rash',
    expected: 'not_health_data',
    why: 'predicative adjective of judgment, in a sentence about someone else',
  },
  {
    // "do not do anything rash" used to land here as an accepted false
    // positive: the imperative opener read as interrogative on the topic path.
    // The Chapter XXI sweep closed it with a measured guard — a negated
    // auxiliary ("do not", "does not", "did not") is never a question opener,
    // which is what the codebook title "Do not resuscitate" proved — so the
    // sentence is a collision now and is asserted as one above.
    message: 'do not do anything rash',
    expected: 'not_health_data',
    why: 'the negated-auxiliary guard, pinned in TRADEOFFS until the guard landed',
  },
];

const PAIN_DISCLOSURES: GateCase[] = [
  { message: 'I have pain in my knee', expected: 'health_data', why: 'disclosure plus site' },
  { message: 'my pain is getting worse', expected: 'health_data', why: 'possessive' },
  { message: 'I have chronic pain', expected: 'health_data', why: 'declared qualifier' },
  { message: 'pains in my legs at night', expected: 'health_data', why: 'site anchor, plural' },
  {
    message: 'the pain is in my lower back',
    expected: 'health_data',
    why: 'site anchor with the copula between token and location',
  },
  { message: 'I have been having pains in my chest', expected: 'health_data', why: 'disclosure' },
];

const PAIN_COLLISIONS: GateCase[] = [
  {
    message: 'the pain points in the process',
    expected: 'not_health_data',
    why: "the product's own business vocabulary",
  },
  { message: 'a pain in the neck', expected: 'not_health_data', why: 'the idiom' },
  {
    message: 'growing pains for a new business',
    expected: 'not_health_data',
    why: 'the business sense, with no context the entry accepts',
  },
  { message: 'the pain of paperwork', expected: 'not_health_data', why: 'figurative, no site' },
];

const PSA_DISCLOSURES: GateCase[] = [
  { message: 'my PSA came back high', expected: 'health_data', why: 'possessive plus result' },
  { message: 'my PSA is elevated', expected: 'health_data', why: 'possessive' },
  { message: 'PSA test results', expected: 'health_data', why: 'clinical noun after the token' },
  { message: 'elevated PSA', expected: 'health_data', why: 'declared qualifier' },
  { message: 'my PSA level was 6', expected: 'health_data', why: 'possessive plus level' },
  { message: 'the doctor checked my PSA', expected: 'health_data', why: 'possessive' },
];

const PSA_COLLISIONS: GateCase[] = [
  {
    message: 'our PSA campaign this quarter',
    expected: 'not_health_data',
    why: 'the announcement sense, stripped by frame',
  },
  {
    message: 'a public service announcement about cover',
    expected: 'not_health_data',
    why: 'the announcement spelled out',
  },
  {
    message: 'PSA: update your beneficiaries',
    expected: 'not_health_data',
    why: 'the colon heading shape',
  },
  {
    message: 'send a PSA to the mailing list',
    expected: 'not_health_data',
    why: 'announcement, no context the entry accepts',
  },
];

describe('Gate road test — the symptom words "rash" and "pain"', () => {
  test.each(
    [...RASH_DISCLOSURES, ...PAIN_DISCLOSURES].map((c) => [c.message, c.expected, c.why] as const),
  )('disclosure "%s" classifies as %s (%s)', (message, expected) => {
    expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
  });

  test.each(
    [...RASH_COLLISIONS, ...PAIN_COLLISIONS].map((c) => [c.message, c.expected, c.why] as const),
  )('collision "%s" stays unclassified (%s)', (message, expected) => {
    expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
  });
});

describe('Gate road test — the tumour marker "PSA"', () => {
  test.each(PSA_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(PSA_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" stays unclassified (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test('the announcement frames the entry strips are all present in the corpus', () => {
    const shapes = PSA_COLLISIONS.map((c) => c.message.toLowerCase());
    for (const phrase of ['campaign', 'public service announcement', 'psa:']) {
      expect({ phrase, present: shapes.some((m) => m.includes(phrase)) }).toEqual({
        phrase,
        present: true,
      });
    }
  });
});

/**
 * The Chapter XXI (1.12.0) status vocabulary, measured in both directions.
 *
 * The disclosures are the sentences the sweep found were travelling to the
 * model unclassified — thirteen of them, one per hole — and the collisions are
 * the ordinary senses the same words carry, including the three the
 * negated-auxiliary guard exists for (an instruction is not a question, which is
 * also what made the codebook title "Do not resuscitate" a disclosure again
 * instead of a health *topic question*).
 */
const CHAPTER_XXI_DISCLOSURES: GateCase[] = [
  { message: 'I am pregnant', expected: 'health_data', why: 'pregnancy state' },
  { message: 'I am 12 weeks pregnant', expected: 'health_data', why: 'with a duration' },
  { message: 'I had COVID last year', expected: 'health_data', why: 'Z86.16 history' },
  { message: 'I have MRSA', expected: 'health_data', why: 'Z86.14 history' },
  { message: 'I have a DNR order', expected: 'health_data', why: 'the Z66 status' },
  { message: 'I have the BRCA1 mutation', expected: 'health_data', why: 'Z15.01 susceptibility' },
  { message: 'my blood type is O positive', expected: 'health_data', why: 'the Z67 status' },
  { message: 'I have a history of blood clots', expected: 'health_data', why: 'Z86.718 history' },
  { message: 'I was exposed to asbestos', expected: 'health_data', why: 'the Z77 exposure row' },
  { message: 'I have a history of self-harm', expected: 'health_data', why: 'the Z91.5 deferral' },
  { message: 'I was abused as a child', expected: 'health_data', why: 'the Z62/Z91.49 history' },
  { message: 'I have a stoma', expected: 'health_data', why: 'the Z93 state' },
  { message: 'I am an amputee', expected: 'health_data', why: 'the Z89 state' },
  { message: 'I am on a ventilator', expected: 'health_data', why: 'the Z99 state' },
  {
    message: 'I am a cystic fibrosis carrier',
    expected: 'health_data',
    why: 'the Z14.1 carrier row',
  },
  { message: 'history of tuberculosis', expected: 'health_data', why: 'Z86.11 history' },
  { message: 'penicillin allergy', expected: 'health_data', why: 'the Z88.0 allergy status' },
];

const CHAPTER_XXI_COLLISIONS: GateCase[] = [
  {
    message: 'do not worry about the deadline',
    expected: 'not_health_data',
    why: 'a negated auxiliary is an instruction, not a question opener',
  },
  {
    message: 'do not hesitate to ask',
    expected: 'not_health_data',
    why: 'same shape, no health word at all',
  },
  {
    message: 'we do not offer that rider',
    expected: 'not_health_data',
    why: "the product's own copy, which the topic path used to read as a question",
  },
  {
    message: 'the family section of the application',
    expected: 'not_health_data',
    why: 'family without a health word is not a family history',
  },
];

describe('Gate road test — the Chapter XXI status vocabulary', () => {
  test.each(CHAPTER_XXI_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(CHAPTER_XXI_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" stays unclassified (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test('a history row and its disease are two different statements', () => {
    // The release's central claim, asserted rather than described: the history
    // phrasing must resolve to the history code and the disease wording to the
    // disease, so a broker reading either gets the right one.
    expect(classify('I had a heart attack in 2019')).toBe('health_data');
    for (const [statement, code] of [
      ['history of breast cancer', 'Z85.3'],
      ['history of tuberculosis', 'Z86.11'],
      ['history of blood clots', 'Z86.718'],
      ['family history of diabetes', 'Z83.3'],
      ['do not resuscitate', 'Z66'],
    ] as const) {
      const resolved = findCanonicalCondition(statement)?.icd10_cm;
      expect({ statement, resolved }).toEqual({ statement, resolved: code });
    }
  });
});

/**
 * The completed abuse family (1.14.0), both directions — re-measured after the
 * topic-mention strip.
 *
 * The disclosures are the sentences the six new rows are reached by, including
 * the two the first probe measured as gaps ("I was forced into labor", "I was
 * forced to work as a child") — each is gated now, which is what makes the row
 * reachable at all — plus the adversarial rows: a mention frame wrapped around
 * a personal fact must keep the disclosure, which is what the strip's
 * object-position and personal-context guards are for.
 *
 * The topic-mention table is the second measurement of the same sentences:
 * 1.14.0 pinned eight of them as accepted trades on the finding that every
 * guard which separated them would also silence a real disclosure. Re-measured
 * against a wider corpus, the finding held only for the personal clause *inside*
 * a mention — a document that mentions forced labour is about the document — so
 * those eight pass now and are asserted here in the direction they measure.
 *
 * The trade table is what no declared shape separates: ordinary senses of the
 * same words (a campaign, a training, a drama, a subject the frame list does not
 * carry) stay gated, recorded rather than hidden, and narrowing any of them
 * later means updating this record.
 */
const ABUSE_FAMILY_DISCLOSURES: GateCase[] = [
  { message: 'I was trafficked as a child', expected: 'health_data', why: 'Z62.813' },
  {
    message: 'I was a victim of trafficking',
    expected: 'health_data',
    why: '`trafficked` does not match it; `trafficking` does',
  },
  {
    message: 'I was sexually exploited as a child',
    expected: 'health_data',
    why: 'Z62.813',
  },
  {
    message: 'I was forced into labor',
    expected: 'health_data',
    why: 'a measured gap the first probe left — now gated',
  },
  {
    message: 'I was forced to work as a child',
    expected: 'health_data',
    why: 'the same gap, for the childhood row',
  },
  {
    message: 'I have a history of financial abuse',
    expected: 'health_data',
    why: 'the Z62.814/Z91.413 pair’s shared wording',
  },
  {
    message: 'there was financial abuse in my home growing up',
    expected: 'health_data',
    why: 'the Z62.814 marker is in the words',
  },
  { message: 'I was in sex trafficking', expected: 'health_data', why: 'Z91.42' },
  // Adversarial: the mention frame is present, the personal fact is inside it,
  // so the strip must not fire — otherwise the frame would be a way to hide a
  // disclosure.
  {
    message: 'the report mentions that I was trafficked as a child',
    expected: 'health_data',
    why: 'the term is not the mention’s direct object',
  },
  {
    message: 'the documentary is about my trafficking experience',
    expected: 'health_data',
    why: 'a possessive intervenes',
  },
  {
    message: 'the report mentions my forced labor',
    expected: 'health_data',
    why: 'a possessive intervenes',
  },
  {
    message: 'the report mentions forced labor in my family',
    expected: 'health_data',
    why: 'a personal context follows the term',
  },
  {
    message: 'the trafficking I experienced',
    expected: 'health_data',
    why: 'a first-person singular follows the term',
  },
  {
    message: 'I was forced to work overtime as a child',
    expected: 'health_data',
    why: 'the overtime collocation is not stripped in childhood',
  },
];

const ABUSE_FAMILY_TOPIC_MENTIONS: GateCase[] = [
  {
    message: 'the supply chain report mentions forced labor',
    expected: 'not_health_data',
    why: 'a document mentions the term; the term is its object',
  },
  {
    message: 'the report describes forced labour in the supply chain',
    expected: 'not_health_data',
    why: 'the same sentence, British spelling',
  },
  {
    message: 'the documentary is about trafficking',
    expected: 'not_health_data',
    why: 'a documentary is the subject',
  },
  {
    message: 'the charity fights human trafficking',
    expected: 'not_health_data',
    why: 'the charity is the subject',
  },
  {
    message: 'the film examines sexual exploitation',
    expected: 'not_health_data',
    why: 'the film is the subject',
  },
  {
    message: 'trafficking of illegal goods',
    expected: 'not_health_data',
    why: 'the declared illegal-goods collocation',
  },
  {
    message: 'financial abuse of the system',
    expected: 'not_health_data',
    why: 'the declared system/process/trust collocation',
  },
  {
    message: 'we were forced to work overtime during the audit',
    expected: 'not_health_data',
    why: 'the declared overtime collocation',
  },
  {
    message: 'a study of forced labor in the garment industry',
    expected: 'not_health_data',
    why: 'the subject-of-connection shape',
  },
  {
    message: 'our supplier was accused of forced labour',
    expected: 'not_health_data',
    why: 'a reporting act by a supplier',
  },
  {
    message: 'the audit found no forced labour at the supplier',
    expected: 'not_health_data',
    why: 'the found-no shape',
  },
  {
    message: 'the report mentions forced labour in our supply chain',
    expected: 'not_health_data',
    why: 'business possession, not a personal fact',
  },
];

/**
 * Two of the 1.14.0 trades are no longer trades: the compound shape (a term
 * directly in front of a programme noun) separates them, and the measurement
 * said so rather than the shape being stretched to fit. They are asserted silent
 * here so a later narrowing of the compound list has to update the record.
 */
const ABUSE_FAMILY_TRADES_CLOSED: GateCase[] = [
  {
    message: "the charity's anti-trafficking campaign",
    expected: 'not_health_data',
    why: 'a campaign is a programme noun — separated by the compound shape',
  },
  {
    message: 'sex trafficking awareness training',
    expected: 'not_health_data',
    why: 'an awareness programme, the same shape',
  },
];

const ABUSE_FAMILY_TRADES: GateCase[] = [
  {
    message: 'the film is a trafficking drama',
    expected: 'health_data',
    why: 'accepted: a noun compound, not a mention shape',
  },
  {
    message: 'the blog post mentions forced labor',
    expected: 'health_data',
    why: 'accepted: the subject list does not carry “blog post”',
  },
  {
    message: 'trafficking of stolen goods',
    expected: 'health_data',
    why: 'accepted: only the illegal-goods compound is declared',
  },
  {
    message: 'we discussed forced labour at the board meeting',
    expected: 'health_data',
    why: 'accepted: no declared artefact subject precedes it',
  },
  {
    message: 'the company published a forced labor report',
    expected: 'health_data',
    why: 'accepted: the term is not the object of a mention verb',
  },
  {
    message: 'the agency announced new anti-trafficking measures',
    expected: 'health_data',
    why: 'accepted: the token is the term',
  },
];

const ABUSE_FAMILY_BOUNDARY: GateCase[] = [
  {
    message: 'the exploitation of loopholes in the policy',
    expected: 'not_health_data',
    why: 'bare “exploitation” is deliberately not gated',
  },
  {
    message: 'the traffic on the drive home was bad',
    expected: 'not_health_data',
    why: '“trafficking” is not “traffic”',
  },
];

describe('Gate road test — the completed abuse family (1.14.0)', () => {
  test.each(ABUSE_FAMILY_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(ABUSE_FAMILY_TOPIC_MENTIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'topic mention "%s" classifies as %s (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(ABUSE_FAMILY_TRADES.map((c) => [c.message, c.expected, c.why] as const))(
    'accepted trade "%s" classifies as %s (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(ABUSE_FAMILY_BOUNDARY.map((c) => [c.message, c.expected, c.why] as const))(
    'boundary "%s" stays unclassified (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(ABUSE_FAMILY_TRADES_CLOSED.map((c) => [c.message, c.expected, c.why] as const))(
    'closed trade "%s" is now unclassified (%s)',
    (message, expected, why) => {
      // Two of the trades 1.14.0 recorded are closed by the compound shape the
      // next measurement declared; the closure is asserted here so a later
      // narrowing of the artefact list has to update this record too.
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );
});

/**
 * The product-provision sense of the suicide words, both directions.
 *
 * The word a disclosure is carried by is the same word a policy's own terms use
 * ("the suicide clause", "suicide exclusion", "suicide rider"), and 1.13.0
 * accepted that collision as a measured false positive rather than write a
 * guard per phrase. It is separated by shape instead: a provision noun directly
 * after the word is the product's reading and is stripped before the condition
 * vocabulary is matched, while every disclosure form names no provision and is
 * untouched — including a sentence that states the disclosure *and* asks about
 * the provision, where only the provision shape is removed.
 *
 * The question form is decided elsewhere and the other way: a *contract*
 * question about the same wording ("does the suicide exclusion apply after two
 * years?") is answered as a product question — the contract-question section at
 * the end of this file owns that corpus, including the personally-framed and
 * reflexive-act forms that keep the handoff.
 */
const SUICIDE_PROVISIONS: GateCase[] = [
  {
    message: 'the suicide clause in the policy',
    expected: 'not_health_data',
    why: 'a contract term, guarded — it was a pinned trade in 1.13.0',
  },
  {
    message: 'suicide exclusion',
    expected: 'not_health_data',
    why: 'the policy exclusion, not a history',
  },
  { message: 'the suicide rider', expected: 'not_health_data', why: 'the policy rider' },
  { message: 'suicide provision', expected: 'not_health_data', why: 'same shape, same word' },
  {
    message: 'the policy pays out after the suicide exclusion period',
    expected: 'not_health_data',
    why: 'the provision sense inside a longer sentence',
  },
  {
    message: 'the suicide clause waiting period',
    expected: 'not_health_data',
    why: 'the clause named by its own term',
  },
];

const SUICIDE_DISCLOSURES: GateCase[] = [
  {
    message: 'I have thought about suicide',
    expected: 'health_data',
    why: 'the disclosure the strip must not touch',
  },
  { message: 'I have been feeling suicidal', expected: 'health_data', why: 'adjectival form' },
  { message: 'my suicide attempt', expected: 'health_data', why: 'possessive' },
  {
    message: 'history of suicidal behavior',
    expected: 'health_data',
    why: 'the Z91.51 row’s wording',
  },
  {
    message: 'I have a history of suicide attempts',
    expected: 'health_data',
    why: 'plural, and it names no provision',
  },
  {
    message: 'I have thought about suicide and the suicide clause in the policy',
    expected: 'health_data',
    why: 'a sentence naming both keeps the disclosure — only the provision shape is stripped',
  },
];

describe('Gate road test — the product-provision sense of the suicide words', () => {
  test.each(SUICIDE_PROVISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'provision "%s" stays unclassified (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(SUICIDE_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test('the question form is decided by the contract rule, not by this strip', () => {
    // 1.13.0 left the question form on the health-topic path; that was
    // re-measured and reversed, so an impersonal provision question is now
    // answered as a product question. What this test guards is the interaction:
    // the statement strip must not be what makes a question silent, and a
    // personally-framed question must still gate.
    expect(classify('does the suicide exclusion apply after two years')).toBe('not_health_data');
    expect(classify('does the suicide exclusion apply to me?')).toBe('health_data');
  });
});

describe('Gate road test — the product/topic compound sense of the maltreatment words', () => {
  test.each(MALTREATMENT_TOPIC_COMPOUNDS.map((c) => [c.message, c.expected, c.why] as const))(
    'topic "%s" stays unclassified (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(MALTREATMENT_DISCLOSURES_KEPT.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test('the senses no declared shape separates are asserted as trades', () => {
    for (const { message, expected, why } of [
      ...MALTREATMENT_TOPIC_TRADES,
      ...MALTREATMENT_RECORDED_BOUNDARY,
    ]) {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    }
  });

  test('the closure keeps every disclosure row gated, and the tables are the measured ones', () => {
    // The measurement, pinned: 24 topical sentences silent (the pinned trade is
    // the first row; the hotline and report-form artefacts joined when the
    // reach-guard separated the bare artefact from the caller), 25 disclosure
    // sentences gated, one recorded trade and two recorded boundaries. A later
    // change that widens the strip turns rows of the second list red, which is
    // the direction that matters.
    expect(MALTREATMENT_TOPIC_COMPOUNDS.length).toBe(27);
    expect(MALTREATMENT_DISCLOSURES_KEPT.length).toBe(27);
    expect(MALTREATMENT_DISCLOSURES_KEPT.filter((c) => c.expected !== 'health_data')).toEqual([]);
    expect(MALTREATMENT_TOPIC_TRADES.length).toBe(1);
    expect(MALTREATMENT_RECORDED_BOUNDARY.length).toBe(2);
  });
});

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
const BUG_DISCLOSURES: GateCase[] = [
  {
    message: 'I have a stomach bug',
    expected: 'health_data',
    why: 'the compound noun the illness is named with',
  },
  {
    message: 'my whole family caught a bug',
    expected: 'health_data',
    why: 'the illness verb the ledger said was missing',
  },
  {
    message: 'there is a nasty bug going around',
    expected: 'health_data',
    why: 'the epidemic frame',
  },
  {
    message: 'my bug turned into a fever',
    expected: 'health_data',
    why: 'token-first with a clinical word after',
  },
  {
    message: 'I caught the bug that is going around',
    expected: 'health_data',
    why: 'the epidemic frame, reversed',
  },
  { message: 'I am shaking off a bug', expected: 'health_data', why: 'recovery verb' },
  {
    message: 'the kids picked up a bug at school',
    expected: 'health_data',
    why: 'the acquisition verb',
  },
  {
    message: 'I had a vomiting bug all weekend',
    expected: 'health_data',
    why: 'the qualifier compound',
  },
  {
    message: 'my stomach bug is finally gone',
    expected: 'health_data',
    why: 'possessive compound',
  },
  {
    message: 'a flu bug is doing the rounds at work',
    expected: 'health_data',
    why: 'the qualifier compound',
  },
];

const BUG_COLLISIONS: GateCase[] = [
  {
    message: 'there is a bug in the app',
    expected: 'not_health_data',
    why: 'the software sense: the product\u2019s own vocabulary',
  },
  {
    message: 'we fixed the login bug',
    expected: 'not_health_data',
    why: 'the software sense, in a fix frame',
  },
  {
    message: 'the bug report was filed yesterday',
    expected: 'not_health_data',
    why: 'the report compound',
  },
  { message: 'a bug in the payment flow', expected: 'not_health_data', why: 'the `in` frame' },
  {
    message: 'debugging the login bug now',
    expected: 'not_health_data',
    why: 'the debug compound hides the word',
  },
  {
    message: 'the tracker shows the bug was squashed',
    expected: 'not_health_data',
    why: 'the tracker frame',
  },
  { message: 'a bug bounty program', expected: 'not_health_data', why: 'the bounty compound' },
  {
    message: 'use bug spray in the summer',
    expected: 'not_health_data',
    why: 'the pest-control frame',
  },
  {
    message: 'a bug zapper on the porch',
    expected: 'not_health_data',
    why: 'the pest-control frame',
  },
  {
    message: 'a bed bug problem in the hotel',
    expected: 'not_health_data',
    why: 'the bed-bug compound hides the word',
  },
  {
    message: 'the bug net kept mosquitoes out',
    expected: 'not_health_data',
    why: 'the pest-control frame',
  },
  {
    message: 'the farmer planted bug-resistant corn',
    expected: 'not_health_data',
    why: 'the pest-resistance compound',
  },
  {
    // The adversarial rows: the ordinary frame carrying one of the entry's own
    // illness words. These are what the guard is load-bearing for — without the
    // lookahead, "caught" and "picked up" would gate the software sense.
    message: 'the developer caught a bug in the checkout flow',
    expected: 'not_health_data',
    why: 'an illness verb inside the software frame — the guard\u2019s job',
  },
  {
    message: 'QA caught a bug in the release build',
    expected: 'not_health_data',
    why: 'an illness verb inside the software frame, `in`-guarded',
  },
];

const REGISTRY_COLLISION_CORPUS: Readonly<Record<string, readonly string[]>> = {
  ms: MS_COLLISIONS.map((c) => c.message),
  sle: SLE_COLLISIONS.map((c) => c.message),
  tia: TIA_COLLISIONS.map((c) => c.message),
  tb: TB_COLLISIONS.map((c) => c.message),
  piles: PILES_COLLISIONS.map((c) => c.message),
  stones: STONES_COLLISIONS,
  lump: LUMP_COLLISIONS.map((c) => c.message),
  rash: RASH_COLLISIONS.map((c) => c.message),
  pain: PAIN_COLLISIONS.map((c) => c.message),
  psa: PSA_COLLISIONS.map((c) => c.message),
  bug: BUG_COLLISIONS.map((c) => c.message),
  manic: [
    'a manic week at work',
    'manic Monday',
    'the manic pace of the city',
    'manic laughter filled the room',
    'a manic pixie dream girl trope',
    'Manic Panic is the dye brand',
    'the manic energy of the crowd',
    'a manic episode of my favorite sitcom',
    'he got manic at the party',
    'the crowd went completely manic',
    'my manic Monday',
  ],
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
      ...RASH_COLLISIONS.map((c) => c.message),
      ...PAIN_COLLISIONS.map((c) => c.message),
      ...PSA_COLLISIONS.map((c) => c.message),
      ...BUG_COLLISIONS.map((c) => c.message),
      ...SYNTACTIC_COLLISION_CASES.flatMap((entry) => entry.benign),
      ...MANIC_COLLISIONS.map((c) => c.message),
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

/**
 * Contract questions — the question form of the product-provision collision.
 *
 * "Is TB curable?" is a health topic (1.13.0), and "the suicide clause" is the
 * product's own wording (the statement strip). This is the third combination,
 * and the one the gate handled worst: an impersonal question about the policy's
 * wording **that names a condition** — "does the suicide exclusion apply after
 * two years?", "does the policy have a cancer exclusion?". Those were handed
 * off as `health_topic_question`, telling a visitor "that's a health topic" and
 * raising a health-topic risk flag on a record where they disclosed nothing
 * about their health and asked about their contract.
 *
 * Re-measured and decided: the condition named is the *provision's* subject, so
 * the message is answered as a product question. The rule requires a question
 * (the same interrogative opener the topic path requires), a frame that makes it
 * a product question — a provision noun ("cancer exclusion") or a contract noun
 * with a coverage verb ("does the policy cover depression?") — and an absence of
 * personal health framing once the contract's own possessives are set aside.
 *
 * The tables below are the measurement, in all four directions:
 *
 *   CONTRACT_QUESTIONS          32 rows that must be silent. 31 of them were
 *                               misclassified before the rule — 25 as topic
 *                               questions and 6 as health data — and the one
 *                               that was already silent ("does the policy ask
 *                               for a medical exam?") is pinned so it stays
 *                               that way. Between them they exercise all four
 *                               health branches the flag has to reach: the
 *                               `namesCondition` topic branch, the broad
 *                               context-family patterns, the condition-term
 *                               list, and the context-qualified registry.
 *   DISCLOSURES                 23 rows that must keep gating — the disclosure
 *                               path is what the rule must not touch.
 *   GUARD                       4 rows on the reflexivity guard: an act of
 *                               self-harm described in any person is not a
 *                               contract question, while a manner of death
 *                               named in a contract is.
 *   TRADES                      10 rows the rule deliberately does not claim,
 *                               recorded with their status so narrowing one
 *                               later has to update this record.
 */
const CONTRACT_QUESTIONS: GateCase[] = [
  // The two rows the decision was taken on.
  {
    message: 'does the suicide exclusion apply after two years?',
    expected: 'not_health_data',
    why: 'the named row: provision noun framing; the condition is the clause\u2019s subject',
  },
  {
    message: 'does the policy have a cancer exclusion?',
    expected: 'not_health_data',
    why: 'the named row: contract noun + provision noun; caught by the condition-term list before',
  },
  // Provision-noun framing — the condition term travels with the contract's
  // own noun, so the restriction is the subject.
  {
    message: 'what is the suicide clause in this policy?',
    expected: 'not_health_data',
    why: 'suicide clause + policy; was a topic question',
  },
  {
    message: 'how long is the cancer waiting period?',
    expected: 'not_health_data',
    why: 'waiting period is a provision noun; was a topic question',
  },
  {
    message: 'what does the self harm rider cover?',
    expected: 'not_health_data',
    why: 'rider framing; was a topic question',
  },
  {
    message: 'is there a depression exclusion on this plan?',
    expected: 'not_health_data',
    why: 'exclusion + plan; was a topic question',
  },
  {
    message: 'are pre-existing conditions excluded?',
    expected: 'not_health_data',
    why: 'the product\u2019s own wording, and it names no diagnosis; was health data',
  },
  {
    message: 'is there an exclusion period for pregnancy?',
    expected: 'not_health_data',
    why: 'exclusion period is a provision noun; was a topic question',
  },
  {
    message: 'does the policy have a diabetes limitation?',
    expected: 'not_health_data',
    why: 'limitation is a provision noun; was a topic question',
  },
  {
    message: 'what are the exclusions for mental health treatment?',
    expected: 'not_health_data',
    why: 'exclusions + the treatment family word; was health data',
  },
  // Contract noun + coverage verb.
  {
    message: 'does the policy cover HIV?',
    expected: 'not_health_data',
    why: 'the plainest coverage question; was a topic question',
  },
  {
    message: 'does the policy cover treatment for cancer?',
    expected: 'not_health_data',
    why: 'exercises the context-family patterns; was a topic question',
  },
  {
    message: 'is cancer covered by the policy?',
    expected: 'not_health_data',
    why: 'passive coverage question; was a topic question',
  },
  {
    message: 'how does the underwriting treat diabetes?',
    expected: 'not_health_data',
    why: 'underwriting framing; was a topic question',
  },
  {
    message: 'does the policy cover therapy for depression?',
    expected: 'not_health_data',
    why: 'therapy is a registry word; was a topic question',
  },
  {
    message: 'will the plan cover a heart condition?',
    expected: 'not_health_data',
    why: 'the heart family word; was health data',
  },
  {
    message: 'does the coverage include asthma?',
    expected: 'not_health_data',
    why: '`coverage` is the product noun; was a topic question',
  },
  {
    message: 'does your coverage cover treatment?',
    expected: 'not_health_data',
    why: 'the product noun is what makes it a contract question — see the boundary row below, where the bare verb form does not',
  },
  {
    message: 'how are pre-existing conditions treated under this policy?',
    expected: 'not_health_data',
    why: 'treated as coverage wording, not a treatment disclosure; was health data',
  },
  {
    message: 'can the policy be voided for a cancer diagnosis?',
    expected: 'not_health_data',
    why: 'voiding is a coverage verb; was a topic question',
  },
  // The application form — a question about the paperwork, not about a person.
  {
    message: 'does the application ask about mental illness?',
    expected: 'not_health_data',
    why: 'application + ask-about; was a topic question',
  },
  {
    message: 'does the policy ask for a medical exam?',
    expected: 'not_health_data',
    why: 'the one row that was already silent — recorded so it stays that way',
  },
  {
    message: 'does the policy require declaring cancer?',
    expected: 'not_health_data',
    why: 'declaring is a form verb; was a topic question',
  },
  {
    message: 'does the policy consider a stroke?',
    expected: 'not_health_data',
    why: 'considering is a coverage verb; was a topic question',
  },
  {
    message: 'what does the application ask about depression?',
    expected: 'not_health_data',
    why: 'form question, condition as its subject; was a topic question',
  },
  {
    message: 'does the policy mention mental illness?',
    expected: 'not_health_data',
    why: 'mentioning is a wording verb; was a topic question',
  },
  {
    message: 'what does the policy say about self-harm?',
    expected: 'not_health_data',
    why: 'say is a wording verb; was a topic question',
  },
  {
    message: 'what does the policy state about mental illness?',
    expected: 'not_health_data',
    why: 'state is a wording verb',
  },
  // The rest of the coverage verbs.
  {
    message: 'how does the carrier assess sleep apnea?',
    expected: 'not_health_data',
    why: 'carrier + assess; was a topic question',
  },
  {
    message: 'does the policy pay out for a heart attack?',
    expected: 'not_health_data',
    why: 'payout framing; was health data',
  },
  {
    message: 'what is the exclusion for self-harm in the policy?',
    expected: 'not_health_data',
    why: 'the registry word inside provision framing; was a topic question',
  },
  {
    message: 'does this plan cover strokes?',
    expected: 'not_health_data',
    why: 'plural coverage question; was a topic question',
  },
  {
    message: 'does the policy have a child abuse exclusion?',
    expected: 'not_health_data',
    why: 'the maltreatment compound follows the same provision path as its cancer sibling — DATA before the compound blanking',
  },
  {
    message: 'does the application ask about child abuse?',
    expected: 'not_health_data',
    why: 'the application-form verb is the coverage frame — the compound\u2019s modifier word is not a family frame',
  },
  {
    message: 'does the policy pay out for child abuse claims?',
    expected: 'not_health_data',
    why: 'a payout question about the provision\u2019s subject, not anybody\u2019s health',
  },
];

/**
 * What the rule must not touch — the disclosure path, unchanged.
 *
 * Each row is a first-person or family-framed version of a row above: the same
 * condition, the same policy vocabulary, one personal word. That is the entire
 * difference the rule turns on, so this table is the safety property of the
 * change rather than an afterthought.
 */
const CONTRACT_QUESTION_DISCLOSURES: GateCase[] = [
  {
    message: 'does the policy cover my cancer?',
    expected: 'health_data',
    why: 'personal possessive',
  },
  {
    message: 'will the policy pay out if I die by suicide?',
    expected: 'health_data',
    why: 'first person inside a coverage question',
  },
  {
    message: 'does the suicide exclusion apply to me?',
    expected: 'health_data',
    why: '`to me` makes it personal',
  },
  { message: 'am I covered for my diabetes?', expected: 'health_data', why: 'first person twice' },
  {
    message: 'does the policy cover my husband\u2019s cancer?',
    expected: 'health_data',
    why: 'family framing is personal',
  },
  {
    message: 'does my policy cover my depression?',
    expected: 'health_data',
    why: 'the contract possessive is excused, the health one is not',
  },
  {
    message: 'how does the policy treat my epilepsy?',
    expected: 'health_data',
    why: 'coverage verb + personal condition',
  },
  {
    message: 'does the plan cover my therapy?',
    expected: 'health_data',
    why: 'registry word inside a personal coverage question',
  },
  {
    message: 'does the policy cover my suicide attempt?',
    expected: 'health_data',
    why: 'the personal form of the trade below',
  },
  {
    message: 'does the policy cover my asthma inhaler prescription?',
    expected: 'health_data',
    why: 'prescription is a registry word, framed personally',
  },
  {
    message: 'I have cancer and want to know about the exclusion',
    expected: 'health_data',
    why: 'a disclosure with a policy question attached',
  },
  {
    message: 'my mother has heart disease and I want cover for her',
    expected: 'health_data',
    why: 'third-party health, family framing',
  },
  {
    message: 'I was diagnosed with cancer last year, is there an exclusion?',
    expected: 'health_data',
    why: 'disclosure first, question second',
  },
  {
    message: 'do I need to declare my cancer?',
    expected: 'health_data',
    why: 'personal declaration question',
  },
  {
    message: 'I declare that I have cancer',
    expected: 'health_data',
    why: 'the statement form of the same verb',
  },
  {
    message: 'I have depression, will the underwriter decline me?',
    expected: 'health_data',
    why: 'disclosure + underwriting question',
  },
  {
    message: 'my doctor said I have sleep apnea \u2014 does that matter?',
    expected: 'health_data',
    why: 'the interrogative is mid-sentence, and `my` is personal',
  },
  {
    message: 'I take medication for a heart condition, does that affect the policy?',
    expected: 'health_data',
    why: 'medication is a broad family word',
  },
  {
    message: 'our family has a history of cancer, do we need to declare it?',
    expected: 'health_data',
    why: 'family framing survives the contract-possessive carve-out',
  },
  {
    message: 'I am diabetic, is there a waiting period?',
    expected: 'health_data',
    why: 'disclosure + provision question: the disclosure wins',
  },
  { message: 'I have cancer', expected: 'health_data', why: 'the bare disclosure' },
  {
    message: 'this policy has a cancer exclusion and I have cancer',
    expected: 'health_data',
    why: 'a sentence naming both keeps the disclosure',
  },
  {
    message: 'I have thought about suicide',
    expected: 'health_data',
    why: 'the self-harm disclosure the guard protects',
  },
];

/**
 * The reflexivity guard, and the one direction it deliberately keeps.
 *
 * A sentence describing an act of self-harm in any person is not a contract
 * question, even when it also asks about a clause — it keeps the health-topic
 * handoff. A *manner of death named in a contract* is the clause's subject and
 * stays a product question, which is what the last row pins.
 */
const CONTRACT_QUESTION_GUARD: GateCase[] = [
  {
    message: 'does the suicide exclusion apply if someone takes their own life?',
    expected: 'health_topic_question',
    why: 'a reflexive act, third person \u2014 not a contract question',
  },
  {
    message: 'does the suicide clause apply if he harms himself?',
    expected: 'health_topic_question',
    why: 'reflexive act, masculine pronoun',
  },
  {
    message: 'does the suicide clause apply if someone kills themselves?',
    expected: 'health_topic_question',
    why: 'reflexive act with a generic person',
  },
  {
    message: 'does the suicide exclusion apply if I kill myself?',
    expected: 'health_data',
    why: 'first person: the disclosure path, not the guard',
  },
  {
    message: 'does the suicide exclusion apply if a policyholder dies by suicide?',
    expected: 'not_health_data',
    why: 'a manner of death the clause names is the clause\u2019s subject \u2014 no reflexive',
  },
];

/**
 * What the rule deliberately does not claim, recorded with its status.
 *
 * Four of these are sentences the rule *could* have been widened to swallow and
 * was not: a coverage question about an act noun ("a suicide attempt"), a
 * generic act with no reflexive, an organisation's question about its staff, and
 * a bare fragment. Two are pre-existing decisions this change does not touch: the
 * 1.13.0 statement strip, and the app's long-standing choice to keep a bare
 * coverage question ("is cancer covered?") on the topic path — the frame now
 * requires the product to be named or a provision noun to be used, which is why
 * the rule is narrow enough to be safe.
 */
const CONTRACT_QUESTION_TRADES: GateCase[] = [
  {
    message: 'does the policy cover a suicide attempt?',
    expected: 'not_health_data',
    why: 'accepted: an act noun as a coverage subject; the reflexive form is refused instead',
  },
  {
    message: 'does the suicide clause apply if someone overdoses?',
    expected: 'not_health_data',
    why: 'accepted: a generic act with no reflexive; the reflexive form is refused',
  },
  {
    message: 'does the policy cover our staff for cancer?',
    expected: 'health_data',
    why: 'conservative: `our` is personal framing, so an organisation\u2019s question still gates',
  },
  {
    message: 'cancer, is there an exclusion?',
    expected: 'health_data',
    why: 'conservative: a fragment with no interrogative opener',
  },
  {
    message: 'is a suicide attempt covered?',
    expected: 'health_topic_question',
    why: 'the frame boundary: no product named and no provision noun',
  },
  {
    message: 'is cancer covered?',
    expected: 'health_topic_question',
    why: 'the frame boundary, and the pre-existing decision for bare coverage questions',
  },
  {
    message: 'is illness covered?',
    expected: 'health_topic_question',
    why: 'a pinned 1.13.0 expectation this change must not disturb',
  },
  {
    message: 'do you cover treatment?',
    expected: 'health_data',
    why: 'pinned by the treatment corpus: the bare coverage verb is the medical sense',
  },
  {
    message: 'do you cover prescriptions?',
    expected: 'health_data',
    why: 'pinned by the prescription corpus, same shape',
  },
  {
    message: 'the suicide clause says nothing',
    expected: 'not_health_data',
    why: 'the 1.13.0 statement strip, unchanged by the question rule',
  },
];

describe('Gate road test — contract questions about the policy\u2019s own wording', () => {
  test.each(CONTRACT_QUESTIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'contract question "%s" is answered as a product question (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(CONTRACT_QUESTION_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" still classifies as %s (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(CONTRACT_QUESTION_GUARD.map((c) => [c.message, c.expected, c.why] as const))(
    'guard "%s" classifies as %s (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(CONTRACT_QUESTION_TRADES.map((c) => [c.message, c.expected, c.why] as const))(
    'recorded trade "%s" classifies as %s (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test('the predicate needs all three of opener, frame and no personal framing', () => {
    // Directly on the exported rule, so a relaxation of one requirement shows up
    // here rather than only as a table row changing sides.
    expect(detectContractQuestion('does the policy cover HIV?')).toBe(true);
    // No interrogative opener: a statement about the same wording.
    expect(detectContractQuestion('the policy covers HIV')).toBe(false);
    // No frame: a topic question that is not about the product.
    expect(detectContractQuestion('is HIV curable?')).toBe(false);
    // Frame, but personal.
    expect(detectContractQuestion('does the policy cover my HIV?')).toBe(false);
    // The contract's own possessive does not make a question personal.
    expect(detectContractQuestion('does my policy have a cancer exclusion?')).toBe(true);
    expect(detectContractQuestion("does the policy's cancer exclusion apply?")).toBe(true);
  });

  test('the tables are the measured ones, and the flag reaches every health branch', () => {
    // Pinned counts: the measurement in the header comment. A later change that
    // moves a row without recording the decision fails here.
    // 1.19.0's three-reading audit extended the contract table with the
    // maltreatment compounds (32 + 3) and the topic table with the act-as-subject
    // payout question and the compound's topic questions.
    expect(CONTRACT_QUESTIONS.length).toBe(35);
    expect(CONTRACT_QUESTION_DISCLOSURES.length).toBe(23);
    expect(CONTRACT_QUESTION_GUARD.length).toBe(5);
    expect(CONTRACT_QUESTION_TRADES.length).toBe(10);
    expect(CONTRACT_QUESTION_DISCLOSURES.filter((c) => c.expected !== 'health_data')).toEqual([]);
    // The four branches the flag bypasses, one row each: the `namesCondition`
    // topic branch, the broad context-family patterns, the condition-term list
    // and the context-qualified registry. Each row is silent only because the
    // flag is applied to that branch.
    for (const message of [
      'does the policy cover HIV?',
      'does the policy cover treatment for cancer?',
      'does the policy have a cancer exclusion?',
      'what is the exclusion for self-harm in the policy?',
    ]) {
      expect({ message, silent: detectSensitiveData(message) }).toEqual({ message, silent: null });
    }
  });

  test('the flag does not open a path past the financial or PII gates', () => {
    // It is applied to the health branches only. A contract question carrying
    // an account number or an SSN still records the sensitive category, and the
    // same sentence with a personal pronoun does too (through the health gate).
    expect(
      detectSensitiveData('does the policy cover cancer? my account number is 123456789'),
    ).toBe('financial_account_data');
    expect(detectSensitiveData('does the policy cover cancer? SSN 123-45-6789')).toBe('pii');
    expect(detectSensitiveData('does the policy cover cancer? my SSN is 123-45-6789')).toBe(
      'health_data',
    );
  });
});

/**
 * The lay word "bug" — the deferral the registry machinery later closed.
 *
 * The 2026-09-19 lay-word measurement graded six candidates and deferred four;
 * `bug`'s recorded reason had two halves: half its medical phrasings ("I caught
 * a bug") need verbs the shared disclosure lists do not carry, and its ordinary
 * sense ("a bug in the app") is the product's own vocabulary. The registry has
 * since grown per-entry `disclosureWords` / `clinicalWords` and the two-sided
 * guard, so the row was re-measured and this time the measurement separated
 * completely — 10 of 10 medical phrasings matched, 0 of 12 ordinary sentences
 * leaked — and the entry shipped. The ledger row is retired; this corpus is
 * what keeps the closure honest, in the same two-directional shape as `piles`,
 * `lump`, `stones`, `rash` and `pain`.
 *
 * The shapes, and the ledger reason each one answers:
 *
 *   illness verbs       caught / picked up / shaking off / getting over /
 *                       coming down with — declared per entry, because adding
 *                       them to the shared list would let "I found stones for
 *                       the patio" gate; this is the half of the reason the
 *                       shared lists could not solve
 *   going around        the epidemic frame, in both directions
 *   qualifiers          stomach / tummy / flu / vomiting / diarrhea — the
 *                       compound nouns the illness is named with
 *   clinical words      sick / fever / contagious / vomiting / symptoms
 *   the guard           the software frame ("a bug in the app", "bug
 *                       report/fix/tracker", "bug bounty") and the pest frame
 *                       ("bug spray", "bug zapper", "bug net",
 *                       "bug-resistant") excluded by shape rather than by a
 *                       list of noun senses; the lookbehind excludes the
 *                       compounds that hide the word ("debugging", "bed bug")
 *
 * The three rows the ledger still carries — `fit`, `mole`, `cold` — were
 * re-measured with the same machinery and still fail it: `fit` gates "I want
 * to get fit", `mole` gates "we have moles in the garden", and `cold` gates
 * "the case has gone cold" while missing "I have a cold". Their ledger reasons
 * stand, now with the re-measurement behind them.
 */
describe('Gate road test — the lay word "bug"', () => {
  test.each(BUG_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test('the source-frame collision is a recorded trade, not a separated sense', () => {
    // The one shape the measurement could NOT separate: the illness and the
    // software readings share "<verb> a bug from X" — "I caught a bug from my
    // kids" is a disclosure, "we picked up a bug from the third-party library"
    // is not — and telling them apart would mean classifying X, which is the
    // open-list shape the ledger deferred. The trade fails safe: an extra
    // handoff of a software sentence, never a silent pass-through of an
    // illness. Asserted so that narrowing it later means updating the record.
    expect({
      message: 'we picked up a bug from the third-party library',
      actual: classify('we picked up a bug from the third-party library'),
    }).toEqual({
      message: 'we picked up a bug from the third-party library',
      actual: 'health_data',
    });
    // The medical reading of the same frame must gate — that is the direction
    // the trade protects.
    expect({
      message: 'I caught a bug from my kids',
      actual: classify('I caught a bug from my kids'),
    }).toEqual({ message: 'I caught a bug from my kids', actual: 'health_data' });
  });

  test.each(BUG_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" stays unclassified (%s)',
    (message, expected, why) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test('the question path treats the word the same way in both directions', () => {
    // A question naming the illness compound reaches the topic path — the same
    // classification "Is piles curable?" gets, an impersonal question about a
    // condition — while the software question stays silent, because the guard
    // is part of the named token too.
    expect(classify('Is the stomach bug contagious?')).toBe('health_topic_question');
    expect(classify('Is there a bug in the app?')).toBe('not_health_data');
  });

  test('the corpus covers every frame family the guard excludes', () => {
    // The guard has two frame families and a compound lookbehind; each must be
    // represented, or a removed alternative would fail nothing here.
    const shapes = BUG_COLLISIONS.map((c) => c.message.toLowerCase());
    for (const phrase of ['bug in the app', 'bug report', 'bug spray', 'bed bug', 'debugging']) {
      expect({ phrase, present: shapes.some((m) => m.includes(phrase)) }).toEqual({
        phrase,
        present: true,
      });
    }
  });

  test('the ledger row is retired: the sweep re-asks three rows, and bug is not one of them', () => {
    // The closure, asserted where the ledger is read: `bug` no longer sits on
    // the deferral ledger, and the file no longer declares it.
    const ledger = readFileSync(
      resolve(__dirname, '../docs/medical-condition-deferred-candidates.txt'),
      'utf8',
    );
    expect(ledger.includes('? bug ::')).toBe(false);
    expect(ledger.includes('? fit ::')).toBe(true);
    expect(ledger.includes('? mole ::')).toBe(true);
    expect(ledger.includes('? cold ::')).toBe(true);
  });
});

const MANIC_COLLISIONS: GateCase[] = [
  {
    message: 'a manic week at work',
    expected: 'not_health_data',
    why: 'the hyperbole compound the 1.16.0 boundary pinned',
  },
  { message: 'manic Monday', expected: 'not_health_data', why: 'the idiom' },
  { message: 'the manic pace of the city', expected: 'not_health_data', why: 'the hyperbole noun' },
  {
    message: 'a manic schedule before launch',
    expected: 'not_health_data',
    why: 'the hyperbole noun',
  },
  {
    message: 'manic laughter filled the room',
    expected: 'not_health_data',
    why: 'the pinned boundary row',
  },
  { message: 'a manic pixie dream girl trope', expected: 'not_health_data', why: 'the trope name' },
  { message: 'Manic Panic is the dye brand', expected: 'not_health_data', why: 'the brand name' },
  {
    message: 'the manic energy of the crowd',
    expected: 'not_health_data',
    why: 'the hyperbole noun',
  },
  {
    message: 'a manic episode of my favorite sitcom',
    expected: 'not_health_data',
    why: 'the television sense — the strip that forced the plain term out of the gate list',
  },
  {
    message: 'he got manic at the party',
    expected: 'not_health_data',
    why: 'the hyperbolic verb, excluded by the preceding guard',
  },
  {
    message: 'the crowd went completely manic',
    expected: 'not_health_data',
    why: 'the same verb family, with an adverb between',
  },
  {
    message: 'my manic Monday',
    expected: 'not_health_data',
    why: 'a possessive must not resurrect a stripped compound',
  },
];

const MANIC_DISCLOSURES: GateCase[] = [
  { message: 'I am manic', expected: 'health_data', why: 'the pinned hole this entry closes' },
  { message: "I'm manic", expected: 'health_data', why: 'the contracted copula' },
  { message: 'I feel manic lately', expected: 'health_data', why: 'the feeling frame' },
  { message: "I've been feeling manic", expected: 'health_data', why: 'the progressive form' },
  {
    message: 'I am manic before deadlines',
    expected: 'health_data',
    why: 'the first-person state with a trigger',
  },
  {
    message: 'I am not manic',
    expected: 'health_data',
    why: 'the registry-wide negation shape, same as the piles corpus',
  },
  {
    message: 'my manic episodes are back',
    expected: 'health_data',
    why: 'possessive plus clinical noun',
  },
  {
    message: 'I have a history of manic episodes',
    expected: 'health_data',
    why: 'history framing',
  },
  {
    message: 'diagnosed with manic depression',
    expected: 'health_data',
    why: 'the codebook wording',
  },
  { message: 'treated for manic depression', expected: 'health_data', why: 'treatment framing' },
  { message: 'suffering from manic episodes', expected: 'health_data', why: 'suffer framing' },
  {
    message: 'a manic episode last month',
    expected: 'health_data',
    why: 'clinical noun after the token',
  },
  {
    message: 'her manic episodes run in the family',
    expected: 'health_data',
    why: 'family framing',
  },
];

describe('Gate road test — the lay adjective "manic"', () => {
  test.each(MANIC_DISCLOSURES.map((c) => [c.message, c.why] as const))(
    'disclosure "%s" classifies as health_data (%s)',
    (message, why) => {
      expect({ message, actual: classify(message) }).toEqual({
        message,
        actual: 'health_data',
      });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(MANIC_COLLISIONS.map((c) => [c.message, c.why] as const))(
    'collision "%s" stays unclassified (%s)',
    (message, why) => {
      expect({ message, actual: classify(message) }).toEqual({
        message,
        actual: 'not_health_data',
      });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test('the question path answers the compound and stays silent on the bare adjective', () => {
    // "Is manic depression treatable?" is a question about a condition and
    // reaches the topic path; "Is he manic?" is a third-person question about a
    // person's state and takes the same answer path — the entry names the
    // spelling for the question path with the TV strip protecting it there.
    expect(classify('Is manic depression treatable?')).toBe('health_topic_question');
    expect(classify('Is a manic episode dangerous?')).toBe('health_topic_question');
  });

  test('the 1.16.0 boundary is retired: the pinned hole gates and the compound stays clear', () => {
    // The retirement, asserted where the old record was: the same sentence the
    // boundary test pinned silent now gates, while its hyperbole counterparts
    // stay exactly where they were.
    expect(classify('I am manic')).toBe('health_data');
    expect(classify('a manic week at work')).toBe('not_health_data');
    expect(classify('manic laughter filled the room')).toBe('not_health_data');
  });
});

describe('Gate road test — the topic-mention sense of the self-harm vocabulary', () => {
  // The measurement this closure pins: `self[-\\s]?harm` was already declared as
  // a topic term by 1.14.0 and separates both directions on its own, but the
  // suicide and overdose words sat outside TOPIC_MENTION_TERMS — a documentary
  // about suicide gated 10 of 11 topical forms. The stems join the same list,
  // and the personal guards are what keep every disclosure row below gating.
  const TOPIC = [
    { message: 'the documentary is about suicide', why: 'the subject shape, suicide stem' },
    { message: 'a documentary about suicide', why: 'article + subject shape' },
    { message: 'the film examines self-harm', why: 'already separated by the 1.14.0 term' },
    { message: 'the film examines self harm', why: 'the spaced spelling, same term' },
    {
      message: 'the podcast discusses suicide prevention',
      why: 'the compound named inside the frame',
    },
    { message: 'the book covers suicide bereavement', why: 'the compound inside the frame' },
    { message: 'the study examines suicide among teenagers', why: 'modified topic noun' },
    { message: 'the documentary about self-harm won an award', why: 'already separated' },
    {
      message: 'a film about suicide and its impact on families',
      why: 'topic noun before a modifier',
    },
    { message: 'the news covers suicide prevention programs', why: 'subject + verb + compound' },
    {
      message: 'the suicide prevention campaign launches next week',
      why: 'the artefact compound, unpossessed',
    },
    {
      message: 'our self-harm awareness training is next month',
      why: 'already separated; our is an organisation',
    },
    {
      message: 'the overdose awareness campaign starts Monday',
      why: 'the overdose stem joins the same shapes',
    },
    {
      message: 'the news covers overdose prevention programs',
      why: 'overdose inside the subject frame',
    },
    { message: 'a study about self-poisoning trends', why: 'the self-poison stem, hyphenated' },
    { message: 'the documentary examines self-mutilation cases', why: 'the self-mutilation stem' },
    {
      message: 'a podcast about parasuicide research',
      why: 'the suicid stem reaching parasuicide',
    },
    {
      message: 'the documentary is about the overdose crisis',
      why: 'overdose inside the subject shape',
    },
    {
      message: 'suicide statistics were published today',
      why: 'the compound shape, as child abuse statistics already is',
    },
    {
      message: 'the suicide prevention hotline is 24/7',
      why: 'the artefact strip — the reach-guard keeps “I called …” gated',
    },
  ];

  const DISCLOSURES = [
    { message: 'I have thought about suicide', why: 'first-person statement, unstripped' },
    { message: 'my suicide attempt was three years ago', why: 'possessive history' },
    { message: 'I have a history of self-harm', why: 'the row wording, both spellings' },
    {
      message: 'I have a history of self-mutilation',
      why: 'the hyphenated row wording, now declared',
    },
    { message: 'history of self-injury', why: 'the hyphenated row wording, now declared' },
    { message: 'I was hospitalized after an overdose', why: 'first-person event' },
    { message: 'my overdose was a wake-up call', why: 'possessive event' },
    { message: 'I survived an overdose last year', why: 'first-person event' },
    { message: 'I have a history of parasuicide', why: 'the row wording' },
    { message: 'the suicide attempt I survived changed me', why: 'relative clause, first person' },
    { message: 'my self-harm scars are old', why: 'possessive body' },
    { message: 'I struggled with self-harm for years', why: 'first-person disclosure' },
    { message: 'after my suicide attempt I got help', why: 'possessive history' },
    { message: 'I was treated after self-poisoning', why: 'first-person event' },
    {
      message: 'a book about my suicide attempt helped me heal',
      why: 'possessive inside a topic frame',
    },
    {
      message: 'my suicide prevention plan is working',
      why: 'personal compound — the lookbehind keeps it',
    },
    { message: 'my overdose prevention plan', why: 'personal compound, overdose stem' },
    {
      message: 'the suicide prevention plan I built with my doctor',
      why: 'relative clause, first person',
    },
    {
      message: 'I called the suicide prevention hotline',
      why: 'a person reaching for help — the reach-guard’s fail-safe direction',
    },
  ];

  test.each(TOPIC.map((c) => [c.message, c.why] as const))(
    'topic "%s" stays unclassified (%s)',
    (message, why) => {
      expect({ message, actual: classify(message) }).toEqual({
        message,
        actual: 'not_health_data',
      });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test.each(DISCLOSURES.map((c) => [c.message, c.why] as const))(
    'disclosure "%s" classifies as health_data (%s)',
    (message, why) => {
      expect({ message, actual: classify(message) }).toEqual({
        message,
        actual: 'health_data',
      });
      expect(why.length).toBeGreaterThan(0);
    },
  );

  test('the corpus is the measured one', () => {
    expect(TOPIC.length).toBe(20);
    expect(DISCLOSURES.length).toBe(19);
  });

  test('the shapes no rule separates are asserted, not implied', () => {
    // The statistics boundary stays outside the artefact list, and the
    // product-provision possessive ("my suicide exclusion") stays silent by
    // the recorded provision-strip decision. Pinning them keeps the next
    // widening from silently re-deciding them.
    expect(classify('the suicide exclusion in my policy')).toBe('not_health_data');
    expect(classify('my suicide exclusion')).toBe('not_health_data');
  });

  test('the question path treats the stems the same way in both directions', () => {
    // An impersonal question naming the compound takes the health-topic path,
    // the way "Is TB curable?" does; the personally-framed form gates.
    expect(classify('Is suicide preventable?')).toBe('health_topic_question');
    expect(classify('have you thought about suicide?')).toBe('health_data');
  });
});

/**
 * The ICD-10 Chapter VI sweep (1.17.0) — G00–G99, diseases of the nervous
 * system. The chapter is the vocabulary's oldest strength (MS, migraine,
 * epilepsy, ALS arrived from carrier sources) and its largest blind spot of
 * the same kind: the peripheral-nerve and muscle rows never appeared on a
 * questionnaire, so seventeen of the fifty candidates were silent. The named
 * diagnoses are canonical rows now; the organ and residual constructs gate
 * descriptively.
 *
 * The boundary corpus pins both directions of the two new wordings whose
 * ordinary life is bigger than the diagnosis:
 *
 * - `muscle disorder` / `disorders of muscle` gate the G71 category and its
 *   person's wording, but every ordinary "muscle" sentence — the gym, the
 *   boxes, the stretch — stays silent, because none of them carries the word
 *   "disorder".
 * - `demyelinat` watches the demyelinating family without watching
 *   `sclerosis`, which sits inside "atherosclerosis" (watched on its own stem)
 *   and "multiple sclerosis" (mapped on its own row).
 */
const CHAPTER_VI_DISCLOSURES: readonly { message: string; expected: string; why: string }[] = [
  { message: 'I have dystonia', expected: 'health_data', why: 'G24.9, mapped' },
  {
    message: 'I was diagnosed with hemiplegia after my stroke',
    expected: 'health_data',
    why: 'G81.90, mapped',
  },
  {
    message: 'my hemiparesis has been improving',
    expected: 'health_data',
    why: 'the weakness family beside hemiplegia',
  },
  {
    message: 'I have a muscle disorder',
    expected: 'health_data',
    why: 'the person wording of G71.9',
  },
  {
    message: 'primary disorders of muscles run in my family',
    expected: 'health_data',
    why: 'the G71 category title',
  },
  { message: 'I have myopathy', expected: 'health_data', why: 'G72.9, mapped' },
  { message: 'I have trigeminal neuralgia', expected: 'health_data', why: 'G50.0, mapped' },
  { message: 'I have tic douloureux', expected: 'health_data', why: 'the French alias of G50.0' },
  {
    message: 'I was treated for toxic encephalopathy',
    expected: 'health_data',
    why: 'G92.9, mapped',
  },
  {
    message: 'I have a brain disorder',
    expected: 'health_data',
    why: 'the person wording of G93.9',
  },
  { message: 'I have a spinal cord disease', expected: 'health_data', why: 'G95.9, mapped' },
  { message: 'I have a nervous system disorder', expected: 'health_data', why: 'G98, mapped' },
  { message: 'I have spinal muscular atrophy', expected: 'health_data', why: 'G12.9, mapped' },
  {
    message: 'a demyelinating disease was ruled out',
    expected: 'health_data',
    why: 'the G35–G37 family, watched without sclerosis',
  },
  {
    message: 'the movement disorder started last year',
    expected: 'health_data',
    why: 'the G20–G26 category',
  },
];

const CHAPTER_VI_COLLISIONS: readonly { message: string; expected: string; why: string }[] = [
  {
    message: 'he pulled a muscle at the gym',
    expected: 'not_health_data',
    why: 'no disorder word — the G71 stems must not catch the gym',
  },
  {
    message: 'I pulled a muscle moving boxes',
    expected: 'not_health_data',
    why: 'same, first person',
  },
  {
    message: 'the muscle soreness after leg day',
    expected: 'not_health_data',
    why: 'soreness is not a muscle disorder',
  },
  {
    message: 'stretch every muscle before you run',
    expected: 'not_health_data',
    why: 'the anatomy, not the category',
  },
  {
    message: 'their muscles ached after the hike',
    expected: 'not_health_data',
    why: 'plural anatomy, still no disorder',
  },
  {
    message: 'atherosclerosis runs in my family',
    expected: 'health_data',
    why: 'gated by the atheroscler stem, not by sclerosis',
  },
  {
    message: 'I have multiple sclerosis',
    expected: 'health_data',
    why: 'the G35 row, reached by its own alias',
  },
  {
    message: 'the central nervous system controls movement',
    expected: 'health_data',
    why: 'the pre-existing trade: the CNS/ANS compounds were watched before this sweep',
  },
];

describe('Gate road test — the ICD-10 Chapter VI sweep', () => {
  test.each(CHAPTER_VI_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(CHAPTER_VI_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );
});

/**
 * The ICD-10 Chapter X sweep (1.19.0) — J00-J99, diseases of the respiratory
 * system. The chapter's strong block (asthma, COPD, pneumonia, OSA, sinusitis,
 * sarcoidosis) arrived from the carrier sources long ago; its blind spot sat
 * exactly where Chapter XXI's exposure row pointed: the occupational-lung
 * diagnoses that follow asbestos were silent. The named diagnoses are canonical
 * rows now; the headers and descriptive residuals gate without codes.
 *
 * The boundary corpus pins both directions of the wordings whose ordinary life
 * is bigger than the diagnosis:
 *
 * - `flu` is a word token because its letters sit inside "influenza" and
 *   "fluid"; `ards` for the same reason ("standards"). The full word
 *   "influenza" rides its own substring stem.
 * - "cold" is deliberately unwatched — the deferred "cold" row records why —
 *   so the J00 row is reached by "common cold" and "head cold" instead.
 * - "coal worker"/"coalworker" gate the J60 family, not bare "coal": mining
 *   life is a job, not a diagnosis.
 * - "pleural plaque" gates without a code: J92.9 is the negative member of the
 *   asbestos split, and coding bare wording would misstate the exposure.
 */
const CHAPTER_X_DISCLOSURES: readonly { message: string; expected: string; why: string }[] = [
  { message: 'I have asbestosis', expected: 'health_data', why: 'J61, mapped' },
  { message: 'I have silicosis', expected: 'health_data', why: 'J62.8, mapped' },
  { message: 'I was diagnosed with black lung disease', expected: 'health_data', why: 'J60, mapped' },
  { message: 'I worked in the mines and got coal workers pneumoconiosis', expected: 'health_data', why: 'J60, mapped' },
  { message: 'I have berylliosis', expected: 'health_data', why: 'J63.2, mapped' },
  { message: 'I was diagnosed with byssinosis', expected: 'health_data', why: 'J66.0, mapped' },
  { message: 'I have farmers lung', expected: 'health_data', why: 'J67.0, mapped' },
  { message: 'I keep pigeons and was diagnosed with bird fanciers lung', expected: 'health_data', why: 'J67.2, mapped' },
  { message: 'my hypersensitivity pneumonitis is worsening', expected: 'health_data', why: 'J67.9, mapped' },
  { message: 'I was exposed to asbestos', expected: 'health_data', why: 'the Z77 exposure row, watched since Chapter XXI' },
  { message: 'I have the flu', expected: 'health_data', why: 'J11.1, mapped' },
  { message: 'I have influenza', expected: 'health_data', why: 'the full word stem' },
  { message: 'my influenza A test came back positive', expected: 'health_data', why: 'J10.1, mapped' },
  { message: 'I have a common cold', expected: 'health_data', why: 'J00, mapped' },
  { message: 'I have a head cold', expected: 'health_data', why: 'J00, mapped' },
  { message: 'I have strep throat', expected: 'health_data', why: 'J02.0, mapped' },
  { message: 'I have a sore throat', expected: 'health_data', why: 'J02.9, mapped' },
  { message: 'I was diagnosed with an upper respiratory infection', expected: 'health_data', why: 'J06.9, mapped' },
  { message: 'my baby has bronchiolitis', expected: 'health_data', why: 'J21.9, mapped' },
  { message: 'I had croup as a child', expected: 'health_data', why: 'J05.0, mapped' },
  { message: 'my son has croup', expected: 'health_data', why: 'J05.0, mapped' },
  { message: 'I had acute tracheitis last winter', expected: 'health_data', why: 'J04.9, mapped' },
  { message: 'I get laryngitis every winter', expected: 'health_data', why: 'J04.9, mapped' },
  { message: 'I had a peritonsillar abscess', expected: 'health_data', why: 'J36, mapped' },
  { message: 'I have vocal cord paralysis', expected: 'health_data', why: 'J38.00, mapped' },
  { message: 'I have chronic tonsillitis', expected: 'health_data', why: 'J35.9, mapped' },
  { message: 'I have acute respiratory distress syndrome', expected: 'health_data', why: 'J80, mapped' },
  { message: 'I have pleural effusion', expected: 'health_data', why: 'J90, mapped' },
  { message: 'I have water on the lung', expected: 'health_data', why: 'J90, mapped' },
  { message: 'I went into respiratory failure', expected: 'health_data', why: 'J96.90, mapped' },
  { message: 'I have pleural plaque', expected: 'health_data', why: 'gated without a code — the J92 exposure split must not be misstated' },
];

const CHAPTER_X_COLLISIONS: readonly { message: string; expected: string; why: string }[] = [
  {
    message: 'the new safety standards apply from January',
    expected: 'not_health_data',
    why: 'ards is word-matched so "standards" is not caught',
  },
  {
    message: 'the fluid reservation was cancelled',
    expected: 'not_health_data',
    why: 'flu is word-matched so "fluid" is not caught',
  },
  {
    message: 'I have a cold',
    expected: 'not_health_data',
    why: 'the deferred cold row: bare "cold" stays unwatched — "common cold" is the mapped wording',
  },
  {
    message: 'the office is cold in winter',
    expected: 'not_health_data',
    why: 'the temperature sense, same deferral',
  },
  {
    message: 'my brother works in the coal industry',
    expected: 'not_health_data',
    why: 'the job, not the diagnosis — coal worker gates the compound only',
  },
  {
    message: 'we sell coal and timber',
    expected: 'not_health_data',
    why: 'bare coal is commerce, not J60',
  },
  {
    message: 'the flu shot clinic opens Monday',
    expected: 'health_data',
    why: 'accepted trade: flu in a health context gates even in a service announcement',
  },
];

describe('Gate road test — the ICD-10 Chapter X sweep', () => {
  test.each(CHAPTER_X_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(CHAPTER_X_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );
});

/**
 * The ICD-10 Chapter XI sweep (1.20.0) - K00-K95, diseases of the digestive
 * system. The chapter's centre (IBS, GERD, gastritis, cirrhosis, pancreatitis,
 * Crohn's, colitis, diverticular disease, gallstones, hernia, hemorrhoids)
 * arrived from the carrier sources long ago; 1.20.0 mapped its named edges:
 * the appendiceal rows, dyspepsia, peritonitis, fatty liver, the salivary and
 * oral rows, the anorectal and obstruction rows, and malabsorption.
 *
 * The boundary corpus pins the deliberate anatomy choices:
 *
 * - bare `appendix` stays unwatched - a policy document's appendix is an
 *   ordinary sense, so the K38 residual closes through its category-title
 *   stems (`diseases of appendix`, `disease of appendix`) instead.
 * - bare `liver` stays unwatched - `fatty liver` and `hepatic` carry the
 *   diagnoses; the organ in isolation is education, not disclosure.
 * - `pancreatic` is the gated adjective; the noun `pancreas` in an
 *   educational sentence is not a disclosure.
 */
const CHAPTER_XI_DISCLOSURES: readonly { message: string; expected: string; why: string }[] = [
  { message: 'I have appendicitis', expected: 'health_data', why: 'K37, mapped - the codebook unspecified home of the bare word' },
  { message: 'I was diagnosed with acute appendicitis', expected: 'health_data', why: 'K35.80, mapped' },
  { message: 'I have chronic appendicitis', expected: 'health_data', why: 'K36, mapped' },
  { message: 'I get indigestion after every meal', expected: 'health_data', why: 'K30, mapped' },
  { message: 'I have dyspepsia', expected: 'health_data', why: 'K30, mapped' },
  { message: 'I had peritonitis', expected: 'health_data', why: 'K65.9, mapped' },
  { message: 'I have fatty liver disease', expected: 'health_data', why: 'K76.0, mapped' },
  { message: 'my hepatic steatosis was found on a scan', expected: 'health_data', why: 'K76.0, mapped' },
  { message: 'I have salivary gland disease', expected: 'health_data', why: 'K11.9, mapped' },
  { message: 'I get canker sores every month', expected: 'health_data', why: 'K12.0, mapped' },
  { message: 'I have a mouth ulcer', expected: 'health_data', why: 'K12.0, mapped' },
  { message: 'I was diagnosed with leukoplakia', expected: 'health_data', why: 'K13.21, mapped' },
  { message: 'I have rectal prolapse', expected: 'health_data', why: 'K62.3, mapped' },
  { message: 'I have biliary disease', expected: 'health_data', why: 'K83.9, mapped' },
  { message: 'I have pancreatic disease', expected: 'health_data', why: 'K86.9, mapped' },
  { message: 'I was diagnosed with disease of tongue', expected: 'health_data', why: 'K14.9, mapped' },
  { message: 'I have an anorectal ulcer', expected: 'health_data', why: 'K62.6, mapped' },
  { message: 'I had paralytic ileus after surgery', expected: 'health_data', why: 'K56.0, mapped' },
  { message: 'I have an ileus', expected: 'health_data', why: 'K56.7, mapped' },
  { message: 'I have malabsorption', expected: 'health_data', why: 'K90.9, mapped' },
];

const CHAPTER_XI_COLLISIONS: readonly { message: string; expected: string; why: string }[] = [
  {
    message: 'the data tables are in the report appendix',
    expected: 'not_health_data',
    why: 'bare appendix is a document part - the K38 residual closes through its category-title stems',
  },
  {
    message: 'the policy appendix lists the exclusions',
    expected: 'not_health_data',
    why: 'same document sense',
  },
  {
    message: 'the pancreas is part of the digestive tract',
    expected: 'not_health_data',
    why: 'educational anatomy - pancreatic is the gated adjective, the bare noun in an educational sentence is not a disclosure',
  },
  {
    message: 'the liver filters your blood',
    expected: 'not_health_data',
    why: 'bare liver stays unwatched - fatty liver and hepatic carry the diagnoses',
  },
];

describe('Gate road test - the ICD-10 Chapter XI sweep', () => {
  test.each(CHAPTER_XI_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(CHAPTER_XI_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );
});

/**
 * The ICD-10 Chapter XII sweep (1.21.0) - L00-L99, diseases of the skin and
 * subcutaneous tissue. The chapter's centre (atopic dermatitis, eczema,
 * psoriasis, urticaria, rosacea, acne, vitiligo, alopecia areata, melanoma,
 * the non-melanoma skin cancers) arrived from the carrier sources long ago;
 * 1.21.0 mapped its named edges: the bullous disorders, the erythemas, the
 * hair and pigmentation rows, and the autoimmune-skin rarities.
 *
 * The boundary corpus pins the deliberate ordinary-sense trades:
 *
 * - bare `pigmentation` stays unwatched - the cosmetics sense is as ordinary
 *   as the medical one, so the L81 residual closes through "disorders of
 *   pigmentation" instead.
 * - bare `corns` stays unwatched - the food sense ("corns and grits") is the
 *   same recorded trade as bare "coal"; "callosities" carries the L84 title.
 * - bare `exfoliation` stays unwatched - the skincare sense is the word's
 *   ordinary life; the L49 title closes through "exfoliation due to".
 * - `sunburn` gates - the word's ordinary sense is the medical one, the same
 *   direction as `hives`.
 */
const CHAPTER_XII_DISCLOSURES: readonly { message: string; expected: string; why: string }[] = [
  { message: 'my baby was diagnosed with staphylococcal scalded skin syndrome', expected: 'health_data', why: 'L00, mapped' },
  { message: 'I have SSSS', expected: 'health_data', why: 'L00, mapped - the acronym, word-matched' },
  { message: 'my son has impetigo', expected: 'health_data', why: 'L01.00, mapped' },
  { message: 'I have pemphigus', expected: 'health_data', why: 'L10.9, mapped' },
  { message: 'I was diagnosed with pemphigoid', expected: 'health_data', why: 'L12.9, mapped' },
  { message: 'I have lichen simplex chronicus', expected: 'health_data', why: 'L28.0, mapped' },
  { message: 'my neurodermatitis is flaring', expected: 'health_data', why: 'L28.0, mapped' },
  { message: 'I have pityriasis rosea', expected: 'health_data', why: 'L42, mapped' },
  { message: 'I have erythema multiforme', expected: 'health_data', why: 'L51.9, mapped' },
  { message: 'I was diagnosed with erythema nodosum', expected: 'health_data', why: 'L52, mapped' },
  { message: 'I have a bad sunburn', expected: 'health_data', why: 'L55.9, mapped' },
  { message: 'I was diagnosed with hypertrichosis', expected: 'health_data', why: 'L68.9, mapped' },
  { message: 'I have excessive hair growth on my face', expected: 'health_data', why: 'L68.9, mapped' },
  { message: 'I have acanthosis nigricans', expected: 'health_data', why: 'L83, mapped' },
  { message: 'I have pyoderma gangrenosum', expected: 'health_data', why: 'L88, mapped' },
  { message: 'I have lichen sclerosus', expected: 'health_data', why: 'L90.0, mapped' },
  { message: 'I have a pilonidal cyst', expected: 'health_data', why: 'L05 - gated without a code, the split is not carried by the bare words' },
  { message: 'my pruritus keeps me up at night', expected: 'health_data', why: 'L29, gated descriptive' },
];

const CHAPTER_XII_COLLISIONS: readonly { message: string; expected: string; why: string }[] = [
  {
    message: 'this serum is for pigmentation correction',
    expected: 'not_health_data',
    why: 'bare pigmentation is cosmetics - the L81 residual closes through its category-title wording',
  },
  {
    message: 'we grilled corns and peppers',
    expected: 'not_health_data',
    why: 'bare corns is food - the same recorded trade as bare coal',
  },
  {
    message: 'the exfoliation step comes after cleansing',
    expected: 'not_health_data',
    why: 'bare exfoliation is skincare - the L49 title closes through "exfoliation due to"',
  },
  {
    message: 'the hair shaft is dead keratin',
    expected: 'health_data',
    why: 'accepted trade: hair shaft in a health context gates even in an educational sentence',
  },
];

describe('Gate road test - the ICD-10 Chapter XII sweep', () => {
  test.each(CHAPTER_XII_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(CHAPTER_XII_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );
});

/**
 * The ICD-10 Chapter XIII sweep (1.22.0) - M00-M99, diseases of the
 * musculoskeletal system and connective tissue. The chapter's centre (gout,
 * rheumatoid arthritis, SLE, psoriatic arthritis, ankylosing spondylitis,
 * scleroderma, fibromyalgia, osteoarthritis, osteoporosis, scoliosis, disc
 * disorders, spinal stenosis, sciatica, carpal tunnel, Ehlers-Danlos, Marfan)
 * arrived from the carrier sources long ago; 1.22.0 mapped its named edges:
 * the vasculitides, the myositides, the shoulder and bone residuals.
 *
 * The boundary corpus pins the deliberate ordinary-sense trades:
 *
 * - bare `joints` and bare `spine` stay unwatched - the educational anatomy
 *   sense is ordinary, exactly as bare `liver` and bare `pancreas`.
 * - bare `fracture` stays unwatched - a broken bone from injury is the S
 *   chapter; `stress fracture` carries the M84 wording instead.
 * - `connective tissue` gates only inside "connective tissue disease" - the
 *   biology-classroom noun phrase is ordinary.
 * - `paget` gates - the surname has no competing ordinary sense, and the bare
 *   stem is what lets "Paget's disease" resolve.
 */
const CHAPTER_XIII_DISCLOSURES: readonly { message: string; expected: string; why: string }[] = [
  { message: 'I have osteomalacia', expected: 'health_data', why: 'M83.9, mapped' },
  { message: 'I have polymyalgia rheumatica', expected: 'health_data', why: 'M35.3, mapped' },
  { message: 'I have a stress fracture in my foot', expected: 'health_data', why: 'M84.9, mapped - bare fracture stays unwatched' },
  { message: 'myositis runs in our family', expected: 'health_data', why: 'M60.9, mapped' },
  { message: 'I was diagnosed with polyarteritis nodosa', expected: 'health_data', why: 'M30.0, mapped' },
  { message: 'I have giant cell arteritis', expected: 'health_data', why: 'M31.6, mapped' },
  { message: 'my frozen shoulder is back', expected: 'health_data', why: 'M75.00, carried from the carrier sources' },
  { message: 'I have Dupuytren contracture', expected: 'health_data', why: 'M72.0, mapped' },
  { message: 'I have osteonecrosis', expected: 'health_data', why: 'M87.9, mapped' },
  { message: 'I have Paget disease of bone', expected: 'health_data', why: 'M88.9, mapped' },
  { message: 'I have temporal arteritis', expected: 'health_data', why: 'M31.6, mapped' },
  { message: 'I have a heel spur', expected: 'health_data', why: 'M77.30, mapped' },
];

const CHAPTER_XIII_COLLISIONS: readonly { message: string; expected: string; why: string }[] = [
  {
    message: 'the spine of the report lists the exhibits',
    expected: 'not_health_data',
    why: 'bare spine is the book sense - the dorsopathy titles close through their own wordings',
  },
  {
    message: 'a biomechanical analysis of the golf swing',
    expected: 'not_health_data',
    why: 'biomechanical alone is engineering - the M99 residual closes through biomechanical lesion',
  },
  {
    message: 'collagen supports the connective tissue',
    expected: 'not_health_data',
    why: 'connective tissue alone is biology-classroom - connective tissue disease is the gate phrase',
  },
  {
    message: 'the joint venture closed last week',
    expected: 'not_health_data',
    why: 'bare joints stay unwatched for their ordinary senses',
  },
  {
    message: 'myalgia after the workout',
    expected: 'not_health_data',
    why: 'bare myalgia is the ordinary post-exercise ache - polymyalgia is the gated stem',
  },
];

describe('Gate road test - the ICD-10 Chapter XIII sweep', () => {
  test.each(CHAPTER_XIII_DISCLOSURES.map((c) => [c.message, c.expected, c.why] as const))(
    'disclosure "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );

  test.each(CHAPTER_XIII_COLLISIONS.map((c) => [c.message, c.expected, c.why] as const))(
    'collision "%s" classifies as %s (%s)',
    (message, expected) => {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: expected });
    },
  );
});
