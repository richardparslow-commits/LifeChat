/**
 * The contract register — a policy document's voice, measured against the gate.
 *
 * The gate was grown from a *disclosure* register: sentences a person types about
 * their own health. The contract register is the other voice that mentions the
 * same words — a policy document describing its own clauses — and it had never
 * been measured as a register. This suite is that measurement, pinned.
 *
 * What it records, over 103 realistic policy-document sentences in eight
 * registers (exclusions, waiting periods, riders and provisions, benefit
 * schedules, definitions, application and underwriting, claims, general
 * conditions):
 *
 *   - **65 are classified `health_data`** and would hand a policy document's own
 *     wording off to a licensed broker as a health disclosure. None is a health
 *     *topic* question — the register is written in statements, which is exactly
 *     why the contract-question rule does not reach it;
 *   - **38 are already silent**, and they are the evidence of which rules
 *     generalise: the suicide provision strip, the `terminal illness` /
 *     `critical illness` product carve-outs, and the narrowing already applied to
 *     `treatment`, `diagnosis` and `condition`;
 *   - the shipped gate is asserted not to have opened a single disclosure — the
 *     fifteen controls in the fixture are all still gated;
 *   - and the candidate closure the next change would need is measured here
 *     rather than proposed in prose (see the last describe).
 *
 * The fixture's `expected` is what the gate returns today, not what it should
 * return, so closing any row means updating the record rather than failing it.
 */
import { detectSensitiveData } from '../src/security/security-controls';
import { CONTRACT_REGISTER, REGISTER_CONTROLS } from './fixtures/contract-register';

type Category = 'health_data' | 'health_topic_question' | 'not_health_data';

const classify = (message: string): Category => {
  const category = detectSensitiveData(message);
  if (category === 'health_data' || category === 'health_topic_question') return category;
  return 'not_health_data';
};

/** The measured per-register totals. */
const REGISTER_TOTALS: Record<string, { total: number; health: number; silent: number }> = {
  exclusions: { total: 18, health: 16, silent: 2 },
  'waiting periods': { total: 10, health: 7, silent: 3 },
  'riders and provisions': { total: 10, health: 6, silent: 4 },
  'benefit schedules': { total: 10, health: 6, silent: 4 },
  definitions: { total: 9, health: 9, silent: 0 },
  'application and underwriting': { total: 28, health: 17, silent: 11 },
  claims: { total: 9, health: 3, silent: 6 },
  'general conditions': { total: 9, health: 1, silent: 8 },
};

/**
 * The declared terms, each testable from outside the module, so the *cause* of
 * every false positive is named rather than guessed at.
 */
const CARRIERS: [string, RegExp][] = [
  [
    'named-condition alternation (bare)',
    /(?:blood\s+pressure|cholesterol|diabetes|cancer|depression|anxiety|ptsd)/i,
  ],
  ['condition family', /\bconditions?\b/i],
  ['diagnosis family', /\bdiagnos\w*/i],
  ['illness', /illness/i],
  ['heart family', /\bheart\b/i],
  ['stem suicidal', /suicid/i],
  ['disease family', /\bdiseases?\b/i],
  ['treatment family', /\btreatments?\b|\btreated\b|\btreating\b/i],
  ['stem pregnancy', /pregnan/i],
  ['prescription family', /\bprescriptions?\b/i],
];

/** The measured ranked carrier counts over the 65 health-data rows. */
const CARRIER_COUNTS: Record<string, number> = {
  'named-condition alternation (bare)': 20,
  'condition family': 11,
  'diagnosis family': 10,
  illness: 8,
  'heart family': 7,
  'stem suicidal': 5,
  'disease family': 5,
  'treatment family': 3,
  'stem pregnancy': 3,
  'prescription family': 3,
};

describe('Contract register — the policy-document voice against the gate', () => {
  test.each(CONTRACT_REGISTER.map((r) => [r.register, r.message, r.expected] as const))(
    '[%s] "%s" classifies as %s',
    (register, message, expected) => {
      // The register is carried in the title so a failure names the voice the
      // sentence was written in, not only the sentence.
      expect({ register, actual: classify(message) }).toEqual({ register, actual: expected });
    },
  );

  test('the corpus is the measured one: 103 sentences, 65 health data, no topic questions', () => {
    expect(CONTRACT_REGISTER.length).toBe(103);
    expect(CONTRACT_REGISTER.filter((r) => r.expected === 'health_data').length).toBe(65);
    expect(CONTRACT_REGISTER.filter((r) => r.expected === 'not_health_data').length).toBe(38);
    // Every row's recorded status is what the gate returns, and not one of them
    // takes the topic-question path: this register is written in statements.
    expect(
      CONTRACT_REGISTER.filter((r) => classify(r.message) === 'health_topic_question'),
    ).toEqual([]);
  });

  test('the per-register totals are the measured ones', () => {
    // The distribution is the finding: the registers whose sentences name a
    // document subject are the ones the gate handles worst, and `definitions` —
    // the register that is *only* a contract term plus its meaning — is 9 of 9.
    const measured: Record<string, { total: number; health: number; silent: number }> = {};
    for (const row of CONTRACT_REGISTER) {
      const bucket = measured[row.register] ?? { total: 0, health: 0, silent: 0 };
      bucket.total++;
      if (row.expected === 'health_data') bucket.health++;
      else bucket.silent++;
      measured[row.register] = bucket;
    }
    expect(measured).toEqual(REGISTER_TOTALS);
  });

  test('the ranked carriers name where the work is being done', () => {
    // Not a guess about which pattern fires: each declared term is tested
    // against the rows, and the ranking is the record of what to narrow or
    // qualify first. A rule change that moves these counts has to update them.
    const open = CONTRACT_REGISTER.filter((r) => r.expected === 'health_data');
    const measured: Record<string, number> = {};
    for (const [name, pattern] of CARRIERS) {
      const count = open.filter((row) => pattern.test(row.message)).length;
      if (count > 0) measured[name] = count;
    }
    expect(measured).toEqual(CARRIER_COUNTS);
    // The single highest-yield carrier is the one the topic-question release
    // deliberately left bare: it is unqualified on the measurement that found no
    // ordinary sense for it, and in this register that is 20 of 65 rows.
    expect(CARRIER_COUNTS['named-condition alternation (bare)']).toBe(20);
  });

  test('the measurement found one hole in the other direction, recorded here', () => {
    // The register surfaced a term the vocabulary does **not** watch: the gate
    // carries `self-harm`, `self harm`, `self poisoning`, `self-poisoning`,
    // `self mutilation`, `self injury` and `history of cutting`, but not the
    // `self-inflicted injury` wording — which is the phrasing a policy document
    // uses and a person may echo. All three disclosure forms below are silent
    // today. This is asserted as an open row rather than a trade: the expected
    // status flips to `health_data` the moment the wording is watched, and a
    // change that does it has to move these rows rather than fail quietly.
    const unfixedHole = [
      'I have a self-inflicted injury',
      'history of self-inflicted injury',
      'my self-inflicted injuries',
    ];
    for (const message of unfixedHole) {
      expect({ message, actual: classify(message) }).toEqual({
        message,
        actual: 'not_health_data',
      });
    }
    // The near-miss forms that *are* watched, so the hole is one spelling and
    // not the whole family.
    for (const message of ['I have a history of self-harm', 'history of self injury']) {
      expect({ message, actual: classify(message) }).toEqual({ message, actual: 'health_data' });
    }
  });

  test('the shipped gate has not opened a single disclosure', () => {
    // The register measurement is only meaningful if the features built on it —
    // the contract-question rule, the provision strip, the topic-mention strips,
    // the mention-based exclusion frames — kept every personal sentence gated.
    for (const message of REGISTER_CONTROLS) {
      expect({ message, actual: classify(message) }).toEqual({
        message,
        actual: 'health_data',
      });
    }
    expect(REGISTER_CONTROLS.length).toBe(15);
  });
});

/**
 * The candidate closure, measured rather than proposed.
 *
 * Two mechanical frames cover a large part of the register, and neither is
 * shipped: this is the measurement that would justify shipping them, in the same
 * shape as the collision benches elsewhere in the gate (a rule, its coverage, and
 * the cost of the guard it needs).
 *
 *   definition frame    `[For the purposes of this policy,] 'term' means …` and
 *                       `'term' is defined as …` — 8 of the 9 definition rows;
 *   document-voice      a document subject ("this policy", "the rider", "the
 *   frame               waiting period for …") with a contract verb and **no
 *                       personal framing** — 18 of the remaining 56.
 *
 * Together: 28 of 65 rows closable, 37 left open, and **zero of the fifteen
 * controls spent** — but only *with* the personal-framing guard. Measured
 * without it, the frame closes three real disclosures ("the policy covers my
 * cancer", "does the policy cover my cancer?", "my condition is excluded from
 * the policy"), which is why the guard is asserted here as the frame's
 * precondition rather than as a detail.
 */
describe('Contract register — the measured candidate closure (not shipped)', () => {
  const DEFINITION_FRAME =
    /^\s*(?:for\s+the\s+purposes?\s+of\s+(?:this|the)\s+policy,?\s*)?(?:the\s+definition\s+of\s+)?["'\u2018\u2019]?[a-z][a-z\s-]{2,30}["'\u2018\u2019]?\s+(?:means|is\s+defined\s+as)\b/i;

  const DOCUMENT_SUBJECT =
    /\b(?:this|the|our|any)\s+(?:polic(?:y|ies)|plans?|riders?|schedules?|applications?|contract|coverage|benefits?|insurer|carrier|exclusions?|provisions?|definitions?|waiting\s+periods?|underwriting|claim(?:s|forms?)?|premiums?)\b/i;

  const CONTRACT_VERB =
    /\b(?:excludes?|excluded|excluding|covers?|covered|pays?|payable|paid|applies|apply|begins?|starts?|lists?|names?|requires?|required|must|may|is|are|was|were|includes?|attached|means|defined|waives?|advances?|reviewed|reduced|issued)\b/i;

  /** The module's personal-framing guard, copied here for the measurement. */
  const PERSONAL_FRAMING =
    /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|myself|we|we're|our|ours|us|father|mother|mom|mum|dad|parent|parents|brother|sister|sibling|spouse|wife|husband|partner|son|daughter|child|children|kid|kids|grandfather|grandmother|grandparent)\b/i;

  const closes = (message: string): boolean =>
    DEFINITION_FRAME.test(message) ||
    (DOCUMENT_SUBJECT.test(message) &&
      CONTRACT_VERB.test(message) &&
      !PERSONAL_FRAMING.test(message));

  const open = CONTRACT_REGISTER.filter((r) => r.expected === 'health_data');

  test('the definition frame closes 8 of the 9 definition rows', () => {
    const definitions = open.filter((row) => row.register === 'definitions');
    const closed = definitions.filter((row) => DEFINITION_FRAME.test(row.message));
    expect(definitions.length).toBe(9);
    expect(closed.length).toBe(8);
    // The one it does not reach defines by inclusion rather than by `means`.
    expect(
      definitions.filter((row) => !DEFINITION_FRAME.test(row.message)).map((r) => r.message),
    ).toEqual(["The definition of 'disability' includes mental illness."]);
  });

  test('the document-voice frame closes 19 of the 56 non-definition rows', () => {
    const others = open.filter((row) => row.register !== 'definitions');
    const closed = others.filter((row) => closes(row.message));
    expect(others.length).toBe(56);
    expect(closed.length).toBe(19);
  });

  test('28 of the 65 rows are closable and 37 are not, by two frames alone', () => {
    const closed = open.filter((row) => closes(row.message));
    expect(closed.length).toBe(28);
    expect(open.length - closed.length).toBe(37);
    // What the two frames cannot reach, named by shape rather than listed:
    // a health term as the grammatical *subject* ("Self-harm is excluded from
    // cover."), a table row with no subject at all ("Waiting periods: cancer, 24
    // months; …"), a statement whose only subject is a form or a body measure
    // ("Height and weight are recorded for underwriting purposes."), and the
    // suicide words, where a document-voice rule needs the reflexivity
    // distinction the question rule needed.
    const unreached = open.filter((row) => !closes(row.message));
    const unreachedShapes = {
      healthTermAsSubject: unreached.filter((row) =>
        /^(?:cancer|depression|self[- ]harm|suicide|hiv|mental illness|pregnancy)/i.test(
          row.message,
        ),
      ).length,
      tableRow: unreached.filter((row) => row.message.includes(': ')).length,
      noDocumentSubject: unreached.filter((row) => !DOCUMENT_SUBJECT.test(row.message)).length,
      suicideWords: unreached.filter((row) => /suicid/i.test(row.message)).length,
    };
    expect(unreachedShapes).toEqual({
      healthTermAsSubject: 7,
      tableRow: 2,
      noDocumentSubject: 35,
      suicideWords: 4,
    });
  });

  test('and the frame spends none of the fifteen controls — with the personal guard', () => {
    const spent = REGISTER_CONTROLS.filter((message) => closes(message));
    expect(spent).toEqual([]);
    expect(REGISTER_CONTROLS.length).toBe(15);
  });

  test('without the guard the frame would spend three real disclosures', () => {
    // The measurement that makes the guard a precondition rather than a detail.
    const unguarded = (message: string): boolean =>
      DEFINITION_FRAME.test(message) ||
      (DOCUMENT_SUBJECT.test(message) && CONTRACT_VERB.test(message));
    const spent = REGISTER_CONTROLS.filter((message) => unguarded(message));
    expect(spent).toEqual([
      'the policy covers my cancer',
      'does the policy cover my cancer?',
      'my condition is excluded from the policy',
    ]);
  });
});
