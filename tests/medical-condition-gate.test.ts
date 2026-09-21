/**
 * Health-data gate coverage — the conditions the PTSD/phenome literature lists.
 *
 * The deterministic pre-LLM gate (`detectSensitiveData`) is the control that
 * decides whether a message that names a medical condition is turned into an
 * educational answer or into a blocked response with a licensed-broker handoff.
 * This suite probes that control for the conditions the three reviewed
 * syntheses actually map (hypertension, sleep apnea, lupus, dementia, dialysis,
 * and the rest of the phenome vocabulary) — at the unit level and through the
 * real /api/chat endpoint.
 *
 * Two deliberate design choices in the probe sentences:
 *
 *   1. They are KEYWORD-FREE. A sentence like "I was diagnosed with lupus" is
 *      caught by the generic `/diagnos(ed|is)/` pattern and proves nothing about
 *      condition coverage. Every sentence below therefore avoids the generic
 *      triggers (diagnosed, medication, prescription, treatment, symptom,
 *      condition, disease, disorder, blood pressure, heart, ...) so that a pass
 *      can only come from the condition term itself.
 *   2. They are phrased the way a visitor types: "I have lupus", "I wear a CPAP
 *      for sleep apnea", "my father has dementia".
 *
 * Known, deliberate limitations (asserted as such, not hidden):
 *   - Two- and three-letter clinical abbreviations (MS, RA, MI, UC, OA, PAD,
 *     HTN, GAD, TMD, ALS) are NOT gated on their own, because as substrings they
 *     collide with ordinary English and names ("Ms.", "pad", "mi"). The gate is
 *     a safety net, not the only control: persona rules and the state machine
 *     still apply. `GATE_EXCLUDED_ABBREVIATIONS` below locks that tradeoff so it
 *     stays a decision rather than drifting into an accident.
 *   - False positives are accepted in the fail-safe direction: a blocked
 *     educational question costs a handoff offer, while a missed disclosure
 *     costs a compliance breach.
 */

import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';
import {
  detectSensitiveData,
  detectHealthTopicQuestion,
  ALL_CONDITION_GATE_TERMS,
  ALL_CONDITION_GATE_WORD_TERMS,
  HEALTH_CONDITION_TERMS,
  HEALTH_CONDITION_WORD_TERMS,
  GATE_EXCLUDED_TERMS,
  isHealthConditionTerm,
  hasContextQualifiedTerm,
} from '../src/security/security-controls';
import {
  CANONICAL_CONDITIONS,
  CONDITION_VOCABULARY_CHANGELOG,
  findCanonicalCondition,
  spellingVariantKeys,
  spellingVariantsOfStem,
  spellingVariantsOfWord,
} from '../src/medical/condition-crosswalk';

/**
 * Gate terms that deliberately have no canonical condition, with the reason.
 *
 * Each names a body system, a measured quantity, a symptom, or a pathoanatomic
 * category rather than a reportable diagnosis, so there is nothing for the
 * crosswalk to carry. Kept explicit — and asserted below — so "the gate watches
 * a term the vocabulary does not have" is always either an intentional entry
 * here or a build failure.
 */
const DESCRIPTIVE_GATE_TERMS: readonly string[] = [
  'cardiovascular', // body system, not a condition
  'glycem', // measurement (glycemia, glycemic control)
  'neurodegenerat', // disease category
  'memory loss', // symptom, not a diagnosis
  'thrombus', // pathoanatomic noun; venous thromboembolism is crosswalked
  'metasta', // metastatic disease descriptor
  // Measured long tail from the 2026-09-18 boundary probes: terms that ARE
  // health data but are deliberately not given a canonical code, each for a
  // written reason. Gated without mapped — the disclosure is protected, and the
  // crosswalk does not invent a code the person did not state.
  'mononucleosis', // acute, self-limited infection
  'urinary tract infection', // acute, self-limited infection
  'cellulitis', // acute bacterial skin infection
  'clostridium difficile', // acute healthcare-associated infection
  'c difficile', // abbreviation of the above
  'ear infection', // acute, self-limited infection; lay phrasing
  'fracture', // injury, not a disease (lay "broke my wrist" stays uncovered)
  'brain fog', // symptom, not a diagnosis
  'irregular periods', // symptom, not a diagnosis
  'gingivitis', // dental finding, not a systemic condition
  'dental caries', // dental finding
  'tooth decay', // lay wording for dental caries
  'skin tags', // cosmetic dermatologic finding
  'bakers cyst', // minor, usually self-limited soft-tissue cyst
  'baker cyst', // variant spelling of the above
  'kyphosis', // postural spinal variant
  'strabismus', // childhood ocular alignment condition
  'tendonitis', // non-specific soft-tissue inflammation
  'tendinitis', // variant spelling of the above
  // Probe 3 — the 2026-09-19 questionnaire sweep. Procedure states, acute
  // infections, symptoms, and one viral carrier row: each is health data the
  // gate must protect, and each is deliberately without a canonical code
  // because the vocabulary carries diagnosed conditions rather than surgical
  // history, self-limited infections, or symptoms.
  'stent', // procedure state, not a diagnosis
  'pacemaker', // implanted device
  'angioplasty', // procedure
  'hip replacement', // procedure
  'knee replacement', // procedure — orthopaedic history is a questionnaire row, not a condition
  'hysterectomy', // procedure (named out of scope in the CAPTURE_SCOPE comment)
  'appendectomy', // procedure
  'tonsillectomy', // procedure
  'blood transfusion', // treatment history
  'organ transplant', // treatment history
  'urine infection', // acute, self-limited infection (lay wording of urinary tract infection)
  'conjunctivitis', // acute, self-limited eye infection
  'sinus infection', // acute, self-limited infection
  'tonsillitis', // acute, self-limited infection
  'laryngitis', // acute, self-limited infection
  'syphilis', // acute bacterial infection, treated and resolved
  'gonorrhea', // acute bacterial infection
  'gonorrhoea', // British spelling of the above
  'chlamydia', // acute bacterial infection
  'malaria', // acute infection, travel-related
  'fungal nail infection', // minor dermatologic infection
  'snoring', // symptom, not a diagnosis
  'shortness of breath', // symptom
  'dizziness', // symptom
  'hpv', // viral carrier state / screening status, not a reportable diagnosis
  // Critical-illness covered-condition lists (1.6.0) — the second independent
  // source. Event, procedure, injury and functional rows the lists carry: the
  // gate protects each one, and the vocabulary does not invent a diagnosis for
  // it. (Coma is the exception — it has a code, R40.20.)
  'paralys', // paralysis, paralysed — a functional state with many causes
  'blindness', // functional vision loss; the causes are coded
  'loss of sight', // lay phrasing of the same
  // 'loss of hearing' is deliberately NOT here: it is the carrier list's
  // spelling of an existing condition (H91.90 hearing loss), so it became an
  // alias in 1.6.0 instead — the descriptive list may never carry a synonym
  // the vocabulary has.
  'loss of speech', // symptom/functional state
  // ICD-10 Chapter IX codebook rows (1.7.0): the category titles that name a
  // body part or a system rather than a diagnosis. The gate watches the word,
  // the vocabulary does not invent a condition for it.
  'pericardium', // "other diseases of pericardium" — the coded row is pericarditis
  'arteriole', // "other disorders of arteries and arterioles"
  'capillaries', // "diseases of capillaries" — plural only, so "capillary action" is clear
  'lymphatic', // "other noninfective disorders of lymphatic vessels and lymph nodes"
  'circulatory', // "other and unspecified disorders of circulatory system"
  'severe burn', // injury, not a disease
  'major burn', // covers the plural ("major burns")
  'head trauma', // injury
  'bone marrow transplant', // procedure
  'aorta', // anatomy named in a procedure history ("surgery to aorta")
  'apallic', // apallic syndrome is a clinical state, not a coded condition here
  'loss of independent existence', // cover-definition language (ADL dependence)
  // ICD-10 Chapter XIV codebook rows (1.9.0): the anatomy, symptom-category and
  // procedure constructs the N00–N99 category titles name. Each is health data
  // the gate must protect, and each is deliberately without a canonical code —
  // the stateable diagnoses inside them are carried (phimosis, mastitis and
  // friends are not stated by this corpus, so they are not invented either).
  'testis', // "noninflammatory disorders of testis" — the codes are per-cause
  'prepuce', // "disorders of prepuce" — the coded rows are phimosis/paraphimosis
  'penis', // "other disorders of penis" — a category, not a diagnosis
  'genital', // "male genital organs", "female genital tract" — anatomy
  'vulva', // "disorders of vulva and perineum" — anatomy
  'sexual dysfunction', // functional-state category; erectile dysfunction is coded
  'artificial fertilization', // procedure construct: complications of IVF
  'genitourinary', // "complications … of genitourinary system" — anatomy
  // The British spellings are no longer listed here: since 1.17.0 the gate
  // derives them from the declared spelling table and the accounting below
  // checks every spelling of an alias, so a derived spelling is accounted by
  // the same canonical alias its sibling is — a grandfathered exemption would
  // only have hidden a vocabulary that stopped carrying the word.
  'serum enzyme', // R74 category title — a laboratory report, not a diagnosis
  // Chapter XVIII R00–R99 (1.11.0): the descriptive findings and examination
  // categories the sweep surfaced. Each is health data the gate protects, and
  // each is deliberately without a canonical code — the stateable findings the
  // same sweep named discretely are in the scope ledger instead.
  'numbness', // the complaint the codebook splits finer than the words do (R20.1 vs R20.2)
  'tingling', // paresthesia wording, same split
  'breathing', // abnormal breathing findings (R06) — category, not a diagnosis
  'throat', // throat findings (R07.0) — anatomy in a symptom category
  'chest pain', // R07.x — the person's complaint; the causes are coded
  'nausea', // R11.0 — symptom
  'vomiting', // R11.x — symptom
  'flatulence', // R14 — symptom
  'skin sensation', // R20.x category — examination language
  'skin eruption', // R21 — examination language
  'skin changes', // R22.x category
  'subcutaneous', // R22.1 granularity — anatomy in a category title
  'involuntary movements', // R25.x category — descriptive
  'gait', // R26.x category — descriptive
  'debility', // R53.x category — malaise and fatigue family
  'cachexia', // R64 — clinical state
  'hyperhidrosis', // R61 — excessive sweating; stateable but uncoded by scope
  'malaise', // R53 — symptom
  'red blood cell', // R71 category — laboratory report
  'immunological', // R76.x category — laboratory report
  'plasma protein', // R77.x category — laboratory report
  'blood chemistry', // R79.x category — laboratory report
  'cerebrospinal', // R83 category — laboratory report
  'diagnostic imaging', // R90-R93 categories — report language
  'physiological', // R94 category — report language
  'smell and taste', // R43 category — descriptive
  'speech disturbance', // R47.x — descriptive
  'function studies', // R94.8 wording — report language
  // Misc measured terms, each with its reason.
  'blood-pressure', // hyphenated spelling; the spaced form is a captured field
  'dyslexia', // R48.8 wording — stateable but uncoded by the sweep's scope
  'ataxia', // R27.0 — descriptive
  'anaphylactic', // T78.2 adjective — 'anaphylaxis' would be the coded noun
  'cardiogenic', // R57.0 adjective — shock qualifier
  'hypovolemic', // R57.1 adjective — shock qualifier
  // Status and history words the Chapter XXI and abuse-family releases made
  // the gate watch; the disclosure is protected, and no code is invented.
  'blood type', // "my blood type is O positive" — a captured field, not a condition
  'asbestos', // Z77 exposure row — exposure status, not a diagnosis
  'was abused', // the Z62/Z91.4 rows are split by setting; the bare shape gates uncoded
  'kill myself', // watched as a statement in its own right ("I tried to kill myself")
  'overdose', // an overdose is a medical event; "an overdose of caffeine" is the accepted cost
  'self-mutilation', // hyphenated spelling of Z91.52's inclusion term; a visitor types both
  'self-injury', // hyphenated spelling of "self injury" (Z91.52), same reason
  'self-poisoning', // the spaced spelling is Z91.51's own inclusion term; both spellings watched
  // ('forced labour' and 'forced into labour' are derived from the declared
  // labour/labor group and accounted through their American siblings.)
  // The Z93-Z99 status rows and the medication-status phrase: the gate
  // protects the state a person reports, and the vocabulary does not invent
  // a condition for an organ's absence or a device's presence.
  'amputat', // Z89 — amputation status (amputated, amputation)
  'amputee', // Z89.8 stateable form ("I am an amputee")
  'colostomy', // Z93.2 — artificial opening status
  'ileostomy', // Z93.2 — artificial opening status
  'tracheostomy', // Z93.0 — artificial opening status
  'feeding tube', // Z95.8 device dependency
  'ventilator', // Z99.1 — device dependency; "the office ventilator" is the accepted cost
  'prosthetic', // Z96 — implant/prosthetic status
  'implant', // Z95/Z96 — implant status; "dental implant" is the accepted cost
  'artificial opening', // Z93 category wording
  'foreign body', // Z18 — retained foreign body status
  'on the pill', // Z79.3 — contraception medication status
  // ICD-10 Chapter VI G00–G99 (1.17.0): the organ and residual constructs the
  // sweep surfaced. Each is health data the gate protects, and each is
  // deliberately without a canonical code — the ten named diagnoses the same
  // sweep surfaced are in the 1.17.0 release entry instead. The three codebook
  // category-title forms sit beside the person's wording for the same organ.
  'cranial nerve', // G50–G52 category — anatomy a diagnosis would name
  'autonomic nervous system', // G90 category — the dysautonomia family is clinical language
  'basal ganglia', // G23 category — the named degenerations are clinical constructs
  'demyelinat', // G35–G37 category — 'sclerosis' stays unwatched (atherosclerosis)
  'extrapyramidal', // G20–G26 category — movement-disorder language
  'movement disorder', // G20–G26 stateable category
  'disorders of nervous system', // the G98 residual's category-title form — qualified,
  'disease of nervous system', // not a bare stem, so "the central nervous system controls…"
  'diseases of nervous system', // stays silent (measured)
  'peripheral nervous system', // the G60–G65 category form
  'disorders of brain', // the G93 category-title form; a person says "brain disorder"
  'disorders of muscle', // the G71 category-title form; a person says "muscle disorder"
  'muscle disorder', // the person's wording for the G71 category
  'paresis', // hemiparesis, paraparesis — the weakness family beside hemiplegia
  'paralyt', // paralytic — the G83 category wording; 'paralys' beside it covers the noun
  // ICD-10 Chapter X J00–J99 (1.19.0): the anatomy and residual stems the sweep
  // surfaced. Each is health data the gate protects, and each is deliberately
  // without a canonical code — the named diagnoses the same sweep surfaced are
  // in the 1.19.0 release entry instead.
  'lower respiratory infection', // the J20–J22 category — an acute, self-limited family
  'lower respiratory tract infection', // the longer form of the same
  'upper respiratory tract', // the J39 residual's anatomy — inherently medical phrasing
  'nasal sinuses', // the J34 residual's anatomy
  'tonsils and adenoids', // the J35 category-title form; the chronic disease is mapped
  'pleural plaque', // the J92 family — bare wording gates rather than misstating the asbestos split
  // ICD-10 Chapter XI K00–K95 (1.20.0): the anatomy, residual and dental stems
  // the sweep surfaced. Each is health data the gate protects, and each is
  // deliberately without a canonical code — the named diagnoses the same sweep
  // surfaced are in the 1.20.0 release entry instead.
  'hepatic', // the adjective of the liver family; the coded row is cirrhosis or fatty liver
  'stomatitis', // the K12 category — the recurrent-aphthae member is mapped
  'tongue disease', // the K14 residual's person wording
  'diseases of tongue', // the K14 category-title form
  'abscess', // an acute suppurative state — the anal/rectal/salivary/dental abscesses
  'intestine', // the K63 residual's anatomy
  'peritoneum', // the K65–K68 category anatomy (covers retroperitoneum)
  'diseases of liver', // the K76 category-title form; the stateable members are mapped
  'digestive system', // the K92 residual's category noun
  'tooth development', // K00 — dental residual, gated not coded
  'impacted teeth', // K01 — dental residual
  'hard tissues of teeth', // K03 — dental residual
  'periapical', // K04 — dental residual
  'gingiva', // K06 — dental residual ('gingivitis' is already descriptive)
  'teeth and supporting structures', // K08 — dental residual
  'cysts of oral region', // K09 — dental residual
  'diseases of appendix', // the K38 category-title form; bare 'appendix' is a document's appendix
  'disease of appendix',
  // ICD-10 Chapter XII L00-L99 (1.21.0): the residual and anatomy stems the
  // sweep surfaced. Each is health data the gate protects, and each is
  // deliberately without a canonical code - the named diagnoses the same
  // sweep surfaced are in the 1.21.0 release entry instead. Bare
  // "pigmentation", "corns" and "exfoliation" stay unwatched for their
  // ordinary cosmetics and food senses; the category-title wordings below
  // carry the residuals instead.
  'pilonidal', // L05 - gated without a code (the with/without-abscess split is not carried by the bare words)
  'pruritus', // L29 - the itch category
  'prurigo', // L28's title residual
  'exfoliation due to', // the L49 title shape - bare 'exfoliation' is skincare
  'nonscarring hair loss', // the L65 title form
  'hair shaft', // the L67 title fragment
  'disorders of pigmentation', // the L81 title form
  'callosities', // the L84 title form - bare 'corns' is food
  'epidermal thickening', // the L85 title form
  'atrophic disorders of skin', // the L90 category-title form
  'hypertrophic disorders of skin', // the L91 category-title form
  'polyosteoarthritis', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'acquired deformities', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'patella', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'internal derangement', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'joint derangement', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'dentofacial', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'malocclusion', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'diseases of jaws', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'autoinflammatory', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'necrotizing vasculopath', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'polymyositis', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'involvement of connective tissue', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'connective tissue disease', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'lordosis', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'spinal osteochondrosis', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'osteochondrosis', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'deforming dorsopathies', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'dorsopath', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'dorsalgia', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'synovitis', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'tenosynovitis', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'synovium', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'enthesopath', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'fibroblastic', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'calcification of muscle', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'ossification of muscle', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'myositis ossificans', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'shoulder lesion', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'soft tissue disorder', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'overuse and pressure', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'osteochondropath', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'disorders of cartilage', // ICD-10 Chapter XIII (1.22.0) descriptive residual
  'biomechanical lesion', // ICD-10 Chapter XIII (1.22.0) descriptive residual
];

/**
 * The declared capture scope — the common chronic conditions a carrier
 * medical-history questionnaire enumerates, grouped by the domain that owns
 * them.
 *
 * This is what "complete" means here: an explicit, reviewable list rather than
 * an open-ended promise to map every ICD-10-CM code in existence. The ledger
 * below enforces the claim in both directions — every phrase must resolve to
 * the exact code declared beside it and classify as `health_data` when stated,
 * and the code list must equal the `1.2.0` release entry in
 * `CONDITION_VOCABULARY_CHANGELOG`, so the declared scope, the release notes,
 * and the live vocabulary cannot drift apart.
 *
 * Deliberately OUT of scope, with reasons: acute and self-limited infections
 * (urinary tract infection, mononucleosis), injuries and fractures, symptom
 * phrases (brain fog, fatigue), procedure states (hysterectomy), and anything
 * whose code would have to be guessed. A condition outside the scope is never
 * coerced — it comes back in `unmapped` in the person's own words.
 */
const CAPTURE_SCOPE: readonly {
  domain: string;
  conditions: readonly (readonly [phrase: string, code: string])[];
}[] = [
  {
    domain: 'Gynecologic / reproductive',
    conditions: [
      ['endometriosis', 'N80.9'],
      ['uterine fibroids', 'D25.9'],
      ['pcos', 'E28.2'],
      ['ovarian cyst', 'N83.20'],
      ['infertility', 'N97.9'],
    ],
  },
  {
    domain: 'Urologic',
    conditions: [
      ['bph', 'N40.1'],
      ['incontinence', 'R32'],
      ['overactive bladder', 'N32.81'],
      ['erectile dysfunction', 'N52.9'],
      ['male infertility', 'N46.9'],
    ],
  },
  {
    domain: 'Dermatologic',
    conditions: [
      ['eczema', 'L20.9'],
      ['hives', 'L50.9'],
      ['vitiligo', 'L80'],
      ['rosacea', 'L71.9'],
      ['alopecia areata', 'L63.9'],
    ],
  },
  {
    domain: 'Ophthalmologic / otologic',
    conditions: [
      ['cataract', 'H25.9'],
      ['glaucoma', 'H40.9'],
      ['macular degeneration', 'H35.31'],
      ['diabetic retinopathy', 'E11.319'],
      ['hearing loss', 'H91.90'],
    ],
  },
  {
    domain: 'ENT / oral',
    conditions: [
      ['tinnitus', 'H93.19'],
      ['sinusitis', 'J32.9'],
      ['vertigo', 'H81.10'],
      ['gum disease', 'K05.30'],
    ],
  },
  {
    domain: 'Congenital / developmental',
    conditions: [
      ['down syndrome', 'Q90.9'],
      ['cerebral palsy', 'G80.9'],
      ['congenital heart disease', 'Q24.9'],
      ['cystic fibrosis', 'E84.9'],
      ['spina bifida', 'Q05.9'],
    ],
  },
  {
    domain: 'Neurological / immune, other',
    conditions: [
      ['autism', 'F84.0'],
      ['myasthenia gravis', 'G70.00'],
      ['sarcoidosis', 'D86.9'],
      ['carpal tunnel', 'G56.00'],
      ['polycystic kidney disease', 'Q61.3'],
    ],
  },
  {
    domain: 'Musculoskeletal, other',
    conditions: [
      ['scoliosis', 'M41.9'],
      ['herniated disc', 'M51.9'],
      ['spinal stenosis', 'M48.00'],
      ['rotator cuff tear', 'M75.100'],
      ['plantar fasciitis', 'M72.2'],
    ],
  },
  {
    domain: 'Gastrointestinal, other',
    conditions: [
      ['diverticulitis', 'K57.32'],
      ['gallstones', 'K80.20'],
      ['hiatal hernia', 'K44.9'],
      ['hemorrhoids', 'K64.9'],
      ['gastritis', 'K29.50'],
    ],
  },
  {
    domain: 'Hematologic, other',
    conditions: [
      ['sickle cell', 'D57.1'],
      ['thalassemia', 'D56.9'],
      ['hemophilia', 'D66'],
      ['von willebrand disease', 'D68.0'],
      ['thrombocytopenia', 'D69.6'],
    ],
  },
  {
    domain: 'Infectious, other',
    conditions: [
      ['shingles', 'B02.9'],
      ['lyme disease', 'A69.20'],
      ['osteomyelitis', 'M86.9'],
      ['long covid', 'U09.9'],
    ],
  },
  {
    domain: 'Oncologic, other',
    conditions: [
      ['stomach cancer', 'C16.9'],
      ['esophageal cancer', 'C15.9'],
      ['cervical cancer', 'C53.9'],
      ['testicular cancer', 'C62.90'],
      ['non-melanoma skin cancer', 'C44.90'],
    ],
  },
  {
    domain: 'Endocrine, other',
    conditions: [
      ['hyperparathyroidism', 'E21.3'],
      ['hypopituitarism', 'E23.0'],
      ['cushing syndrome', 'E24.9'],
      ['diabetes insipidus', 'E23.2'],
      ['thyroid nodule', 'E04.1'],
    ],
  },
  {
    domain: 'Respiratory, other',
    conditions: [
      ['pulmonary fibrosis', 'J84.10'],
      ['bronchiectasis', 'J47.9'],
      ['pulmonary hypertension', 'I27.20'],
    ],
  },
  {
    domain: 'Mental health, other',
    conditions: [
      ['social anxiety', 'F40.10'],
      ['agoraphobia', 'F40.00'],
      ['eating disorder', 'F50.9'],
      ['postpartum depression', 'F53.0'],
    ],
  },
];

/**
 * Conditions named in the reviewed PTSD syntheses, each with a keyword-free
 * visitor sentence. Every row must classify as `health_data` — the sentence is
 * the visitor talking about their own situation ("I have lupus", "My father has
 * dementia", "Will atrial fibrillation change my options?" — the possessive is
 * what makes that last one personal).
 *
 * The two rows that ask about a condition WITHOUT bringing the visitor in live
 * in LITERATURE_TOPIC_QUESTIONS below, because they classify differently.
 */
const LITERATURE_CONDITIONS: [condition: string, sentence: string][] = [
  // Cardiovascular / cerebrovascular
  ['hypertension', 'I have hypertension'],
  ['atherosclerosis', 'Do I need to mention atherosclerosis separately?'],
  ['myocardial infarction', 'Do I need to tell you about my myocardial infarction?'],
  ['atrial fibrillation', 'Will atrial fibrillation change my options?'],
  ['stroke', 'I had a stroke last year'],
  ['cardiac arrest', 'My brother survived a cardiac arrest'],
  ['heart failure', 'My mother is living with heart failure'],
  ['coronary artery disease', 'I have coronary artery disease'],

  // Metabolic / endocrine
  ['type 2 diabetes', 'I am type 2 diabetic'],
  ['prediabetes', 'They told me I am prediabetic'],
  ['obesity', 'I have obesity'],
  ['hyperlipidemia', 'I have hyperlipidemia'],
  ['hypothyroidism', 'I take levothyroxine for hypothyroidism'],
  ['Graves disease', 'I was told I have Graves'],
  ['gout', 'I get gout attacks'],
  ['adrenal insufficiency', "I have Addison's adrenal insufficiency"],

  // Autoimmune / inflammatory
  ['rheumatoid arthritis', 'I have rheumatoid arthritis'],
  ['lupus', 'I have lupus'],
  ['multiple sclerosis', 'I have multiple sclerosis'],
  ['Crohn disease', "I have Crohn's"],
  ['ulcerative colitis', 'I have ulcerative colitis'],
  ['psoriasis', 'I have psoriasis'],
  ['Sjogren syndrome', "I have Sjogren's syndrome"],
  ['celiac disease', 'I have celiac'],
  ['Hashimoto thyroiditis', "I have Hashimoto's"],

  // Neurodegenerative / cognitive
  ['Alzheimer disease', "My mother has Alzheimer's"],
  ['dementia', 'My father has dementia'],
  ['Parkinson disease', "My father has Parkinson's"],
  ['amyotrophic lateral sclerosis', "My uncle had Lou Gehrig's"],
  ['mild cognitive impairment', 'I have some mild cognitive impairment'],

  // Neurological
  ['migraine', 'I get migraines'],
  ['epilepsy', 'I have epilepsy'],
  ['chronic fatigue syndrome / ME', 'I have chronic fatigue syndrome'],
  ['chronic pain', 'I live with chronic pain'],

  // Respiratory / sleep
  ['asthma', 'I have asthma'],
  ['COPD', 'I have COPD'],
  ['insomnia', 'I have insomnia'],
  ['obstructive sleep apnea', 'I wear a CPAP for sleep apnea'],
  ['narcolepsy', 'I have narcolepsy'],

  // Renal
  ['chronic kidney disease', 'I have chronic kidney failure'],
  ['end-stage renal disease', 'I am on dialysis'],

  // Musculoskeletal / functional somatic
  ['fibromyalgia', 'I have fibromyalgia'],
  ['osteoarthritis', 'I have osteoarthritis'],
  ['osteoporosis', 'I have osteoporosis'],
  ['temporomandibular disorder', 'I have temporomandibular joint pain'],
  ['low back pain', 'I have chronic low back pain'],
  ['irritable bowel syndrome', 'I have irritable bowel syndrome'],
  ['GERD', 'I have acid reflux'],
  ['peptic ulcer', 'I had a peptic ulcer'],

  // Mental health
  ['PTSD', 'I have PTSD'],
  ['major depressive disorder', 'I have depression'],
  ['generalized anxiety disorder', 'I have anxiety'],
  ['bipolar disorder', 'I am bipolar'],
  ['panic disorder', 'I get panic attacks'],
  ['substance use disorder', "I've had trouble with alcohol"],

  // Oncologic / hematologic / infectious
  ['melanoma', 'I had a melanoma removed'],
  ['leukemia', 'My brother had leukemia'],
  ['anemia', 'I have anemia'],
  ['HIV', 'I am HIV positive'],
  ['hepatitis C', 'I had hepatitis C'],
  ['meningitis', 'I had meningitis'],
  ['endocarditis', 'I had endocarditis'],

  // Injury / trauma-adjacent
  ['traumatic brain injury', 'I had a traumatic brain injury'],
  ['concussion', 'I had a concussion last year'],
];

/**
 * The same literature vocabulary, asked about impersonally.
 *
 * These are keyword-free questions about a condition with no first-person or
 * family framing, so they classify as `health_topic_question`: the visitor
 * asked about a topic rather than telling us about their own health. They hand
 * off exactly like a disclosure; only the framing of the reply and the recorded
 * reason differ (asserted in the topic-question suite below).
 */
const LITERATURE_TOPIC_QUESTIONS: [condition: string, sentence: string][] = [
  ['metabolic syndrome', 'Is metabolic syndrome relevant here?'],
  ['ankylosing spondylitis', 'Do you know about ankylosing spondylitis?'],
];

describe('Health-data gate — conditions named in the PTSD literature', () => {
  test.each(LITERATURE_CONDITIONS)('%s → health_data', (condition, sentence) => {
    expect({ condition, result: detectSensitiveData(sentence) }).toEqual({
      condition,
      result: 'health_data',
    });
  });

  test.each(LITERATURE_TOPIC_QUESTIONS)(
    '%s asked about impersonally → health_topic_question',
    (condition, sentence) => {
      expect({ condition, result: detectSensitiveData(sentence) }).toEqual({
        condition,
        result: 'health_topic_question',
      });
    },
  );

  test.each(['hypertension', 'apnea', 'lupus', 'dementia', 'dialysis', 'asthma', 'fibromyalgia'])(
    'a bare condition term "%s" is enough to classify as health_data',
    (term) => {
      expect(detectSensitiveData(term)).toBe('health_data');
    },
  );

  test('the gate vocabulary is documented and reviewable', () => {
    expect(HEALTH_CONDITION_TERMS.length).toBeGreaterThan(40);
    expect(HEALTH_CONDITION_WORD_TERMS.length).toBeGreaterThan(10);
    // Hygiene over the combined lists — a derived spelling is a term like any
    // other, so it must be reviewable and unique within its bucket too.
    for (const term of [...ALL_CONDITION_GATE_TERMS, ...ALL_CONDITION_GATE_WORD_TERMS]) {
      expect(term.trim().toLowerCase()).toBe(term);
      expect(term.length).toBeGreaterThan(2);
    }
    // A term must live in exactly one bucket — the two patterns overlap by
    // design, but a duplicate entry means the wrong mode was chosen somewhere.
    const overlap = HEALTH_CONDITION_TERMS.filter((term) =>
      (HEALTH_CONDITION_WORD_TERMS as readonly string[]).includes(term),
    );
    expect(overlap).toEqual([]);
    // No bucket duplicates itself through derivation: every derived spelling
    // is genuinely new, and the derivation never collapses a hand-written term.
    expect(new Set(ALL_CONDITION_GATE_TERMS).size).toBe(ALL_CONDITION_GATE_TERMS.length);
    expect(new Set(ALL_CONDITION_GATE_WORD_TERMS).size).toBe(ALL_CONDITION_GATE_WORD_TERMS.length);
    expect(ALL_CONDITION_GATE_TERMS.length).toBeGreaterThan(HEALTH_CONDITION_TERMS.length);
  });

  test('documented exclusions are deliberate (tradeoff, not an accident)', () => {
    // Each of these collides with ordinary English or a name when matched as a
    // word, so the gate does not trip on it alone. Locked here so the tradeoff
    // is reviewed rather than silently changed.
    expect(GATE_EXCLUDED_TERMS).toEqual(
      expect.arrayContaining(['ms', 'ra', 'mi', 'uc', 'oa', 'pad', 'panic']),
    );
    for (const excluded of GATE_EXCLUDED_TERMS) {
      expect(ALL_CONDITION_GATE_TERMS).not.toContain(excluded);
      expect(ALL_CONDITION_GATE_WORD_TERMS).not.toContain(excluded);
      // And the gate genuinely does not trip on the excluded term alone.
      expect(isHealthConditionTerm(`I have ${excluded}`)).toBe(false);
    }
    // Excluded terms still reach the gate through the condition they belong to.
    expect(detectSensitiveData('I get panic attacks')).toBe('health_data');
    // And the contextual abbreviations are classified once framed as a
    // disclosure, even though the vocabulary matcher alone stays silent — the
    // split between "is a vocabulary term present" and "is this a disclosure"
    // is deliberate (see isHealthConditionTerm's docstring).
    expect(isHealthConditionTerm('I have MS')).toBe(false);
    expect(detectSensitiveData('I have MS')).toBe('health_data');
  });

  test('excluded abbreviations are still caught when framed as a disclosure', () => {
    // These cannot be standalone tokens (a title; a name; too short; "sleep";
    // or, for piles, a quantifier), so they are contextual: the term counts only
    // next to a disclosure or history word — keyword before the token OR after
    // it — and for piles, next to a clinical qualifier or a possessive too.
    expect(detectSensitiveData('I had a TIA last month')).toBe('health_data');
    expect(detectSensitiveData('history of TB')).toBe('health_data');
    expect(detectSensitiveData('I have MS')).toBe('health_data');
    expect(detectSensitiveData('I was diagnosed with MS in 2019')).toBe('health_data');
    expect(detectSensitiveData('my SLE is well controlled')).toBe('health_data');
    expect(detectSensitiveData('history of SLE')).toBe('health_data');
    // Token first, keyword second.
    expect(detectSensitiveData('MS diagnosis two years ago')).toBe('health_data');
    expect(detectSensitiveData('TB treatment finished in March')).toBe('health_data');
    expect(detectSensitiveData('SLE flares are rare for me')).toBe('health_data');
    // The mechanism itself, asserted directly.
    expect(hasContextQualifiedTerm('I have MS')).toBe(true);
    expect(hasContextQualifiedTerm('ask Ms. Smith for a quote')).toBe(false);
  });

  test('the lay synonym "piles" is closed: mapped, and gated only in context', () => {
    // The questionnaire sweep's last row. It closed as an alias on the
    // hemorrhoids entry (1.5.0) plus a context rule, because the ordinary sense
    // is a quantifier and gating the token outright would hand off "piles of
    // paperwork" — the same fail-safe trade the abbreviations make.
    expect(findCanonicalCondition('piles')?.icd10_cm).toBe('K64.9');
    expect(detectSensitiveData('I have piles')).toBe('health_data');
    expect(detectSensitiveData('my piles are back')).toBe('health_data');
    expect(detectSensitiveData('bleeding piles again')).toBe('health_data');
    expect(detectSensitiveData('piles treatment options')).toBe('health_data');
    expect(detectSensitiveData('Is piles curable?')).toBe('health_topic_question');
    expect(detectSensitiveData('piles of paperwork')).not.toBe('health_data');
    expect(detectSensitiveData('we have piles of data')).not.toBe('health_data');
    expect(detectSensitiveData('the work piles up')).not.toBe('health_data');
    expect(hasContextQualifiedTerm('piles of paperwork')).toBe(false);
    expect(hasContextQualifiedTerm('I have piles')).toBe(true);
  });

  test('the contextual rule does not fire on the collisions it exists to avoid', () => {
    // Each of these is why the abbreviation was excluded as a bare token, and
    // each must stay unclassified now that context can gate it.
    expect(detectSensitiveData('Can Ms. Smith call me about a quote?')).not.toBe('health_data');
    expect(detectSensitiveData('I have a question for Ms Smith')).not.toBe('health_data');
    expect(detectSensitiveData('the page loaded in 300 ms')).not.toBe('health_data');
    expect(detectSensitiveData('What is sleep hygiene?')).not.toBe('health_data');
    expect(detectSensitiveData("my daughter's name is Mia, not Tia")).not.toBe('health_data');
    expect(detectSensitiveData('I have trouble sleeping')).not.toBe('health_data');
    // A disclosure word in a different sentence must not chain to the token.
    expect(detectSensitiveData('I have a question. Ms. Smith can help.')).not.toBe('health_data');
  });

  test('whole-word tokens do not fire on ordinary words that contain them', () => {
    // The reason the short tokens are word-anchored rather than substrings.
    expect(isHealthConditionTerm('I read the archive')).toBe(false);
    expect(isHealthConditionTerm('we visited the gravestone')).toBe(false);
    expect(detectSensitiveData('I read the archive')).not.toBe('health_data');
  });
});

describe('Health-data gate — parity with the canonical condition vocabulary', () => {
  test('every canonical condition is recognised by the gate vocabulary', () => {
    // No probe may rely on this test's own wording: each condition must be
    // recognised either by the condition vocabulary or by the pre-existing
    // generic patterns, and never by nothing.
    const uncovered: string[] = [];
    for (const condition of CANONICAL_CONDITIONS) {
      const probes = [condition.name, ...condition.synonyms];
      const detected = probes.some(
        (probe) => isHealthConditionTerm(probe) || detectSensitiveData(probe) === 'health_data',
      );
      if (!detected) uncovered.push(`${condition.icd10_cm} ${condition.name}`);
    }
    expect(uncovered).toEqual([]);
  });

  test('very common conditions stay in the generic patterns and are not duplicated', () => {
    // These were already gated before the condition vocabulary existed, so they
    // are deliberately NOT duplicated in it. Locked here so the split between
    // "generic popular-condition list" and "condition vocabulary" stays
    // intentional: heart failure, PTSD, and generalised anxiety disorder are
    // recognised by the generic patterns alone.
    for (const term of ['heart', 'ptsd', 'anxiety', 'depression', 'cancer']) {
      expect(HEALTH_CONDITION_TERMS).not.toContain(term);
      expect(HEALTH_CONDITION_WORD_TERMS).not.toContain(term);
      expect(detectSensitiveData(term)).toBe('health_data');
    }
    expect(isHealthConditionTerm('heart failure')).toBe(false);
    expect(detectSensitiveData('heart failure')).toBe('health_data');
  });

  test('every synonym in the shared vocabulary is gated or explicitly excluded', () => {
    // The strong invariant: adding a condition to the vocabulary the broker
    // matches against can never silently create a gate hole. Either the phrase
    // is classified as health data, or it is on the documented exclusion list
    // of abbreviations and ambiguous symptom words.
    const ungated: string[] = [];
    for (const condition of CANONICAL_CONDITIONS) {
      for (const synonym of condition.synonyms) {
        const gated = detectSensitiveData(synonym) === 'health_data';
        const excluded = (GATE_EXCLUDED_TERMS as readonly string[]).includes(synonym);
        if (!gated && !excluded) ungated.push(`${condition.icd10_cm} "${synonym}"`);
      }
    }
    expect(ungated).toEqual([]);
  });

  test('every gate vocabulary term maps to a condition or is documented as descriptive', () => {
    // The completion invariant, and the reverse of the one above: a term the
    // gate watches for can never be a condition with no canonical entry. A term
    // is accounted for when it appears in a canonical name or alias, or when it
    // is on the documented descriptive list. This is what makes the vocabulary
    // auditable for "nothing left to map" — add a condition term to the gate and
    // the build fails until the crosswalk carries it.
    const accounted = CANONICAL_CONDITIONS.map((condition) => {
      // Every spelling the mechanism claims, not just the curated wording —
      // since 1.15.0 an alias reaches its code in its declared spellings, so
      // a derived gate spelling is accounted by the same alias its sibling is.
      const spellings = [condition.name, ...condition.synonyms].flatMap((alias) => [
        alias.toLowerCase(),
        ...spellingVariantKeys(alias),
      ]);
      return spellings.join(' | ');
    });
    const unaccounted: string[] = [];
    for (const term of [...ALL_CONDITION_GATE_TERMS, ...ALL_CONDITION_GATE_WORD_TERMS]) {
      if (DESCRIPTIVE_GATE_TERMS.includes(term)) continue;
      if (!accounted.some((haystack) => haystack.includes(term))) unaccounted.push(term);
    }
    expect(unaccounted).toEqual([]);
  });

  test('descriptive gate terms are genuinely not condition names', () => {
    // If one of these ever becomes a real diagnosis in the vocabulary, it must
    // leave the descriptive list rather than being silently double-counted.
    const descriptive = new Set(DESCRIPTIVE_GATE_TERMS);
    for (const condition of CANONICAL_CONDITIONS) {
      for (const probe of [condition.name, ...condition.synonyms]) {
        expect(descriptive.has(probe.toLowerCase())).toBe(false);
      }
    }
  });

  test('every canonical condition is also classified as health_data when stated', () => {
    const uncovered: string[] = [];
    for (const condition of CANONICAL_CONDITIONS) {
      const stated = condition.synonyms[0] ?? condition.name;
      const detected = detectSensitiveData(`I have ${stated}`) === 'health_data';
      if (!detected) uncovered.push(`${condition.icd10_cm} ${condition.name} ("${stated}")`);
    }
    expect(uncovered).toEqual([]);
  });
});

describe('Health-data gate — specificity (fail-safe, not fail-anything)', () => {
  test('classification is a pure function of the text, however often it is called', () => {
    // Guards the failure mode a one-off flake usually turns out to be: a stateful
    // regex (`lastIndex` on a `g` flag) or a module-level counter that makes the
    // same sentence classify differently on the 200th call than on the first.
    // The classification has to be a function of the text alone, so this is
    // asserted rather than argued from reading the pattern list.
    for (const message of [
      'retail therapy',
      'the weight of the evidence favours the insurer',
      'I have hypertension',
    ]) {
      const first = detectSensitiveData(message);
      for (let i = 0; i < 200; i++) {
        expect({ message, call: i, actual: detectSensitiveData(message) }).toEqual({
          message,
          call: i,
          actual: first,
        });
      }
    }
  });

  test.each([
    'What is term life insurance?',
    'How much coverage do I need?',
    'What factors affect life insurance cost?',
    'Is a medical exam required for final expense insurance?',
    'What are the TDI advertising rules?',
    'Does a 20-year term policy expire?',
    'Can I change the beneficiary later?',
  ])('educational question is not classified as health_data: %s', (message) => {
    expect(detectSensitiveData(message)).not.toBe('health_data');
  });

  test('financial-account data still wins over a condition term', () => {
    // Ordering rule: financial identifiers must never reach the model, even
    // when the same message names a condition.
    expect(detectSensitiveData('I have lupus and my account number is 1234567890')).toBe(
      'financial_account_data',
    );
  });
});

// ── Questions about a condition: a topic, not a disclosure ──────────────────

/**
 * A question about a condition is classified as `health_topic_question` rather
 * than `health_data`, and it hands off either way.
 *
 * The distinction is not cosmetic. `health_data` means the visitor told us
 * something about their own health: the reply asks them not to share diagnoses,
 * the message is redacted as a disclosure, and the record carries a
 * health-data risk flag. A visitor who asked "Is TB curable?" did none of
 * those things, so describing the event that way misstates both the reply and
 * the compliance record. Answering it is still clinical or underwriting
 * guidance, so it still goes to the licensed broker, and a later turn still
 * must not put the condition in front of the model.
 *
 * The dividing line is first-person framing: "does MS affect MY rate?" brings
 * the visitor in (an implied condition — still a disclosure), while "does MS
 * affect life insurance rates?" does not (a topic).
 */
describe('Health-topic questions are classified apart from health disclosures', () => {
  test.each([
    'Is TB curable?',
    'What does TIA stand for?',
    'Does MS show up in a blood test?',
    'What is lupus?',
    'How is cancer treated?',
    'does MS affect life insurance rates?',
    'Is tuberculosis contagious?',
    'What is multiple sclerosis?',
  ])('impersonal question about a condition: %s', (message) => {
    expect(detectSensitiveData(message)).toBe('health_topic_question');
    expect(detectHealthTopicQuestion(message)).toBe(true);
  });

  test.each([
    'does MS affect my life insurance rate?',
    'do I have MS?',
    'does my father have MS?',
    'Is my lupus controlled?',
    'can I get life insurance with lupus?',
    'I have MS — does that rule me out?',
  ])('first-person framing keeps it a disclosure: %s', (message) => {
    expect(detectSensitiveData(message)).toBe('health_data');
    expect(detectHealthTopicQuestion(message)).toBe(false);
  });

  test.each([
    'Is life insurance taxable?',
    'What is the difference between term and whole life insurance?',
    'How much coverage do I need?',
    'Is a medical exam required for final expense insurance?',
    'Can Ms. Smith call me about a quote?',
    'Is Tia coming to the appointment?',
    'How much latency is 300 ms?',
  ])('a question with no condition reference is untouched: %s', (message) => {
    expect(detectSensitiveData(message)).toBeNull();
    expect(detectHealthTopicQuestion(message)).toBe(false);
  });

  test('a disclosure fragment with a question mark stays a disclosure', () => {
    // The rule requires a LEADING interrogative, so a fragment that merely ends
    // in "?" does not get the softer framing.
    expect(detectSensitiveData('history of SLE?')).toBe('health_data');
    expect(detectSensitiveData('MS?')).not.toBe('health_topic_question');
  });

  test('the guard that protects the name "Tia" protects it here too', () => {
    expect(detectSensitiveData('Is Tia coming to the appointment?')).toBeNull();
    expect(detectHealthTopicQuestion('Is TIA hereditary?')).toBe(true);
  });
});

// ── Endpoint level: the gate is enforced, and only in the consented state ────

interface LoadedApp {
  app: Express;
  cleanup: () => Promise<void>;
}

/** Loads a fresh app with the given health-capture flag and a temp lead log. */
async function loadApp(flagValue: string): Promise<LoadedApp> {
  jest.resetModules();
  const previous = { ...process.env };
  process.env.HEALTH_DATA_COLLECTION_DISABLED = flagValue;
  process.env.LIFECHAT_PORT = '0';
  process.env.LLM_API_KEY = '';
  const leadLogPath = tempLogPath('lead-gate-test');
  process.env.LEAD_LOG_PATH = leadLogPath;

  const { app, server } = (await import('../src/index')) as {
    app: Express;
    server: Server;
  };

  return {
    app,
    cleanup: () =>
      new Promise<void>((resolve) => {
        // Remove the record log this instance wrote, then restore the env.
        cleanupTempLogs(leadLogPath);
        for (const key of [
          'HEALTH_DATA_COLLECTION_DISABLED',
          'LIFECHAT_PORT',
          'LLM_API_KEY',
          'LEAD_LOG_PATH',
        ]) {
          if (previous[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = previous[key];
          }
        }
        server.close(() => resolve());
      }),
  };
}

const BLOCK_MESSAGE = "This chat isn't the right place for medical or health information.";

describe('/api/chat — education state blocks condition disclosures with a handoff', () => {
  let loaded: LoadedApp;

  // A FRESH app per test, not one per describe. `loadApp()` resets the module
  // registry, so "fresh" means fresh module state: one rate-limit store, one
  // session store, one page-context bridge, one kill switch, none of them
  // carried over from the tests that ran before. Nothing in the gate reads those
  // — but a shared instance makes every test's outcome depend on how many
  // requests ran first, and an endpoint test whose result depends on its
  // position in the file cannot be trusted to fail for its own reason.
  beforeEach(async () => {
    loaded = await loadApp('');
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  test.each([
    ['hypertension', 'I have hypertension'],
    ['sleep apnea', 'I wear a CPAP for sleep apnea'],
    ['lupus', 'I have lupus'],
    ['dementia', 'My father has dementia'],
    ['dialysis', 'I am on dialysis'],
    ['fibromyalgia', 'I have fibromyalgia'],
    // Contextual abbreviations: excluded as bare tokens, classified by context.
    ['multiple sclerosis (MS)', 'I have MS'],
    ['lupus (SLE)', 'history of SLE'],
    // The measurement-driven additions: a diagnosis, a treatment relationship
    // and the informal medication form, none of which name a condition, so
    // nothing but the pattern for that word can carry them.
    ['diagnosis', 'I was diagnosed last year'],
    ['therapy', "I'm in therapy"],
    ['therapist', 'I see a therapist twice a week'],
    ['meds', 'I stopped taking my meds'],
    // The lifestyle and body-measure fields, none of which name a condition —
    // including the bare-field and verb forms the old noun-only stems missed.
    ['weight', 'my weight is 180 pounds'],
    ['weigh', 'I weigh 180 pounds'],
    ['weighed at a clinic', 'I was weighed at the clinic'],
    ['tobacco', 'tobacco'],
    ['alcohol', 'I drink alcohol occasionally'],
    ['smoker', 'my father was a smoker'],
    // The mirror-image pass: three coverage gaps and one product-name carve-out.
    ['smoking', 'I smoke'],
    ['stopped drinking', 'I stopped drinking'],
    ['on stress leave', 'I am on stress leave'],
    ['long-term illness', 'I have a long-term illness'],
  ])('blocks %s disclosed in education', async (label, message) => {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({
        sessionId: `gate-edu-${label.replace(/\s+/g, '-')}`,
        currentState: 'education',
        message,
      });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('handoff');
    expect(res.body.risk_flags).toContain('sensitive_data_disclosed');
    expect(res.body.proposed_action).toBe('request_human_handoff');
    expect(res.body.assistant_message).toContain(BLOCK_MESSAGE);
  });

  test('does not block an ordinary educational question', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'gate-edu-control',
      currentState: 'education',
      message: 'What is the difference between term and whole life insurance?',
    });
    expect(res.status).toBe(200);
    expect(res.body.risk_flags).not.toContain('sensitive_data_disclosed');
    expect(res.body.assistant_message).not.toContain(BLOCK_MESSAGE);
  });

  test.each([
    ['mechanism diagnosis', 'can you diagnose why my quote never arrived?'],
    ['fault diagnosis', 'the problem was diagnosed as a timing issue'],
    ['retail therapy', 'I did some retail therapy at the weekend'],
    ['aromatherapy business', 'I run an aromatherapy business on the side'],
    ['massage therapist', 'I am a massage therapist'],
    ['figurative weight', 'does my occupation carry any weight?'],
    ['weighting', 'is there a weighted average of these factors?'],
    ['figurative height', 'at the height of the market rates were lower'],
    ['no substance', 'there is no substance to that claim'],
    ['tobacco company', 'I work at a tobacco company'],
    ['alcohol licence', 'does the alcohol licence cost extra?'],
    ['barbecue smoker', 'I cook on a pellet smoker'],
    ['smoke damage', 'does the policy cover smoke damage?'],
    ['critical illness cover', 'does it include critical illness cover?'],
    ['drinking water', 'I drink plenty of water'],
    ['stress of moving', 'the stress of moving house is enough'],
    ['stress-test', 'can you stress-test the numbers?'],
    ['ill-advised', 'that is ill-advised'],
  ])('does not block the ordinary sense of a health word: %s', async (label, message) => {
    // The other half of the measured narrowing, through the real endpoint: these
    // sentences contain a health word in its ordinary sense and must reach the
    // model rather than being handed off with "don't share diagnoses" copy.
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({
        sessionId: `gate-edu-meta-${label.replace(/\s+/g, '-')}`,
        currentState: 'education',
        message,
      });
    // ONE object comparison, deliberately: a failure prints the status, the
    // state, the flags and the reply together. This test failed once in a full
    // suite run and passed in every rerun, and one field at a time is not enough
    // evidence to diagnose that from — so the error body is carried too.
    expect({
      label,
      status: res.status,
      state: res.body.state,
      risk_flags: res.body.risk_flags,
      assistant_message: res.body.assistant_message,
      error_body: res.status === 200 ? undefined : res.body,
    }).toEqual({
      label,
      status: 200,
      state: expect.not.stringMatching(/handoff/),
      risk_flags: expect.not.arrayContaining(['sensitive_data_disclosed']),
      assistant_message: expect.not.stringContaining(BLOCK_MESSAGE),
      error_body: undefined,
    });
  });

  test('the same benign message classifies identically however many requests came before it', async () => {
    // The property the one-off failure violated, asserted directly: an ordinary
    // sentence must not become a disclosure because of request order, session
    // reuse or any module-level counter. Each request gets its own session, and
    // an extra one reuses a session on purpose to read the same answer twice.
    const message = 'I did some retail therapy at the weekend';
    const states: string[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(loaded.app)
        .post('/api/chat')
        .send({
          sessionId: i < 11 ? `gate-order-${i}` : 'gate-order-0',
          currentState: 'education',
          message,
        });
      states.push(`${res.status}:${String(res.body.state)}`);
    }
    expect(new Set(states).size).toBe(1);
    expect(states[0]).not.toContain('handoff');
  });

  test('the gate the endpoint runs agrees with the gate this file imported', async () => {
    // `loadApp()` resets the module registry, so the app runs a NEWER instance of
    // the security module than the one imported at the top of this file. If the
    // two ever classified differently, every unit assertion in this file would be
    // describing a gate the endpoint does not run — so the agreement is asserted
    // rather than assumed.
    const fresh = await import('../src/security/security-controls');
    for (const message of [
      'I have hypertension',
      'I did some retail therapy at the weekend',
      'the weight of the evidence favours the insurer',
      'does it include critical illness cover?',
      'I smoke',
    ]) {
      expect({ message, fresh: fresh.detectSensitiveData(message) }).toEqual({
        message,
        fresh: detectSensitiveData(message),
      });
    }
  });
});

describe('/api/chat — the same disclosure is accepted only in consented medical_review', () => {
  let loaded: LoadedApp;

  // Fresh app per test — see the isolation note in the first /api/chat describe.
  beforeEach(async () => {
    loaded = await loadApp('false');
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  test('a condition term is still not blocked in medical_review, and still blocked in education', async () => {
    const inReview = await request(loaded.app).post('/api/chat').send({
      sessionId: 'gate-review-lupus',
      currentState: 'medical_review',
      message: 'I have lupus',
    });
    expect(inReview.status).toBe(200);
    expect(inReview.body.risk_flags).not.toContain('sensitive_data_disclosed');
    expect(inReview.body.assistant_message).not.toContain(BLOCK_MESSAGE);

    const inEducation = await request(loaded.app).post('/api/chat').send({
      sessionId: 'gate-review-edu-lupus',
      currentState: 'education',
      message: 'I have lupus',
    });
    expect(inEducation.status).toBe(200);
    expect(inEducation.body.state).toBe('handoff');
    expect(inEducation.body.risk_flags).toContain('sensitive_data_disclosed');
  });
});

describe('/api/chat — a health topic question hands off without being logged as a disclosure', () => {
  let loaded: LoadedApp;

  // Fresh app per test — see the isolation note in the first /api/chat describe.
  beforeEach(async () => {
    loaded = await loadApp('');
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  test.each([
    ['TB', 'Is TB curable?'],
    ['TIA', 'What does TIA stand for?'],
    ['MS', 'Does MS show up in a blood test?'],
    ['cancer', 'How is cancer treated?'],
  ])('hands off %s as a topic question, not a disclosure', async (label, message) => {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId: `topic-${label}`, currentState: 'education', message });

    expect(res.status).toBe(200);
    // Same safety: no answer from the model, deterministic handoff.
    expect(res.body.state).toBe('handoff');
    expect(res.body.proposed_action).toBe('request_human_handoff');
    expect(res.body.action_arguments.handoff_reason).toBe('health_topic_question');

    // Different record: a question about a topic is not a health-data event.
    expect(res.body.risk_flags).toContain('health_topic_question');
    expect(res.body.risk_flags).not.toContain('sensitive_data_disclosed');

    // Different framing: the visitor is not told they disclosed anything.
    expect(res.body.assistant_message).not.toContain(BLOCK_MESSAGE);
    expect(res.body.assistant_message).not.toMatch(/don't share/i);
    expect(res.body.assistant_message).toContain('licensed Texas broker');
  });

  test('an impersonal question is still never answered by the model', async () => {
    // The handoff reason is what proves the block fired before the LLM call:
    // with no LLM key configured, a request that got through to the model would
    // come back as the abstention path instead of a handoff.
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId: 'topic-no-model', currentState: 'education', message: 'Is TB curable?' });
    expect(res.body.analytics.event_name).toBe('ai_handoff_request');
    expect(res.body.action_arguments.handoff_reason).toBe('health_topic_question');
    expect(res.body.assistant_message).not.toMatch(/culture|antibiotic|latent/i);
  });

  test('a personal question about the same condition is still a disclosure', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'topic-personal',
      currentState: 'education',
      message: 'does MS affect my life insurance rate?',
    });
    expect(res.body.risk_flags).toContain('sensitive_data_disclosed');
    expect(res.body.risk_flags).not.toContain('health_topic_question');
    expect(res.body.assistant_message).toContain(BLOCK_MESSAGE);
  });
});

describe('/api/chat — a topic question is accepted in consented medical_review only', () => {
  let loaded: LoadedApp;

  // Fresh app per test — see the isolation note in the first /api/chat describe.
  beforeEach(async () => {
    loaded = await loadApp('false');
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  test('medical_review accepts it, education hands it off', async () => {
    const inReview = await request(loaded.app).post('/api/chat').send({
      sessionId: 'topic-review',
      currentState: 'medical_review',
      message: 'Is TB curable?',
    });
    expect(inReview.status).toBe(200);
    expect(inReview.body.risk_flags).not.toContain('health_topic_question');

    const inEducation = await request(loaded.app).post('/api/chat').send({
      sessionId: 'topic-review-edu',
      currentState: 'education',
      message: 'Is TB curable?',
    });
    expect(inEducation.body.state).toBe('handoff');
    expect(inEducation.body.risk_flags).toContain('health_topic_question');
  });
});

// ── The declared scope is closed: mapped, gated, and recorded in the release ──

/**
 * The 1.3.0 residual scope — the carrier-relevant chronic rows that a boundary
 * probe found were **neither gated nor mapped**, i.e. a disclosure of them
 * travelled to the model untouched and could not be matched afterwards.
 *
 * Rows enter here only if they are a named diagnosis rather than a symptom, an
 * acute self-limited infection, or an injury. Those three categories stay out
 * of the vocabulary on purpose (see the out-of-scope list in the CAPTURE_SCOPE
 * comment) and are covered by the gate's generic patterns where they matter.
 */
const RESIDUAL_SCOPE: readonly {
  domain: string;
  conditions: readonly (readonly [phrase: string, code: string])[];
}[] = [
  {
    domain: 'Venous / spinal / electrolyte / hematologic',
    conditions: [
      ['varicose veins', 'I83.90'],
      ['sciatica', 'M54.30'],
      ['hyperkalemia', 'E87.5'],
      ['vitamin b12 deficiency', 'D51.9'],
      ['hemochromatosis', 'E83.110'],
    ],
  },
  {
    domain: 'Inherited connective-tissue and neurologic',
    conditions: [
      ['g6pd deficiency', 'D55.0'],
      ['ehlers-danlos syndrome', 'Q79.60'],
      ['marfan syndrome', 'Q87.40'],
      ["bell's palsy", 'G51.0'],
      ['cluster headache', 'G44.009'],
    ],
  },
  {
    domain: 'Shoulder, foot, obstetric, ophthalmic',
    conditions: [
      ['frozen shoulder', 'M75.00'],
      ['flat feet', 'M21.40'],
      ['bunions', 'M20.10'],
      ['preeclampsia', 'O14.90'],
      ['dry eye syndrome', 'H04.129'],
    ],
  },
  {
    domain: 'Skin, menopausal state, minor surgical',
    conditions: [
      ['menopause', 'N95.1'],
      ['lichen planus', 'L43.9'],
      ['hemangioma', 'D18.00'],
      ['plantar wart', 'B07.0'],
      ['chalazion', 'H00.1'],
    ],
  },
  {
    domain: 'Vascular spasm, thyroid, tremor, breast, anal',
    conditions: [
      ['raynauds phenomenon', 'I73.00'],
      ['goiter', 'E04.9'],
      ['essential tremor', 'G25.0'],
      ['fibrocystic breast changes', 'N60.29'],
      ['anal fissure', 'K60.2'],
    ],
  },
  {
    domain: 'Pre-malignant, hernia, bladder pain, skin, prolapse',
    conditions: [
      ['barretts esophagus', 'K22.70'],
      ['inguinal hernia', 'K40.90'],
      ['interstitial cystitis', 'N30.10'],
      ['actinic keratosis', 'L57.0'],
      ['uterine prolapse', 'N81.4'],
    ],
  },
  {
    domain: 'Menstrual, intolerance, renal, dermatologic',
    conditions: [
      ['dysmenorrhea', 'N94.6'],
      ['pms', 'N94.3'],
      ['lactose intolerance', 'E73.9'],
      ['kidney cyst', 'N28.1'],
      ['seborrheic dermatitis', 'L21.9'],
    ],
  },
  {
    domain: 'Minor soft-tissue and dermatologic',
    conditions: [
      ['ganglion cyst', 'M67.40'],
      ['tennis elbow', 'M77.10'],
      ['trigger finger', 'M65.30'],
      ['bursitis', 'M71.9'],
      ['contact dermatitis', 'L23.9'],
      ['anal fistula', 'K60.3'],
    ],
  },
];

/**
 * The 1.4.0 questionnaire-sweep scope — the named diagnoses a 237-phrase
 * carrier-questionnaire probe (2026-09-19) found were neither gated nor mapped.
 *
 * Rows enter here only if they are a named diagnosis; the sweep's procedure
 * states, acute infections, and symptoms became documented descriptive gate
 * terms instead (see DESCRIPTIVE_GATE_TERMS), so the vocabulary stays what it
 * claims to be — diagnosed conditions, not surgical history.
 */
const PROBE_GAP_SCOPE: readonly {
  domain: string;
  conditions: readonly (readonly [phrase: string, code: string])[];
}[] = [
  {
    domain: 'Cardiac muscle, rhythm, and lipids',
    conditions: [
      ['cardiomyopathy', 'I42.9'],
      ['myocarditis', 'I40.9'],
      ['pericarditis', 'I30.9'],
      ['supraventricular tachycardia', 'I47.9'],
      ['high triglycerides', 'E78.1'],
    ],
  },
  {
    domain: 'Electrolyte, androgen, and parathyroid',
    conditions: [
      ['hyponatremia', 'E87.1'],
      ['hypercalcemia', 'E83.52'],
      ['high uric acid', 'E79.0'],
      ['low testosterone', 'E29.1'],
      ['hypoparathyroidism', 'E20.9'],
    ],
  },
  {
    domain: 'Renal, airway, pleural, and gastric',
    conditions: [
      ['glomerulonephritis', 'N05.9'],
      ['nasal polyps', 'J33.9'],
      ['pleurisy', 'R09.1'],
      ['collapsed lung', 'J93.9'],
      ['gastroparesis', 'K31.84'],
    ],
  },
  {
    domain: 'Headache, movement, cerebrospinal, and retinal',
    conditions: [
      ['tension headache', 'G44.209'],
      ['tourette syndrome', 'F95.2'],
      ['hydrocephalus', 'G91.9'],
      ['muscular dystrophy', 'G71.0'],
      ['retinal detachment', 'H33.20'],
    ],
  },
  {
    domain: 'Congenital and hematologic',
    conditions: [
      ['cleft palate', 'Q35.9'],
      ['club foot', 'Q66.89'],
      ['turner syndrome', 'Q96.9'],
      ['fragile x syndrome', 'Q99.2'],
      ['polycythemia', 'D45'],
    ],
  },
  {
    domain: 'Dermatologic, lymphatic, urologic, and viral',
    conditions: [
      ['acne', 'L70.0'],
      ['keloid', 'L91.0'],
      ['lymphedema', 'I89.0'],
      ['varicocele', 'I86.1'],
      ['herpes', 'B00.9'],
    ],
  },
];

/**
 * The 1.6.0 critical-illness scope — the named diagnoses the carrier
 * covered-condition lists (the ten a specific plan covers, the standard thirty,
 * and the expanded thirty-six) surfaced as neither gated nor mapped.
 *
 * Rows enter here only if the list names a diagnosis; its procedure rows
 * (bypass, transplant, valve surgery), injury rows (burns, head trauma) and
 * functional rows (blindness, loss of speech) are gated descriptively instead,
 * so the vocabulary stays what it claims to be.
 */
const CRITICAL_ILLNESS_SCOPE: readonly {
  domain: string;
  conditions: readonly (readonly [phrase: string, code: string])[];
}[] = [
  {
    domain: 'CNS infection, movement, and coma',
    conditions: [
      ['encephalitis', 'A86'],
      ['poliomyelitis', 'A80.9'],
      ['bacterial meningitis', 'G00.9'],
      ['motor neurone disease', 'G12.29'],
      ['coma', 'R40.20'],
    ],
  },
  {
    domain: 'Paralysis, hepatic failure, blood, and tumour',
    conditions: [
      ['paraplegia', 'G82.20'],
      ['end stage liver failure', 'K72.90'],
      ['chronic liver disease', 'K76.9'],
      ['aplastic anaemia', 'D61.9'],
      ['benign brain tumour', 'D33.2'],
    ],
  },
];

/**
 * The 1.7.0 ICD-10 Chapter IX scope — the named diagnoses the WHO tabular
 * list's three-character category titles surfaced as neither gated nor mapped.
 *
 * This is the first codebook enumeration used as a source, and the two holes it
 * found are worth naming: the vocabulary carried only the American spelling of
 * haemorrhage (so a British visitor's "subarachnoid haemorrhage" and
 * "haemorrhoids" were both silent), and it carried "stroke" but not "cerebral
 * infarction". The category constructs the chapter also enumerates ("other
 * diseases of pericardium") are gated descriptively, not coded.
 */
const ICD10_CHAPTER_IX_SCOPE: readonly {
  domain: string;
  conditions: readonly (readonly [phrase: string, code: string])[];
}[] = [
  {
    domain: 'Haemorrhagic stroke and its spellings',
    conditions: [
      ['subarachnoid haemorrhage', 'I60.9'],
      ['intracerebral haemorrhage', 'I61.9'],
      ['nontraumatic intracranial haemorrhage', 'I62.9'],
      ['phlebitis', 'I80.9'],
      ['nonspecific lymphadenitis', 'I88.9'],
    ],
  },
  {
    domain: 'Conduction',
    conditions: [['atrioventricular block', 'I44.30']],
  },
];

/**
 * The 1.8.0 stone-family scope — the diagnoses the syntactic-collision sweep
 * left protected but unmatchable, plus the spelling it measured.
 *
 * The `stones` registry entry closed the gate side one release earlier: a
 * disclosure of "bladder stones" or "ureteral stones" is health data, but
 * neither had a canonical code, so a consented mapping returned them in the
 * person's own words (`gated, not mapped` in the sweep). This release gives
 * each its own row. `gall stone` — the two-word spelling the 1.4.0
 * questionnaire corpus had carried only as the one-word "gallstones" — lands
 * on the existing K80.20 row as an alias and is asserted in the ledger test
 * rather than counted here, the way the 1.6.0 and 1.7.0 alias rows are.
 */
const STONE_FAMILY_SCOPE: readonly {
  domain: string;
  conditions: readonly (readonly [phrase: string, code: string])[];
}[] = [
  {
    domain: 'Upper and lower urinary tract calculi',
    conditions: [
      ['bladder stones', 'N21.0'],
      ['ureteral stones', 'N20.1'],
    ],
  },
];

/**
 * The 1.9.0 ICD-10 Chapter XIV scope — the named diagnoses the three-character
 * category titles of N00–N99 (diseases of the genitourinary system) surfaced as
 * neither gated nor mapped. Six batches of five, and the chapter the stone
 * family itself sits in.
 *
 * The sweep asked every row as written and as a disclosure, so this scope is
 * its work queue rather than a reading of the codebook: the nephritic syndrome
 * family (N00–N06, whose unspecified members already carried N04.9 and N05.9),
 * acute pyelonephritis and the tubulo-interstitial rows, kidney failure, the
 * calculi and obstruction rows, cystitis and the neurogenic bladder, the male
 * genital infections, then the breast, female pelvic and reproductive rows.
 *
 * Two kinds of row are deliberately NOT here. Category constructs ("other
 * disorders of the bladder") are gated descriptively. And urethral stricture is
 * gated rather than coded because FY2026 split it into sex-specific billable
 * codes (N35.91 male / N35.92 female) — a code would have to guess the
 * visitor's sex, which the crosswalk never does.
 */
const ICD10_CHAPTER_XIV_SCOPE: readonly {
  domain: string;
  conditions: readonly (readonly [phrase: string, code: string])[];
}[] = [
  {
    domain: 'Nephritic syndromes and isolated proteinuria',
    conditions: [
      ['acute nephritic syndrome', 'N00.9'],
      ['rapidly progressive nephritic syndrome', 'N01.9'],
      ['recurrent and persistent hematuria', 'N02.9'],
      ['chronic nephritic syndrome', 'N03.9'],
      ['isolated proteinuria', 'N06.9'],
    ],
  },
  {
    domain: 'Tubulo-interstitial nephritis and kidney failure',
    conditions: [
      ['acute pyelonephritis', 'N10'],
      ['chronic tubulo-interstitial nephritis', 'N11.9'],
      ['tubulo-interstitial nephritis', 'N12'],
      ['acute kidney failure', 'N17.9'],
      ['kidney failure', 'N19'],
    ],
  },
  {
    domain: 'Obstructive uropathy, calculi and the bladder',
    conditions: [
      ['obstructive and reflux uropathy', 'N13.9'],
      ['calculus of lower urinary tract', 'N21.9'],
      ['renal colic', 'N23'],
      ['cystitis', 'N30.90'],
      ['neurogenic bladder', 'N31.9'],
    ],
  },
  {
    domain: 'Urethra and the male genital organs',
    conditions: [
      ['urethritis', 'N34.1'],
      ['hydrocele', 'N43.3'],
      ['spermatocele', 'N43.40'],
      ['epididymitis', 'N45.1'],
      ['orchitis', 'N45.2'],
    ],
  },
  {
    domain: 'Breast and female pelvic organs',
    conditions: [
      ['benign mammary dysplasia', 'N60.99'],
      ['breast hypertrophy', 'N62'],
      ['breast lump', 'N63.0'],
      ['salpingitis', 'N70.91'],
      ['oophoritis', 'N70.92'],
    ],
  },
  {
    domain: 'Female genital tract, cervix and reproductive loss',
    conditions: [
      ['disease of bartholins gland', 'N75.9'],
      ['female genital prolapse', 'N81.9'],
      ['cervical erosion', 'N86'],
      ['cervical dysplasia', 'N87.9'],
      ['recurrent pregnancy loss', 'N96'],
    ],
  },
];

/**
 * Every term the two boundary probes surfaced, kept verbatim so the closure can
 * be re-measured rather than re-argued.
 *
 * The test below asserts the claim that actually matters for compliance: every
 * one of these is **either mapped to a canonical condition or classified as
 * health data** — nothing here travels to the model untouched. A row may be
 * gated without a code (acute infections, injuries, symptoms, dental and
 * cosmetic findings are deliberately uncoded, see DESCRIPTIVE_GATE_TERMS), but
 * silence is not an allowed outcome.
 */
const BOUNDARY_PROBE_TERMS: readonly string[] = [
  // Probe 1 — the first boundary sweep (2026-09-18)
  "bell's palsy",
  'menieres disease',
  'mononucleosis',
  'urinary tract infection',
  'anal fissure',
  'plantar wart',
  'chalazion',
  'hemangioma',
  'lichen planus',
  'pelvic inflammatory disease',
  'varicose veins',
  'fibrocystic breast',
  'hypoparathyroidism',
  'hyperkalemia',
  'hypoglycemia',
  'vitamin b12 deficiency',
  'sickle cell trait',
  'thalassemia trait',
  'hemochromatosis',
  'g6pd deficiency',
  'gestational diabetes',
  'preeclampsia',
  'cellulitis',
  'clostridium difficile',
  'sciatica',
  'frozen shoulder',
  'bunions',
  'flat feet',
  'dry eye',
  'cluster headache',
  'ehlers-danlos syndrome',
  'marfan syndrome',
  'menopause',
  'fracture of the wrist',
  'brain fog',
  // Probe 2 — the wider sweep
  'raynauds',
  'barretts esophagus',
  'gingivitis',
  'tennis elbow',
  'trigger finger',
  'ganglion cyst',
  'bursitis',
  'essential tremor',
  'uterine prolapse',
  'dysmenorrhea',
  'goiter',
  'anal fistula',
  'dental caries',
  'lactose intolerance',
  'interstitial cystitis',
  'seborrheic dermatitis',
  'contact dermatitis',
  'actinic keratosis',
  'skin tags',
  'bakers cyst',
  'kyphosis',
  'strabismus',
  'otosclerosis',
  'pms',
  'irregular periods',
  'ear infection',
  'tendonitis',
  'inguinal hernia',
  'kidney cyst',
  // Probe 3 — the questionnaire sweep (2026-09-19): 237 candidate phrases
  // drawn from carrier medical-history questionnaires, 55 of which were neither
  // mapped nor gated. All 55 are closed: 28 became canonical conditions, 2
  // aliases, 24 descriptive gate terms, and 'piles' became an alias plus a
  // context rule (1.5.0) — the row whose ordinary sense is a quantifier.
  'irregular heartbeat',
  'cardiomyopathy',
  'myocarditis',
  'pericarditis',
  'stent',
  'pacemaker',
  'angioplasty',
  'high triglycerides',
  'low testosterone',
  'high calcium',
  'low sodium',
  'high uric acid',
  'nasal polyps',
  'snoring',
  'shortness of breath',
  'pleurisy',
  'collapsed lung',
  'gastroparesis',
  'glomerulonephritis',
  'urine infection',
  'varicocele',
  'tension headache',
  'tourette syndrome',
  'hydrocephalus',
  'dizziness',
  'hip replacement',
  'knee replacement',
  'muscular dystrophy',
  'drug addiction',
  'acne',
  'fungal nail infection',
  'keloid',
  'retinal detachment',
  'conjunctivitis',
  'sinus infection',
  'tonsillitis',
  'laryngitis',
  'polycythemia',
  'herpes',
  'hpv',
  'syphilis',
  'gonorrhea',
  'chlamydia',
  'malaria',
  'cleft palate',
  'club foot',
  'turner syndrome',
  'fragile x syndrome',
  'lymphedema',
  'blood transfusion',
  'organ transplant',
  'hysterectomy',
  'tonsillectomy',
  'appendectomy',
  'piles',
];

/**
 * Declared scopes, one per release that added conditions.
 *
 * Every scope is enforced the same way: each phrase must resolve to the exact
 * code beside it and be gated, and each scope's code list must equal that
 * release's `added` list. A new release that adds conditions without a scope
 * (or a scope without a release) fails the build.
 */
const DECLARED_SCOPES: readonly {
  release: string;
  label: string;
  groups: readonly { domain: string; conditions: readonly (readonly [string, string])[] }[];
}[] = [
  {
    release: '1.2.0',
    label: 'the common-chronic questionnaire scope',
    groups: CAPTURE_SCOPE,
  },
  {
    release: '1.3.0',
    label: 'the residual boundary-probe gap',
    groups: RESIDUAL_SCOPE,
  },
  {
    release: '1.4.0',
    label: 'the questionnaire-sweep gap',
    groups: PROBE_GAP_SCOPE,
  },
  {
    release: '1.6.0',
    label: 'the critical-illness sweep gap',
    groups: CRITICAL_ILLNESS_SCOPE,
  },
  {
    release: '1.7.0',
    label: 'the ICD-10 Chapter IX codebook gap',
    groups: ICD10_CHAPTER_IX_SCOPE,
  },
  {
    release: '1.8.0',
    label: 'the stone-family mapping residue',
    groups: STONE_FAMILY_SCOPE,
  },
  {
    release: '1.9.0',
    label: 'the ICD-10 Chapter XIV codebook gap',
    groups: ICD10_CHAPTER_XIV_SCOPE,
  },
];

describe('Health-data gate — the declared capture scope is closed', () => {
  const entries = CAPTURE_SCOPE.flatMap((group) =>
    group.conditions.map(([phrase, code]) => ({ domain: group.domain, phrase, code })),
  );
  const residualEntries = RESIDUAL_SCOPE.flatMap((group) =>
    group.conditions.map(([phrase, code]) => ({ domain: group.domain, phrase, code })),
  );
  const probeEntries = PROBE_GAP_SCOPE.flatMap((group) =>
    group.conditions.map(([phrase, code]) => ({ domain: group.domain, phrase, code })),
  );
  const criticalEntries = CRITICAL_ILLNESS_SCOPE.flatMap((group) =>
    group.conditions.map(([phrase, code]) => ({ domain: group.domain, phrase, code })),
  );
  const chapterEntries = ICD10_CHAPTER_IX_SCOPE.flatMap((group) =>
    group.conditions.map(([phrase, code]) => ({ domain: group.domain, phrase, code })),
  );
  const stoneEntries = STONE_FAMILY_SCOPE.flatMap((group) =>
    group.conditions.map(([phrase, code]) => ({ domain: group.domain, phrase, code })),
  );
  const chapterXIVEntries = ICD10_CHAPTER_XIV_SCOPE.flatMap((group) =>
    group.conditions.map(([phrase, code]) => ({ domain: group.domain, phrase, code })),
  );
  const allEntries = [
    ...entries,
    ...residualEntries,
    ...probeEntries,
    ...criticalEntries,
    ...chapterEntries,
    ...stoneEntries,
    ...chapterXIVEntries,
  ];

  test('every declared scope condition resolves to the exact code declared beside it', () => {
    // "Complete" is only meaningful against a declared list, so the list is
    // checked as behaviour: each lay phrase must reach its own code, not a
    // neighbour's. A typo in either column fails the build.
    const mismatched = allEntries
      .filter(({ phrase, code }) => findCanonicalCondition(phrase)?.icd10_cm !== code)
      .map(
        ({ phrase, code }) =>
          `${phrase} → declared ${code}, resolved ${findCanonicalCondition(phrase)?.icd10_cm ?? 'nothing'}`,
      );
    expect(mismatched).toEqual([]);
  });

  test('every declared scope condition is classified as health_data when stated', () => {
    const ungated = allEntries
      .filter(({ phrase }) => detectSensitiveData(`I have ${phrase}`) !== 'health_data')
      .map(({ phrase }) => phrase);
    expect(ungated).toEqual([]);
  });

  test('each declared scope equals its release entry, in both directions', () => {
    // A scope, its release notes, and the vocabulary are one artifact: the
    // codes in a scope must be exactly the codes that release says it added, so
    // a condition cannot be added to either without the other.
    for (const { release, label, groups } of DECLARED_SCOPES) {
      const revision = CONDITION_VOCABULARY_CHANGELOG.find((r) => r.version === release);
      expect(revision).toBeDefined();
      const scopeCodes = [
        ...new Set(groups.flatMap((group) => group.conditions.map(([, code]) => code))),
      ].sort();
      expect({ release, label, codes: scopeCodes }).toEqual({
        release,
        label,
        codes: [...revision!.added].sort(),
      });
      // Domains are unique labels, so a scope cannot double-count a row.
      expect(new Set(groups.map((group) => group.domain)).size).toBe(groups.length);
    }
  });

  test('every canonical condition is declared in a scope or source-derived', () => {
    // The other direction: nothing in the live vocabulary may fall outside the
    // declared scopes unless it came from the earlier PTSD/phenome source sweep
    // (1.0.0/1.1.0). Together with the release equality above this leaves no
    // condition that is neither source-derived nor scope-declared — so "still
    // unmapped" cannot hide inside an unrecorded addition.
    const declaredCodes = new Set(allEntries.map((entry) => entry.code));
    const addedByAnyScopeRelease = new Set(
      DECLARED_SCOPES.flatMap(
        ({ release }) => CONDITION_VOCABULARY_CHANGELOG.find((r) => r.version === release)!.added,
      ),
    );

    const outsideScope = CANONICAL_CONDITIONS.map((condition) => condition.icd10_cm).filter(
      (code) => !declaredCodes.has(code),
    );
    // Every out-of-scope code is source-derived, i.e. not an unrecorded addition.
    expect(outsideScope.filter((code) => addedByAnyScopeRelease.has(code))).toEqual([]);
    expect(outsideScope.length).toBe(CANONICAL_CONDITIONS.length - declaredCodes.size);

    // And every declared code actually exists in the vocabulary.
    const missing = [...declaredCodes].filter(
      (code) => !CANONICAL_CONDITIONS.some((condition) => condition.icd10_cm === code),
    );
    expect(missing).toEqual([]);
  });

  test('nothing the boundary probes surfaced is left ungated', () => {
    // The closure claim, measured against the probe terms themselves: each is
    // either mapped to a canonical condition or classified as health data. Rows
    // may be gated-but-uncoded by policy (acute, injury, symptom, dental,
    // cosmetic); what may not happen is a silent pass-through.
    const silent = BOUNDARY_PROBE_TERMS.filter(
      (term) =>
        !findCanonicalCondition(term) && detectSensitiveData(`I have ${term}`) !== 'health_data',
    );
    expect(silent).toEqual([]);
  });

  test('the gated-but-uncoded probe rows are documented as descriptive', () => {
    // If a probe term has no canonical condition, the reason must be written
    // down — either its gate term is on the descriptive list, or the term is
    // covered by a broader gate term that is. This keeps "deliberately not
    // coded" distinguishable from "forgotten".
    const uncoded = BOUNDARY_PROBE_TERMS.filter((term) => !findCanonicalCondition(term));
    expect(uncoded.length).toBeGreaterThan(0);
    for (const term of uncoded) {
      expect(detectSensitiveData(`I have ${term}`)).toBe('health_data');
    }
  });

  test('the residual scope names the boundary-probe rows that were gated but uncoded', () => {
    // The 1.3.0 scope exists to close a measured gap, not an assumed one: every
    // row in it must be a real diagnosis (a code with a canonical entry) and
    // must be gated when stated. A row that is merely a symptom belongs in the
    // documented out-of-scope list below, not in the vocabulary.
    expect(residualEntries.length).toBeGreaterThan(0);
    for (const { phrase } of residualEntries) {
      const condition = findCanonicalCondition(phrase);
      expect(condition).not.toBeNull();
      expect(detectSensitiveData(`I have ${phrase}`)).toBe('health_data');
    }
  });

  test('the 1.4.0 probe scope names the diagnoses the questionnaire sweep found silent', () => {
    // Same standard as the residual scope: a row enters only if it is a real
    // diagnosis (a code with a canonical entry) and is gated when stated. Thirty
    // rows, six batches of five — the sweep's procedure states, acute
    // infections, and symptoms are on the descriptive list instead.
    expect(probeEntries).toHaveLength(30);
    for (const { phrase } of probeEntries) {
      const condition = findCanonicalCondition(phrase);
      expect(condition).not.toBeNull();
      expect(detectSensitiveData(`I have ${phrase}`)).toBe('health_data');
    }
  });

  test('the 1.6.0 critical-illness scope names what the carrier lists surfaced', () => {
    // The second independent source: the covered-condition lists a carrier
    // publishes. Ten named diagnoses, two batches of five — and the same
    // standard as every other scope: each phrase resolves to its declared code
    // and is gated when stated.
    expect(criticalEntries).toHaveLength(10);
    for (const { phrase } of criticalEntries) {
      const condition = findCanonicalCondition(phrase);
      expect(condition).not.toBeNull();
      expect(detectSensitiveData(`I have ${phrase}`)).toBe('health_data');
    }

    // The rows that were *aliases* rather than new conditions. 'loss of hearing'
    // is the carrier list's wording for a condition the vocabulary already had;
    // mapping it is what keeps the row out of the descriptive bucket.
    expect(findCanonicalCondition('loss of hearing')?.icd10_cm).toBe('H91.90');
    expect(detectSensitiveData('loss of hearing in one ear')).toBe('health_data');
    expect(findCanonicalCondition('primary pulmonary arterial hypertension')?.icd10_cm).toBe(
      'I27.20',
    );
  });

  test('the 1.8.0 stone-family scope codes what the collision sweep left protected', () => {
    // Two rows in one batch. The diagnoses were already gated by the `stones`
    // context rule, so this is a mapping-only release: the sweep cannot show it
    // as a coverage gap closing, only as two gated-but-uncoded rows becoming
    // mapped. The alias beside them is the spelling hole the same measurement
    // found — the corpus carried only the one-word "gallstones", so the spaced
    // form gated without being matchable.
    expect(stoneEntries).toHaveLength(2);
    expect(new Set(stoneEntries.map(({ code }) => code)).size).toBe(2);
    for (const { phrase } of stoneEntries) {
      const condition = findCanonicalCondition(phrase);
      expect(condition).not.toBeNull();
      expect(detectSensitiveData(`I have ${phrase}`)).toBe('health_data');
    }

    for (const phrase of ['gall stone', 'gall stones', 'gallstones']) {
      expect(findCanonicalCondition(phrase)?.icd10_cm).toBe('K80.20');
      expect(detectSensitiveData(`I have ${phrase}`)).toBe('health_data');
    }

    // The family's rows stay distinct: a stone in the kidney, the ureter and
    // the bladder resolves to its own code rather than a neighbour's.
    expect(findCanonicalCondition('kidney stones')?.icd10_cm).toBe('N20.0');
    expect(findCanonicalCondition('bladder stones')?.icd10_cm).toBe('N21.0');
    expect(findCanonicalCondition('ureteric stones')?.icd10_cm).toBe('N20.1');
  });

  test('the 1.7.0 ICD-10 Chapter IX scope closes the codebook holes', () => {
    // Six codes in two batches — five named diagnoses the chapter's category
    // titles surfaced, then the conduction row — plus the aliases that landed on
    // existing codes, which is where the spelling holes were.
    expect(chapterEntries).toHaveLength(6);
    expect(new Set(chapterEntries.map(({ code }) => code)).size).toBe(6);
    for (const { phrase } of chapterEntries) {
      const condition = findCanonicalCondition(phrase);
      expect(condition).not.toBeNull();
      expect(detectSensitiveData(`I have ${phrase}`)).toBe('health_data');
    }

    // Aliases on existing rows: the British spellings and the synonym hole.
    for (const [phrase, code] of [
      ['haemorrhoids', 'K64.9'],
      ['cerebral infarction', 'I63.9'],
      ['subarachnoid hemorrhage', 'I60.9'],
      ['intracerebral hemorrhage', 'I61.9'],
      ['intracranial haemorrhage', 'I62.9'],
      ['thrombophlebitis', 'I80.9'],
      ['lymphadenitis', 'I88.9'],
      ['heart block', 'I44.30'],
    ] as const) {
      const condition = findCanonicalCondition(phrase);
      expect(condition?.icd10_cm).toBe(code);
      expect(detectSensitiveData(`I have ${phrase}`)).toBe('health_data');
    }

    // And the codebook constructs the chapter enumerates are gated, not coded:
    // each one is health data while remaining absent from the vocabulary.
    for (const phrase of [
      'other diseases of pulmonary vessels',
      'other diseases of pericardium',
      'other disorders of arteries and arterioles',
      'diseases of capillaries',
      'other disorders of veins',
      'other noninfective disorders of lymphatic vessels and lymph nodes',
      'postprocedural disorders of circulatory system, not elsewhere classified',
      'other and unspecified disorders of circulatory system',
    ]) {
      expect(detectSensitiveData(phrase)).toBe('health_data');
      expect(findCanonicalCondition(phrase)).toBeNull();
    }
  });

  test('the 1.9.0 ICD-10 Chapter XIV scope closes the genitourinary codebook holes', () => {
    // Thirty codes in six batches of five — the named diagnoses the N00–N99
    // category titles surfaced, each title verified against ICD-10-CM before
    // use. The batch shape is asserted because it is the work order the sweep
    // produced, not a decoration.
    expect(chapterXIVEntries).toHaveLength(30);
    expect(new Set(chapterXIVEntries.map(({ code }) => code)).size).toBe(30);
    expect(ICD10_CHAPTER_XIV_SCOPE.map((group) => group.conditions.length)).toEqual([
      5, 5, 5, 5, 5, 5,
    ]);
    for (const { phrase } of chapterXIVEntries) {
      const condition = findCanonicalCondition(phrase);
      expect(condition).not.toBeNull();
      expect(detectSensitiveData(`I have ${phrase}`)).toBe('health_data');
    }

    // The aliases this chapter's wording needed on rows that already existed:
    // the corpus row the lump context rule had gated but not matched, and the
    // erectile-dysfunction row's own phrasing.
    for (const [phrase, code] of [
      ['unspecified lump in breast', 'N63.0'],
      ['male erectile dysfunction', 'N52.9'],
    ] as const) {
      expect(findCanonicalCondition(phrase)?.icd10_cm).toBe(code);
      expect(detectSensitiveData(`I have ${phrase}`)).toBe('health_data');
    }

    // The moved alias resolves to its new row and no longer to the old one: an
    // unqualified "kidney failure" is N19, not end-stage renal disease, which
    // keeps its own name, ESRD and dialysis.
    expect(findCanonicalCondition('kidney failure')?.icd10_cm).toBe('N19');
    expect(findCanonicalCondition('end stage renal disease')?.icd10_cm).toBe('N18.6');
    expect(detectSensitiveData('I have kidney failure')).toBe('health_data');

    // Two kinds of row the chapter enumerates that stay gated, not coded: the
    // category constructs, and the one codebook hole where no sex-free billable
    // code exists (FY2026 split N35.9 into N35.91 male and N35.92 female, so a
    // code would have to guess the visitor's sex).
    for (const phrase of [
      'other disorders of bladder',
      'other disorders of urinary system',
      'neuromuscular dysfunction of bladder, not elsewhere classified',
      'other male sexual dysfunction',
      'noninflammatory disorders of ovary, fallopian tube and broad ligament',
      'intraoperative and postprocedural complications and disorders of genitourinary system, not elsewhere classified',
      'urethral stricture',
    ]) {
      expect(detectSensitiveData(phrase)).toBe('health_data');
      expect(findCanonicalCondition(phrase)).toBeNull();
    }
  });

  test('the probe ledger has no deferred rows left', () => {
    // The closure claim is absolute now: the boundary ledger is what "nothing
    // left to map" is measured against, so a future deferral has to be added
    // here deliberately (with its reason) rather than left implicit.
    const deferred: string[] = [];
    for (const term of BOUNDARY_PROBE_TERMS) {
      if (
        !findCanonicalCondition(term) &&
        detectSensitiveData(`I have ${term}`) !== 'health_data'
      ) {
        deferred.push(term);
      }
    }
    expect(deferred).toEqual([]);
  });
});

describe('Health-data gate — the Chapter V mental-health vocabulary', () => {
  test('the release rows are gated through their gate terms', () => {
    for (const message of [
      'I have a manic episode',
      'my depressive episode lasted weeks',
      'I have a paraphilia',
      'I have an intellectual disability',
      'my son has mild intellectual disability',
      'I have severe intellectual disability',
      'history of moderate intellectual disability',
      'I was diagnosed with profound intellectual disability',
      'my mania is managed with medication',
    ]) {
      expect(detectSensitiveData(message)).toBe('health_data');
    }
  });

  test('mania is word-matched, so the country stays clear', () => {
    expect(detectSensitiveData('do you insure people in Romania?')).toBeNull();
  });

  test('bare manic separated after the 1.16.0 deferral: the disclosure gates, the hyperbole does not', () => {
    // The 1.16.0 record deferred the adjective because both readings share the
    // copula and the adjectival slot. The re-measurement found the separator in
    // the compound: the ordinary sense nearly always names its noun (week,
    // Monday, laughter, energy), so those compounds are stripped and the
    // first-person state with no compound behind it is the disclosure. Pinned
    // here at the classifier and in the registry corpus in the road test.
    expect(detectSensitiveData('I am manic')).toBe('health_data');
    expect(detectSensitiveData('I am manic before deadlines')).toBe('health_data');
    expect(detectSensitiveData('a manic week at work')).toBeNull();
    expect(detectSensitiveData('manic laughter filled the room')).toBeNull();
    expect(detectSensitiveData('the manic pace of the city')).toBeNull();
    expect(detectSensitiveData('he got manic at the party')).toBeNull();
  });

  test('every F-code alias added by the release is gated when stated', () => {
    const fCodes = CANONICAL_CONDITIONS.filter((c) => c.icd10_cm.startsWith('F'));
    expect(fCodes.length).toBeGreaterThanOrEqual(7);
    for (const condition of fCodes) {
      const stated = condition.synonyms[0] ?? condition.name;
      expect(detectSensitiveData(`I have ${stated}`)).toBe('health_data');
    }
  });
});

describe('Health-data gate — spelling derivation from the declared table', () => {
  // The gate no longer hand-writes the British side of a declared pair: the
  // spelling table in the crosswalk is the one declaration, the resolver claims
  // aliases in every declared spelling, and the gate watches words in every
  // declared spelling. These tests pin the two invariants the hand-written
  // copies used to satisfy silently.

  test('the watched set is the hand-written set plus exactly the declared spellings', () => {
    // Every derived spelling is a real alternative of a watched word — and the
    // sample below is the complete delta as shipped, so a change here is a
    // reviewed decision, not a silent widening.
    const hand = HEALTH_CONDITION_TERMS.length;
    expect(ALL_CONDITION_GATE_TERMS.slice(hand).sort()).toEqual(
      [
        'coeliac',
        'apnoea',
        'ischaem',
        'leukaemia',
        'tumour',
        'anaemia',
        'haemorrhoid',
        'thalassaemia',
        'haemophilia',
        'hyperkalaemia',
        'haemochromatosis',
        'haemangioma',
        'goitre',
        'dysmenorrhoea',
        'seborrhoe',
        'hyponatraem',
        'hypercalcaem',
        'hyperuricaem',
        'polycythaem',
        'lymphoedema',
        'haemorrhage',
        'oedema',
        'oesophag',
        'forced labour',
        'forced into labour',
      ].sort(),
    );
    // The short-token bucket derives nothing: its entries are acronyms and
    // word-matched nouns with no declared spelling.
    expect(ALL_CONDITION_GATE_WORD_TERMS.length).toBe(HEALTH_CONDITION_WORD_TERMS.length);
  });

  test('every spelling of a watched word is watched — no half-pairs', () => {
    // For each declared word that the gate watches in one spelling, the other
    // spellings must be watched too (in the matching mode: a whole word stays a
    // whole word, a stem stays a substring stem).
    const watchedLong = new Set(ALL_CONDITION_GATE_TERMS);
    const watchedWord = new Set(ALL_CONDITION_GATE_WORD_TERMS);
    const gaps: string[] = [];
    for (const term of ALL_CONDITION_GATE_TERMS) {
      for (const token of term.split(' ')) {
        for (const variant of spellingVariantsOfWord(token)) {
          const rewritten = term.split(token).join(variant);
          if (!watchedLong.has(rewritten) && !watchedWord.has(rewritten)) {
            gaps.push(`${term} -> ${rewritten}`);
          }
        }
      }
    }
    for (const term of ALL_CONDITION_GATE_WORD_TERMS) {
      for (const variant of spellingVariantsOfWord(term)) {
        if (!watchedWord.has(variant) && !watchedLong.has(variant)) {
          gaps.push(`${term} -> ${variant}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  test('derived stems come from the equal-trim rule and nothing else', () => {
    // The stem rule: a proper prefix of one spelling derives its sibling
    // trimmed by the same amount — and a group without a common ending
    // derives nothing rather than guessing.
    expect(spellingVariantsOfStem('ischem')).toEqual(['ischaem']);
    expect(spellingVariantsOfStem('ischaem')).toEqual(['ischem']);
    expect(spellingVariantsOfStem('esophag')).toEqual(['oesophag']);
    expect(spellingVariantsOfStem('polycythem')).toEqual(['polycythaem']);
    expect(spellingVariantsOfStem('seborrhe')).toEqual(['seborrhoe']);
    // The resolver's real shared stem derives across, at the rule's floor.
    expect(spellingVariantsOfStem('anaem')).toEqual(['anem']);
    // Short fragments and unknowable shapes are refused.
    expect(spellingVariantsOfStem('hem')).toEqual([]);
    expect(spellingVariantsOfStem('is')).toEqual([]);
    // A whole word is not a stem case.
    expect(spellingVariantsOfStem('anemia')).toEqual([]);
  });

  test('the disclosure classifications the derivation must protect are pinned', () => {
    // Both spellings of every derived pair gate a plain disclosure; the
    // ordinary senses the resolver's word-declared rule never rewrites stay
    // silent; and the accepted labour/tumour trades are unchanged.
    for (const [american, british] of [
      ['anemia', 'anaemia'],
      ['sleep apnea', 'sleep apnoea'],
      ['leukemia', 'leukaemia'],
      ['tumor', 'tumour'],
      ['goiter', 'goitre'],
      ['edema', 'oedema'],
      ['ischemic heart disease', 'ischaemic heart disease'],
      ['esophageal reflux', 'oesophageal reflux'],
      ['forced labor', 'forced labour'],
    ]) {
      expect(detectSensitiveData(`I was treated for ${american}`)).toBe('health_data');
      expect(detectSensitiveData(`I was treated for ${british}`)).toBe('health_data');
    }
    for (const ordinary of [
      'the labor union went on strike',
      'labor day traffic was terrible',
      'she went into labor at the birthing center',
    ]) {
      expect(detectSensitiveData(ordinary)).toBeNull();
    }
    // The one deliberate exception: gonorrhoea stays hand-written because the
    // vocabulary gates it descriptively, and declaring the group would be dead
    // data — both spellings still gate.
    expect(detectSensitiveData('I was treated for gonorrhea')).toBe('health_data');
    expect(detectSensitiveData('I was treated for gonorrhoea')).toBe('health_data');
  });
});
