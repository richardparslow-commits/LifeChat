/**
 * The contract register — a policy document's voice, measured against the gate.
 *
 * Every sentence below is written the way a policy document writes: an
 * exclusion, a waiting period, a rider, a benefit schedule row, a definition, an
 * application or underwriting rule, a claim condition, a general condition. They
 * mention health stems on purpose, and the point of the corpus is the register
 * itself rather than any one phrase.
 *
 * 103 sentences in eight registers, and the measured status of each one. The
 * `expected` field is what the gate returns today, not what it should return:
 * this is the record of a measurement, so a change that closes any of these
 * rows has to update the fixture rather than fail quietly. `tests/contract-register.test.ts`
 * asserts every row and the per-register totals.
 */
export interface ContractRegisterRow {
  /** The document register the sentence belongs to. */
  register: string;
  /** What `detectSensitiveData()` returns for it today. */
  expected: 'health_data' | 'not_health_data';
  message: string;
  /** What the sentence is, in the document's own terms. */
  kind?: string;
}

export const CONTRACT_REGISTER: ContractRegisterRow[] = [
  // ── exclusions: 18 sentences, 16 of them health data ───────────────────────
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'This policy excludes cancer diagnosed within the first two years.',
    kind: 'clause with a document subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'Cancer is excluded unless diagnosed after the waiting period.',
    kind: 'clause with the condition as subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'The cancer exclusion applies for twenty-four months from issue.',
    kind: 'clause naming the exclusion',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'Exclusions include diabetes-related complications.',
    kind: 'list opener with no document subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'The policy does not cover treatment for a pre-existing condition.',
    kind: 'clause with a document subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'Heart conditions diagnosed before the policy date are not covered.',
    kind: 'clause with the condition as subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'No benefit is payable for a suicide within two years.',
    kind: 'benefit clause naming the suicide provision',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'Death by suicide is excluded during the first two years.',
    kind: 'clause naming the manner of death',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'Self-harm is excluded from cover.',
    kind: 'clause with the term as subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'Mental illness is excluded unless hospitalised.',
    kind: 'clause with the term as subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'Depression is covered only when diagnosed by a specialist.',
    kind: 'benefit clause with the condition as subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'Pregnancy and childbirth are excluded for the first ten months.',
    kind: 'clause with the status as subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'HIV is excluded unless contracted through a covered accident.',
    kind: 'clause with the condition as subject',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'The exclusion for back pain applies for six months.',
    kind: 'clause naming the exclusion',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'The exclusions section lists cancer and heart disease.',
    kind: 'section reference',
  },
  {
    register: 'exclusions',
    expected: 'not_health_data',
    message: 'Exclusions: war, self-inflicted injury, and acts of terrorism.',
    kind: 'list row with no health stem the vocabulary carries',
  },
  {
    register: 'exclusions',
    expected: 'health_data',
    message: 'Suicide and self-inflicted injury are excluded for two years.',
    kind: 'clause naming the suicide provision',
  },
  {
    register: 'exclusions',
    expected: 'not_health_data',
    message: 'Read the exclusions before you apply.',
    kind: 'instruction naming no condition',
  },

  // ── waiting periods: 10 sentences, 7 of them health data ───────────────────
  {
    register: 'waiting periods',
    expected: 'health_data',
    message: 'The waiting period for cancer is two years.',
    kind: 'provision clause with a document subject',
  },
  {
    register: 'waiting periods',
    expected: 'health_data',
    message: 'A waiting period of twelve months applies to diabetes.',
    kind: 'provision clause, condition as object',
  },
  {
    register: 'waiting periods',
    expected: 'health_data',
    message: 'Waiting periods: cancer, 24 months; heart attack, 12 months.',
    kind: 'schedule row',
  },
  {
    register: 'waiting periods',
    expected: 'health_data',
    message: 'Pregnancy has a ten-month waiting period.',
    kind: 'provision clause with the status as subject',
  },
  {
    register: 'waiting periods',
    expected: 'not_health_data',
    message: 'There is no waiting period for accidental death.',
    kind: 'provision clause naming no condition',
  },
  {
    register: 'waiting periods',
    expected: 'health_data',
    message: 'The waiting period for mental illness is 12 months from the issue date.',
    kind: 'provision clause with a document subject',
  },
  {
    register: 'waiting periods',
    expected: 'health_data',
    message: 'Coverage for a pre-existing condition begins after the waiting period.',
    kind: 'provision clause naming the phrase',
  },
  {
    register: 'waiting periods',
    expected: 'health_data',
    message: 'Benefits for a pre-existing condition start after twelve months.',
    kind: 'provision clause naming the phrase',
  },
  {
    register: 'waiting periods',
    expected: 'not_health_data',
    message: 'The policy handbook explains the waiting periods.',
    kind: 'document reference naming no condition',
  },
  {
    register: 'waiting periods',
    expected: 'not_health_data',
    message: 'The suicide exclusion period is 24 months.',
    kind: 'the provision strip already reaches it',
  },

  // ── riders and provisions: 10 sentences, 6 of them health data ─────────────
  {
    register: 'riders and provisions',
    expected: 'health_data',
    message: 'The critical illness rider pays a lump sum on diagnosis of a specified condition.',
    kind: 'rider clause',
  },
  {
    register: 'riders and provisions',
    expected: 'not_health_data',
    message: 'The accelerated death benefit rider advances part of the face amount.',
    kind: 'rider clause naming no condition',
  },
  {
    register: 'riders and provisions',
    expected: 'health_data',
    message: 'This rider covers cancer, heart attack and stroke.',
    kind: 'rider clause with a document subject',
  },
  {
    register: 'riders and provisions',
    expected: 'health_data',
    message: "The rider's cancer benefit is 25% of the face amount.",
    kind: 'benefit clause naming the rider',
  },
  {
    register: 'riders and provisions',
    expected: 'not_health_data',
    message: 'The disability waiver rider waives premiums during a disability.',
    kind: 'rider clause naming no watched term',
  },
  {
    register: 'riders and provisions',
    expected: 'health_data',
    message: 'The accidental death rider does not cover suicide.',
    kind: 'rider clause naming the provision',
  },
  {
    register: 'riders and provisions',
    expected: 'not_health_data',
    message: 'The suicide provision applies only in the first two years.',
    kind: 'the provision strip already reaches it',
  },
  {
    register: 'riders and provisions',
    expected: 'not_health_data',
    message: 'The policy includes a disability income rider.',
    kind: 'rider clause naming no watched term',
  },
  {
    register: 'riders and provisions',
    expected: 'health_data',
    message: "The policy's cancer benefit is payable once only.",
    kind: "benefit clause with the policy's possessive",
  },
  {
    register: 'riders and provisions',
    expected: 'health_data',
    message: 'Recurrence of the same cancer is not covered.',
    kind: 'benefit clause with the condition as subject',
  },

  // ── benefit schedules: 10 sentences, 6 of them health data ─────────────────
  {
    register: 'benefit schedules',
    expected: 'health_data',
    message: 'Benefit schedule: cancer diagnosis, $50,000; heart attack, $50,000; stroke, $25,000.',
    kind: 'schedule row',
  },
  {
    register: 'benefit schedules',
    expected: 'not_health_data',
    message: 'The schedule lists a benefit for each covered condition.',
    kind: 'schedule reference naming no condition',
  },
  {
    register: 'benefit schedules',
    expected: 'not_health_data',
    message: 'Terminal illness benefit: 75% of the face amount.',
    kind: 'the product carve-out already reaches it',
  },
  {
    register: 'benefit schedules',
    expected: 'health_data',
    message: 'Specified disease benefit schedule attached.',
    kind: 'schedule title',
  },
  {
    register: 'benefit schedules',
    expected: 'health_data',
    message: 'Benefits for a terminal illness are paid in advance.',
    kind: 'benefit clause naming the illness',
  },
  {
    register: 'benefit schedules',
    expected: 'not_health_data',
    message: 'Only conditions named in the schedule are covered.',
    kind: 'reference clause naming no condition',
  },
  {
    register: 'benefit schedules',
    expected: 'health_data',
    message: 'The schedule names each covered disease and its benefit.',
    kind: 'schedule clause with a document subject',
  },
  {
    register: 'benefit schedules',
    expected: 'not_health_data',
    message: 'Benefits are payable on proof of death.',
    kind: 'clause naming no condition',
  },
  {
    register: 'benefit schedules',
    expected: 'health_data',
    message: 'No benefit is payable for a condition arising before the policy date.',
    kind: 'benefit clause with a document subject',
  },
  {
    register: 'benefit schedules',
    expected: 'health_data',
    message: 'The benefit for a heart attack is paid on diagnosis.',
    kind: 'benefit clause with a document subject',
  },

  // ── definitions: 9 sentences, all 9 health data ────────────────────────────
  {
    register: 'definitions',
    expected: 'health_data',
    message: "For the purposes of this policy, 'cancer' means a malignant tumour.",
    kind: 'definition frame',
  },
  {
    register: 'definitions',
    expected: 'health_data',
    message: "'Condition' means a disease or disorder named in the schedule.",
    kind: 'definition frame',
  },
  {
    register: 'definitions',
    expected: 'health_data',
    message: "'Suicide' means the intentional taking of one's own life.",
    kind: 'definition frame, and a reflexive act',
  },
  {
    register: 'definitions',
    expected: 'health_data',
    message: "'Heart attack' is defined as myocardial infarction.",
    kind: 'definition frame',
  },
  {
    register: 'definitions',
    expected: 'health_data',
    message: "'Mental illness' means a disorder listed in the schedule.",
    kind: 'definition frame',
  },
  {
    register: 'definitions',
    expected: 'health_data',
    message: "'Diagnosis' means the determination of a disease by a physician.",
    kind: 'definition frame',
  },
  {
    register: 'definitions',
    expected: 'health_data',
    message: "'Treatment' means any medical care received for a condition.",
    kind: 'definition frame',
  },
  {
    register: 'definitions',
    expected: 'health_data',
    message: "The definition of 'disability' includes mental illness.",
    kind: 'definition by inclusion, not by `means`',
  },
  {
    register: 'definitions',
    expected: 'health_data',
    message: "'Prescription' means a medicine dispensed on a physician's order.",
    kind: 'definition frame',
  },

  // ── application and underwriting: 28 sentences, 17 of them health data ─────
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'The application asks whether the proposed insured has diabetes.',
    kind: 'form clause with a document subject',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'Underwriting may require a medical examination.',
    kind: 'no watched term fires',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'The applicant must declare any treatment received in the last five years.',
    kind: 'the treatment rule already narrows it',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'Declarations of health history are required at the point of sale.',
    kind: 'form clause naming health history',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'The application includes a health questionnaire.',
    kind: 'no watched term fires',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'Failure to disclose a medical condition may void the policy.',
    kind: 'form clause with a document subject',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'The applicant must disclose any diagnosis of cancer.',
    kind: 'form clause naming a diagnosis',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'Underwriting guidelines treat depression as a rated condition.',
    kind: 'underwriting clause',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'A prescription list must be provided with the application.',
    kind: 'form clause naming a prescription list',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'The rate class depends on the health history disclosed.',
    kind: 'rating clause naming health history',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: "The carrier's underwriting manual lists rated conditions.",
    kind: 'no watched term fires',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'Height and weight are recorded for underwriting purposes.',
    kind: 'body-measure fields',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'A blood pressure reading may be requested.',
    kind: 'a broad-by-measurement field',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'Cholesterol results may be requested at the medical exam.',
    kind: 'a broad-by-measurement field',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'The application asks about tobacco and nicotine use.',
    kind: 'lifestyle fields',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'Premium rates are based on age, sex and tobacco use.',
    kind: 'rating clause naming tobacco',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'A statement of health may be required for reinstatement.',
    kind: 'no watched term fires',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'The insurer may decline an application after a medical examination.',
    kind: 'no watched term fires',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'The insurer reserves the right to require an autopsy.',
    kind: 'no watched term fires',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'Alcohol and drug use may affect eligibility.',
    kind: 'lifestyle fields',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'Underwriting may order medical records from the treating doctor.',
    kind: 'no watched term fires',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'The policy is not available to applicants receiving dialysis.',
    kind: 'a stem the vocabulary carries',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'Cover is not available where the proposed insured is pregnant.',
    kind: 'a status stem the vocabulary carries',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'Prescription medication information may be requested.',
    kind: 'form clause naming medication',
  },
  {
    register: 'application and underwriting',
    expected: 'health_data',
    message: 'The statement of health asks about medication.',
    kind: 'the bare medication rule',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'Critical illness cover is optional.',
    kind: 'the product carve-out already reaches it',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'Medical records may be requested from the treating doctor.',
    kind: 'no watched term fires',
  },
  {
    register: 'application and underwriting',
    expected: 'not_health_data',
    message: 'Diagnosis must occur after the policy date.',
    kind: 'the diagnosis rule already narrows it',
  },

  // ── claims: 9 sentences, 3 of them health data ─────────────────────────────
  {
    register: 'claims',
    expected: 'health_data',
    message: 'A claim for a critical illness requires a diagnosis from a licensed physician.',
    kind: 'claim condition',
  },
  {
    register: 'claims',
    expected: 'not_health_data',
    message: 'Claims for disability require medical evidence.',
    kind: 'no watched term fires',
  },
  {
    register: 'claims',
    expected: 'not_health_data',
    message: 'The insurer may request medical records when a claim is filed.',
    kind: 'no watched term fires',
  },
  {
    register: 'claims',
    expected: 'not_health_data',
    message: 'Evidence of the diagnosis must be submitted with the claim.',
    kind: 'the diagnosis rule already narrows it',
  },
  {
    register: 'claims',
    expected: 'not_health_data',
    message: "Claim forms must include the attending physician's statement.",
    kind: 'no watched term fires',
  },
  {
    register: 'claims',
    expected: 'health_data',
    message: 'The illness claim form must be completed by the physician.',
    kind: 'the illness rule inside a document clause',
  },
  {
    register: 'claims',
    expected: 'not_health_data',
    message: 'Written notice of a claim must be given within 20 days.',
    kind: 'no watched term fires',
  },
  {
    register: 'claims',
    expected: 'health_data',
    message: 'Claims arising from a pre-existing condition are reviewed.',
    kind: 'claim clause naming the phrase',
  },
  {
    register: 'claims',
    expected: 'not_health_data',
    message: 'The beneficiary must submit proof of the insured\u2019s death.',
    kind: 'no watched term fires',
  },

  // ── general conditions: 9 sentences, 1 of them health data ─────────────────
  {
    register: 'general conditions',
    expected: 'not_health_data',
    message: 'Coverage continues while premiums are paid.',
    kind: 'no watched term fires',
  },
  {
    register: 'general conditions',
    expected: 'not_health_data',
    message: 'This policy does not cover any condition arising from war.',
    kind: 'the condition family already narrows it',
  },
  {
    register: 'general conditions',
    expected: 'not_health_data',
    message: 'The policy may be cancelled for non-payment.',
    kind: 'no watched term fires',
  },
  {
    register: 'general conditions',
    expected: 'not_health_data',
    message: 'The contract is governed by Texas law.',
    kind: 'no watched term fires',
  },
  {
    register: 'general conditions',
    expected: 'not_health_data',
    message: 'The policy lapses if a premium is missed.',
    kind: 'no watched term fires',
  },
  {
    register: 'general conditions',
    expected: 'not_health_data',
    message: 'Benefits under the policy are not reduced by other insurance.',
    kind: 'no watched term fires',
  },
  {
    register: 'general conditions',
    expected: 'not_health_data',
    message: 'The policy is issued on the basis of the answers in the application.',
    kind: 'no watched term fires',
  },
  {
    register: 'general conditions',
    expected: 'not_health_data',
    message: 'Reinstatement requires evidence of insurability.',
    kind: 'no watched term fires',
  },
  {
    register: 'general conditions',
    expected: 'health_data',
    message: 'The policy covers treatment for a covered accident.',
    kind: 'the treatment family inside a document clause',
  },
];

/** The other direction: sentences the register measurement must never have opened. */
export const REGISTER_CONTROLS: string[] = [
  'I have cancer',
  'my cancer was diagnosed in 2020',
  'I was diagnosed with diabetes last year',
  'I am on dialysis',
  'I have a history of self-harm',
  'my wife had a heart attack',
  'I take medication for depression',
  'I was pregnant last year',
  'my blood pressure is high',
  'I use nicotine pouches',
  'the policy covers my cancer',
  'does the policy cover my cancer?',
  'I have a cancer exclusion on my policy and I have cancer',
  'my condition is excluded from the policy',
  'the treatment I am receiving is excluded',
];
