/**
 * Security and Prompt-Injection Controls (Section 4.9 of the specification)
 *
 * Prompt text alone is not a security boundary. OWASP notes that prompt
 * injection can be direct or indirect and that foolproof prevention is not
 * established (OWASP LLM01:2025). Implement defense in depth.
 */

import {
  hasContextQualifiedTerm,
  namesContextQualifiedTerm,
  withoutAmbiguousSpellings,
} from './context-qualified-terms';
import { MALTREATMENT_TERMS, stripOrdinarySenseShapes } from './ordinary-sense-shapes';
import {
  BODY_OR_SYSTEM,
  CONTEXT_FAMILY_PATTERNS,
  escapeRegExp,
  ownedWord,
  PERSONAL_OWNERS,
  PERSON_PRONOUNS,
  qualifiedWord,
} from './context-family-terms';
import { spellingVariantsOfStem, spellingVariantsOfWord } from '../medical/condition-crosswalk';

/**
 * Trust zone markers — system instructions, developer policy, user text,
 * article context, and tool results must be marked as separate trust zones.
 */
export type TrustZone =
  'system_instructions' | 'developer_policy' | 'user_text' | 'article_context' | 'tool_result';

/**
 * Defense-in-depth controls from Section 4.9.
 */
export const SECURITY_CONTROLS = {
  // Mark content with separate trust zones
  TRUST_ZONE_MARKING: true,

  // Never place credentials, private CRM records, or other users' data in model context
  NO_CREDENTIALS_IN_CONTEXT: true,
  NO_PRIVATE_RECORDS_IN_CONTEXT: true,
  NO_OTHER_USERS_DATA_IN_CONTEXT: true,

  // Sanitize and allowlist RAG inputs
  SANITIZE_RAG_INPUTS: true,
  ALLOWLIST_RAG_DOMAINS: true,

  // Remove scripts, hidden text, comments, and instruction-like content
  REMOVE_SCRIPTS: true,
  REMOVE_HIDDEN_TEXT: true,
  REMOVE_COMMENTS: true,
  REMOVE_INSTRUCTION_LIKE_CONTENT: true,

  // Enforce server-side authorization and schema validation
  SERVER_SIDE_AUTHORIZATION: true,
  SERVER_SIDE_SCHEMA_VALIDATION: true,

  // Use read-only retrieval credentials and separate write credentials per tool
  READ_ONLY_RETRIEVAL_CREDENTIALS: true,
  SEPARATE_WRITE_CREDENTIALS_PER_TOOL: true,

  // Add input/output classifiers
  INPUT_OUTPUT_CLASSIFIERS: true,

  // Rate-limit by session/IP risk signals; cap token budgets
  RATE_LIMITING: true,
  TOKEN_BUDGET_CAP: true,

  // Perform adversarial tests
  ADVERSARIAL_TESTING: true,

  // Provide a kill switch, incident owner, evidence preservation,
  // vendor notification path, and rollback to a static FAQ
  KILL_SWITCH: true,
  INCIDENT_OWNER: true,
  EVIDENCE_PRESERVATION: true,
  VENDOR_NOTIFICATION_PATH: true,
  ROLLBACK_TO_STATIC_FAQ: true,
} as const;

/**
 * Input classification categories for input/output classifiers.
 */
export const INPUT_CLASSIFICATION_CATEGORIES = [
  'prompt_exfiltration',
  'pii',
  'health_data',
  /**
   * An impersonal question about a condition — "Is TB curable?", "What does TIA
   * stand for?", "How is cancer treated?".
   *
   * Distinct from `health_data` because nothing about the visitor's own health
   * was disclosed: the accurate response is a broker handoff without the
   * "please don't share diagnoses" framing, and the accurate record is a
   * question about a topic, not a health-data event. Answering it is still
   * clinical or underwriting guidance, so it still hands off — see
   * `detectHealthTopicQuestion()`.
   */
  'health_topic_question',
  'financial_account_data',
  'unsafe_advice',
  'prohibited_recommendations',
] as const;

/**
 * Adversarial test categories (Section 4.9).
 */
export const ADVERSARIAL_TEST_CATEGORIES = [
  'direct_injection',
  'retrieved_document_injection',
  'data_exfiltration',
  'tool_misuse',
  'encoded_text',
  'multilingual_attacks',
  'denial_of_wallet',
] as const;

/**
 * Sanitizes retrieved content before it enters the model context.
 * Removes scripts, hidden text, comments, and instruction-like content.
 *
 * @param content - The raw retrieved text from a RAG source
 * @returns Sanitized content safe for model context
 */
export function sanitizeRetrievedContent(content: string): string {
  let sanitized = content;

  // Remove <script> tags and their contents
  sanitized = sanitized.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove HTML comments
  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');

  // Remove hidden text (display:none, visibility:hidden, etc.)
  sanitized = sanitized.replace(
    /<[^>]*style="[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi,
    '',
  );
  sanitized = sanitized.replace(/<[^>]*hidden[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // Remove instruction-like patterns that could be prompt injection
  // e.g., "Ignore previous instructions", "Ignore all previous instructions",
  // "You are now", "System:" — allow 1-3 qualifier words (the canonical
  // "ignore all previous instructions" has two).
  sanitized = sanitized.replace(
    /(?:ignore|disregard)\s+(?:(?:previous|all|above|your)\s+){1,3}instructions?/gi,
    '',
  );
  sanitized = sanitized.replace(/(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s/gi, '');
  sanitized = sanitized.replace(/^system\s*:/gim, '');

  // Remove null bytes and other control characters
  // eslint-disable-next-line no-control-regex
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized.trim();
}

/**
 * Checks if user input appears to contain prompt injection attempts.
 * This is a classifier heuristic, not a guarantee.
 *
 * @param userInput - The text entered by the user
 * @returns True if prompt injection is suspected
 */
export function detectPromptInjection(userInput: string): boolean {
  const injectionPatterns = [
    // 1-3 qualifier words between the verb and "instructions" so the canonical
    // "ignore all previous instructions" (two qualifiers) is caught, not just
    // the single-qualifier "ignore previous instructions".
    /(?:ignore|disregard|forget)\s+(?:(?:previous|all|above|your)\s+){1,3}instructions?/i,
    /(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|role[\s-]?play\s+as)/i,
    /^(?:system|admin|developer)\s*:/i,
    // 1-3 qualifier words between the verb and the target so "reveal your
    // system prompt" (two qualifiers) is caught alongside "reveal your prompt".
    /(?:reveal|show|print|output)\s+(?:(?:your|the|system)\s+){1,3}(?:prompt|instructions?|rules?|policy)/i,
    /(?:override|disable|bypass)\s+(?:safety|content|system|filter)/i,
    /(?:translate|encode|base64|rot13|hex)\s+(?:this|the|your)\s+(?:prompt|instructions?|rules?)/i,
    /<\/?(?:script|iframe|object|embed|svg)/i,
    /(?:DROP\s+TABLE|UNION\s+SELECT|;\s*DELETE)/i,
  ];

  return injectionPatterns.some((pattern) => pattern.test(userInput));
}

/**
 * Condition vocabulary for the health-data gate.
 *
 * The generic patterns catch disclosures phrased AS disclosures ("I was
 * diagnosed with...", "my medication...") plus a short list of common
 * conditions. They miss a condition named plainly — "I have lupus", "I have
 * hypertension", "I wear a CPAP for sleep apnea" — because none of those words
 * were on the list. Since virtually every condition a visitor names IS health
 * data, the gate needs the condition vocabulary itself.
 *
 * Matching runs in two modes, and each term's mode is a deliberate choice:
 *
 *   HEALTH_CONDITION_TERMS       substring match, no boundaries. For long stems
 *                               that cannot appear inside a benign word, and —
 *                               critically — for prefixed compounds, so
 *                               "arthritis" catches osteoarthritis, "thyroid"
 *                               catches hypothyroidism, and "lipid" catches
 *                               hyperlipidemia.
 *   HEALTH_CONDITION_WORD_TERMS  whole-word match (\b..\b). For short tokens
 *                               and acronyms whose substrings occur in ordinary
 *                               English: "hiv" inside "archive", "gout" inside
 *                               "ragout", "graves" inside "gravestone".
 *
 * The vocabulary covers the conditions the PTSD/phenome literature maps (see
 * docs/phenome-mapping-rules.md), the common-chronic domains a carrier
 * medical-history questionnaire enumerates (gynecologic, urologic,
 * dermatologic, ophthalmologic/otologic, ENT/oral, congenital/developmental,
 * and the residual musculoskeletal, gastrointestinal, hematologic, infectious,
 * oncologic, endocrine, respiratory, and mental-health rows), and mirrors the
 * canonical vocabulary in src/medical/condition-crosswalk.ts;
 * tests/medical-condition-gate.test.ts locks the parity between the two,
 * asserts every exclusion below, and checks every declared capture scope
 * (`CAPTURE_SCOPE`, `RESIDUAL_SCOPE`, `PROBE_GAP_SCOPE`) end to end.
 *
 * False positives are accepted in the fail-safe direction: a blocked
 * educational question produces the abstention sentence plus a licensed-broker
 * handoff, while a missed disclosure lets health data reach the model. Known
 * accepted collisions are noted inline.
 */
export const HEALTH_CONDITION_TERMS = [
  // Cardiovascular / cerebrovascular
  'hypertens', // hypertension, hypertensive
  'high bp', // common shorthand — "blood pressure" alone does not match it
  'hypotens',
  'coronar',
  'cardiovascular',
  'cardiac',
  'myocardial',
  'atheroscler', // include the prefixed form explicitly: "sclerosis" also matches it
  'fibrillation', // atrial fibrillation
  'arrhythm',
  'angina',
  'aneurysm',
  'stroke', // accepts "stroke of luck" — rare in this context
  'cerebrovascular',
  'vascular', // peripheral vascular
  'endocarditis',
  'meningitis',
  'embolism', // pulmonary embolism, thromboembolism — not 'embol', which is in "embolden"
  'embolus',
  'thrombosis', // deep vein thrombosis
  'thrombus',

  // Metabolic / endocrine
  'diabet', // diabetes, diabetic, prediabetic
  'glycem',
  'insulin',
  'metabolic syndrome',
  'syndrome x',
  'obesity',
  'obese',
  'lipidemi', // hyperlipidemia, dyslipidemia
  'lipid',
  'glucose', // impaired glucose tolerance
  'gluten', // gluten intolerance (celiac)
  'thyroid', // hypothyroidism, hyperthyroidism, thyroiditis
  'thyrotox', // thyrotoxicosis
  'hashimoto',
  'adrenal',
  'addison',
  'vitamin d', // vitamin D deficiency

  // Autoimmune / inflammatory
  'arthritis', // rheumatoid, osteo-, psoriatic
  'rheumat',
  'lupus',
  'sclerosis', // multiple sclerosis, ALS, atherosclerosis
  'crohn',
  'colitis',
  'enteritis', // regional enteritis (Crohn disease)
  'bowel', // irritable/inflammatory bowel
  'psoriasis',
  'spondyl',
  'sjogren',
  'sjögren',
  'celiac',
  'vasculitis',
  'scleroderma', // systemic sclerosis

  // Neurodegenerative / cognitive
  'alzheimer',
  'dementia',
  'parkinson',
  'lewy body',
  'neurodegenerat',
  'cognitive impairment',
  'cognitive decline',
  'memory loss',
  'gehrig', // Lou Gehrig's disease (ALS)

  // Neurological / sleep / pain
  'myalgic', // myalgic encephalomyelitis (ME/CFS)
  'migraine',
  'epilep', // epilepsy, epileptic
  'seizure', // accepted collision: asset seizure
  'narcolepsy',
  'apnea',
  'restless legs',
  'insomnia',
  'sleep problem', // "sleep problems"
  'sleep disturbance',
  'chronic fatigue',
  'chronic pain',
  'neuropath', // neuropathic pain, neuropathy
  'ischem', // transient ischemic attack, ischemic stroke — 'ischaem' is derived
  'back pain',
  'joint pain',

  // Respiratory
  'asthma',
  'emphysema',
  'bronchit',
  'pneumonia',
  'rhinitis',
  'allerg', // allergies, allergic rhinitis
  'hay fever',

  // Renal / gastrointestinal / hepatic
  'kidney',
  'renal', // chronic kidney/renal disease, renal insufficiency
  'nephro',
  'dialysis',
  'cirrhosis',
  'hepatitis',
  'pancreatitis',
  'fatty liver',
  'steatosis', // hepatic steatosis
  'reflux',
  'ulcer',
  'temporomandibular',
  'fibromyalgia',
  'arthralgia', // joint pain
  'osteoporosis',
  'osteopenia',
  'bone loss',
  'low bone density',

  // Mental health
  'bipolar',
  'panic attack',
  'schizophren',
  'attention deficit', // ADHD
  'obsessive', // obsessive-compulsive disorder
  'alcoholism',
  // Added with the Chapter V sweep, whose rows are the first that a person
  // states about their mind rather than their body. "mania" is word-matched
  // (below) because the substring sits inside "Romania"; bare "manic" is
  // deliberately not watched — its ordinary senses ("a manic week", "manic
  // before launch") use the same frame a guard would have to separate, and the
  // release records that edge rather than guessing at it.
  // 'manic episode' is gated in context only now — see the registry's `manic`
  // entry: the plain token made "a manic episode of my favorite sitcom" a false
  // positive, and the strip that separates the television sense cannot run
  // while the plain token gates first.
  'depressive episode',
  'paraphili', // paraphilia, paraphilias, paraphilic disorder
  'intellectual disabilit', // every severity form, singular and plural

  // ICD-10 Chapter VI sweep (1.17.0) — the named diagnoses the chapter's
  // stateable forms reach the gate by, plus the organ/residual constructs a
  // person states the organ for ("I have a brain disorder") rather than the
  // category title. The peripheral-nerve and muscle rows never appeared on a
  // carrier questionnaire, which is why this chapter was the largest silent
  // blind spot of its kind.
  'spinal muscular atrophy',
  'dystonia',
  'hemiplegi', // hemiplegia — the G81 category title names it
  'paresis', // hemiparesis, paraparesis — the weakness family beside hemiplegia
  'myopath', // myopathy, myopathies
  'muscle disorder', // a person's wording — and 'disorder of muscle' beside it, the
  'disorder of muscle', // canonical name's own shape (G71.9); both watched
  'trigeminal',
  'neuralgi', // trigeminal neuralgia and every facial neuralgia
  'tic douloureux', // the French alias the G50.0 row carries
  'encephalopath', // toxic, hepatic, metabolic, unspecified — the encephalopathy family
  'brain disorder',
  'disorders of brain', // the G93 category-title form; a person says "brain disorder"
  'spinal cord',
  'disorders of nervous system', // the G98 residual's category-title form — qualified,
  'disease of nervous system', // not a bare 'nervous system' stem: the anatomy in the
  'diseases of nervous system', // abstract ("the central nervous system controls…") must stay silent
  'disorders of muscle', // the G71 category-title form; a person says "muscle disorder"
  'cranial nerve',
  'basal ganglia',
  'demyelinat', // demyelinating disease, demyelination — 'sclerosis' is deliberately unwatched
  'extrapyramidal',
  'autonomic nervous system',
  'peripheral nervous system',
  'movement disorder',
  'paralyt', // paralytic — 'paralys' beside it covers paralysis/paralyse/paralyzed

  // Oncologic / hematologic
  'melanoma',
  'leukemia',
  'lymphoma',
  'myeloma',
  'carcinoma',
  'sarcoma',
  'malignan',
  'neoplasm',
  'tumor',
  'metasta',
  'anemia',
  'iron deficiency',
  'low iron',
  'blood count', // low blood count

  // Infectious
  'immunodeficien', // human immunodeficiency virus
  'tuberculosis',
  'sepsis',
  'septic', // septicemia, septic shock — "sepsis" is not a substring of "septicemia"
  'blood poisoning',

  // Injury / trauma-adjacent
  'traumatic brain injury',
  'concussion',
  'head injury',

  // Gynecologic / reproductive
  'endometrio', // endometriosis
  'fibroid', // uterine fibroids
  'leiomyoma',
  'polycystic', // polycystic ovary syndrome, polycystic kidney disease
  'ovarian cyst',
  'infertil', // female/male infertility
  'unable to conceive',

  // Urologic
  'prostat', // benign prostatic hyperplasia, prostatitis
  'incontinen', // urinary incontinence
  'overactive bladder',
  'erectile dysfunction',
  'impotence',
  'low sperm count',
  'azoospermi', // azoospermia

  // Dermatologic
  'eczema',
  'dermatitis', // atopic dermatitis, contact dermatitis
  'urticaria',
  'vitiligo',
  'rosacea',
  'alopecia', // alopecia areata

  // Ophthalmologic / otologic
  'cataract',
  'glaucoma',
  'macular degeneration',
  'retinopathy', // diabetic retinopathy
  'hearing loss',
  'deafness',

  // ENT / oral
  'tinnitus',
  'ringing in the ears',
  'sinusitis',
  'vertigo', // accepted collision: the film/song title; fail-safe direction
  'periodont', // periodontitis, periodontal disease
  'gum disease',

  // Congenital / developmental
  'down syndrome',
  'trisomy', // trisomy 21, trisomy 18
  'cerebral palsy',
  'congenital heart',
  'cystic fibrosis',
  'spina bifida',

  // Neurological / immune, other
  'autis', // autism, autism spectrum disorder
  'myasthenia',
  'sarcoidosis',
  'carpal tunnel',
  'polycystic kidney',

  // Musculoskeletal, other
  'scoliosis',
  'herniat', // herniated disc, disc herniation
  'slipped disc',
  'bulging disc',
  'stenosis', // spinal stenosis; also gates aortic stenosis, which stays unmapped
  'rotator cuff',
  'plantar fasciitis',

  // Gastrointestinal, other
  'diverticul', // diverticulitis, diverticulosis
  'gallstone', // gallstones
  'gallbladder', // gallbladder disease
  'cholelithiasis',
  'hernia', // hiatal/diaphragmatic hernia — "herniated disc" is a separate row
  'hemorrhoid',
  'gastritis',

  // Hematologic, other
  'sickle cell',
  'thalassemia',
  'hemophilia',
  'von willebrand',
  'thrombocytopenia',
  'low platelets',

  // Infectious, other
  'shingles', // accepted collision: roofing shingles
  'zoster', // herpes zoster
  'lyme',
  'osteomyelitis',
  'long covid', // post-COVID condition
  'post-covid',

  // Oncologic, other
  'esophag', // esophageal cancer — 'oesophag' is derived from the declaration
  'gastric', // gastric cancer
  'stomach cancer',
  'cervical cancer',
  'cervix',
  'testicular',
  'skin cancer', // non-melanoma skin cancer
  'basal cell',
  'squamous cell',

  // Endocrine, other
  'parathyroid', // hyperparathyroidism; also gates hypoparathyroidism, which stays unmapped
  'pituitar', // covers both "hypopituitarism" and "pituitary disorder"
  'cushing',

  // Respiratory, other
  'pulmonary fibrosis', // also covers idiopathic pulmonary fibrosis
  'lung fibrosis',
  'bronchiect', // bronchiectasis

  // Mental health, other
  'social anxiety',
  'social phobia',
  'agoraphobia',
  'eating disorder',
  'anorexi', // anorexia, anorexia nervosa
  'bulimi', // bulimia, bulimia nervosa
  // Postpartum/postnatal depression needs no term: the generic depression
  // pattern already classifies it.

  // Residual gap (1.3.0) — carrier-relevant chronic rows that were neither
  // gated nor mapped when the boundary probe surfaced them.
  'varicose', // varicose veins
  'sciatica',
  'hyperkalemia',
  'high potassium',
  'b12 deficiency', // covers "vitamin b12 deficiency"
  'low b12',
  'hemochromatosis',
  'g6pd',
  'glucose-6-phosphate',
  'glucose 6 phosphate', // spaced spelling of the same enzyme
  'ehlers', // Ehlers-Danlos syndrome
  'marfan', // Marfan syndrome / Marfans
  'palsy', // Bell's palsy (cerebral palsy has its own term)
  'cluster headache',
  'frozen shoulder',
  'adhesive capsulitis',
  'flat foot', // covers "flat foot"; the plural has its own term below
  'flat feet',
  'pes planus',
  'bunion', // bunions
  'hallux valgus',
  'preeclampsia',
  'pre-eclampsia',
  'dry eye', // dry eye syndrome, dry eyes
  'menopaus', // menopause, perimenopause, postmenopausal
  'lichen planus',
  'hemangioma',
  'plantar wart', // covers "plantar warts"
  'chalazion', // covers "chalazions"
  'raynaud', // Raynaud's phenomenon / syndrome
  'goiter',
  'essential tremor',
  'fibrocystic', // fibrocystic breast changes
  'anal fissure',
  'barrett', // Barrett's esophagus (with or without the apostrophe)
  'inguinal hernia',
  'interstitial cystitis',
  'painful bladder', // painful bladder syndrome
  'actinic keratos', // covers "actinic keratosis" and "actinic keratoses"
  'solar keratosis', // lay wording for actinic keratosis
  'prolapse', // uterine prolapse, prolapsed uterus, pelvic organ prolapse
  'dysmenorrhea',
  'painful periods',
  'premenstrual', // premenstrual syndrome / tension
  'lactose intolerance',
  'kidney cyst', // covers "kidney cysts"
  'renal cyst', // covers "renal cysts"
  'seborrhe', // seborrheic dermatitis — 'seborrhoe' is derived (was a hole)
  'ganglion cyst', // covers "ganglion cysts"
  'tennis elbow',
  'lateral epicondylitis',
  'trigger finger',
  'trigger thumb',
  'bursitis',
  'anal fistula',

  // Probe gap (1.4.0) — named diagnoses a 237-phrase carrier-questionnaire
  // sweep found were neither gated nor mapped. Every term here is a substring
  // of the canonical name or alias it gates, which the parity test locks.
  'cardiomyopath', // dilated/hypertrophic cardiomyopathy
  'myocarditis',
  'pericarditis',
  'tachycard', // paroxysmal / supraventricular tachycardia; 'svt' is word-matched
  'triglycerid', // high triglycerides, hypertriglyceridemia
  'hyponatrem',
  'low sodium', // accepted: a food label may say it, and the disclosure reading is the one that matters
  'hypercalcem',
  'high calcium',
  'hyperuricem',
  'uric acid', // high uric acid
  'testosterone', // low testosterone, testosterone deficiency
  'hypogonad',
  'glomerulonephrit',
  'nephritic', // nephritic syndrome — "nephrotic" has its own row
  'nasal polyp', // covers the plural; colon polyps stay covered by the generic pattern
  'pleurisy',
  'pneumothorax',
  'collapsed lung',
  'gastropares',
  'tension headache', // covers the plural
  'tension-type headache', // the hyphen blocks the spaced term
  'tourette',
  'hydrocephal',
  'muscular dystrophy',
  'retinal detachment',
  'detached retina',
  'cleft palate',
  'club foot',
  'clubfoot', // one-word spelling
  'turner syndrome',
  'turners syndrome', // with the apostrophe dropped
  'fragile x',
  'polycythem',
  'acne',
  'keloid',
  'lymphedema',
  'varicocele',
  'herpes', // herpes simplex; herpes zoster is already gated by 'zoster'
  'irregular heart', // irregular heartbeat / irregular heart beat
  'drug addiction',
  'drug abuse',

  // Procedure states — health data the gate protects but the crosswalk does
  // not code by policy (see DESCRIPTIVE_GATE_TERMS): the vocabulary carries
  // diagnosed conditions, not surgical history.
  'stent',
  'pacemaker',
  'angioplasty',
  'hip replacement',
  'knee replacement',
  'hysterectomy',
  'appendectomy',
  'tonsillectomy',
  'blood transfusion',
  'organ transplant',

  // Acute and self-limited infections from the same sweep — the same policy as
  // the 2026-09-18 tail below: gated, deliberately uncoded.
  'urine infection',
  'conjunctivitis',
  'sinus infection',
  'tonsillitis',
  'laryngitis',
  'syphilis',
  'gonorrhea',
  'gonorrhoea', // stays hand-written: not a canonical condition, so declaring
  // the group would be dead data in the vocabulary (see the spelling-derivation
  // note above the word-token list)
  'chlamydia',
  'malaria',
  'fungal nail infection',

  // Symptoms from the same sweep: health data with no reportable diagnosis.
  'snoring',
  'shortness of breath',
  'dizziness',

  // Critical-illness covered-condition lists (1.6.0) — the second independent
  // source: the conditions a claim is triggered by, i.e. exactly the rows an
  // underwriter asks about. Named diagnoses first, then the event, procedure,
  // injury and functional rows those lists also carry.
  'encephalit', // encephalitis, viral encephalitis
  'polio', // poliomyelitis
  'coma', // accepted collision: "food coma"; the medical reading is the one that matters
  'parapleg', // paraplegia, paraplegic
  'paralys', // paralysis, paralysed
  'liver failure',
  'hepatic failure',
  'aplastic', // aplastic anaemia / anemia
  'benign brain', // benign brain tumour / tumor
  'motor neurone',
  'motor neuron', // US spelling
  'blindness', // functional vision loss — causes are coded, the state is not
  'loss of sight', // lay phrasing of the same
  'loss of hearing', // the coded entry is hearing loss (H91.90)
  'loss of speech', // symptom/functional state
  'severe burn', // injury, not a disease
  'major burn', // covers the plural ("major burns")
  'head trauma', // injury
  'bone marrow transplant', // procedure
  'aorta', // anatomy named in a procedure history ("surgery to aorta")
  'apallic', // apallic syndrome is a clinical state, not a coded condition here
  'loss of independent existence', // cover-definition language (ADL dependence)

  // ICD-10 Chapter IX codebook enumeration (1.7.0) — the third independent
  // source. Named diagnoses first (haemorrhage is watched in both spellings,
  // derived from the declaration since 1.17.0), then the category titles that
  // are codebook constructs rather than diagnoses.
  'hemorrhage', // watched in its own right — 'haemorrhage' is derived
  'subarachnoid', // subarachnoid haemorrhage / hemorrhage
  'intracerebral', // intracerebral haemorrhage / hemorrhage
  'intracranial', // intracranial haemorrhage / hemorrhage
  'phlebitis', // phlebitis and thrombophlebitis
  'thrombophlebitis',
  'infarction', // cerebral infarction; a clinical noun with no ordinary sense
  'bundle branch', // bundle branch block (left/right) on an ECG history
  'lymphadenitis', // nonspecific lymphadenitis
  'atrioventricular', // atrioventricular block / the category title above it
  'pulmonary', // "other diseases of pulmonary vessels" — a clinical adjective
  'pericardium', // "other diseases of pericardium"
  'arteriole', // "other disorders of arteries and arterioles"
  'capillaries', // "diseases of capillaries" — plural only, so "capillary action" stays clear
  'lymphatic', // "disorders of lymphatic vessels and lymph nodes"
  'circulatory', // "disorders of circulatory system"

  // ICD-10 Chapter XIV codebook enumeration (1.9.0) — the fourth independent
  // source and the chapter the stone family sits in. The clinical nouns first:
  // each is a substring of a canonical name or alias, so the parity test can
  // account for it without a descriptive entry.
  'nephritis', // pyelonephritis, tubulo-interstitial nephritis
  'tubulo', // tubulo-interstitial — covers the hyphenated and unhyphenated forms
  'hematuria', // recurrent and persistent hematuria
  'proteinuria', // isolated proteinuria
  'kidney failure', // unspecified kidney failure; ESRD has its own wording
  'kidney injury', // acute kidney injury — the emergency-department phrasing
  'renal failure', // acute/unspecified renal failure
  'uropathy', // obstructive and reflux uropathy
  'renal colic',
  'urinary', // lower urinary tract, urinary system; also matches urine-adjacent wording
  'cystitis', // interstitial cystitis is a separate, existing term
  'bladder', // accepts "gallbladder" — health data in the fail-safe direction
  'urethr', // urethritis, urethral, urethra
  'hydrocele',
  'spermatocele',
  'epididymitis',
  'orchitis',
  'mammary', // benign mammary dysplasia
  'breast', // accepted collision: "chicken breast" is a food; the medical reading matters more
  'cervical', // cervical dysplasia, cervical erosion — also "cervical spine", fail-safe
  'salpingitis',
  'oophoritis',
  'bartholin', // Bartholin's gland disease / cyst
  'ovar', // ovary, ovarian, oophorectomy — one stem for all three
  'vagin', // vagina, vaginal, vaginitis, uterovaginal
  'pregnancy loss', // recurrent pregnancy loss
  'miscarriage', // the lay word for the same
  'menstrua', // menstruation, menstrual cycle, premenstrual — a physiological state
  // …and the anatomy and symptom-category terms the chapter's constructs name,
  // classified as health data but deliberately without a code (each has a
  // written reason in the gate suite's DESCRIPTIVE_GATE_TERMS).
  'testis', // "noninflammatory disorders of testis" — the codes are per-cause
  'prepuce', // the coded rows are phimosis and paraphimosis, not the anatomy
  'penis', // "other disorders of penis" is a category, not a diagnosis
  'genital', // "male genital organs", "female genital tract" — anatomy
  'vulva', // "disorders of vulva and perineum" — anatomy
  'sexual dysfunction', // a functional-state category; erectile dysfunction is coded
  'artificial fertilization', // procedure construct: complications of IVF
  'genitourinary', // "complications … of genitourinary system" — anatomy

  // Measured long tail — classified as health data but deliberately NOT coded
  // (see DESCRIPTIVE_GATE_TERMS for each reason). A disclosure is protected by
  // the gate; the crosswalk stays honest by not inventing a code for it.
  'mononucleosis',
  'urinary tract infection',
  'cellulitis',
  'clostridium difficile',
  'c difficile',
  'ear infection',
  'fracture', // injury — lay phrasings like "broke my wrist" remain uncovered
  'brain fog', // symptom, not a diagnosis
  'irregular periods', // symptom, not a diagnosis
  'gingivitis',
  'dental caries',
  'tooth decay',
  'skin tags',
  'bakers cyst',
  'baker cyst',
  'kyphosis',
  'strabismus',
  'tendonitis',
  'tendinitis',
  // ICD-10 Chapter XVIII (1.11.0) — the R00–R99 sweep. Two kinds of term, both
  // declared on the test suite's descriptive list with their reasons:
  //
  // (a) the names and lay phrasings of the twenty-seven findings the release
  // mapped (epistaxis through aphasia, plus the two-row R35 coda), which must be
  // gated for the vocabulary's own invariant; and
  // (b) the symptom nouns and clinical category words the chapter's remaining
  // rows are built from — a cough, a headache, a rash. These are health data and
  // deliberately uncoded: the vocabulary carries findings and diagnoses, not
  // descriptions of experience. `rash` and `pain` are the two whose ordinary
  // senses are common enough to need the context registry instead of a bare
  // token, so they are declared there and excluded below.
  'epistaxis',
  'nosebleed',
  'nose bleed',
  'hemoptysis',
  'coughing up blood',
  'dysuria',
  'painful urination',
  'micturition',
  'urinary frequency',
  'frequency of urination',
  // The two lay phrasings of the R35.0 row ("urinating frequently", "peeing
  // frequently"). Both stems are urinary-function words in every sentence that
  // contains them, so they gate as themselves rather than through the entry.
  'urinating',
  'peeing',
  'blood in urine',
  'retention of urine',
  'anuria',
  'oliguria',
  'polyuria',
  'nocturia',
  'syncope',
  'fainting',
  'fainted',
  'convulsion',
  'jaundice',
  'ascites',
  'hepatomegaly',
  'enlarged liver',
  'splenomegaly',
  'enlarged spleen',
  'enlarged lymph nodes',
  'swollen lymph nodes',
  'swollen glands',
  'lymph node',
  'edema',
  'dysphagia',
  'difficulty swallowing',
  'trouble swallowing',
  'glycosuria',
  'sugar in urine',
  'hyperglycemia',
  'high blood sugar',
  'liver enzymes',
  'serum enzyme',
  'erythrocyte sedimentation rate',
  'prostate specific antigen',
  'anosmia',
  'loss of smell',
  'aphasia',
  'paresthesia',
  'pins and needles', // "on pins and needles" is the ordinary sense (TRADEOFFS)
  'numbness',
  'tingling',
  'cough',
  'breathing',
  'throat',
  'chest pain',
  'abdominal',
  'pelvic',
  'nausea',
  'vomiting',
  'flatulence',
  'skin sensation',
  'skin eruption',
  'skin changes',
  'subcutaneous',
  'involuntary movements',
  'gait',
  'debility',
  'cachexia',
  'hyperhidrosis',
  'malaise',
  'fatigue',
  'fever',
  'headache',
  'red blood cell',
  'immunological',
  'plasma protein',
  'blood chemistry',
  'urine',
  'cerebrospinal',
  'thorax',
  'organ', // "other organs, systems and tissues" — specimens are what the lab reports on
  'central nervous system',
  'diagnostic imaging',
  'lung',
  'physiological',
  'smell and taste',
  'speech disturbance',
  'function studies', // "abnormal results of function studies" — a report heading, not a disclosure
  'blood-pressure', // the hyphenated spelling of "blood pressure", used in codebook wording
  'dyslexia',
  'ataxia',
  // The shock row's own stateable members: the category (R57) is protected
  // through the words a person actually says about it, not through "shock"
  // alone — that word is the product's own vocabulary ("it came as a shock")
  // and is deliberately not gated.
  'anaphylactic',
  'cardiogenic',
  'hypovolemic',
  // ICD-10 Chapter XXI (1.12.0) — the Z00–Z99 sweep, the fourth codebook
  // enumeration and the first chapter that is mostly *status* rather than
  // disease. Two groups:
  //
  // (a) the history and status vocabulary the forty mapped rows are stated
  // with. Most already gated through the disease word inside them ("family
  // history of breast cancer" is carried by `breast cancer`); what the sweep
  // found missing was the vocabulary of the *status* statements themselves —
  // and these are the measured holes, each one a sentence that travelled to
  // the model unclassified before this release.
  'covid', // "I had COVID last year" — the infection word was not watched (#)
  'do not resuscitate', // the Z66 row's own words; `dnr` is word-matched beside it
  'gestation', // "weeks of gestation"; `gestational diabetes` is a condition row
  'pregnan', // "I am pregnant" was silent; the pregnancy state is a captured field
  'brca', // "I have the BRCA1 mutation" — the Z15.01 row's own words
  'polyp', // bare "I have polyps"; only "colon polyps" was watched before
  'blood type', // "my blood type is O positive"
  'blood clot', // "I have a history of blood clots"
  'asbestos', // "I was exposed to asbestos" — the Z77 exposure row
  'self-harm',
  'self harm', // "I have a history of self-harm" — both spellings
  // The abuse disclosures. The phrases are multi-word on purpose: the bare noun
  // collides with the product's own vocabulary ("abuse of the system"), so the
  // shapes a person actually states are watched instead, which is also how the
  // Z62/Z91.49 rows are reached.
  'abused as a child',
  'childhood abuse',
  'domestic abuse',
  'emotional abuse',
  'physical abuse',
  'sexual abuse',
  'was abused',
  'history of abuse',
  // The 1.13.0 closure of the two rows this chapter had gated without a code.
  // Each term is here because a curated wording is reached by it, which is what
  // makes the rows reachable at all — a disclosure the gate does not see never
  // gets as far as the crosswalk. The intent words are watched as statements in
  // their own right too: "I tried to kill myself" and "I overdosed" are medical
  // disclosures whether or not the sentence names a history.
  'suicid', // "history of suicidal behavior", "attempted suicide", "parasuicide";
  // the product-provision shape ("the suicide clause") is stripped before this
  // term is matched — the ordinary-sense registry's product-provision entry
  'kill myself', // watched as a statement in its own right, not only as a row's wording
  'overdose',
  // The hyphenated forms of the self-harm family's own row wordings: the gate
  // declared only the spaced stems, and the measurement found "I have a history
  // of self-mutilation" and "history of self-injury" — the 1.13.0 rows' own
  // spellings — silent. "self-poisoning" was already declared both ways.
  'self-mutilation',
  'self-injury',
  'self poisoning',
  'self-poisoning',
  'history of cutting', // bare "cutting" is ordinary ("cutting costs") — see the marker note below
  'self mutilation',
  'self injury',
  'beaten as a child', // bare "beaten" collides ("beaten in the final")
  'molested',
  'psychological abuse',
  'neglected as a child',
  'childhood neglect',
  // The codebook's other lay order — Z62.812's row declares it beside
  // "childhood neglect", the same both-orders shape the abuse row carries.
  'child neglect',
  'neglected as an adult',
  'adult neglect',
  'neglected by my', // "neglected by my partner", "neglected by my carer"
  'abused by', // "abused by my partner", "abused by my parents"
  'abused me', // "my partner abused me", "my parents abused me"
  'abused as an adult',
  'adult abuse',
  'adulthood abuse', // the Z91.419 row's own other wording
  'domestic violence',
  'intimate partner abuse',
  'elder abuse',
  'child abuse', // "history of child abuse"; the current-abuse sense is out of scope
  'abusive parenting',
  'raped',
  'assaulted',
  'beaten by my partner',
  'emotionally abused',
  'verbally abused',
  // The 1.14.0 completion of the same family: the named kinds the 1.13.0 rows
  // left to their unspecified members, plus the two adult siblings the codebook
  // exposes beside them (adult intimate-partner abuse Z91.414 and forced labor
  // or sexual exploitation Z91.42). Each is a wording one of those rows is
  // reached by, which is what makes the row reachable at all.
  'financial abuse', // the Z62.814/Z91.413 pair's shared wording
  'forced labor', // 'forced labour' is derived from the declaration
  'trafficked', // "I was trafficked as a child"
  'trafficking', // "a victim of trafficking" — `trafficked` does not match it
  'forced to work', // "I was forced to work as a child" — measured trade, see the road test
  'forced into labor', // 'forced into labour' is derived
  'sex trafficking', // Z91.42's own wording
  'sexual exploitation', // Z91.42's other wording
  'sexually exploited', // "I was sexually exploited as a child" — Z62.813
  'genetic carrier', // "I am a genetic carrier" — the Z14.8 row
  'genetic mutation', // "I carry a genetic mutation"
  'cf carrier',
  'cf gene', // the Z14.1 row: "cf carrier", "I carry the cf gene"
  'combat stress',
  'operational stress', // "history of operational stress" — the Z86.51 row
  'psychological trauma',
  'childhood trauma', // "history of childhood trauma" — the Z91.49 row
  'penicillin', // a drug name that only appears in a health context (Z88.0)
  // (b) the procedure, prosthesis and device states this chapter enumerates.
  // Gated without a code, the same trade the 1.4.0 procedure rows took: the
  // disclosure is protected and the vocabulary does not invent a diagnosis for
  // a surgical fact. `implant` and `prosthetic` also gate two of the chapter's
  // device rows as written.
  'amputat',
  'amputee', // the Z89 row: "I am an amputee" and "I have an amputation"
  'stoma',
  'colostomy',
  'ileostomy',
  'tracheostomy',
  'feeding tube',
  'ventilator',
  'prosthetic',
  'implant',
  'artificial opening',
  'foreign body', // retained fragments — the Z18 row
  'on the pill', // "I am on the pill" was silent; contraception is a health fact
  // ICD-10 Chapter X (1.19.0): the occupational-lung, infection and pleural
  // residuals the sweep surfaced silent. Multi-word stems ride the substring
  // list; the two collision-prone short forms are word tokens below.
  'pneumoconios',
  'silicosis',
  'berylliosis',
  'beryllium disease',
  'byssinosis',
  'brown lung',
  'farmer lung', // the spelling-variant mechanism carries 'farmers lung' and the plural
  'bird fancier', // covers fanciers/fancier's; the lay name is not a plain English word
  'black lung',
  'coal worker', // the compound, not bare 'coal' (mining life is a job, not a diagnosis)
  'coalworker',
  'hypersensitivity pneumonitis',
  'chemical inhalation',
  'bronchiolitis',
  'influenza', // the full word — \bflu\b cannot match inside it
  'pneumonitis', // bare: covers the hypersensitivity compound and the J69 inhalation family
  'respiratory distress',
  'lower respiratory infection',
  'lower respiratory tract infection',
  'upper respiratory tract', // covers the J39 residual title; inherently medical
  'nasal sinuses', // the J34 residual title; inherently medical
  'tonsils and adenoids', // the J35 category-title phrasing
  'pharyngitis', // strep throat is reached by its own phrase below
  'strep throat',
  'sore throat',
  'common cold',
  'head cold',
  'croup',
  'epiglottitis',
  'tracheitis',
  'peritonsillar',
  'quinsy',
  'vocal cord',
  'chronic tonsillitis',
  'chronic adenoid disease',
  'adenoids', // the plural is the lay form; bare 'adenoid' sits inside 'adenoidectomy'
  'pleural effusion',
  'pleural plaque', // the J92 family — bare wording gates without a code rather than misstating the asbestos split
  'water on the lung',
  'respiratory failure',
  'acute upper respiratory infection',
  'upper respiratory infection',
  'upper respiratory tract infection',
  // ICD-10 Chapter XI (1.20.0): the digestive wordings the rows are reached by
  // and the dental/anatomy residuals the sweep surfaced. The mapped-row stems
  // are exact enough to be unambiguous; the anatomy stems ('biliary', 'pancrea',
  // 'hepatic', 'intestinal', 'peritoneum') have no ordinary sense to collide
  // with, and 'digestive system' follows the 'nervous system' precedent.
  'appendicitis',
  'dyspepsi',
  'indigestion',
  'peritonit',
  'hepatic', // hepatic failure, hepatic steatosis — the adjective is medical only
  'salivary gland',
  'stomatitis',
  'canker sore',
  'mouth ulcer',
  'leukoplaki',
  'leucoplaki', // the British spelling
  'fistula', // bare: no ordinary sense; covers the K60 category title and every member
  'rectal prolapse',
  'biliary',
  'pancreati', // pancreatic disease; pancreatitis (carried). The bare noun 'pancreas' is educational anatomy, unwatched like 'liver'
  'disease of pancreas', // the K86.9 row's noun-form wording
  'diseases of pancreas', // the K86 category-title form (the sweep's corpus line)
  // ICD-10 Chapter XII (1.21.0): the skin wordings the rows are reached by.
  // Bare "pigmentation" stays unwatched for its cosmetics sense (the L81
  // residual closes through "disorders of pigmentation"), bare "corns" for its
  // food sense ("callosities" carries the L84 title), and bare "exfoliation"
  // for its skincare sense (the L49 title closes through "exfoliation due to")
  // — the same ordinary-sense trades as bare "coal" and bare "appendix".
  'scalded skin syndrome', // L00 — the staphylococcal form is the diagnosis
  'impetigo', // L01.00
  'pemphigus', // L10.9
  'pemphigoid', // L12.9
  'lichen simplex', // L28.0
  'pityriasis', // L42 rosea — covers parapsoriasis (L41) and the L44 residual too
  'neurodermatitis', // L28.0's codebook synonym
  'erythema', // covers multiforme (L51.9), nodosum (L52) and the L53 residual — medical Latin only
  'sunburn', // L55.9 — the word's ordinary sense is the medical one
  'hypertrichosis', // L68.9
  'excessive hair growth', // L68.9's lay wording
  'acanthosis nigricans', // L83
  'pyoderma gangrenosum', // L88
  'lichen sclerosus', // L90.0
  'pilonidal', // L05 — gated without a code: the with/without-abscess split is not carried by the bare words
  'pruritus', // L29 — the itch category
  'prurigo', // L28's title residual
  'exfoliation due to', // the L49 title shape — bare "exfoliation" is skincare
  'nonscarring hair loss', // the L65 title form
  'hair shaft', // the L67 title fragment
  'disorders of pigmentation', // the L81 title form
  'callosities', // the L84 title form — bare "corns" is food
  'epidermal thickening', // the L85 title form
  'atrophic disorders of skin', // the L90 category-title form
  'hypertrophic disorders of skin', // the L91 category-title form
  // ICD-10 Chapter XIII (1.22.0): the musculoskeletal wordings the rows are
  // reached by. Bare "joints" and bare "spine" stay unwatched - the
  // educational anatomy sense is ordinary, exactly as bare "liver". Bare
  // "fracture" stays unwatched because a broken bone from injury is the S
  // chapter; "stress fracture" carries the M84 wording instead.
  'arthropath', // the reactive/enteropathic/crystal/unspecified arthropathy titles; gouty and psoriatic arthritis carry their rows
  'polyosteoarthritis', // the M15 title form (osteoarthritis cannot match inside it)
  'acquired deformities', // the M20/M21/M95 deformity-title form
  'patella', // the M22 knee category - medical Latin only
  'internal derangement', // the M23 knee title form
  'joint derangement', // the M24 title form
  'dentofacial', // the M26 category - medical only
  'malocclusion', // the M26.3 orthodontic residual
  'diseases of jaws', // the M27 title form
  'polyarteritis', // M30.0, mapped
  'autoinflammatory', // the M04 category title (periodic fever syndromes)
  'necrotizing vasculopath', // the M31 residual-title form (PAN and GCA carry their rows)
  'giant cell arteritis', // M31.6, mapped
  'temporal arteritis', // the M31.6 lay-clinician wording
  'dermatomyositis', // M33.10, mapped - covers the dermatopolymyositis title
  'polymyositis', // the M33.2 member the dermatopolymyositis title needs
  'polymyalgia', // M35.3, mapped
  'sicca syndrome', // the Sjogren wording (the row is carried)
  'involvement of connective tissue', // the M35 title fragment
  'connective tissue disease', // the M35 family's clinical phrase
  'lordosis', // the M40 category
  'spinal osteochondrosis', // the M42 title form
  'osteochondrosis', // the M91/M92 juvenile titles
  'deforming dorsopathies', // the M43 title form
  'dorsopath', // the M53 residual title form
  'dorsalgia', // M54 - low back pain's codebook title
  'low back pain', // the M54.5 lay-clinician wording
  'synovitis', // the M65 category
  'tenosynovitis', // the M65 category
  'synovium', // the M66/M67 title form
  'enthesopath', // the M76/M77 title form
  'calcaneal spur', // the M77.3 title form (heel spur is the mapped wording)
  'heel spur', // M77.30, mapped
  'dupuytren', // M72.0 - the bare stem so the apostrophe forms resolve
  'fibroblastic', // the M72 category
  'myositis', // M60.9, mapped - also reaches polymyositis and dermatomyositis
  'calcification of muscle', // the M61 title form
  'ossification of muscle', // the M61 title form
  'myositis ossificans', // the M61 lay-clinician wording
  'shoulder lesion', // the M75 title form
  'bursopath', // the M71 title form
  'soft tissue disorder', // the M70/M79 title form
  'overuse and pressure', // the M70 title fragment
  'osteomalacia', // M83.9, mapped
  'disorder of continuity of bone', // the M84 title form (stress fracture is the mapped wording)
  'stress fracture', // M84.9, mapped - bare 'fracture' stays unwatched (injury is the S chapter)
  'disorders of bone density', // the M85 title form
  'osteonecrosis', // M87.9, mapped
  'avascular necrosis', // the M87 lay-clinician wording
  'paget', // M88.9 - the bare stem so the apostrophe forms resolve
  'osteitis deformans', // the M88 codebook title
  'disorders of bone', // the M89 title form
  'osteochondropath', // the M93 title form
  'disorders of cartilage', // the M94 title form
  'biomechanical lesion', // the M99 title form
  'tongue disease',
  'diseases of tongue', // the K14 category-title form
  'ileus',
  'malabsorption',
  'abscess', // bare: covers anal/rectal/salivary/dental abscesses — all health data
  'intestinal',
  'intestine',
  'peritoneum', // covers retroperitoneum by substring
  'liver disease',
  'diseases of liver', // the K76 category-title form
  'oral mucosa',
  'anus and rectum', // the K62 category-title form; the K62.6 name also carries it
  'digestive system', // the K92 residual's title fragment — the category noun
  'tooth development', // K00 — dental residual, gated not coded
  'impacted teeth', // K01 — dental residual
  'hard tissues of teeth', // K03 — dental residual
  'periapical', // K04 — dental residual
  'gingiva', // K06 — dental residual ('gingivitis' already descriptive)
  'teeth and supporting structures', // K08 — dental residual
  'cysts of oral region', // K09 — dental residual
  'aphthae', // K12.0's codebook synonym — canker sores is the mapped lay form
  'disease of tongue', // K14.9's title word order
  'disorder of tongue', // K14.9's sibling wording
  'diseases of appendix', // the K38 category-title form — bare 'appendix' stays unwatched (a document's appendix)
  'disease of appendix',
] as const;

/**
 * Whole-word condition tokens. Short forms and acronyms whose letters appear
 * inside ordinary words, matched as `\b<term>\b` so "archive", "ragout", and
 * "gravestone" do not trip the gate.
 */
export const HEALTH_CONDITION_WORD_TERMS = [
  'hiv',
  'copd',
  'gerd',
  'ibs',
  'ibd',
  'cfs',
  'mecfs',
  'osa',
  'tmj',
  'tmd',
  'tbi',
  'mtbi', // word-matched: \btbi\b does not match inside "mtbi"
  'htn',
  'chd',
  'chf',
  'pvd',
  'ckd',
  'esrd',
  'mdd',
  'mci',
  'fms',
  'cptsd',
  'cva',
  'cpap',
  'afib',
  'a-fib',
  't1dm',
  't2dm',
  'dm1',
  'dm2',
  'hep c',
  'hep b',
  'dvt',
  'vte',
  'adhd',
  'nafld',
  'ocd',
  'colon', // spastic colon, colon cancer — word-matched so "colonel" is not caught
  'gout',
  'graves',
  'pcos',
  'bph',
  'oab',
  'hives', // word-matched so "beehives" is not caught
  'bppv',
  'pkd',
  'eds', // Ehlers-Danlos syndrome — word-matched so "needs" is not caught
  'pms',
  'mania', // word-matched: \bmania\b does not match inside "Romania"
  'svt', // supraventricular tachycardia
  'hpv', // human papillomavirus — gated, deliberately uncoded (viral carrier state)
  'veins', // word-matched plural: the codebook's "other disorders of veins", and
  // "my veins" (the singular is left alone — "in the same vein" is ordinary
  // business English; the metaphor "the veins of the market" is gated, which is
  // the fail-safe direction)
  'esr', // erythrocyte sedimentation rate — the abbreviation is not an English word
  // ICD-10 Chapter XXI (1.12.0): the two short status abbreviations the sweep
  // surfaced, word-matched for the same reason as every other three-letter token
  // here — "DNR" and "MRSA" must not be found inside a longer word.
  'dnr',
  'mrsa',
  // ICD-10 Chapter X (1.19.0): two acronyms whose letters sit inside ordinary
  // words — 'ards' is a substring of 'standards', 'flu' of 'fluid' and 'influenza'.
  'ards',
  'flu',
  // ICD-10 Chapter XII (1.21.0): 'ssss' — the acronym of staphylococcal
  // scalded skin syndrome, word-matched so a run of sibilants in an ordinary
  // word can never match it.
  'ssss',
] as const;

/**
 * Spelling derivation — the declared table is the only place a British/American
 * orthography difference is written down (SPELLING_VARIANT_GROUPS in
 * src/medical/condition-crosswalk.ts), and this gate is its second consumer:
 * a word here is watched in every declared spelling of it, exactly as an alias
 * resolves in every declared spelling of its words.
 *
 * Before 1.17.0 the British side of each pair was hand-written next to its
 * American sibling — twenty-four duplicated entries, plus the stems (`ischem`,
 * `polycythem`, `oesophag`) whose British forms were separately hand-written
 * too. Both spellings of the same word are one declaration, so the duplicates
 * are gone and the derivation below rewrites each declared word with the
 * resolver's own rules: the exact word, its plural carried across, and — for
 * the gate's prefixed-compound stems — the sibling trimmed by the same amount
 * (`ischemic` − 3 → `ischaem`).
 *
 * `gonorrhea`/`gonorrhoea` stays hand-written on purpose: gonorrhoea is not a
 * canonical condition (the vocabulary gates it descriptively — an acute,
 * self-limited infection), and every declared group must be reached by the
 * vocabulary, so declaring the pair would make dead data there.
 *
 * The derived spellings are exported so the parity suite can prove the two
 * invariants the hand-written copies used to satisfy silently: every spelling
 * the gate watches is either curated or on the documented descriptive list,
 * and every declared spelling of a watched word is watched (a term cannot be
 * added in one spelling and silently miss the other).
 */
const GATE_TERM_LIST: readonly string[] = HEALTH_CONDITION_TERMS;
const GATE_WORD_TERM_LIST: readonly string[] = HEALTH_CONDITION_WORD_TERMS;

const DERIVED_CONDITION_SPELLINGS: readonly string[] = [
  ...new Set(
    GATE_TERM_LIST.flatMap((term) =>
      term.split(' ').reduce<readonly string[]>(
        (acc, token) =>
          acc.flatMap((partial) => {
            const variants = spellingVariantsOfWord(token);
            return variants.length === 0
              ? [partial]
              : variants.map((v) => partial.split(token).join(v));
          }),
        [term],
      ),
    ),
  ),
].filter((variant) => !GATE_TERM_LIST.includes(variant));

const DERIVED_CONDITION_WORD_SPELLINGS: readonly string[] = [
  ...new Set(GATE_WORD_TERM_LIST.flatMap((token) => spellingVariantsOfWord(token))),
].filter((variant) => !GATE_WORD_TERM_LIST.includes(variant));

const DERIVED_STEM_SPELLINGS: readonly string[] = [
  ...new Set(
    GATE_TERM_LIST.flatMap((term) =>
      term.split(' ').flatMap((token) => (token.length >= 4 ? spellingVariantsOfStem(token) : [])),
    ),
  ),
].filter((variant) => !GATE_TERM_LIST.includes(variant));

/** Every long-form condition term, hand-written and spelling-derived. */
export const ALL_CONDITION_GATE_TERMS: readonly string[] = [
  ...GATE_TERM_LIST,
  ...DERIVED_STEM_SPELLINGS,
  ...DERIVED_CONDITION_SPELLINGS,
];

/** Every whole-word condition token, hand-written and spelling-derived. */
export const ALL_CONDITION_GATE_WORD_TERMS: readonly string[] = [
  ...GATE_WORD_TERM_LIST,
  ...DERIVED_CONDITION_WORD_SPELLINGS,
];

/**
 * Vocabulary terms deliberately NOT gated on their own.
 *
 * Clinical abbreviations, each of which collides with ordinary English, a name,
 * or another word:
 *
 *   ms  → "Ms."          ra → short/ambiguous   mi → short/ambiguous
 *   uc  → short          oa → short             pad → "pad", "padding"
 *   cad → "cadence"      gad → "gadget"         sle → "sleep" (!)
 *   als → "also"         tia → "Tia", a name   tb  → below the 3-char minimum
 *
 * Plus ambiguous symptom words that are not condition names and appear in
 * ordinary reassurance:
 *
 *   panic → "don't panic about the paperwork"
 *
 * Plus two lay synonyms whose ordinary sense is a frame rather than a second
 * meaning — the quantifier, the place and the task:
 *
 *   piles  → "piles of paperwork", "the work piles up", "he piles on"
 *   stones → "stones of the path", "the stones in the driveway", "stones to move"
 *
 * Being on this list means the term is not matched *alone*. The names these
 * stand for (multiple sclerosis, panic disorder, hemorrhoids, ...) are gated in
 * full, and six of the entries — ms, sle, tia, tb, and the lay synonyms piles
 * and stones — are additionally gated by context: see the registry in
 * ./context-qualified-terms.ts, whose entries declare their own spellings,
 * guards, possessives and qualifiers (piles and stones additionally declare the
 * frames their token never takes: "piles of"/"piles up", "stones of"/"stones to"
 * and the place phrase "the stones in the driveway"). The rest (ra, mi, uc, oa,
 * pad, cad, gad, als, panic) stay contextual-free because no such rule can
 * separate them from their everyday collisions.
 *
 * Asserted in tests/medical-condition-gate.test.ts (including the invariant
 * that every other vocabulary synonym IS gated), so this stays a reviewed
 * tradeoff rather than an accident.
 */
export const GATE_EXCLUDED_TERMS = [
  'ms',
  'ra',
  'mi',
  'uc',
  'oa',
  'pad',
  'cad',
  'gad',
  'sle',
  'tia', // "Tia" is a name — transient ischemic attack is gated as the full phrase
  'als',
  'panic',
  'tb', // two characters, so it fails the minimum-length rule for a token; "tuberculosis" is gated
  'piles', // lay synonym for hemorrhoids — gated only in context (see the registry)
  'stones', // lay synonym for a calculus; ordinary sense is a quantifier or a place
  'lump', // lay word for a mass; ordinary sense is the payout shape ("lump sum") or a quantifier
  'calculus', // the clinical noun collides with the mathematics sense (1.8.0 note)
  'calculi', // its plural, carried as an alias so the crosswalk's rows can resolve it
  'rash', // "a rash decision" — gated only in context (see the registry)
  'pain', // "the pain points", "a pain in the neck" — gated only in context
  'psa', // "a PSA campaign" is an announcement — gated only in context (the registry)
  'bug', // lay word for a stomach upset; ordinary sense is the software or pest bug — gated only in context (the registry)
  'manic', // the adjective gated by first-person state and clinical nouns; the hyperbolic compounds are stripped — see the registry entry
] as const;

/**
 * The wording builders, the broad two-sense families — "condition", "treatment",
 * "heart", "symptom", "prescription", "disease", "disorder" — and the four
 * words the first measurement pass narrowed in place (diagnosis, therapy,
 * therapist, medication) all live in `context-family-terms.ts`. The builders are
 * imported here because the phrase families below (growth, discharge, passing,
 * pads) still use them directly; every family's patterns are generated from that
 * registry's entries rather than written here. `escapeRegExp` is imported too:
 * the health-condition patterns further down need it, and a second copy would be
 * a second thing to keep in step.
 */

/**
 * = "weight" =================================================================
 *
 * Measured before changing it: all EIGHT ordinary probe sentences false-gated,
 * because the stem was matched by substring and "weight" in this domain is as
 * often about influence as about the body —
 *
 *   what weight do you give to my credit history?
 *   does my occupation carry any weight?
 *   how much weight does a speeding ticket carry?
 *   I want to give more weight to affordability
 *   the weight of the evidence favours the insurer
 *   the weighting of the premium is unclear
 *   is there a weighted average of these factors?
 *   what is the weight of that in the decision?
 *
 * Medical senses that must survive: "my weight is 180 pounds", "I am trying to
 * lose weight", "I put on weight last year", "do you need my height and
 * weight?", "I was overweight as a child", "weight loss surgery", "my weight has
 * changed since then".
 *
 * The same probe found the VERB ungated in every form — "I weigh 180 pounds",
 * "she weighs 120 pounds", "I weigh myself every morning", "the nurse weighed
 * me", "I was weighed at the clinic" — so `weigh` is carried here too, in its
 * numeral, reflexive and clinical shapes only: "I weigh the options" is the same
 * verb in the figurative sense, which is why it is not matched bare.
 */
const WEIGHT_PATTERNS = [
  // The body measure, positively. Owner first, and the owner has to sit directly
  // before the word — "the weight of my argument" is not a body weight.
  /\b(?:my|his|her|their|our|your)\s+(?:current|exact|usual|body|starting|ideal)?\s*weight\b/i,
  // Prefix-tolerant on purpose: "overweight" and "underweight" are the same
  // field and the substring pattern used to carry them.
  /\b(?:over|under)weight\b/i,
  /\b(?:lose|losing|lost|gain|gaining|gained|watch|watching|reduce|reducing|measure|measuring|check|checking|record|recorded|put on|putting on)\s+(?:[a-z]+\s+){0,2}weight\b/i,
  /\bweight\s+(?:loss|gain|change|management|training|clinic|problems?|issues?)\b/i,
  /\bheight\s+and\s+weight\b/i,
  /\bbody\s?weight\b/i,
  // "weight 180", "weight: 180" — the underwriting field answered without a
  // sentence, which is exactly the form a bare stem was good at catching.
  /\bweight\b\s*[:=]?\s*\d/i,
  // The verb, in its measured shapes only.
  /\bweigh(?:s|ed)?\s+\d/i,
  /\bweigh(?:ed|ing|s)?\s+(?:myself|yourself|himself|herself|ourselves|themselves)\b/i,
  /\b(?:was|were|been|being|got|get)\s+weighed\b/i,
  new RegExp(
    String.raw`\b(?:nurse|doctor|doctors|gp|midwife|clinic|hospital|scales?)\b[^.\n]{0,20}\bweigh(?:ed|ing|s)?\b`,
    'i',
  ),
];

/**
 * = "height" =================================================================
 *
 * Measured: all four ordinary probe sentences false-gated — "at the height of
 * the market rates were lower", "the cost reached a new height this year", "the
 * height of my career was in 2019", "uncertainty is at its height" — against
 * four medical ones that had to survive: "my height is 5 foot 10", "height and
 * weight", "does my height affect the rate?", "the nurse measured my height".
 *
 * The near-miss the positive rule handles for free: "the height of my career"
 * contains "my", but not "my height" — the owner has to sit directly before the
 * word.
 *
 * Residual, recorded rather than implied: a units-only statement with no medical
 * word at all — "I am 5 foot 10" — which no pattern for "height" can see.
 */
const HEIGHT_PATTERNS = [
  /\b(?:my|his|her|their|our|your)\s+(?:current|exact|usual|approximate)?\s*height\b/i,
  /\b(?:measure|measured|measuring|check|checked|record|recorded|ask|asked)\s+(?:[a-z]+\s+){0,2}height\b/i,
  // "height 5 foot 10", "height: 175cm" — the field answered without a sentence.
  /\bheight\b\s*[:=]?\s*\d/i,
];

/**
 * = "substance" ==============================================================
 *
 * Measured: all five ordinary probe sentences false-gated — "there is no
 * substance to that claim", "the substance of my complaint is the delay",
 * "nothing of substance changed in the policy", "in substance the two policies
 * are the same", "the substance of the contract" — against four medical ones:
 * "I have a history of substance abuse", "substance use disorder", "I use
 * substances occasionally", "I was treated for substance dependence".
 *
 * The ordinary sense is a matter/content metaphor and it appears in three fixed
 * shapes — "substance of ...", "in substance", "substance to ..." — so those are
 * what the first pattern excludes. The medical NOUN PHRASES are re-added
 * explicitly, because one of them contains the collision: "history OF substance
 * abuse" would be swallowed by the plain "of substance" exclusion.
 */
const SUBSTANCE_PATTERNS = [
  /(?<!\bin\s)(?<!\bof\s)\bsubstances?\b(?!\s+of\b|\s+to\b)/i,
  /\bsubstance\s+(?:abuse|use|misuse|dependence|dependance|addiction|problems?|issues?)\b/i,
];

/**
 * = "tobacco" ================================================================
 *
 * Measured: three ordinary sentences false-gated — "I work at a tobacco
 * company", "I sell tobacco products", "is a tobacco shop a risky occupation?"
 * — against five that must survive: "I use tobacco", the bare field answer
 * "tobacco", "do I need to declare tobacco use?", "I quit tobacco last year",
 * "tobacco user".
 *
 * The ordinary sense is the industry, the shop or the tax line, so the carve-out
 * is a short list of nouns that make it one. Bare "tobacco" stays gated
 * deliberately: in this app the questionnaire answer is a bare word, and a rule
 * that required a verb or an owner would miss it.
 *
 * `products` is deliberately NOT in that list, and it is the trade this rule
 * makes: "I sell tobacco products" gates, because "I USE tobacco products" is
 * the same noun phrase and is a disclosure. The business reading of a sentence
 * with no business noun in it is recorded as an accepted false positive rather
 * than traded for a leak.
 */
const TOBACCO_PATTERNS = [
  /tobacco(?!\s+(?:compan(?:y|ies)|shops?|stores?|industry|farms?|fields?|crops?|business|licen[cs]es?|manufacturers?|retailers?|duty|tax|leaf|stock))/i,
];

/**
 * = "alcohol" ================================================================
 *
 * Measured: both ordinary sentences are the licence or business sense — "I run
 * an alcohol licensing business", "does the alcohol licence cost extra?" — while
 * every consumption statement has to stay gated: "I drink alcohol occasionally",
 * "my alcohol consumption is two units a week", "I gave up alcohol", and the
 * vocabulary's own "alcohol use disorder" and "alcoholism".
 *
 * That last one is why the stem stays substring-matched here: `\balcohol\b`
 * would stop matching the "-ism" form, and the synonym is gated by the substring
 * vocabulary rather than by this pattern.
 */
const ALCOHOL_PATTERNS = [
  /alcohol(?!\s+(?:licen[cs]e|licen[cs]ing|business|industry|duty|tax|sales?|shops?|stores?|brand|compan(?:y|ies)|manufacturers?|retailers?|delivery|counter))/i,
];

/**
 * = "smoker" =================================================================
 *
 * Measured: one ordinary sense, the barbecue — "I bought a smoker for the
 * garden", "I cook on a pellet smoker", "smoker grill" all false-gated — against
 * "I am a smoker", "non-smoker", "my father was a smoker", "smokers pay more".
 *
 * The carve-out is LOCAL on purpose: a device adjective before the word, or a
 * grill part after it. A purchase-verb window (which would have caught "I bought
 * a smoker") was rejected because the same window swallows real disclosures —
 * "I bought a policy for my father, a smoker" is a smoker disclosure with a
 * purchase in it — so that sentence is recorded as an accepted false positive
 * instead of being traded for one.
 */
const SMOKER_PATTERNS = [
  /(?<!pellet\s)(?<!charcoal\s)(?<!electric\s)(?<!offset\s)(?<!propane\s)(?<!wood\s)\bsmokers?\b(?!\s+(?:grill|oven|bbq|barbecue|trailer|pit|box|chips|wood)\b)/i,
];

/**
 * = "stress" ================================================================
 *
 * Measured, and the result was the opposite of what the word's reputation
 * suggested: every ordinary probe sentence was already silent (the word is not
 * matched at all), while SEVEN clinical shapes were ungated — "my stress levels
 * are high", "I am off work with stress", "I am on stress leave", "the doctor
 * said it is stress", "chronic stress", "stress-related condition", "work stress
 * is affecting my sleep".
 *
 * So this is a coverage rule, not a narrowing one. It is positive for the same
 * reason the collisions looked absent: the ordinary uses ("the stress of moving
 * house", "stress-test the numbers", "I am stressed about the timeline") carry no
 * clinical noun, no clinician and no leave-of-absence framing, so requiring one
 * of those keeps them silent.
 *
 * Deliberately not covered: "I am stressed" and "I feel stressed", which are
 * colloquial in this domain. "stress and anxiety" is already gated by `anxiety`.
 */
const STRESS_PATTERNS = [
  /\b(?:my|his|her|their|our|your)\s+stress\s+levels?\b/i,
  // `[\s-]`, because "stress-related" is hyphenated and `\s+` missed it.
  /\bstress[\s-](?:levels?|leave|disorder|management|related|symptoms?|issues?|problems?)\b/i,
  /\b(?:chronic|severe|extreme|ongoing|long-?term|constant|daily|serious|debilitating|work-?related|post-?traumatic)\s+(?:[a-z]+\s+){0,1}stress\b/i,
  /\boff\s+work\s+with\s+stress\b/i,
  /\bstress\s+(?:is|was|has\s+been)\s+(?:affecting|impacting|causing|making)\b/i,
  new RegExp(
    String.raw`\b(?:doctor|gp|nurse|psychiatrist|psychologist|therapist|consultant|hospital|clinic)\b[^\n]{0,20}\bstress\b`,
    'i',
  ),
  /\b(?:signed off|on leave|time off)\b[^\n]{0,20}\bstress\b/i,
];

/**
 * = "illness" ================================================================
 *
 * The one word in the set that needed BOTH directions, and the probe shows why:
 *
 *   over-gating    "does it include critical illness cover?", "what does critical
 *                  illness insurance pay out?", "is critical illness cover worth
 *                  it?" — a product name, classified as a health TOPIC QUESTION,
 *                  so a pricing question about a policy was handed off with
 *                  "don't share diagnoses"-adjacent framing
 *   under-gating   "I have a long-term illness", "my illness is managed", "I have
 *                  a serious illness", "mental illness", "terminal illness", "I was
 *                  off work with an illness" — all silent
 *
 * The carve-out is the product nouns, and it is a lookahead rather than a
 * lookbehind on purpose: "I have a critical illness" is a disclosure, and only
 * the FOLLOWING word distinguishes it from "critical illness cover". `cover`
 * keeps "is illness covered?" in the health path, where it belongs.
 *
 * `claim` is deliberately NOT carved out, tested rather than assumed: "my
 * critical illness claim was refused" and "I filed an illness claim" are
 * statements that imply the condition, and the general question form ("how does
 * a critical illness claim work?") comes out a health TOPIC question, which is
 * the right classification for it anyway. Only the sales nouns — cover,
 * insurance, policy, plan, quote — are about the product rather than the person.
 *
 * The ADJECTIVE is here too, in its clinical shapes only: "I have been ill for
 * months" and "I was ill last year" were silent, while `\bill\b` on its own
 * would drag in "ill-advised", "ill-prepared" and "speak ill of you".
 */
const ILLNESS_PATTERNS = [
  /\billness(?:es)?\b(?!\s+(?:cover|insurance|polic(?:y|ies)|plans?|benefits?|protection|pay-?outs?|quotes?|riders?|element|component|definition)\b)/i,
  // `(?!-)` on every `ill`: a hyphen is a word boundary, so without it the
  // copula form swallowed "is ill-advised" and "am ill-prepared".
  /\b(?:was|were|am|is|are|been|being|felt|feel|feels)\s+(?:seriously\s+|terminally\s+|chronically\s+|very\s+|quite\s+)?ill\b(?!-)/i,
  /\b(?:seriously|terminally|chronically|mentally|physically)\s+ill\b(?!-)/i,
  /\bill\s+health\b/i,
  /\bill\s+for\s+(?:months|weeks|days|years|a\s+while)\b/i,
  /\b(?:fell|falls|became|becomes|got|gets|getting)\s+ill\b(?!-)/i,
];

/**
 * = "smoke" / "smoking" ====================================================
 *
 * Measured, and again the gap was the finding: "I smoke", "I smoke a pack a
 * day", "I used to smoke", "I quit smoking", "do you smoke?", "I stopped smoking
 * last year" and "smoking status" were ALL silent — seven ways of stating the
 * field life underwriting asks about first.
 *
 * The ordinary uses the positive rule keeps silent, none of which has a person
 * as the subject of the verb: "does the policy cover smoke damage?", "do I need a
 * smoke alarm?", "is there a smoke detector requirement?", "there is no smoking
 * gun here", "the whole plan went up in smoke".
 */
const SMOKE_PATTERNS = [
  // A person smoking, in any tense or polarity: "I smoke", "we both smoke",
  // "I've never smoked", "I don't smoke", "do you smoke?".
  new RegExp(
    String.raw`\b(?:${PERSON_PRONOUNS})(?:['\u2019](?:ve|d|m))?\s+(?:both\s+|used to\s+|still\s+|also\s+|ever\s+|currently\s+|never\s+|do(?:n['\u2019]t| not)\s+|did(?:n['\u2019]t| not)\s+)?smok(?:e|es|ed|ing)\b`,
    'i',
  ),
  // Starting or stopping, which is the underwriting fact: "I quit smoking",
  // "I stopped smoking last year", "gave up smoking".
  /\b(?:quit|quits|quitting|stopped|stopping|started|starting|gave up|giving up|give up|took up|taking up|cut down on|cutting down on|reduce|reduced|reducing)\s+(?:[a-z]+\s+){0,2}smok(?:e|ing)\b/i,
  // The field itself: "smoking status", "smoking habits", "smoking history".
  /\bsmoking\s+(?:status|habits?|history|frequency|amount|question|categor(?:y|ies))\b/i,
  // A quantity: "a pack a day", "20 a day", "half a pack".
  /\b(?:pack|packs|packet|packets|cartons?)\s+(?:a|per)\s+(?:day|week|month)\b/i,
  /\bsmok(?:e|es|ed|ing)\s+(?:\d+|a pack|half a pack|twenty|ten|thirty)\b/i,
];

/**
 * = "drink" / "drinking" ===================================================
 *
 * The same shape of finding: "I drink two units a week", "how much do you
 * drink?", "I stopped drinking", "I don't drink", "I have a drinking problem" and
 * "my drinking habits changed" were all silent, while every ordinary probe
 * sentence ("I drink plenty of water", "fizzy drinks are my weakness", "is there
 * a drinks reception?") was silent too — so this is a coverage rule again.
 *
 * Every pattern requires a quantity, a practice verb or a habit noun. That is
 * what separates a consumption statement from drinking as such: "I drink a lot"
 * gates, "I drink plenty of water" does not, and the water/tea/coffee carve-out
 * handles the question form ("do you drink coffee?"), which is not alcohol.
 */
const DRINK_PATTERNS = [
  new RegExp(
    String.raw`\b(?:${PERSON_PRONOUNS})(?:['\u2019](?:ve|d|m))?\s+(?:also\s+|still\s+|usually\s+|sometimes\s+|rarely\s+)?drink\s+(?:\d|two|three|four|five|six|ten|a lot|heavily|daily|most days|every day|occasionally|socially|too much|a few|at all)\b`,
    'i',
  ),
  /\b(?:units?|[a-z]+\s+drinks?)\s+(?:a|per)\s+(?:day|week|month)\b/i,
  /\b(?:stopped|stopping|quit|quitting|gave up|giving up|give up|cut down on|cutting down on|reduced|reducing|started|starting)\s+(?:[a-z]+\s+){0,2}drinking\b/i,
  // Negative statements are underwriting facts: "I don't drink", "I never
  // drink", "I rarely drink".
  new RegExp(
    String.raw`\b(?:i|we|he|she|they)\s+(?:do(?:n['\u2019]t| not)|never|rarely)\s+drink\b`,
    'i',
  ),
  /\bdrinking\s+(?:habits?|problem|history|frequency|units?|levels?)\b/i,
  /\bhow\s+(?:much|many)\b[^\n]{0,20}\bdrink\b/i,
  // The question form, with the non-alcoholic drinks carved out — "do you drink
  // coffee?" is not the underwriting question, "do you drink?" is.
  /\b(?:do|does|did)\s+(?:you|he|she|we|they)\s+drink\b(?!\s+(?:coffee|tea|water|milk|juice|sodas?|fizzy|soft|coke|smoothies?))/i,
];

/**
 * = "growth" ==================================================================
 *
 * A lay word for a tumour and a mass noun for increase, and the determiner is
 * what separates them: a person has *a* growth ("a growth in my lung", "my
 * growth is being monitored"), while a projection shows "growth of the market",
 * "growth in premiums", "the growth we projected", "policy growth", "compound
 * growth".
 *
 * Measured before the rule: eight medical sentences, seven of them silent —
 * only "a growth on my kidney" gated, carried by the word kidney — and ten
 * ordinary sentences, none gated. The rule below gates all eight and leaves all
 * ten ordinary shapes silent.
 *
 * "the" is deliberately not an owner, because "the growth of the policy" and
 * "the growth in premiums" are ordinary; the medical uses that begin with it are
 * carried by the body-site and removal patterns instead ("the growth on my
 * skin", "the growth was removed").
 */
const GROWTH_PATTERNS = [
  ownedWord('growth', `${PERSONAL_OWNERS}|a|an|this|that`, true),
  qualifiedWord(
    'growth',
    String.raw`abnormal|benign|malignant|cancerous|pre-?cancerous|suspicious|unusual`,
  ),
  // The body site is what makes it medical when no determiner is there:
  // "growth on my skin", "growth in my lung".
  new RegExp(String.raw`\bgrowths?\s+(?:on|in)\s+(?:${PERSONAL_OWNERS})\b`, 'i'),
  new RegExp(String.raw`\bgrowths?\s+(?:on|in)\s+the\s+(?:${BODY_OR_SYSTEM})\b`, 'i'),
  // Removal is medical whichever determiner introduced it: "the growth was
  // removed", "a growth excised", "growth biopsied".
  new RegExp(
    String.raw`\bgrowths?\s+(?:was|were|is|has\s+been)\s+(?:removed|excised|biopsied)\b`,
    'i',
  ),
  new RegExp(String.raw`\bgrowths?\s+(?:removed|excised|biopsied)\b`, 'i'),
];

/**
 * = "discharge" ==============================================================
 *
 * Three senses, two of them ordinary in this domain: a fluid from the body
 * ("nasal discharge", "discharge from my ear"), the formal end of a debt or a
 * policy ("discharge of the mortgage", "the discharge of the policy"), and the
 * end of military service ("dishonourable discharge from the army").
 *
 * Measured before the rule: all eight medical sentences silent, and all seven
 * ordinary sentences silent. The rule gates the medical ones and keeps the
 * ordinary ones out — the loan sense is the "<word> of" metaphor, the military
 * sense is the same "from" frame pointing at a different institution, and `the`
 * is therefore not an owner ("the discharge date on the loan" stays silent).
 */
const DISCHARGE_PATTERNS = [
  ownedWord('discharge', `${PERSONAL_OWNERS}|a|an|this|that`, true),
  qualifiedWord(
    'discharge',
    String.raw`nasal|vaginal|urethral|rectal|anal|ear|eye|nipple|wound|purulent|yellow|green|bloody|watery|mucous|mucoid|clear|thick|foul|smelly`,
  ),
  // "discharge from my ear", "discharge from the wound", "discharge from
  // hospital" — the body, or the hospital, is what makes the frame medical.
  new RegExp(
    String.raw`\bdischarg\w*\s+from\s+(?:${PERSONAL_OWNERS}|the)\s+(?:${BODY_OR_SYSTEM}|ear|ears|nose|wound|incision|hospital|clinic|surgical\s+site|nursing\s+home)\b`,
    'i',
  ),
  // "I was discharged last week" — a hospital stay. The military sense is the
  // same words with a different institution, and it is excluded by name.
  new RegExp(
    String.raw`\b(?:was|were|been|being|got|get|getting)\s+discharged\b(?!\s+from\s+the\s+(?:army|navy|air\s+force|military|marines|corps|service)\b)`,
    'i',
  ),
  // "the discharge was yellow" — no owner and no "from", but the adjective
  // carries the sense.
  new RegExp(
    String.raw`\bdischarg\w*\s+(?:was|is|has\s+been|looks?)\s+(?:yellow|green|bloody|clear|thick|watery|foul|smelly|purulent)\b`,
    'i',
  ),
];

/**
 * = "passed" / "passing" =====================================================
 *
 * Measured: seven medical phrases, every one of them silent before this rule —
 * "I passed out", "I keep passing out", "I pass blood", "pass a stone", "passing
 * urine", "I passed water" — plus "blood in my urine", the same symptom stated
 * without the verb. The nine ordinary sentences ("in passing", "passing the
 * time", "the passing of the law", "passing my details to a colleague", "the bill
 * was passed", "I passed the exam", "the passing lane", "the car passed us",
 * "time passing quickly") were silent before and are silent after.
 *
 * The one frame the two senses share is "passed out" meaning handed out, so the
 * fainting rule requires a person as the subject and no object after "out".
 */
const PASSING_PATTERNS = [
  new RegExp(
    String.raw`\b(?:${PERSON_PRONOUNS})(?:['\u2019](?:ve|d|m))?\s+(?:also\s+|just\s+|nearly\s+|almost\s+|keeps?\s+|kept\s+|was\s+|were\s+|is\s+|are\s+)?(?:passed|passing|pass|passes)\s+out\b(?!\s+(?:the|a|an|these|those|forms?|papers?|leaflets?|flyers?|books?|worksheets?|samples?|copies|handouts?)\b)`,
    'i',
  ),
  // The bodily phrases, none of which has an ordinary reading. The location
  // guard keeps "I passed a stone on the path" out of it.
  new RegExp(
    String.raw`\bpass(?:es|ed|ing)?\s+(?:blood|clots?|a\s+clot|gravel|stones?|a\s+stone|water|urine|stool)\b(?!\s+(?:on|in|by|near|along|at)\s+the\b)`,
    'i',
  ),
  // The same symptom without the verb: "blood in my urine".
  new RegExp(
    String.raw`\b(?:blood|pus|protein|sugar)\s+in\s+(?:${PERSONAL_OWNERS})\s+(?:urine|stool|water|wee)\b`,
    'i',
  ),
];

/**
 * = "pads" ====================================================================
 *
 * The plural of an excluded product word, and the measurement says the *token*
 * cannot be watched here: the medical frames ("I wear pads", "I change my pads
 * often") are the same frames as the ordinary ones ("I wear knee pads", "my pads
 * are worn out"), and the shared disclosure words make it worse — "I have to
 * replace the brake pads" is twenty characters of ordinary sentence away from
 * gating. So this is a qualified-phrase rule: what makes the product medical is
 * the word in front of it or the symptom behind it.
 *
 * Measured: four medical phrases, all silent before the rule ("sanitary pads",
 * "period pads", "maternity pads", "I need pads for bleeding"); five ordinary
 * sentences, all silent before and after ("I wear knee pads", "I use pads of
 * paper", "I need new brake pads", "my pads are worn out", "the pads of my
 * fingers"). The bare verb frames stay open — recorded as a residue rather than
 * guessed at, because closing them would gate the ordinary ones too.
 */
const PADS_PATTERNS = [
  qualifiedWord(
    'pads?',
    String.raw`sanitary|period|maternity|menstrual|nursing|incontinence|overnight`,
  ),
  /\bpads?\s+for\s+(?:bleeding|periods?|spotting|incontinence)\b/i,
];

/** Substring alternation over the long-form condition stems and their declared spellings. */
const HEALTH_CONDITION_PATTERN = new RegExp(
  `(?:${ALL_CONDITION_GATE_TERMS.map(escapeRegExp).join('|')})`,
  'i',
);

/** Whole-word alternation over the short-form condition tokens and their declared spellings. */
const HEALTH_CONDITION_WORD_PATTERN = new RegExp(
  `\\b(?:${ALL_CONDITION_GATE_WORD_TERMS.map(escapeRegExp).join('|')})\\b`,
  'i',
);

/**
 * The gate's ordinary-sense strips — the product-provision reading of the
 * suicide words ("the suicide clause" is the contract's vocabulary), the
 * topic-mention frames ("the report mentions forced labor" is the report's
 * subject), the maltreatment artefact compounds ("child abuse policy for our
 * staff") and their measured collocations — are declared data in
 * ./ordinary-sense-shapes.ts, whose entries carry the terms, the shapes and
 * the guards that keep the disclosure direction alive. The composed sources
 * are pinned byte-exact against the last hand-written generation in
 * tests/ordinary-sense-shapes.test.ts, so this call site is the whole
 * hand-written surface: one strip, in declaration order.
 */

/**
 * True when the text names a condition from THIS condition vocabulary,
 * independent of the generic disclosure patterns ("diagnosed", "medication",
 * ...) and of the short list of very common conditions in `healthPatterns`
 * (heart, diabetes, cancer, depression, anxiety, ptsd) that the gate already
 * covered before this vocabulary existed. Exposed so the test suite can assert
 * vocabulary parity and the exclusion list without relying on its own wording.
 *
 * Note the deliberate split: this function answers "is a vocabulary term
 * present?", so it stays false for the contextual abbreviations below (ms, sle,
 * tia, tb) even when `detectSensitiveData()` classifies the same sentence as
 * health data. Vocabulary membership and contextual classification are
 * different questions; conflating them would make the parity ledger lie about
 * which terms the vocabulary actually carries.
 */
export function isHealthConditionTerm(userInput: string): boolean {
  return HEALTH_CONDITION_PATTERN.test(userInput) || HEALTH_CONDITION_WORD_PATTERN.test(userInput);
}

/**
 * Context-qualified gating — the terms on GATE_EXCLUDED_TERMS that are still
 * gated once a disclosure, clinical qualifier, or possessive sits next to them —
 * now lives in the declarative registry at ./context-qualified-terms.ts, where
 * each entry declares its own spellings, guard, possessives, qualifiers and
 * strips, and the pattern family is derived from that data.
 *
 * Two directions are covered there, because both are natural ways to state a
 * diagnosis:
 *
 *   keyword → token   "I have MS", "history of TB", "diagnosed with SLE"
 *   token → keyword   "MS diagnosis", "SLE flares", "TB treatment"
 */

/**
 * A leading interrogative — the shape of a question *about* something.
 *
 * A trailing "?" alone is not enough: a disclosure fragment can end in one
 * ("history of SLE?"), and that belongs in the stricter disclosure path.
 *
 * The conditional branch ("If someone takes their own life, does the policy
 * pay out?") was, until the three-reading audit, **inert**: it sat inside the
 * shared group ahead of the trailing `\b`, and a word boundary can never
 * follow the branch's sentence-final `?` — so no conditional-shaped sentence
 * ever opened a question path. The branch now stands on its own; the word
 * alternatives keep the `\b` that stops "island" opening with "is".
 */
const QUESTION_OPENER =
  /^\s*(?!(?:do|does|did)\s+not\b)(?:if\s+[^.!?\n]{0,80}\?|(?:what|how|why|when|where|which|who|whose|does|do|is|are|was|were|can|could|should|would|will|am|may|might)\b)/i;

/**
 * The contract vocabulary a *product* question is built from — the nouns a
 * visitor names when the question is about their policy rather than about
 * themselves ("the policy", "my plan", "coverage", "underwriting").
 *
 * Bare `cover` is deliberately **not** here even though it is a noun: as a
 * verb it is the commonest way to ask a coverage question at all, and two pinned
 * rows depend on that reading being a health question — "do you cover
 * treatment?" and "do you cover prescriptions?" (the treatment and prescription
 * corpora, where the coverage question is the *medical* sense). A question needs
 * the product named as a noun to reach the contract rule, which is the boundary
 * this rule is built on.
 */
const CONTRACT_NOUN_PATTERN =
  /\b(?:polic(?:y|ies)|plans?|coverage|applications?|underwriting|carriers?|riders?)\b/i;

/**
 * A provision noun — the contract's own parts. Sitting next to a condition word
 * ("cancer exclusion", "suicide clause", "self harm rider") it makes the
 * condition a *term of the contract* rather than something about the person.
 * "pre-existing conditions" is included because it is the wording the product's
 * own copy uses and it names no diagnosis.
 */
const PROVISION_NOUN_PATTERN =
  /\b(?:clauses?|exclusions?|exclusion\s+periods?|riders?|provisions?|waiting\s+periods?|limitations?|pre-existing\s+conditions?)\b/i;

/**
 * The verbs and nouns a coverage question is asked with — what the policy does
 * to a condition (cover, exclude, pay out, void, cancel, deny, limit, treat,
 * assess, consider) and what it charges (premium, rate). The last group is the
 * verbs of an **application form** question ("does the application ask about
 * mental illness?", "does the policy require declaring cancer?"), which name
 * the product's paperwork rather than anybody's health.
 */
const COVERAGE_VERB_PATTERN =
  /\b(?:cover|covers|covered|excluding|exclude|excludes|excluded|exclusion|payouts?|pays?\s+out|paid\s+out|appl(?:y|ies|ied)|voids?|voided|cancel\w*|rescind\w*|refus\w*|den(?:y|ies|ied)|limits?|limited|reduc\w*|affect\w*|impact\w*|treat\w*|asses\w*|consider\w*|underwrit\w*|premiums?|rates?|asks?|required?|requires|declar\w*|disclos\w*|mention\w*|says?|say|states?|stated|wording|includ\w*)\b/i;

/**
 * An **act of self-harm described reflexively** — a person acting on
 * themselves, in any grammatical person ("if someone takes their own life",
 * "if he harms himself", "if I kill myself").
 *
 * This is the one shape the contract rule below must not claim, and it is
 * deliberately distinguished from a *manner of death named in a contract*
 * ("if the policyholder dies by suicide"): the first is a person's act and
 * keeps the health-topic handoff, the second is the clause's subject and is a
 * contract question. The reflexive pronoun is what carries the difference, so
 * "dies by suicide" and "suicide exclusion" do not match here.
 */
const SELF_HARM_ACT_PATTERN =
  /\b(?:takes?|took|taking|ends?|ended|ending|dies?|died|dying|die|kills?|killed|killing|harms?|harmed|harming|hurts?|hurt|hurting|injures?|injured|poisons?|poisoned|overdos\w*|cuts?|cutting)\b[^.!?\n]{0,24}\b(?:own\s+life|own\s+self|themselves?|himself|herself|myself|yourself|itself|their\s+life|my\s+life|his\s+life|her\s+life)\b/i;

/**
 * A contract noun with whatever possessive attaches to *it* — the one kind of
 * first-person wording that does not make a question personal. "my policy" is
 * the visitor's contract; "my cancer" is the visitor's health, and the rule
 * below is built on that difference.
 */
/**
 * The verbs of a payout question — "does the policy pay out?", "is there a
 * claim?" — which mark the conditional act question the contract rule must
 * not claim (see the guard in `detectContractQuestion`).
 */
/**
 * The **act-as-subject payout question** — "If someone takes their own life,
 * does the policy pay out?" — which names the act and **no condition**, the
 * one shape the three-reading split left silent. The act is not a topic; the
 * payout verbs make it a question about the product. Shared by the caller's
 * topic branch (which must consult it before the condition test, since no
 * condition is named) and `detectHealthTopicQuestion` (which still applies
 * its personal-framing guard first, so "If I kill myself, does the policy pay
 * out?" stays on the disclosure path).
 */
function isSelfHarmActPayoutQuestion(userInput: string): boolean {
  return (
    SELF_HARM_ACT_PATTERN.test(userInput) &&
    !PROVISION_NOUN_PATTERN.test(userInput) &&
    PAYMENT_VERB_PATTERN.test(userInput)
  );
}

/**
 * First-person wording — the person test for the act-as-subject payout
 * question, whose act carries its own pronoun: "someone takes their own life"
 * is a generic third person (the act, not a topic, is the subject), while
 * "if I kill myself" and "if my husband takes his own life" are the visitor
 * or their family and stay disclosures. The shared `PERSONAL_FRAMING` list
 * would misread the act's generic "their" as family framing, so this shape
 * decides its own person with the first-person words alone.
 */
const FIRST_PERSON_PATTERN = /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|myself|we|we're|our|ours|us)\b/i;

const PAYMENT_VERB_PATTERN = /\b(?:pays?|paid|paying|payouts?|claims?|benefits?)\b/i;

const CONTRACT_PHRASE_PATTERN =
  /\b(?:my|our|your|his|her|their|its|the|a|an|this|that)\s+(?:polic(?:y|ies)|plans?|cover(?:age)?|applications?|underwriting|riders?)(?:'s)?\b/gi;

/** The text with the contract's own possessives removed ("my policy" → gone). */
function withoutContractPhrases(userInput: string): string {
  return userInput.replace(CONTRACT_PHRASE_PATTERN, ' ');
}

/**
 * First-person or family framing, which makes a health mention personal.
 *
 * "does MS affect my life insurance rate?" is a question about the visitor's
 * own situation — an implied condition — so it stays `health_data`. The same
 * question without the possessive ("does MS affect life insurance rates?") is a
 * topic question.
 */
const PERSONAL_FRAMING =
  /\b(?:i|i'm|i've|i'd|i'll|me|my|mine|myself|we|we're|our|ours|us|father|mother|mom|mum|dad|parent|parents|brother|sister|sibling|spouse|wife|husband|partner|son|daughter|child|children|kid|kids|grandfather|grandmother|grandparent)\b/i;

/**
 * The question paths' personal-framing test: `PERSONAL_FRAMING` with `child`
 * removed. Inside "child abuse" or "child neglect" the word "child" is the
 * condition's modifier, not a person reference — but the same word in the
 * same sentence is what a contract question uses ("does the policy have a
 * child abuse exclusion?"), so the compound must be set aside before the test
 * rather than the word removed from the list. Blanking the bare compound is
 * safe in these paths because a personal frame always carries its own marker
 * outside the compound: "does child abuse affect my premium?" still has "my",
 * and "was my child abused?" still has "my" — only the impersonal question
 * loses the false positive.
 */
const PERSONAL_FRAMING_FOR_QUESTIONS = new RegExp(
  PERSONAL_FRAMING.source.replace('child|', ''),
  'i',
);

/** The text with the maltreatment compounds removed, for the question paths. */
function withoutQuestionCompounds(userInput: string): string {
  const compound = new RegExp(`\\b${MALTREATMENT_TERMS}\\b`, 'gi');
  return userInput.replace(compound, ' ');
}

/**
 * Conditions common enough to be named without the crosswalk vocabulary.
 *
 * Narrower than the disclosure patterns on purpose: those also watch meta words
 * ("treatment", "condition", "disease") and lifestyle fields ("height",
 * "weight", "tobacco"), and using them here would turn "what conditions apply
 * to my application?" into a health question.
 */
const COMMON_CONDITION_PATTERN =
  /(?:blood\s+pressure|cholesterol|diabetes|cancer|depression|anxiety|ptsd|disease|disorder)/i;

/**
 * True when the text names a condition — the crosswalk vocabulary, a common
 * condition, or a context-qualified term from the registry (with the ambiguity
 * and quantifier guards applied).
 */
function namesCondition(userInput: string): boolean {
  const sanitized = withoutAmbiguousSpellings(userInput);
  return (
    COMMON_CONDITION_PATTERN.test(sanitized) ||
    // The context-qualified registry, guards applied: it is what makes "Is
    // piles curable?" a question about a condition and "Are piles of paperwork
    // a problem?" nothing at all.
    namesContextQualifiedTerm(userInput) ||
    // `illness` is tested here through its own pattern rather than this
    // alternation, so the PRODUCT carve-out applies on this path too: "is
    // critical illness cover worth it?" is a pricing question, not a condition
    // question, and it reached this function before.
    ILLNESS_PATTERNS.some((p) => p.test(sanitized)) ||
    HEALTH_CONDITION_PATTERN.test(sanitized) ||
    HEALTH_CONDITION_WORD_PATTERN.test(sanitized)
  );
}

/**
 * True when the input is an impersonal question about a health condition.
 *
 * Three requirements, all of them necessary:
 *
 *   1. it opens with an interrogative ("Is TB curable?", "How is cancer
 *      treated?") — not merely a statement with a question mark;
 *   2. it names a condition — the vocabulary, or a context-qualified term from
 *      the registry in any spelling, with the usual ambiguity guards applied;
 *   3. it carries no first-person or family framing, so a question about the
 *      visitor's own situation stays a personal disclosure.
 *
 * This is a classification, not a permission: the caller still refuses and
 * hands off. The point is that it refuses with accurate framing and records an
 * accurate reason — a question about a topic is not a disclosure of health
 * data, and saying so would misstate the visitor's action and the record.
 *
 * Exported so the rule can be tested directly.
 */
export function detectHealthTopicQuestion(userInput: string): boolean {
  if (!QUESTION_OPENER.test(userInput)) return false;
  // The act-as-subject payout question decides its own person (see
  // FIRST_PERSON_PATTERN): first-person wording makes it the visitor's own
  // act — a disclosure, refused here so the caller keeps it on the health-data
  // path — while the generic form ("If someone takes their own life, does the
  // policy pay out?") is a question about the product, caught even though it
  // names no condition. When the act sits beside an explicit provision ("does
  // the suicide exclusion apply if someone takes their own life?") the
  // contract rule is consulted first in the caller and its own act guard
  // refuses it — this branch never runs there, and the road test's pinned
  // rows hold.
  if (isSelfHarmActPayoutQuestion(userInput)) return !FIRST_PERSON_PATTERN.test(userInput);
  if (PERSONAL_FRAMING_FOR_QUESTIONS.test(withoutQuestionCompounds(userInput))) return false;
  return namesCondition(userInput);
}

/**
 * True when the input is a **contract question** — an impersonal question about
 * the product's own policy wording, not about anybody's health.
 *
 * Motivated by the same measurement that produced the topic-question path and
 * the provision strip: "does the suicide exclusion apply after two years?" and
 * "does the policy have a cancer exclusion?" name a condition, so the gate was
 * handing them off as `health_topic_question` — with the copy "that's a health
 * topic" and a health-topic risk flag on a record where the visitor disclosed
 * nothing about their health and asked about their policy. The condition is the
 * *provision's* subject, not the visitor's.
 *
 * Three requirements, all necessary:
 *
 *   1. it is a question (an interrogative opener, the same shape the topic path
 *      requires — a mid-sentence interrogative stays on the old path);
 *   2. it is framed as a provision or coverage question — a provision noun
 *      ("cancer exclusion"), or a contract noun with a coverage verb ("does the
 *      policy cover depression?", "how does the underwriting treat diabetes?");
 *   3. it carries no personal health framing once the contract's own
 *      possessives are set aside: "my policy" is the visitor's contract, while
 *      "my cancer", "my husband's cancer" and "am I covered for my diabetes?"
 *      make it personal and stay `health_data`.
 *
 * It is a classification, not a permission granted here: the caller answers it
 * like any other product question, because what was asked is about the policy.
 * What it deliberately does **not** cover is the suicide wording's statement
 * form (the registry's product-provision entry), any personally-framed question, and
 * any sentence describing an act of self-harm (`SELF_HARM_ACT_PATTERN`) — those
 * three keep the health-topic or health-data handoff.
 *
 * The boundary that stays on the old path: a coverage question that names
 * neither the product nor a provision ("is a suicide attempt covered?", "is
 * cancer covered?") is still a health topic question, because the app's
 * existing decision keeps bare coverage questions there.
 *
 * Exported so the rule can be tested directly.
 */
export function detectContractQuestion(userInput: string): boolean {
  if (!QUESTION_OPENER.test(userInput)) return false;
  const framed =
    PROVISION_NOUN_PATTERN.test(userInput) ||
    (CONTRACT_NOUN_PATTERN.test(userInput) && COVERAGE_VERB_PATTERN.test(userInput));
  if (!framed) return false;
  // An act of self-harm described in *any* person is not a contract question:
  // it keeps the health-topic handoff rather than a policy answer.
  if (SELF_HARM_ACT_PATTERN.test(userInput)) return false;
  // (The earlier PAYMENT_VERB guard's second branch is folded into the act
  // guard above: an act question in conditional form fails the same test —
  // `SELF_HARM_ACT_PATTERN` matches the act whether or not a payout verb
  // follows, so the second `if` could never run. The conditional payout
  // question is caught by the topic predicate's act branch instead, and the
  // road test's pinned rows hold.)
  return !PERSONAL_FRAMING_FOR_QUESTIONS.test(
    withoutQuestionCompounds(withoutContractPhrases(userInput)),
  );
}

/**
 * True when a context-qualified term appears next to a disclosure or history
 * word, a clinical noun, a possessive, or a clinical qualifier: the rule that
 * lets "I have MS" and "I have piles" gate while "Ms. Smith", "sleep", and
 * "piles of paperwork" do not.
 *
 * The rule is data in ./context-qualified-terms.ts — one entry per term, each
 * declaring its own spellings, guard, possessives, qualifiers and strips. This
 * is the predicate the gate calls, re-exported from the module that used to
 * hand-code the patterns so the mechanism stays testable directly rather than
 * only through `detectSensitiveData()`.
 */
export { hasContextQualifiedTerm };

/**
 * Checks if user input appears to contain PII or health data.
 *
 * @param userInput - The text entered by the user
 * @returns The category of sensitive data detected, or null
 */
export function detectSensitiveData(
  userInput: string,
): (typeof INPUT_CLASSIFICATION_CATEGORIES)[number] | null {
  // Financial-account patterns are checked BEFORE health data so that a
  //   message containing both categories (e.g. "My account number is
  //   123456789 and I have diabetes") always hits the financial block first.
  //   In medical_review, health_data is allowed through — but financial
  //   identifiers must never reach the LLM regardless of stage.
  //   Banking identifiers, tuned like the phone rules: the number alone is
  //   never enough, it must sit next to a whole-word account/routing/bank
  //   keyword (or the common "acct" abbreviation). A bare 9- or 10-digit
  //   sequence stays unclassified (it could be a case/reference id).
  //   Routing number: 9 digits next to a banking keyword.
  //   Account number: 8-17 digits next to a banking keyword.
  //   Accepts spaces and hyphens within the digit group (e.g.
  //   "1234-5678-9012" or "1234 5678 9012") since formatted account/routing
  //   numbers are common. The keyword uses \b word boundaries so substrings
  //   like "bankruptcy" or "accountancy" don't trigger.
  // NOTE: must use regex literals, not `new RegExp` with template strings.
  //   In a template literal \b becomes a backspace char and \d becomes literal
  //   'd', so the pattern silently matches nothing.
  const financialPatterns = [
    // Keyword → 9-digit routing (with optional spaces/hyphens in the number)
    /\b(?:routing|account|bank|acct)\b[^\n]{0,30}\b\d[\d\s-]{6}\d\b/i,
    // 9-digit routing → keyword
    /\b\d[\d\s-]{6}\d\b[^\n]{0,30}\b(?:routing|account|bank|acct)\b/i,
    // Keyword → 8-17 digit account (with optional spaces/hyphens)
    /\b(?:routing|account|bank|acct)\b[^\n]{0,30}\b\d[\d\s-]{6,15}\d\b/i,
    // 8-17 digit account → keyword
    /\b\d[\d\s-]{6,15}\d\b[^\n]{0,30}\b(?:routing|account|bank|acct)\b/i,
  ];

  if (financialPatterns.some((p) => p.test(userInput))) {
    return 'financial_account_data';
  }

  // An impersonal question about a condition ("Is TB curable?") is classified
  // BEFORE the disclosure patterns, so the framing and the recorded reason
  // describe what actually happened: a question about a topic, not a health
  // disclosure. Ordering matters — a question that mentions the visitor's own
  // situation ("does MS affect MY rate?") is caught by the personal-framing
  // guard inside the predicate and falls through to `health_data` below.
  // A **contract question** — "does the suicide exclusion apply after two
  // years?", "does the policy have a cancer exclusion?" — is not health data and
  // not a health topic: the condition named is the *provision's* subject, and the
  // answer is the policy's. It is answered like any other product question. The
  // flag is applied to the health branches only, so a message that also carries
  // an account number is still caught by the financial and PII checks below.
  const contractQuestion = detectContractQuestion(userInput);

  // The act-as-subject payout question names no condition, so it is consulted
  // before (and independently of) the condition test — the predicate applies
  // its personal-framing guard, keeping the first-person form on the
  // disclosure path below.
  if (
    !contractQuestion &&
    QUESTION_OPENER.test(userInput) &&
    (isSelfHarmActPayoutQuestion(userInput) || namesCondition(userInput))
  ) {
    return detectHealthTopicQuestion(userInput) ? 'health_topic_question' : 'health_data';
  }

  // Health data patterns
  const healthPatterns = [
    // The broad two-sense families and the four words narrowed in the first
    // measurement pass — "condition", "treatment", "heart", "symptom",
    // "prescription", "disease", "disorder", plus "diagnosis", "therapy",
    // "therapist" and "medication" — generated from their registry entries in
    // src/security/context-family-terms.ts. "medication" is the bare rule there:
    // the probe found no ordinary sense at all ("medicate the problem" and
    // "medicated shampoo" do not even contain the word), so it is matched as
    // declared rather than qualified.
    ...CONTEXT_FAMILY_PATTERNS,
    // The syntactic-collision class: a lay synonym or a phrase whose ordinary
    // sense is a quantifier, a particle or a location frame rather than a
    // second meaning of the word. `stones` and `pads` are registry entries
    // (their shapes come from the tokens); growth, discharge and passing are
    // phrase families, because the medical sense is carried by what surrounds
    // the word rather than by the word itself.
    ...GROWTH_PATTERNS,
    ...DISCHARGE_PATTERNS,
    ...PASSING_PATTERNS,
    ...PADS_PATTERNS,
    // Common named conditions. `heart` is deliberately absent: it moved to the
    // context-family registry, where "the heart of the policy" is not a heart
    // condition.
    // `blood pressure` and `cholesterol` stay in this bare alternation on the
    // measurement: the probe found no realistic ordinary sense for either (only
    // contrived ones — "the blood pressure of the market", "the cholesterol of
    // the policy"), so qualifying them would buy nothing and cost a rule.
    /(?:blood\s+pressure|cholesterol|diabetes|cancer|depression|anxiety|ptsd)/i,
    // Lifestyle and body-measure fields. `bmi` and `nicotine` keep their bare
    // stems on the same measurement — no ordinary sense exists for either. The
    // rest are qualified; their rules and their measured corpora sit together in
    // WEIGHT/HEIGHT/SUBSTANCE/TOBACCO/ALCOHOL/SMOKER_PATTERNS above.
    /\b(?:bmi|nicotine)\b/i,
    ...WEIGHT_PATTERNS,
    ...HEIGHT_PATTERNS,
    ...SUBSTANCE_PATTERNS,
    ...TOBACCO_PATTERNS,
    ...ALCOHOL_PATTERNS,
    ...SMOKER_PATTERNS,
    // The four words the source comments had flagged as collision-prone turned
    // out to be the mirror image after measuring: three were coverage gaps
    // (stress, smoke, drink) and one needed both directions (illness, whose only
    // over-match was the product name "critical illness cover").
    ...STRESS_PATTERNS,
    ...ILLNESS_PATTERNS,
    ...SMOKE_PATTERNS,
    ...DRINK_PATTERNS,
    /(?:family\s+history|medical\s+history|health\s+history)/i,
  ];

  if (!contractQuestion && healthPatterns.some((p) => p.test(userInput))) {
    return 'health_data';
  }

  // Condition names stated plainly ("I have lupus", "I wear a CPAP for sleep
  // apnea") — see HEALTH_CONDITION_TERMS / HEALTH_CONDITION_WORD_TERMS.
  // Without these, a visitor who names a condition without using a disclosure
  // word (diagnosed/medication/...) is not classified as health data at all.
  // Matched against a copy of the text with the ordinary-sense shapes
  // removed (`stripOrdinarySenseShapes`), so "the suicide clause in the
  // policy" is what it is — a product question — "the report mentions forced
  // labor" is the report's subject, and "child abuse policy for our staff" is
  // a policy topic, while the disclosure forms name no frame and cannot be
  // silenced by the strips. They remove a frame, never a term on its own:
  // "forced labor" and "I was trafficked as a child" are untouched.
  if (!contractQuestion && isHealthConditionTerm(stripOrdinarySenseShapes(userInput))) {
    return 'health_data';
  }

  // Terms excluded as standalone tokens (GATE_EXCLUDED_TERMS: "Ms." is a
  // title, "sleep" contains "sle", "Tia" is a name, "tb" is under the
  // 3-character minimum, "piles" is a quantifier) but unambiguous once a
  // disclosure, clinical qualifier, or possessive sits next to them. Same
  // keyword-adjacency approach as the phone-number rules below: the token alone
  // is not enough, the context is what makes it a disclosure. Each term's
  // spellings, guard, possessives and qualifiers are declared in the registry
  // at ./context-qualified-terms.ts.
  if (!contractQuestion && hasContextQualifiedTerm(userInput)) {
    return 'health_data';
  }

  // PII patterns — tuned to reduce false positives on benign numbers.
  //   SSN: requires the canonical XXX-XX-XXXX format (or XXX XX XXXX /
  //   XXX.XX.XXXX). The bare \d{3}\d{2}\d{4} variant was removed because
  //   it matched any 9-digit sequence.
  //   Phone: requires a +1 prefix, or (XXX) area code, or an explicit phone
  //   keyword nearby. A bare 10-digit number alone is not enough — it could
  //   be a reference number or ZIP+4.
  const piiPatterns = [
    // Email (high precision)
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    // SSN — canonical format only (XXX-XX-XXXX or XXX.XX.XXXX or XXX XX XXXX)
    /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/,
    // Phone — with context: +1 prefix or (XXX) area-code format
    /\+1\s?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
    /\(\d{3}\)\s?\d{3}[-.\s]?\d{4}/,
    // Phone — with an explicit keyword nearby (call/text/phone/number/fax)
    /(?:call|text|phone|number|fax|reach|dial)[^\n]{0,30}\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/i,
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b[^\n]{0,30}(?:call|text|phone|number|fax|reach|dial)/i,
    // Credit card — 4 groups of 4 digits separated by spaces or dashes
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  ];

  if (piiPatterns.some((p) => p.test(userInput))) {
    return 'pii';
  }

  return null;
}

/**
 * Prohibited promotional/free-offer phrases (marketing-review gate).
 *
 * The word "free" alone is not flagged — only promotional offers whose terms
 * are not approved. Until FREE_OFFER_MARKETING_APPROVED=true after marketing
 * review, the assistant must never claim a free quote, free consultation,
 * free estimate, or no-obligation review.
 */
export const PROMOTIONAL_OFFER_PATTERNS = [
  /\bfree\s+(?:quote|consultation|estimate|review|assessment|evaluation)\b/i,
  /\b(?:100\s*%|totally|absolutely|completely)\s+free\b/i,
  /\bfree\s+of\s+charge\b/i,
  /\bno[\s-]?obligation\b/i,
] as const;

/**
 * Returns true when the text contains a promotional free-offer claim whose
 * terms are not approved (free quote / free consultation / no-obligation).
 * Used as an output guard while FREE_OFFER_MARKETING_APPROVED is false.
 *
 * @param text - The assistant message or other text to inspect
 */
export function detectProhibitedPromotionalOffer(text: string): boolean {
  return PROMOTIONAL_OFFER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Rate limiting state tracking (per session/IP).
 * In production, this should use Redis or a similar shared store.
 */
interface RateLimitState {
  sessionId: string;
  requestCount: number;
  windowStart: number;
  tokenCount: number;
  /** Last activity timestamp, used by the cleanup timer to prune stale entries. */
  lastActivity: number;
}

const rateLimitStore = new Map<string, RateLimitState>();

/**
 * Rate limit configuration.
 *
 * All budgets are per-window (one minute), not per-session lifetime: every
 * counter resets when WINDOW_MS elapses. The names use *_PER_WINDOW because
 * the reset behavior is the guarantee — a session that exhausts a budget is
 * limited for the current minute, never permanently locked out for the
 * lifetime of the process. (The earlier *_PER_SESSION names described
 * lifetime budgets that the reset contradicted.)
 */
export const RATE_LIMIT_CONFIG = {
  /** Max requests per window (1 minute) */
  MAX_REQUESTS_PER_WINDOW: 20,
  /** Max tokens per window (1 minute), fed by real LLM usage from the
   *  orchestrator via incrementTokenCount. */
  MAX_TOKENS_PER_WINDOW: 50000,
  /** Window size in milliseconds (1 minute) */
  WINDOW_MS: 60_000,
  /** How long to keep a rate-limit entry after its last activity before
   *  it is eligible for cleanup. Keeps the store bounded so it doesn't
   *  grow forever with unique session IDs. */
  ENTRY_TTL_MS: 10 * 60_000, // 10 minutes of inactivity
  /** Interval for pruning stale rate-limit entries. */
  CLEANUP_INTERVAL_MS: 5 * 60_000, // 5 minutes
} as const;

/**
 * Checks rate limits for a session.
 * Returns true if the request is allowed, false if rate-limited.
 */
export function checkRateLimit(sessionId: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  let state = rateLimitStore.get(sessionId);

  if (!state) {
    state = {
      sessionId,
      requestCount: 0,
      windowStart: now,
      tokenCount: 0,
      lastActivity: now,
    };
    rateLimitStore.set(sessionId, state);
  }

  // Reset the per-window counters when the window expires. Previously only
  // requestCount was reset, which left tokenCount permanently elevated — a
  // session that hit the token budget stayed locked out for the lifetime of
  // the process.
  if (now - state.windowStart > RATE_LIMIT_CONFIG.WINDOW_MS) {
    state.requestCount = 0;
    state.tokenCount = 0;
    state.windowStart = now;
  }

  state.lastActivity = now;

  if (state.requestCount >= RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, reason: 'rate_limit_exceeded' };
  }

  if (state.tokenCount >= RATE_LIMIT_CONFIG.MAX_TOKENS_PER_WINDOW) {
    return { allowed: false, reason: 'token_budget_exceeded' };
  }

  state.requestCount++;
  return { allowed: true };
}

/**
 * Write-endpoint rate limiting state (per client key, e.g. client IP).
 *
 * `/api/chat` is budgeted per session because a session is what the model call
 * belongs to. The two *write* endpoints — `/api/consent` and `/api/dsr` — are
 * unauthenticated by design (a consumer must be able to submit a lead or a
 * privacy request without an account), and each accepted request appends a
 * record to disk. Without a bound, one client can fill the volume and flood
 * the retention store. They are therefore budgeted per client key, with their
 * own deliberately generous window so ordinary use never notices.
 */
const writeRateLimitStore = new Map<string, RateLimitState>();

/**
 * Write-endpoint budget. Per client key, per one-minute window.
 *
 * 60/min is chosen to be far above any human pace (a person submitting a
 * contact form and a privacy request a few times) while still bounding a
 * scripted flood. Kept in the same shape as RATE_LIMIT_CONFIG so both limiters
 * reset and clean up identically.
 */
export const WRITE_RATE_LIMIT_CONFIG = {
  MAX_REQUESTS_PER_WINDOW: 60,
  WINDOW_MS: 60_000,
} as const;

/**
 * Checks the write-endpoint budget for a client key (client IP).
 *
 * @param clientKey - Stable identifier for the caller (req.ip in the server)
 */
export function checkWriteRateLimit(clientKey: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  let state = writeRateLimitStore.get(clientKey);

  if (!state) {
    state = {
      sessionId: clientKey,
      requestCount: 0,
      windowStart: now,
      tokenCount: 0,
      lastActivity: now,
    };
    writeRateLimitStore.set(clientKey, state);
  }

  if (now - state.windowStart > WRITE_RATE_LIMIT_CONFIG.WINDOW_MS) {
    state.requestCount = 0;
    state.windowStart = now;
  }

  state.lastActivity = now;

  if (state.requestCount >= WRITE_RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, reason: 'rate_limit_exceeded' };
  }

  state.requestCount++;
  return { allowed: true };
}

/**
 * Increments the per-window token count for a session using real LLM usage
 * passed up from the orchestrator (input + output across attempts). This is
 * what makes MAX_TOKENS_PER_WINDOW enforce: without it, tokenCount stayed 0
 * forever and the token budget was dead config.
 *
 * No-op when the session has no rate-limit state or the count is not a
 * positive number (defensive — real usage is always >= 0).
 */
export function incrementTokenCount(sessionId: string, tokens: number): void {
  const state = rateLimitStore.get(sessionId);
  if (state && Number.isFinite(tokens) && tokens > 0) {
    state.tokenCount += tokens;
    state.lastActivity = Date.now();
  }
}

/**
 * Periodic cleanup of stale rate-limit entries. Without this the
 * rateLimitStore Map grows unboundedly with unique session IDs, leaking
 * memory in a long-running process. Runs on a timer that does not keep
 * the process alive on its own (unref).
 */
let rateLimitCleanupTimer: NodeJS.Timeout | null = null;

export function startRateLimitCleanup(): void {
  if (rateLimitCleanupTimer) {
    return; // Already running
  }
  rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, state] of rateLimitStore.entries()) {
      if (now - state.lastActivity > RATE_LIMIT_CONFIG.ENTRY_TTL_MS) {
        rateLimitStore.delete(id);
      }
    }
    for (const [id, state] of writeRateLimitStore.entries()) {
      if (now - state.lastActivity > RATE_LIMIT_CONFIG.ENTRY_TTL_MS) {
        writeRateLimitStore.delete(id);
      }
    }
  }, RATE_LIMIT_CONFIG.CLEANUP_INTERVAL_MS);

  // Don't keep the process alive just for the cleanup timer
  if (rateLimitCleanupTimer.unref) {
    rateLimitCleanupTimer.unref();
  }
}

/**
 * Stops the cleanup timer (for graceful shutdown / tests).
 */
export function stopRateLimitCleanup(): void {
  if (rateLimitCleanupTimer) {
    clearInterval(rateLimitCleanupTimer);
    rateLimitCleanupTimer = null;
  }
}

/**
 * Clears all rate-limit state (for testing).
 */
export function clearAllRateLimits(): void {
  rateLimitStore.clear();
  writeRateLimitStore.clear();
}

/**
 * The kill switch. When activated, the system immediately stops serving
 * model responses and falls back to a static FAQ.
 */
let killSwitchActive = false;

export function activateKillSwitch(): void {
  killSwitchActive = true;
}

export function deactivateKillSwitch(): void {
  killSwitchActive = false;
}

export function isKillSwitchActive(): boolean {
  return killSwitchActive;
}
