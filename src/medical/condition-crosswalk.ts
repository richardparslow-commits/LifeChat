/**
 * Canonical medical-condition crosswalk (Phase 2, consented medical fact-finding)
 *
 * Purpose: the model records conditions the user states in their own words
 * (`MedicalProfile.medical_conditions: string[]`). Free text cannot be matched
 * or queried, so this module maps that text onto a small, versioned,
 * canonical vocabulary — one ICD-10-CM code + canonical name + body system per
 * condition — so the licensed broker can group and query a profile the same way
 * every time.
 *
 * Design rules (deliberate, and the reason this module is so literal):
 *
 *   1. CONSENT GATE FIRST — `mapConsentedMedicalConditions()` is the only
 *      entry point that touches a user's stated conditions, and it returns
 *      `null` unless health-data capture is enabled AND medical consent is
 *      affirmed AND versioned. The crosswalk never becomes a side door around
 *      the §9.1 / HEALTH_DATA_COLLECTION_DISABLED gate enforced in
 *      src/index.ts and src/security/security-controls.ts.
 *   2. NEVER GUESS — matching is exact against a curated alias index (after
 *      light text normalization). There is no fuzzy, prefix, or substring
 *      matching, and no code is ever inferred. Text that does not match is
 *      returned in `unmapped` and left in the user's own words; "complete"
 *      mapping means every condition is either matched or explicitly flagged,
 *      never silently coerced onto the nearest code.
 *   3. ADDITIVE, NOT DESTRUCTIVE — the user's stated wording
 *      (`medical_conditions`) is preserved verbatim on the record. Canonical
 *      refs are stored alongside it, tagged with the vocabulary id + version so
 *      a later mapping change is reproducible and auditable.
 *   4. CLINICAL NORMALIZATION ONLY — a canonical ref classifies what the user
 *      reported. It is never an underwriting judgment, an eligibility finding,
 *      a rating, or a carrier decision, and it is never shown to the user.
 *   5. SENSITIVE BY CLASSIFICATION — canonical refs are TDPSA sensitive health
 *      data. They belong only in the encrypted operational lead record: never
 *      in analytics, session history, logs, or the chat response.
 *
 * The vocabulary covers the domains the review literature and the approved
 * medical topics exercise (cardiovascular, metabolic,
 * autoimmune/inflammatory, neurodegenerative, respiratory, sleep, renal,
 * musculoskeletal, gastrointestinal, mental health, oncologic, hematologic,
 * infectious), including the systemic physical outcomes the PTSD phenome
 * syntheses report beyond the classic cardiovascular/metabolic rows — acute
 * cardiac events and arrhythmia, venous thromboembolism, transient ischemic
 * attack and neuropathy, traumatic brain injury, obstructive airways disease,
 * restless legs, nephrotic disease and renal calculi, low bone density, hepatic
 * disease, the major tumor sites, and the bacterial/infectious rows. It also
 * carries the common-chronic domains the literature sweep never reached but a
 * carrier medical-history questionnaire still enumerates: gynecologic/
 * reproductive, urologic, dermatologic, ophthalmologic/otologic, ENT/oral,
 * congenital/developmental, and the residual musculoskeletal,
 * gastrointestinal, hematologic, infectious, oncologic, endocrine,
 * respiratory, and mental-health rows.
 *
 * SOME CODES DEPEND ON WHAT THE PERSON SAID ABOUT THEMSELVES, NOT ON MORE
 * CLINICAL DETAIL (1.10.0). The codebook occasionally splits one condition into
 * sibling codes that differ only by a qualifier the visitor has already stated
 * somewhere else — FY2026's urethral stricture split (male / female), and the
 * site words a person puts in the phrase itself ("bladder calculus", "lump in my
 * breast"). A row declares that dependence with `appliesWhen` instead of leaving
 * the condition unmapped: sex comes from the consented profile (never inferred
 * from prose), a site is matched in the person's own words, and a phrase that
 * supplies neither resolves to nothing at all — the deferral is the same
 * never-guess outcome, now recorded as data with a reason rather than as an
 * absence. Site-qualified rows additionally resolve the spelled-out forms
 * ("ureteric calculus") by stripping the declared site word and matching the
 * remainder, which is the "qualifying rule" the 1.8.0 stone-family residue asked
 * for. A qualifier never widens a match: it only chooses between siblings that
 * were already curated.
 *
 * COVERAGE IS COMPLETE, NOT MERELY LARGER, and "complete" is a declared scope
 * rather than a promise. The scopes are declared and enforced — 1.2.0's
 * common-chronic questionnaire set, 1.3.0's residual gap, 1.4.0's
 * questionnaire sweep, 1.6.0's critical-illness covered-condition lists,
 * 1.7.0's ICD-10 Chapter IX enumeration, 1.8.0's stone-family residue, 1.9.0's
 * ICD-10 Chapter XIV enumeration (the chapter the stone family sits in,
 * N00–N99) and 1.10.0's qualifier-split rows — each of them a measured gap
 * rather than an assumption, and each
 * carrying a `CAPTURE_SCOPE`-shaped ledger whose code list must equal its
 * release's `added` list. The probe and corpus terms
 * themselves are kept verbatim in the test suite with a standing assertion that
 * nothing they surfaced is left ungated. Two ledgers enforce it in
 * `tests/medical-condition-gate.test.ts`: (1) every canonical alias is
 * classified as health data by the gate (or is a documented exclusion), and
 * every term the gate watches for either resolves to a canonical entry or
 * appears on the documented list of descriptive terms (body systems,
 * measurements, symptoms, pathoanatomic categories) that are not reportable
 * conditions — so a condition term cannot be added to the gate without a
 * crosswalk entry or vice versa; and (2) `CAPTURE_SCOPE` declares the common
 * chronic conditions a medical-history questionnaire enumerates, each with the
 * code it must resolve to, and asserts both that every declared phrase reaches
 * exactly that code and is gated, and that the declared code list equals the
 * current release's `added` list. Nothing in the vocabulary may sit outside the
 * scope unless it is source-derived, and out-of-scope text is returned in
 * `unmapped` in the person's own words rather than coerced.
 *
 * Expanding it is expected. Any change to codes, names, systems, or aliases is a
 * version bump with an entry in `CONDITION_VOCABULARY_CHANGELOG` — and the
 * version, the changelog, and the vocabulary are locked together by test, so a
 * condition cannot be added without recording the release. Counsel sign-off
 * under docs/medical-lead-capture-phase2.md §7 still governs any live use.
 */

/** Vocabulary identity — stored on every mapped record for reproducibility. */
export const CONDITION_VOCABULARY_ID = 'lifechat-condition-v1';

/** Bump on any change to codes, names, systems, or aliases. */
export const CONDITION_VOCABULARY_VERSION = '1.16.0';

/** One released revision of the vocabulary. */
export interface ConditionVocabularyRevision {
  /** Semantic version. Minor = additive/alias changes; major = a code, name,
   * or body-system change that would re-map an already-stored condition. */
  version: string;
  /** Release date, YYYY-MM-DD. */
  date: string;
  /** What changed, in one sentence. */
  summary: string;
  /** Total canonical conditions after this release — the count the vocabulary
   * had when this version was published. */
  condition_count: number;
  /** ICD-10-CM codes added by this release. */
  added: string[];
  /**
   * Aliases re-pointed from one code to another. Recorded because a stored
   * record mapped under the older version resolved the same stated text to the
   * older code — this is the list that makes such a record explainable.
   */
  aliases_moved: { alias: string; from: string; to: string }[];
}

/**
 * Release history, newest first. Append-only: a released entry is never edited
 * or removed, because stored records cite the version they were mapped under.
 *
 * The test suite enforces the link in both directions — every code named here
 * must exist in the vocabulary, every moved alias must actually resolve to its
 * new code and not the old one, and the newest entry's `condition_count` must
 * equal the live vocabulary's length, chained back through the history. Adding
 * or removing a condition without a matching entry fails the build.
 */
export const CONDITION_VOCABULARY_CHANGELOG: ConditionVocabularyRevision[] = [
  {
    version: '1.16.0',
    date: '2026-09-20',
    summary:
      'Closed the ICD-10 Chapter V sweep — the seventh candidate source, the fifth codebook enumeration, and the first chapter whose rows are mostly **stateable**: a mental and behavioural disorder is something a person says about themselves, so a bare category title is close to what a visitor types. The vocabulary, grown from physical-condition sources, was looking straight through the mind: the three-character titles of F00–F99 (72 titles, 62 candidates, ten declared in the corpus with reasons because they are coder-routing constructs) surfaced nine silent rows, and seven of them are named diagnoses now. Two batches of five: manic episode (F30.9), paraphilia (F65.9) and the first three severity rows of the intellectual-disability block (mild F70, moderate F71, severe F72); then profound (F73) and unspecified (F79). The block’s shape decided the wording rather than the corpus’s row order: the generic "intellectual disability" belongs to the *unspecified* member (F79), because F70–F73 assert a severity the person did not state, and **F78 is not mapped at all** — the codebook makes "other intellectual disabilities" a non-billable header whose only members are genetic-related (F78.A1, F78.A9), so that corpus row closes as a gated, deliberately uncoded construct, the same treatment the non-billable headers of Chapters IX, XIV, XVIII and XXI received. "Depressive episode" — the F32 category title the sweep surfaced — is an **alias** on the existing F32.9 row rather than a new code, since the unspecified single-episode member already carries "depression". The gate gained the wordings the rows are reached by ("manic episode", "depressive episode", "paraphili", "intellectual disabilit" as a stem covering singular, plural and every severity, and "mania" word-matched because the substring sits inside "Romania"). One measured edge is recorded rather than implied covered: bare "manic" is deliberately unwatched, because its ordinary senses ("a manic week", "manic before launch", "manic laughter") use the frames a guard would have to separate, and no declared shape separates them from "I am manic", which therefore still reaches the model — the honest limit of a word whose adjective sense is as common as its diagnosis. No existing row changed meaning and no alias moved.',
    condition_count: 395,
    added: [
      // Batch 1 — mania, paraphilia, and the first three severity rows.
      'F30.9',
      'F65.9',
      'F70',
      'F71',
      'F72',
      // Batch 2 — the rest of the severity block the chapter exposes.
      'F73',
      'F79',
    ],
    aliases_moved: [],
  },
  {
    version: '1.15.0',
    date: '2026-09-20',
    summary:
      "Replaced the per-alias British/American spelling duplicates with one declared mechanism, because the duplication was the vocabulary’s own: the curated list carried spelling pairs as two synonyms — ['anemia', 'anaemia'], ['hemorrhage', 'haemorrhage'], ['tumor', 'tumour'] and 38 more — while the gate had been watching the British forms all along. `SPELLING_VARIANT_GROUPS` now declares the 26 interchangeable word spellings in one place, and the resolver claims every alias in every declared spelling of it, word by word with the plural carried across, so the 41 spellings deleted from `synonyms` resolve to exactly the codes they resolved to before (locked by a frozen table in tests/condition-spelling-variants.test.ts) and each spelling is reached wherever the word occurs rather than only in the alias that happened to list both. That wider reach is the release’s only behaviour change, and it is measured rather than hoped for: 79 keys derive from the curated aliases and all 79 resolve, of which 38 were reachable in one spelling only — most of them the vocabulary’s own canonical titles rewritten (“Anaemia, unspecified” → “anaemia unspecified”), and the rest phrases a person would actually write: “sickle cell anaemia” (D57.1), “ischaemic heart disease” (I25.10), “ischaemic stroke” (I63.9), “history of transient ischaemic attack” (Z86.73), “obstructive sleep apnoea” (G47.33), “cancer of the oesophagus” (C15.9), “barrett oesophagus” (K22.70), “polycythaemia vera” (D45). None of them is a spelling the vocabulary never had, because a group is admitted only when the curated list already wrote both words — which is also what keeps the widening from being an English rewrite: “your”, “four” and “therapeutic” are untouched, and the undeclared look-alikes are asserted silent. The mechanism is word-declared, never a blanket “-our → -or”/“-ae- → -e-” rewrite (a token is substituted only when its exact spelling is declared, so “your” is not folded into “yor” and “four” is not read as “for”), and the ambiguity check now runs across derived spellings as well as curated aliases and still reports nothing. No condition, code, name or system changed, and no alias moved.",
    condition_count: 388,
    added: [],
    aliases_moved: [],
  },
  {
    version: '1.14.0',
    date: '2026-09-19',
    summary:
      'Completed the abuse family the 1.13.0 release left standing — the named kinds its ten rows deferred — and the codebook decided each pair’s shape rather than the family being made uniform. Six rows replaced the residue: childhood forced labor or sexual exploitation Z62.813, child financial abuse Z62.814, childhood intimate partner abuse Z62.815, adult financial abuse Z91.413, adult intimate partner abuse Z91.414 and forced labor or sexual exploitation Z91.42 (382 → 388 conditions, all `psychosocial`). The financial and intimate-partner pairs are setting-qualified in both of their titles, so each shares its generic wording (“financial abuse”, “history of financial abuse”; “intimate partner abuse”, “history of intimate partner abuse”) with the disjoint markers 1.13.0 introduced — “financial abuse as a child” strips its marker to reach the shared wording and only Z62.814 may take it, and the bare wording resolves to neither, exactly as “history of abuse” does. The forced-labor pair is the first in the family that shares nothing, and the codebook is why: Z91.42 is titled “personal history of forced labor or sexual exploitation” with no setting word at all, and the alphabetical index routes the bare phrase to it, while Z62.813 is reachable only *in childhood* — so the bare phrase has a billable home and resolves to Z91.42, and the childhood row is reached by wording that names the setting itself (“forced labor as a child”, “trafficked as a child”) rather than by a marker. Two aliases moved off Z91.419 to Z91.414 (“abused by my partner”, “my partner abused me”) because 1.13.0 gave them to the unspecified adult row only because the specific row did not exist yet; and “history of intimate partner abuse”, which 1.13.0 resolved to Z91.419, is now claimed by the new pair and resolves to neither unwitnessed — the same deliberate narrowing as “history of abuse”, for the same codebook reason. That required removing the `intimate partner` marker from Z91.419: it had been made a witness of adulthood when no intimate-partner row existed, and left in place it would have let the old row keep claiming the phrase the pair now owns. The gate gained the wordings these rows are reached by — “financial abuse”, both spellings of “forced labor”, “trafficked”/“trafficking”, “sex trafficking”, “sexual exploitation”/“sexually exploited”, “forced to work” and “forced into labor”/“labour” — after the first probe’s measured gaps (“I was forced into labor” and “I was forced to work as a child” were silent) were closed. Eight ordinary senses the terms now gate are pinned as accepted trades rather than guarded — a supply-chain report that mentions forced labor, a documentary about trafficking, a charity that fights human trafficking, a film that examines sexual exploitation, the trafficking of illegal goods, “financial abuse of the system” and “we were forced to work overtime” — because every guard that separated them would also silence a real disclosure, and the sentences that measure silent (“the exploitation of loopholes in the policy”) are asserted as the boundary of what “exploitation” alone does not catch. One lay phrasing is recorded as uncovered rather than implied: “my husband controlled all the money” never names the phrase and stays silent. No code changed meaning; the two alias moves are 1.14.0’s only behavior changes to existing rows.',
    condition_count: 388,
    added: [
      // Batch 1 — the four named kinds, plus the adult home of the forced-labor
      // pair (Z62.813's bare wording is Z91.42's, which is why the pair has to
      // be added together).
      'Z62.813',
      'Z62.814',
      'Z62.815',
      'Z91.413',
      'Z91.42',
      // Coda — the adult intimate-partner row the pair and the two moved
      // aliases require; without it “abused by my partner” would land on the
      // unspecified adult row even though a specific one exists.
      'Z91.414',
    ],
    aliases_moved: [
      { alias: 'abused by my partner', from: 'Z91.419', to: 'Z91.414' },
      { alias: 'my partner abused me', from: 'Z91.419', to: 'Z91.414' },
    ],
  },
  {
    version: '1.13.0',
    date: '2026-09-19',
    summary:
      'Closed the two rows the Chapter XXI sweep had gated without a code, on the machinery 1.10.0 built for exactly this shape. Both splits are axes the person’s own words carry rather than organs, so the qualifier gains a third dimension — `words`, a marker the phrase has to name — and ten rows replaced the two deferrals: personal history of suicidal behavior Z91.51 and of nonsuicidal self-harm Z91.52, and the childhood and adult maltreatment rows (physical and sexual abuse Z62.810, psychological abuse Z62.811, neglect Z62.812 and unspecified abuse Z62.819 in childhood; physical and sexual abuse Z91.410, psychological abuse Z91.411, neglect Z91.412 and unspecified abuse Z91.419 in adulthood). The dimension is what makes the split real rather than alias-precise: a marker is stripped from the phrase the way a site value is, so “history of abuse as a child” reaches the wording both abuse rows declare (“history of abuse”) and only Z62.819 — whose marker the phrase names — may take it, and the row re-checks that marker against the whole stated phrase. The bare phrase is the case that made the dimension necessary, and the codebook decides it twice over: Z91.419 is titled “unspecified *adult* abuse”, Z62.819 “unspecified abuse *in childhood*”, and the alphabetical index routes “self-harm” and “abuse” only with their qualifier (“History, personal, self-harm, nonsuicidal Z91.52”; “History, personal, abuse, adult Z91.419”; “abuse, childhood Z62.819”). So “history of abuse” — which resolved to Z91.49 under 1.12.0 — is now claimed by both rows with disjoint markers and **resolves to neither without one**, a deliberate narrowing rather than a move: coding an abuse history of unstated setting as “other psychological trauma” asserted a setting the person had not given. “History of domestic abuse” is Z91.419, “history of attempted suicide” and “history of parasuicide” are Z91.51, “history of self mutilation” and “history of self injury” are Z91.52, and a phrase that names both settings (“abused as a child and as an adult”) strips to a wording no row claims and defers rather than being assigned to whichever row is read first. Two aliases moved off Z91.49 to the row that now owns them, “history of childhood trauma” stays there, and no code changed meaning. The gate gained the statements these rows are reached by — the suicide and parasuicide phrasings, “history of cutting”, “self mutilation”, “self injury”, “neglect as a child”/“childhood neglect” and the adult forms, “domestic violence”, “intimate partner abuse”, “elder abuse”, “molested”, “beaten as a child”, “raped”, “assaulted”, “abused by”, “abused me”, “emotionally abused”, “verbally abused”, “psychological abuse” — with two forms watched as statements in their own right (“I tried to kill myself”, “I overdosed”) and seven measured ordinary senses pinned as accepted trades instead of guarded, since every guard that separated them would also have silenced a real disclosure (“the suicide clause in the policy” is a *question* about a provision and is still answered as one). One residue is deliberate: “suicidal ideation” gates but stays uncoded, because Z91.51 is a history of *behavior* and thoughts are not an attempt. The rows name maltreatment circumstances, which the codebook files as socioeconomic/psychosocial rather than psychiatric, so the vocabulary gains the `psychosocial` system — the second value added because a row has to say what it is.',
    condition_count: 382,
    added: [
      // Batch 1 — the self-harm split and the childhood rows by type
      'Z91.51',
      'Z91.52',
      'Z62.810',
      'Z62.811',
      'Z62.812',
      // Batch 2 — unspecified childhood abuse and the adult rows
      'Z62.819',
      'Z91.410',
      'Z91.411',
      'Z91.412',
      'Z91.419',
    ],
    aliases_moved: [
      { alias: 'abused as a child', from: 'Z91.49', to: 'Z62.819' },
      { alias: 'history of childhood abuse', from: 'Z91.49', to: 'Z62.819' },
    ],
  },
  {
    version: '1.12.0',
    date: '2026-09-19',
    summary:
      'Closed the ICD-10 Chapter XXI sweep, the fourth codebook enumeration and the first chapter that is not a list of diseases at all: the Z00–Z99 category titles (factors influencing health status and contact with health services — 90 titles, 84 of them candidates, because six are not statements a person makes and are declared in the corpus file with a reason) surfaced 61 silent rows, the largest count of any source. The chapter is where a carrier’s questions live and the vocabulary had been thinnest, so forty of its rows became canonical conditions in eight batches of five: the family-history rows a medical history asks by name (breast, digestive, prostate and leukaemia malignancy, colon polyps through the unspecified member Z83.719 because Z83.71 is a non-billable header, stroke, ischaemic heart disease, sudden cardiac death, diabetes, familial hypercholesterolaemia, asthma, epilepsy, mental illness, alcoholism); the genetic and carrier status rows no other chapter carries (cystic fibrosis carrier Z14.1, genetic carrier of other disease Z14.8, BRCA susceptibility Z15.01, asymptomatic HIV status Z21, do not resuscitate Z66); the personal-history rows for infectious disease (tuberculosis Z86.11, latent tuberculosis Z86.15, COVID-19 Z86.16, MRSA Z86.14, malaria Z86.13); the circulatory history rows (TIA and cerebral infarction Z86.73, pulmonary embolism Z86.711, other venous thrombosis and embolism Z86.718, sudden cardiac arrest Z86.74, thrombophlebitis Z86.72); cancer history and gestational diabetes (Z85.3, Z85.038, Z85.820, Z85.9, Z86.32); and the mental-health and allergy rows (combat and operational stress Z86.51, other mental and behavioural Z86.59, penicillin allergy Z88.0, central nervous system infection history Z86.61, psychological trauma Z91.49). Every row is the *history* code for the statement, never the disease’s own code: “history of breast cancer” is Z85.3, not C50.9. The same sweep found and closed the gate holes the chapter exposed — statements that travelled unclassified to the model: I am pregnant, I had COVID, I have MRSA, I have a DNR order, I have the BRCA1 mutation, my blood type is O positive, I have a history of blood clots, I was exposed to asbestos, I have a history of self-harm, I was abused as a child, I have a stoma, I am an amputee, I am on a ventilator. Two rows were deliberately left uncoded and are gated instead, with the reasons recorded: the self-harm header Z91.5 is non-billable and its two members split suicidal behaviour from non-suicidal self-harm, which the person’s words do not distinguish; and Z33 “pregnant state” is billable only as “incidental”, a coding nuance that would misstate a visitor who simply says they are pregnant. No existing row changed behavior and no alias moved.',
    condition_count: 372,
    added: [
      // Batch 1 — family history of malignant neoplasm
      'Z80.3',
      'Z80.9',
      'Z80.0',
      'Z80.42',
      'Z83.719',
      // Batch 2 — family history of the circulatory and metabolic rows
      'Z82.3',
      'Z82.49',
      'Z82.41',
      'Z83.3',
      'Z83.42',
      // Batch 3 — family history of the remaining conditions
      'Z82.5',
      'Z82.0',
      'Z81.8',
      'Z81.1',
      'Z80.6',
      // Batch 4 — genetic susceptibility and carrier status
      'Z14.1',
      'Z14.8',
      'Z15.01',
      'Z21',
      'Z66',
      // Batch 5 — personal history of an infectious disease
      'Z86.11',
      'Z86.15',
      'Z86.16',
      'Z86.14',
      'Z86.13',
      // Batch 6 — personal history of the circulatory events
      'Z86.73',
      'Z86.711',
      'Z86.718',
      'Z86.74',
      'Z86.72',
      // Batch 7 — personal history of cancer and of gestational diabetes
      'Z85.3',
      'Z85.038',
      'Z85.820',
      'Z85.9',
      'Z86.32',
      // Batch 8 — personal history of the mental-health rows and the allergy
      'Z86.51',
      'Z86.59',
      'Z88.0',
      'Z86.61',
      'Z91.49',
    ],
    aliases_moved: [],
  },
  {
    version: '1.11.0',
    date: '2026-09-19',
    summary:
      'Closed the ICD-10 Chapter XVIII sweep, the third codebook enumeration: the three-character category titles of R00–R99 (symptoms, signs and abnormal clinical and laboratory findings — 89 titles, of which 86 are candidates, because three cannot be a disclosure and are declared in the corpus file with a reason) surfaced 55 silent rows — the largest silent share of any source, because a chapter of symptoms is mostly a description of experience rather than a list of diagnoses. Twenty-seven of its rows name a discrete finding with a billable member and became canonical conditions in five batches of five plus a two-row coda — epistaxis, hemoptysis, dysuria, hematuria and retention of urine; anuria/oliguria, nocturia, syncope, convulsions and paresthesia; jaundice, ascites (the “other” member R18.8, since R18 is a header and malignancy is not something the person said), hepatomegaly, splenomegaly and enlarged lymph nodes; edema, dysphagia, proteinuria, glycosuria and hyperglycemia; then the lab findings (elevated liver enzymes R74.01, elevated PSA, elevated ESR) and anosmia and aphasia; and finally the rest of R35 (frequency of micturition R35.0 and polyuria R35.89), whose member nocturia batch 2 had already mapped. The rest of the chapter closed as gate terms rather than codes, because a cough, a headache or a rash is not a diagnosis: the symptom nouns and clinical category words are declared on the descriptive list with their reasons, two of them (`rash`, `pain`) through the context-qualified registry so their ordinary senses ("a rash decision", "the pain points") stay silent, and two short abbreviations became word tokens (`esr`, `psa`) with their recorded tradeoffs. No existing row changed behavior and no alias moved.',
    condition_count: 332,
    added: [
      // Chapter XVIII sweep, batch 1 — bleeding and the urinary tract
      'R04.0',
      'R04.2',
      'R30.0',
      'R31.9',
      'R33.9',
      // Batch 2 — urinary output, collapse and the nervous system
      'R34',
      'R35.1',
      'R55',
      'R56.9',
      'R20.2',
      // Batch 3 — liver, spleen and lymph nodes
      'R17',
      'R18.8',
      'R16.0',
      'R16.1',
      'R59.9',
      // Batch 4 — fluid, swallowing and the urine findings
      'R60.9',
      'R13.10',
      'R80.9',
      'R81',
      'R73.9',
      // Batch 5 — lab findings, smell and speech
      'R74.01',
      'R97.20',
      'R70.0',
      'R43.0',
      'R47.01',
      // Coda — the rest of R35, whose nocturia member batch 2 mapped
      'R35.0',
      'R35.89',
    ],
    aliases_moved: [],
  },
  {
    version: '1.10.0',
    date: '2026-09-19',
    summary:
      'Made the crosswalk qualifier-aware, so a row whose code depends on something the person already stated elsewhere can be mapped instead of deferred. The worked example is the row 1.9.0 had to leave gated: FY2026 split urethral stricture into sex-specific codes, so “urethral stricture” now resolves to the billable unspecified-site member for the sex on the consented profile (N35.919 male, N35.92 female) and resolves to nothing at all when the profile records neither — the deferral is data with a reason now, not an absence. A site word in the person’s own words chooses between siblings that differ only by organ: N20.0 (kidney), N20.1 (ureter) and N21.0 (bladder) carry the generic “calculus”/“calculi” spellings plus the residual matching the 1.8.0 stone-family residue asked for, so “bladder calculus”, “ureteric calculus” and “renal calculus” resolve while a bare “calculus” still defers; N63.0 gained the generic “lump”, so “lump in my breast” resolves while a bare “lump” and a side-stated “lump in my left breast” both still defer, because FY2026’s side members are quadrant-specific (N63.11–N63.14 right, N63.2x left) and a side alone cannot choose a billable code. No previously carried row changed behavior: a row with no qualifier applies unconditionally.',
    condition_count: 305,
    added: [
      // FY2026 sex split — the two codes the same words resolve to, per sex
      'N35.919',
      'N35.92',
    ],
    aliases_moved: [],
  },
  {
    version: '1.9.0',
    date: '2026-09-19',
    summary:
      'Closed the ICD-10 Chapter XIV sweep, the second codebook enumeration and the first chapter the stone family itself sits in: the three-character category titles of N00–N99 (diseases of the genitourinary system, 87 candidates) surfaced 41 silent rows. Thirty named diagnoses became canonical conditions in six batches of five — the nephritic syndromes and isolated proteinuria, tubulo-interstitial nephritis and kidney failure, obstructive uropathy and calculi, cystitis and neurogenic bladder, urethritis and the male genital infections, then the breast, female pelvic and reproductive rows — each title verified against ICD-10-CM before use. Three rows are deliberately gated rather than coded, each for a codebook reason this release records: urethral stricture (FY2026 split N35.9 into sex-specific billable codes, so a code would have to guess the visitor’s sex), neuromuscular dysfunction of bladder, not elsewhere classified (the N31 header; the stateable form is neurogenic bladder, N31.9, which is carried), and the remaining “other …” category constructs. One alias moved: “kidney failure” now resolves to unspecified kidney failure (N19) rather than end stage renal disease (N18.6) — ESRD keeps dialysis and its own name, so a plain “kidney failure” no longer lands on the end-stage row.',
    condition_count: 303,
    added: [
      // Chapter XIV sweep, batch 1 — nephritic syndromes and isolated proteinuria
      'N00.9',
      'N01.9',
      'N02.9',
      'N03.9',
      'N06.9',
      // Chapter XIV sweep, batch 2 — tubulo-interstitial nephritis and kidney failure
      'N10',
      'N11.9',
      'N12',
      'N17.9',
      'N19',
      // Chapter XIV sweep, batch 3 — obstructive uropathy, calculi and the bladder
      'N13.9',
      'N21.9',
      'N23',
      'N30.90',
      'N31.9',
      // Chapter XIV sweep, batch 4 — urethra and the male genital organs
      'N34.1',
      'N43.3',
      'N43.40',
      'N45.1',
      'N45.2',
      // Chapter XIV sweep, batch 5 — breast and female pelvic organs
      'N60.99',
      'N62',
      'N63.0',
      'N70.91',
      'N70.92',
      // Chapter XIV sweep, batch 6 — female genital tract, cervix, reproductive loss
      'N75.9',
      'N81.9',
      'N86',
      'N87.9',
      'N96',
    ],
    aliases_moved: [{ alias: 'kidney failure', from: 'N18.6', to: 'N19' }],
  },
  {
    version: '1.8.0',
    date: '2026-09-19',
    summary:
      'Closed the stone-family residue the syntactic-collision sweep left behind. The stones context rule (1.7.0 work, no code) made "bladder stones" and "ureteral stones" health data, but the crosswalk carried neither, so a consented mapping returned them in unmapped — gated, not mapped. Both are rows now: calculus in bladder (N21.0) and calculus of ureter (N20.1). The same sweep measured the two-word spelling "gall stone", which the 1.4.0 questionnaire corpus had carried only as the one-word "gallstones"; it joined the K80.20 aliases (with "gall stones" derived as its plural). Mapping-only release: the gate already classified every phrase, so nothing moved between buckets and no alias was re-pointed.',
    condition_count: 273,
    added: [
      // Stone-family closure — the gated-but-uncoded rows the collision sweep measured
      'N20.1',
      'N21.0',
    ],
    aliases_moved: [],
  },
  {
    version: '1.7.0',
    date: '2026-09-19',
    summary:
      'Closed the ICD-10 Chapter IX sweep, the third independent source and the first codebook enumeration: the three-character category titles of the WHO tabular list (77 candidates) surfaced 16 rows that were neither gated nor mapped. Six became canonical conditions in two batches — nontraumatic subarachnoid, intracerebral and intracranial haemorrhage, phlebitis and thrombophlebitis, nonspecific lymphadenitis, and atrioventricular block — and three aliases landed on existing rows: cerebral infarction on I63.9 and the British spelling haemorrhoids on K64.9 (the vocabulary carried only the American spellings, which is how a British visitor stating the condition reached the model ungated). The remaining category rows are codebook constructs, not diagnoses the person states ("other diseases of pericardium", "other disorders of veins"), and are gated descriptively instead.',
    condition_count: 271,
    added: [
      // ICD-10 Chapter IX sweep, batch 1 — haemorrhagic stroke and spellings
      'I60.9',
      'I61.9',
      'I62.9',
      // ICD-10 Chapter IX sweep, batch 2 — venous, lymphatic, conduction
      'I80.9',
      'I88.9',
      'I44.30',
    ],
    aliases_moved: [],
  },
  {
    version: '1.6.0',
    date: '2026-09-19',
    summary:
      'Closed the critical-illness sweep, the second independent source: the carrier covered-condition lists (10/30/36-condition enumerations) surfaced 18 silent rows. Ten became canonical conditions in two batches of five; the rest were event, procedure, injury and functional rows (coma excepted) that the gate now protects without inventing a code. Three aliases were added to existing rows: primary pulmonary hypertension and primary pulmonary arterial hypertension on I27.20, and loss of hearing on H91.90 (the row already carried hearing loss and deafness — the carrier list simply spells the same condition differently).',
    condition_count: 265,
    added: [
      // Critical-illness sweep, batch 1 — CNS infection, movement, coma
      'A86',
      'A80.9',
      'G00.9',
      'G12.29',
      'R40.20',
      // Critical-illness sweep, batch 2 — paralysis, hepatic failure, blood, tumour
      'G82.20',
      'K72.90',
      'K76.9',
      'D61.9',
      'D33.2',
    ],
    aliases_moved: [],
  },
  {
    version: '1.5.0',
    date: '2026-09-19',
    summary:
      'Alias release: "piles", the lay synonym for hemorrhoids, now resolves to K64.9 — closing the questionnaire-sweep row that 1.4.0 deferred. The gate (src/security/security-controls.ts) classifies it only in context, because its ordinary sense is a quantifier ("piles of paperwork", "the work piles up"); no codes added, so the condition count is unchanged.',
    condition_count: 255,
    added: [],
    aliases_moved: [],
  },
  {
    version: '1.4.0',
    date: '2026-09-19',
    summary:
      'Closed the third measured gap: a 237-phrase carrier-questionnaire sweep found 55 rows that were neither gated nor mapped. 30 became canonical conditions here, 2 became aliases on existing rows (irregular heartbeat → I49.9, drug addiction/drug abuse → F19.20), 22 became documented descriptive gate terms (procedure states, acute infections, symptoms), and 1 ("piles") is deferred because its ordinary sense collides with the lay synonym.',
    condition_count: 255,
    added: [
      // Probe gap, batch 1 — cardiac muscle, pericardium, rhythm, lipid
      'I42.9',
      'I40.9',
      'I30.9',
      'I47.9',
      'E78.1',
      // Probe gap, batch 2 — electrolyte, androgen, parathyroid
      'E87.1',
      'E83.52',
      'E79.0',
      'E29.1',
      'E20.9',
      // Probe gap, batch 3 — renal, airway, pleural, gastric
      'N05.9',
      'J33.9',
      'R09.1',
      'J93.9',
      'K31.84',
      // Probe gap, batch 4 — headache, movement, cerebrospinal, retinal
      'G44.209',
      'F95.2',
      'G91.9',
      'G71.0',
      'H33.20',
      // Probe gap, batch 5 — congenital and hematologic
      'Q35.9',
      'Q66.89',
      'Q96.9',
      'Q99.2',
      'D45',
      // Probe gap, batch 6 — dermatologic, lymphatic, urologic, viral
      'L70.0',
      'L91.0',
      'I89.0',
      'I86.1',
      'B00.9',
    ],
    aliases_moved: [],
  },
  {
    version: '1.3.0',
    date: '2026-09-18',
    summary:
      'Closed the residual gap the boundary probe exposed: carrier-relevant chronic rows that were neither gated nor mapped, declared in RESIDUAL_SCOPE and enforced by the same two-way ledger.',
    condition_count: 225,
    added: [
      // Residual gap, batch 1 — venous, spinal, electrolyte, hematologic
      'I83.90',
      'M54.30',
      'E87.5',
      'D51.9',
      'E83.110',
      // Residual gap, batch 2 — inherited connective-tissue and neurologic
      'D55.0',
      'Q79.60',
      'Q87.40',
      'G51.0',
      'G44.009',
      // Residual gap, batch 3 — shoulder, foot, obstetric, ophthalmic
      'M75.00',
      'M21.40',
      'M20.10',
      'O14.90',
      'H04.129',
      // Residual gap, batch 4 — skin, menopausal state, minor surgical
      'N95.1',
      'L43.9',
      'D18.00',
      'B07.0',
      'H00.1',
      // Residual gap, batch 5 — vascular spasm, thyroid, tremor, breast, anal
      'I73.00',
      'E04.9',
      'G25.0',
      'N60.29',
      'K60.2',
      // Residual gap, batch 6 — pre-malignant, hernia, bladder pain, skin, prolapse
      'K22.70',
      'K40.90',
      'N30.10',
      'L57.0',
      'N81.4',
      // Residual gap, batch 7 — menstrual, intolerance, renal, dermatologic
      'N94.6',
      'N94.3',
      'E73.9',
      'N28.1',
      'L21.9',
      // Residual gap, batch 8 — minor soft-tissue and dermatologic
      'M67.40',
      'M77.10',
      'M65.30',
      'M71.9',
      'L23.9',
      'K60.3',
    ],
    aliases_moved: [],
  },
  {
    version: '1.2.0',
    date: '2026-09-18',
    summary:
      'Closed the common-chronic domains outside the PTSD source scope: gynecologic, urologic, dermatologic, ophthalmologic, ENT/oral, congenital/developmental, and the residual musculoskeletal, gastrointestinal, hematologic, infectious, oncologic, endocrine, respiratory, and mental-health rows a carrier medical questionnaire enumerates.',
    condition_count: 184,
    added: [
      // Gynecologic / reproductive
      'N80.9',
      'D25.9',
      'E28.2',
      'N83.20',
      'N97.9',
      // Urologic
      'N40.1',
      'R32',
      'N32.81',
      'N52.9',
      'N46.9',
      // Dermatologic
      'L20.9',
      'L50.9',
      'L80',
      'L71.9',
      'L63.9',
      // Ophthalmologic / otologic
      'H25.9',
      'H40.9',
      'H35.31',
      'E11.319',
      'H91.90',
      // ENT / oral
      'H93.19',
      'J32.9',
      'H81.10',
      'K05.30',
      // Congenital / developmental
      'Q90.9',
      'G80.9',
      'Q24.9',
      'E84.9',
      'Q05.9',
      // Neurological / immune, other
      'F84.0',
      'G70.00',
      'D86.9',
      'G56.00',
      'Q61.3',
      // Musculoskeletal, other
      'M41.9',
      'M51.9',
      'M48.00',
      'M75.100',
      'M72.2',
      // Gastrointestinal, other
      'K57.32',
      'K80.20',
      'K44.9',
      'K64.9',
      'K29.50',
      // Hematologic, other
      'D57.1',
      'D56.9',
      'D66',
      'D68.0',
      'D69.6',
      // Infectious, other
      'B02.9',
      'A69.20',
      'M86.9',
      'U09.9',
      // Oncologic, other
      'C16.9',
      'C15.9',
      'C53.9',
      'C62.90',
      'C44.90',
      // Endocrine, other
      'E21.3',
      'E23.0',
      'E24.9',
      'E23.2',
      'E04.1',
      // Respiratory, other
      'J84.10',
      'J47.9',
      'I27.20',
      // Mental health, other
      'F40.10',
      'F40.00',
      'F50.9',
      'F53.0',
    ],
    aliases_moved: [],
  },
  {
    version: '1.1.0',
    date: '2026-09-18',
    summary:
      'Mapped the remaining conditions the health-data gate already watched for, and corrected two alias assignments.',
    condition_count: 114,
    added: [
      // Cardiovascular
      'I46.9',
      'I49.9',
      'I20.9',
      'I71.9',
      'I95.9',
      'I33.0',
      'I26.99',
      'I82.90',
      // Metabolic / endocrine
      'E55.9',
      // Autoimmune / inflammatory
      'M31.30',
      'M34.9',
      'K75.4',
      // Neurodegenerative
      'G31.83',
      // Neurological
      'G45.9',
      'G62.9',
      'S06.0',
      'S06.9',
      'G03.9',
      // Respiratory
      'J20.9',
      'J18.9',
      // Sleep
      'G25.81',
      // Renal
      'N04.9',
      'N20.0',
      // Musculoskeletal
      'M85.80',
      'M25.50',
      // Gastrointestinal
      'K74.60',
      'K76.0',
      'K85.90',
      // Mental health
      'F20.9',
      'F90.9',
      'F42.9',
      // Oncologic
      'C85.90',
      'C90.00',
      'C56.9',
      'C25.9',
      'C22.0',
      'C67.9',
      'C64.9',
      'C73',
      'C71.9',
      'C54.1',
      // Hematologic
      'D50.9',
      // Infectious
      'A15.0',
      'A41.9',
      'B16.9',
    ],
    aliases_moved: [
      // Was mapped to M81.0 (age-related osteoporosis). Osteopenia is a lower
      // bone-density state that is not the same diagnosis, so it now resolves
      // to its own code.
      { alias: 'osteopenia', from: 'M81.0', to: 'M85.80' },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-08-30',
    summary:
      'Initial vocabulary covering the domains the approved medical topics and the reviewed PTSD phenome literature exercise.',
    condition_count: 69,
    added: [],
    aliases_moved: [],
  },
];

/** Classification of any canonical ref that leaves this module. */
export const CONDITION_DATA_CLASSIFICATION = 'tdpsa_sensitive_health';

/**
 * Body-system / domain grouping. Used to roll a profile up the way the
 * phenome literature does (circulatory, endocrine, neurological, ...) without
 * carrying any clinical interpretation.
 */
export const CONDITION_SYSTEMS = [
  'cardiovascular',
  'metabolic',
  'autoimmune_inflammatory',
  'neurodegenerative',
  'neurological',
  'respiratory',
  'sleep',
  'renal',
  'musculoskeletal',
  'gastrointestinal',
  'mental_health',
  'oncologic',
  'hematologic',
  'infectious',
  'gynecologic',
  'urologic',
  'dermatologic',
  'ophthalmologic',
  'ent',
  'congenital',
  // Added with the Chapter XXI sweep: the Z00–Z99 chapter carries care status
  // rows that are not diseases at all (do not resuscitate is the first), and a
  // status row has to say so rather than be filed under a body system it does
  // not belong to.
  'status',
  // Added with the 1.13.0 closure of that chapter's two deferrals: the abuse and
  // neglect rows come from Z62 (“problems related to upbringing”) and Z91.41
  // (“personal history of adult abuse”), which the codebook itself files under
  // socioeconomic and psychosocial circumstances. Filing childhood neglect under
  // a body system — or under mental_health, which is where the *psychiatric*
  // history rows (psychological trauma, self-harm) belong — would repeat the
  // mistake the status value was added to avoid.
  'psychosocial',
] as const;

export type ConditionSystem = (typeof CONDITION_SYSTEMS)[number];

/**
 * Sex as the codebook splits a condition. Deliberately narrower than the
 * profile's gender field: only an explicit male/female answer is usable here,
 * because the code set offers no third code and an inferred answer would be a
 * guess (see `conditionSexFromGender`).
 */
export type ConditionSex = 'male' | 'female';

/**
 * What has to be true about the person or their wording for a row to apply.
 * A row with no `appliesWhen` applies unconditionally — which is every row the
 * vocabulary carried before 1.10.0, so their behavior is unchanged.
 */
export interface ConditionQualifier {
  /** Applies only to a person of one of these sexes (from the profile). */
  sex?: readonly ConditionSex[];
  /**
   * Applies only when the person's own words name one of these sites. Values
   * are matched at a word start (so "ureter" covers "ureteric" and "ureters")
   * and may be multi-word ("left breast").
   */
  site?: readonly string[];
  /**
   * Applies only when the person's own words name one of these *markers* — the
   * third dimension, added with the Chapter XXI closure (1.13.0), where two
   * sibling rows share one phrase and are separated by what else the person
   * said: "history of abuse" is Z62.819 when the words say *childhood* and
   * Z91.419 when they say *adult*, and "history of self harm" is the behavior
   * row when the words name the behavior and the suicidal row when they name the
   * intent. Matched the same way as a site value: at a word start, anywhere in
   * the phrase, multi-word allowed — and against the *normalized* phrase, where
   * punctuation has already become a space, so the value for "self-harm" is
   * declared 'self harm' and a hyphenated spelling here would be inert.
   *
   * A marker is both a witness and, like a site, strippable: a phrase that names
   * one but not the shared wording it qualifies ("history of abuse as a child")
   * strips the marker off and resolves the generic wording against the phrase
   * that was actually stated, so the marker is checked in the whole sentence
   * rather than in the remainder. Two rows that share an alias must have
   * disjoint markers, and the resolver keeps its documented first-match rule if
   * a phrase ever satisfies both — with these two pairs it does not arise: the
   * marked forms strip to a shared wording only when one setting (or one intent)
   * is named, and a phrase naming both ("abused as a child and as an adult")
   * strips to something no row claims and defers, which a test pins. An alias
   * claimed by a marker row that names none of its own
   * markers is the shared generic wording, and stays unresolved on its own —
   * which is the codebook's own rule: the parent codes Z91.5 and Z91.41 are
   * headers, so "history of self harm" and "history of abuse" without a marker
   * are unspecified statements with no billable member to land on.
   */
  words?: readonly string[];
}

/**
 * Everything the resolver is allowed to know besides the stated text. Absent or
 * null sex means unknown, which defers a sex-qualified row rather than picking
 * one of its siblings.
 */
export interface ConditionResolutionContext {
  sex?: ConditionSex | null;
}

/** A vocabulary entry. */
export interface CanonicalCondition {
  /** ICD-10-CM code (primary/unspecified code where the user gave no detail). */
  icd10_cm: string;
  /** Canonical display name used in the internal operational record. */
  name: string;
  /** Body system / domain for rollups. */
  system: ConditionSystem;
  /** Curated alternate wordings and abbreviations (matched exactly). */
  synonyms: string[];
  /** Declared when this row is one sibling of a qualifier-split condition. */
  appliesWhen?: ConditionQualifier;
}

/** A canonical ref as stored on a lead record (vocabulary-tagged). */
export interface CanonicalConditionRef {
  icd10_cm: string;
  name: string;
  system: ConditionSystem;
  /** Vocabulary id the ref was resolved against. */
  vocabulary: string;
  /** Vocabulary version at resolution time. */
  vocabulary_version: string;
}

/** Result of mapping one profile's stated conditions. */
export interface ConditionMappingResult {
  vocabulary: string;
  vocabulary_version: string;
  /** Deduplicated canonical refs, in first-stated order. */
  canonical: CanonicalConditionRef[];
  /**
   * Stated conditions that matched no alias. Kept verbatim — never guessed —
   * and surfaced so the gap can be closed in the vocabulary or reviewed by the
   * broker.
   */
  unmapped: string[];
}

/** Per-system rollup entry for internal grouping/query. */
export interface ConditionSystemGroup {
  system: ConditionSystem;
  count: number;
  icd10_cm: string[];
}

/**
 * The vocabulary. Codes are ICD-10-CM; each condition uses the unspecified or
 * most general code that still identifies the condition, because the user is
 * reporting a diagnosis, not a clinical encounter.
 */
export const CANONICAL_CONDITIONS: CanonicalCondition[] = [
  // ── Cardiovascular ──
  {
    icd10_cm: 'I10',
    name: 'Essential (primary) hypertension',
    system: 'cardiovascular',
    synonyms: ['hypertension', 'high blood pressure', 'htn', 'high bp'],
  },
  {
    icd10_cm: 'I25.10',
    name: 'Atherosclerotic heart disease of native coronary artery',
    system: 'cardiovascular',
    synonyms: [
      'coronary artery disease',
      'cad',
      'coronary heart disease',
      'chd',
      'ischemic heart disease',
      'atherosclerosis',
    ],
  },
  {
    icd10_cm: 'I21.9',
    name: 'Acute myocardial infarction, unspecified',
    system: 'cardiovascular',
    synonyms: ['myocardial infarction', 'heart attack', 'mi'],
  },
  {
    icd10_cm: 'I50.9',
    name: 'Heart failure, unspecified',
    system: 'cardiovascular',
    synonyms: ['heart failure', 'congestive heart failure', 'chf'],
  },
  {
    icd10_cm: 'I48.91',
    name: 'Unspecified atrial fibrillation',
    system: 'cardiovascular',
    synonyms: ['atrial fibrillation', 'afib', 'a-fib'],
  },
  {
    icd10_cm: 'I63.9',
    name: 'Cerebral infarction, unspecified',
    system: 'cardiovascular',
    synonyms: [
      'stroke',
      'cerebrovascular accident',
      'cva',
      'ischemic stroke',
      'cerebral infarction',
    ],
  },
  {
    icd10_cm: 'I73.9',
    name: 'Peripheral vascular disease, unspecified',
    system: 'cardiovascular',
    synonyms: ['peripheral vascular disease', 'peripheral artery disease', 'pvd', 'pad'],
  },
  {
    icd10_cm: 'I46.9',
    name: 'Cardiac arrest, cause unspecified',
    system: 'cardiovascular',
    synonyms: ['cardiac arrest', 'sudden cardiac death', 'sudden cardiac arrest'],
  },
  {
    icd10_cm: 'I49.9',
    name: 'Cardiac arrhythmia, unspecified',
    system: 'cardiovascular',
    synonyms: [
      'cardiac arrhythmia',
      'arrhythmia',
      'ventricular arrhythmia',
      'irregular heartbeat',
      'irregular heart beat',
    ],
  },
  {
    icd10_cm: 'I20.9',
    name: 'Angina pectoris, unspecified',
    system: 'cardiovascular',
    synonyms: ['angina', 'angina pectoris', 'stable angina'],
  },
  {
    icd10_cm: 'I71.9',
    name: 'Aortic aneurysm of unspecified site, without rupture',
    system: 'cardiovascular',
    synonyms: ['aortic aneurysm', 'aneurysm', 'abdominal aortic aneurysm'],
  },
  {
    icd10_cm: 'I95.9',
    name: 'Hypotension, unspecified',
    system: 'cardiovascular',
    synonyms: ['hypotension', 'low blood pressure', 'orthostatic hypotension'],
  },
  {
    icd10_cm: 'I33.0',
    name: 'Acute and subacute infective endocarditis',
    system: 'cardiovascular',
    synonyms: ['infective endocarditis', 'endocarditis'],
  },
  {
    icd10_cm: 'I26.99',
    name: 'Other pulmonary embolism without acute cor pulmonale',
    system: 'cardiovascular',
    synonyms: ['pulmonary embolism', 'pulmonary embolus'],
  },
  {
    icd10_cm: 'I82.90',
    name: 'Acute embolism and thrombosis of unspecified deep veins of lower extremity',
    system: 'cardiovascular',
    synonyms: ['deep vein thrombosis', 'venous thromboembolism', 'dvt', 'vte'],
  },

  // ── Metabolic / endocrine ──
  {
    icd10_cm: 'E11.9',
    name: 'Type 2 diabetes mellitus without complications',
    system: 'metabolic',
    synonyms: [
      'type 2 diabetes',
      'type 2 diabetes mellitus',
      't2dm',
      'dm2',
      'adult onset diabetes',
      'diabetes',
      'diabetes mellitus',
    ],
  },
  {
    icd10_cm: 'E10.9',
    name: 'Type 1 diabetes mellitus without complications',
    system: 'metabolic',
    synonyms: [
      'type 1 diabetes',
      'type 1 diabetes mellitus',
      't1dm',
      'dm1',
      'juvenile diabetes',
      'insulin dependent diabetes',
    ],
  },
  {
    icd10_cm: 'R73.03',
    name: 'Prediabetes',
    system: 'metabolic',
    synonyms: ['prediabetes', 'pre-diabetes', 'borderline diabetes', 'impaired glucose tolerance'],
  },
  {
    icd10_cm: 'E88.81',
    name: 'Metabolic syndrome',
    system: 'metabolic',
    synonyms: ['metabolic syndrome', 'syndrome x', 'insulin resistance syndrome'],
  },
  {
    icd10_cm: 'E66.9',
    name: 'Obesity, unspecified',
    system: 'metabolic',
    synonyms: ['obesity', 'obese', 'morbid obesity', 'severe obesity'],
  },
  {
    icd10_cm: 'E78.5',
    name: 'Hyperlipidemia, unspecified',
    system: 'metabolic',
    synonyms: [
      'hyperlipidemia',
      'high cholesterol',
      'high lipids',
      'dyslipidemia',
      'hypercholesterolemia',
    ],
  },
  {
    icd10_cm: 'E03.9',
    name: 'Hypothyroidism, unspecified',
    system: 'metabolic',
    synonyms: ['hypothyroidism', 'underactive thyroid', 'low thyroid'],
  },
  {
    icd10_cm: 'E05.90',
    name: 'Thyrotoxicosis, unspecified, without thyrotoxic crisis',
    system: 'metabolic',
    synonyms: ['hyperthyroidism', 'overactive thyroid', 'graves disease', 'thyrotoxicosis'],
  },
  {
    icd10_cm: 'M10.9',
    name: 'Gout, unspecified',
    system: 'metabolic',
    synonyms: ['gout', 'gouty arthritis'],
  },
  {
    icd10_cm: 'E27.40',
    name: 'Unspecified adrenocortical insufficiency',
    system: 'metabolic',
    synonyms: ['adrenal insufficiency', 'addison disease', 'addisonian crisis'],
  },
  {
    icd10_cm: 'E55.9',
    name: 'Vitamin D deficiency, unspecified',
    system: 'metabolic',
    synonyms: ['vitamin d deficiency', 'low vitamin d'],
  },

  // ── Autoimmune / inflammatory ──
  {
    icd10_cm: 'M06.9',
    name: 'Rheumatoid arthritis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['rheumatoid arthritis', 'ra'],
  },
  {
    icd10_cm: 'M32.9',
    name: 'Systemic lupus erythematosus, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['systemic lupus erythematosus', 'lupus', 'sle'],
  },
  {
    icd10_cm: 'G35',
    name: 'Multiple sclerosis',
    system: 'autoimmune_inflammatory',
    synonyms: ['multiple sclerosis', 'ms'],
  },
  {
    icd10_cm: 'K50.90',
    name: "Crohn's disease, unspecified, without complications",
    system: 'autoimmune_inflammatory',
    synonyms: ['crohn disease', 'crohns disease', 'crohns', 'regional enteritis'],
  },
  {
    icd10_cm: 'K51.90',
    name: 'Ulcerative colitis, unspecified, without complications',
    system: 'autoimmune_inflammatory',
    synonyms: ['ulcerative colitis', 'uc', 'inflammatory bowel disease', 'ibd'],
  },
  {
    icd10_cm: 'L40.9',
    name: 'Psoriasis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['psoriasis'],
  },
  {
    icd10_cm: 'L40.50',
    name: 'Arthropathic psoriasis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['psoriatic arthritis'],
  },
  {
    icd10_cm: 'M45.9',
    name: 'Ankylosing spondylitis of unspecified sites in spine',
    system: 'autoimmune_inflammatory',
    synonyms: ['ankylosing spondylitis', 'axial spondyloarthritis'],
  },
  {
    icd10_cm: 'M35.00',
    name: 'Sjögren syndrome, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['sjogren syndrome', 'sjogrens syndrome', 'sjogrens'],
  },
  {
    icd10_cm: 'K90.0',
    name: 'Celiac disease',
    system: 'autoimmune_inflammatory',
    synonyms: ['celiac disease', 'gluten intolerance'],
  },
  {
    icd10_cm: 'E06.3',
    name: 'Autoimmune thyroiditis',
    system: 'autoimmune_inflammatory',
    synonyms: [
      'hashimoto thyroiditis',
      'hashimotos thyroiditis',
      'hashimotos',
      'autoimmune thyroiditis',
      'thyroiditis',
    ],
  },
  {
    icd10_cm: 'M31.30',
    name: 'Unspecified vasculitis',
    system: 'autoimmune_inflammatory',
    synonyms: ['vasculitis'],
  },
  {
    icd10_cm: 'M34.9',
    name: 'Systemic sclerosis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['systemic sclerosis', 'scleroderma'],
  },
  {
    icd10_cm: 'K75.4',
    name: 'Autoimmune hepatitis',
    system: 'autoimmune_inflammatory',
    synonyms: ['autoimmune hepatitis'],
  },

  // ── Neurodegenerative ──
  {
    icd10_cm: 'G30.9',
    name: "Alzheimer's disease, unspecified",
    system: 'neurodegenerative',
    synonyms: ['alzheimer disease', 'alzheimers disease', 'alzheimers', 'early onset alzheimers'],
  },
  {
    icd10_cm: 'F03.90',
    name: 'Unspecified dementia without behavioral disturbance',
    system: 'neurodegenerative',
    synonyms: ['dementia', 'senile dementia', 'vascular dementia', 'cognitive decline'],
  },
  {
    icd10_cm: 'G20',
    name: "Parkinson's disease",
    system: 'neurodegenerative',
    synonyms: ['parkinson disease', 'parkinsons disease', 'parkinsons'],
  },
  {
    icd10_cm: 'G12.21',
    name: 'Amyotrophic lateral sclerosis',
    system: 'neurodegenerative',
    synonyms: ['amyotrophic lateral sclerosis', 'als', 'lou gehrig disease'],
  },
  {
    icd10_cm: 'G31.84',
    name: 'Mild cognitive impairment, so stated',
    system: 'neurodegenerative',
    synonyms: ['mild cognitive impairment', 'mci'],
  },
  {
    icd10_cm: 'G31.83',
    name: 'Dementia with Lewy bodies',
    system: 'neurodegenerative',
    synonyms: ['lewy body dementia', 'dementia with lewy bodies'],
  },

  // ── Neurological ──
  {
    icd10_cm: 'G43.909',
    name: 'Migraine, unspecified, not intractable, without status migrainosus',
    system: 'neurological',
    synonyms: ['migraine', 'migraine headaches', 'migraines'],
  },
  {
    icd10_cm: 'G40.909',
    name: 'Epilepsy, unspecified, not intractable, without status epilepticus',
    system: 'neurological',
    synonyms: ['epilepsy', 'seizure disorder', 'seizures'],
  },
  {
    icd10_cm: 'G93.32',
    name: 'Myalgic encephalomyelitis/chronic fatigue syndrome',
    system: 'neurological',
    synonyms: ['chronic fatigue syndrome', 'cfs', 'myalgic encephalomyelitis', 'me/cfs', 'mecfs'],
  },
  {
    icd10_cm: 'G89.29',
    name: 'Other chronic pain',
    system: 'neurological',
    synonyms: ['chronic pain', 'chronic pain syndrome', 'neuropathic pain'],
  },
  {
    icd10_cm: 'G45.9',
    name: 'Transient cerebral ischemic attack, unspecified',
    system: 'neurological',
    synonyms: ['transient ischemic attack', 'tia'],
  },
  {
    icd10_cm: 'G62.9',
    name: 'Polyneuropathy, unspecified',
    system: 'neurological',
    synonyms: ['neuropathy', 'peripheral neuropathy', 'polyneuropathy'],
  },
  {
    icd10_cm: 'S06.0',
    name: 'Concussion',
    system: 'neurological',
    synonyms: ['concussion', 'mild traumatic brain injury', 'mtbi'],
  },
  {
    icd10_cm: 'S06.9',
    name: 'Unspecified intracranial injury',
    system: 'neurological',
    synonyms: ['traumatic brain injury', 'tbi', 'head injury'],
  },
  {
    icd10_cm: 'G03.9',
    name: 'Meningitis, unspecified',
    system: 'neurological',
    synonyms: ['meningitis'],
  },

  // ── Respiratory ──
  {
    icd10_cm: 'J45.909',
    name: 'Unspecified asthma, uncomplicated',
    system: 'respiratory',
    synonyms: ['asthma', 'reactive airway disease'],
  },
  {
    icd10_cm: 'J44.9',
    name: 'Chronic obstructive pulmonary disease, unspecified',
    system: 'respiratory',
    synonyms: ['chronic obstructive pulmonary disease', 'copd', 'emphysema', 'chronic bronchitis'],
  },
  {
    icd10_cm: 'J30.9',
    name: 'Allergic rhinitis, unspecified',
    system: 'respiratory',
    synonyms: ['allergic rhinitis', 'hay fever', 'seasonal allergies', 'allergies'],
  },
  {
    icd10_cm: 'J20.9',
    name: 'Acute bronchitis, unspecified',
    system: 'respiratory',
    synonyms: ['acute bronchitis', 'bronchitis'],
  },
  {
    icd10_cm: 'J18.9',
    name: 'Pneumonia, unspecified organism',
    system: 'respiratory',
    synonyms: ['pneumonia'],
  },

  // ── Sleep ──
  {
    icd10_cm: 'G47.00',
    name: 'Insomnia, unspecified',
    system: 'sleep',
    synonyms: ['insomnia', 'sleep problems', 'sleep disturbance', 'chronic insomnia'],
  },
  {
    icd10_cm: 'G47.33',
    name: 'Obstructive sleep apnea (adult) (pediatric)',
    system: 'sleep',
    synonyms: ['obstructive sleep apnea', 'sleep apnea', 'osa', 'apnea', 'cpap use', 'cpap'],
  },
  {
    icd10_cm: 'G47.419',
    name: 'Narcolepsy without cataplexy',
    system: 'sleep',
    synonyms: ['narcolepsy'],
  },
  {
    icd10_cm: 'G25.81',
    name: 'Restless legs syndrome',
    system: 'sleep',
    synonyms: ['restless legs syndrome', 'restless legs'],
  },

  // ── Renal / genitourinary ──
  {
    icd10_cm: 'N18.9',
    name: 'Chronic kidney disease, unspecified',
    system: 'renal',
    synonyms: ['chronic kidney disease', 'ckd', 'kidney disease', 'renal insufficiency'],
  },
  {
    icd10_cm: 'N18.6',
    name: 'End stage renal disease',
    system: 'renal',
    // "kidney failure" moved to N19 in 1.9.0 — an unqualified statement is the
    // unspecified row, not the end-stage one.
    synonyms: ['end stage renal disease', 'esrd', 'dialysis', 'on dialysis'],
  },
  {
    icd10_cm: 'N04.9',
    name: 'Nephrotic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['nephrotic syndrome'],
  },
  {
    icd10_cm: 'N20.0',
    name: 'Calculus of kidney',
    system: 'renal',
    // Site-qualified: the generic spellings a person writes ("calculus",
    // "renal calculus", "calculus in my kidney") name the stone by its organ, so
    // the row is reachable only when one of its own site words is in the words —
    // and the spelled-out forms are matched by stripping that site word and
    // matching the remainder (the 1.8.0 residue's qualifying rule).
    synonyms: ['kidney stones', 'kidney stone', 'nephrolithiasis', 'calculus', 'calculi'],
    appliesWhen: { site: ['kidney', 'renal', 'nephro'] },
  },
  {
    icd10_cm: 'N20.1',
    name: 'Calculus of ureter',
    system: 'renal',
    // Both adjective spellings are gated (the stones entry declares ureter,
    // ureteral and ureteric as qualifiers) and both are common in British and
    // American usage; exact matching means neither would cover the other. The
    // site value is the stem, so one entry covers ureter, ureteric and ureters.
    synonyms: ['ureteral stones', 'ureteric stones', 'ureter stones', 'calculus', 'calculi'],
    appliesWhen: { site: ['ureter'] },
  },
  {
    icd10_cm: 'N21.0',
    name: 'Calculus in bladder',
    system: 'urologic',
    synonyms: ['bladder stones', 'bladder stone', 'calculus', 'calculi'],
    appliesWhen: { site: ['bladder', 'vesical'] },
  },

  // ── Musculoskeletal ──
  {
    icd10_cm: 'M79.7',
    name: 'Fibromyalgia',
    system: 'musculoskeletal',
    synonyms: ['fibromyalgia', 'fibromyalgia syndrome', 'fms'],
  },
  {
    icd10_cm: 'M19.90',
    name: 'Unspecified osteoarthritis, unspecified site',
    system: 'musculoskeletal',
    synonyms: ['osteoarthritis', 'degenerative joint disease', 'oa'],
  },
  {
    icd10_cm: 'M81.0',
    name: 'Age-related osteoporosis without current pathological fracture',
    system: 'musculoskeletal',
    synonyms: ['osteoporosis', 'bone loss'],
  },
  {
    icd10_cm: 'M85.80',
    name: 'Other specified disorders of bone density and structure, unspecified site',
    system: 'musculoskeletal',
    synonyms: ['osteopenia', 'low bone density'],
  },
  {
    icd10_cm: 'M26.60',
    name: 'Temporomandibular joint disorder, unspecified',
    system: 'musculoskeletal',
    synonyms: ['temporomandibular joint disorder', 'tmd', 'tmj', 'tmj disorder'],
  },
  {
    icd10_cm: 'M54.5',
    name: 'Low back pain',
    system: 'musculoskeletal',
    synonyms: ['low back pain', 'chronic low back pain', 'back pain'],
  },
  {
    icd10_cm: 'M25.50',
    name: 'Pain in unspecified joint',
    system: 'musculoskeletal',
    synonyms: ['arthralgia', 'joint pain'],
  },

  // ── Gastrointestinal ──
  {
    icd10_cm: 'K58.9',
    name: 'Irritable bowel syndrome without diarrhea',
    system: 'gastrointestinal',
    synonyms: ['irritable bowel syndrome', 'ibs', 'spastic colon'],
  },
  {
    icd10_cm: 'K21.9',
    name: 'Gastro-esophageal reflux disease without esophagitis',
    system: 'gastrointestinal',
    synonyms: ['gastroesophageal reflux disease', 'gerd', 'acid reflux', 'heartburn'],
  },
  {
    icd10_cm: 'K27.9',
    name: 'Peptic ulcer, site unspecified, unspecified as acute or chronic',
    system: 'gastrointestinal',
    synonyms: ['peptic ulcer', 'stomach ulcer', 'ulcer disease'],
  },
  {
    icd10_cm: 'K74.60',
    name: 'Unspecified cirrhosis of liver',
    system: 'gastrointestinal',
    synonyms: ['cirrhosis', 'liver cirrhosis'],
  },
  {
    icd10_cm: 'K76.0',
    name: 'Fatty (change of) liver, not elsewhere classified',
    system: 'gastrointestinal',
    synonyms: ['fatty liver', 'nonalcoholic fatty liver disease', 'nafld', 'hepatic steatosis'],
  },
  {
    icd10_cm: 'K85.90',
    name: 'Acute pancreatitis, unspecified',
    system: 'gastrointestinal',
    synonyms: ['pancreatitis', 'acute pancreatitis'],
  },

  // ── Mental health ──
  {
    icd10_cm: 'F43.10',
    name: 'Post-traumatic stress disorder, unspecified',
    system: 'mental_health',
    synonyms: [
      'post traumatic stress disorder',
      'posttraumatic stress disorder',
      'ptsd',
      'complex ptsd',
      'cptsd',
    ],
  },
  {
    icd10_cm: 'F32.9',
    name: 'Major depressive disorder, single episode, unspecified',
    system: 'mental_health',
    synonyms: [
      'major depressive disorder',
      'major depression',
      'depression',
      'mdd',
      'clinical depression',
      // The codebook's own category title for the single-episode unspecified
      // member (F32) — the wording the Chapter V sweep surfaced.
      'depressive episode',
    ],
  },
  {
    icd10_cm: 'F41.1',
    name: 'Generalized anxiety disorder',
    system: 'mental_health',
    synonyms: ['generalized anxiety disorder', 'gad', 'anxiety', 'anxiety disorder'],
  },
  {
    icd10_cm: 'F41.0',
    name: 'Panic disorder without agoraphobia',
    system: 'mental_health',
    synonyms: ['panic disorder', 'panic attacks', 'panic'],
  },
  {
    icd10_cm: 'F31.9',
    name: 'Bipolar disorder, unspecified',
    system: 'mental_health',
    synonyms: ['bipolar disorder', 'bipolar', 'manic depression'],
  },
  {
    icd10_cm: 'F19.20',
    name: 'Other psychoactive substance dependence, uncomplicated',
    system: 'mental_health',
    synonyms: [
      'substance use disorder',
      'substance abuse',
      'drug addiction',
      'drug abuse',
      'alcohol use disorder',
      'alcoholism',
    ],
  },
  {
    icd10_cm: 'F20.9',
    name: 'Schizophrenia, unspecified',
    system: 'mental_health',
    synonyms: ['schizophrenia'],
  },
  {
    icd10_cm: 'F90.9',
    name: 'Attention-deficit hyperactivity disorder, unspecified type',
    system: 'mental_health',
    synonyms: ['adhd', 'attention deficit hyperactivity disorder', 'attention deficit disorder'],
  },
  {
    icd10_cm: 'F42.9',
    name: 'Obsessive-compulsive disorder, unspecified',
    system: 'mental_health',
    synonyms: ['obsessive compulsive disorder', 'ocd'],
  },

  // ── ICD-10 Chapter V sweep (1.16.0) — the seventh candidate source and the ──
  // ── fifth codebook enumeration, and the first chapter whose rows are mostly ──
  // ── *stateable*: a mental and behavioural disorder is something a person can ──
  // ── say about themselves, so a bare category title is close to what a ──
  // ── visitor types. The sweep found the vocabulary — grown from physical- ──
  // ── condition sources — looking straight through mania, depressive episode, ──
  // ── paraphilia and the whole intellectual-disability block; these are the ──
  // ── named diagnoses it surfaced. Batch 1 = mania, paraphilia and the first ──
  // ── three severity rows; batch 2 = the last two severity rows plus the ──
  // ── generic wording the block's residual uses.
  {
    icd10_cm: 'F30.9',
    name: 'Manic episode, unspecified',
    system: 'mental_health',
    synonyms: ['manic episode', 'mania'],
  },
  {
    icd10_cm: 'F65.9',
    name: 'Paraphilia, unspecified',
    system: 'mental_health',
    synonyms: ['paraphilia', 'paraphilic disorder'],
  },
  {
    icd10_cm: 'F70',
    name: 'Mild intellectual disabilities',
    system: 'mental_health',
    synonyms: ['mild intellectual disability'],
  },
  {
    icd10_cm: 'F71',
    name: 'Moderate intellectual disabilities',
    system: 'mental_health',
    synonyms: ['moderate intellectual disability'],
  },
  {
    icd10_cm: 'F72',
    name: 'Severe intellectual disabilities',
    system: 'mental_health',
    synonyms: ['severe intellectual disability'],
  },
  {
    icd10_cm: 'F73',
    name: 'Profound intellectual disabilities',
    system: 'mental_health',
    synonyms: ['profound intellectual disability'],
  },
  {
    // The generic wording belongs to the *unspecified* member, not to the
    // severity rows: F70–F73 assert a severity the person did not state, and
    // F78 is a non-billable header (its only members are genetic-related), so
    // "other intellectual disabilities" is gated descriptively instead.
    icd10_cm: 'F79',
    name: 'Unspecified intellectual disabilities',
    system: 'mental_health',
    synonyms: ['intellectual disability', 'unspecified intellectual disability'],
  },

  // ── Oncologic / hematologic ──
  {
    icd10_cm: 'C80.1',
    name: 'Malignant (primary) neoplasm, unspecified',
    system: 'oncologic',
    synonyms: ['cancer', 'cancer history', 'malignancy', 'carcinoma', 'sarcoma'],
  },
  {
    icd10_cm: 'C50.9',
    name: 'Malignant neoplasm of breast, unspecified',
    system: 'oncologic',
    synonyms: ['breast cancer', 'breast carcinoma'],
  },
  {
    icd10_cm: 'C61',
    name: 'Malignant neoplasm of prostate',
    system: 'oncologic',
    synonyms: ['prostate cancer', 'prostate carcinoma'],
  },
  {
    icd10_cm: 'C34.90',
    name: 'Malignant neoplasm of unspecified part of unspecified bronchus or lung',
    system: 'oncologic',
    synonyms: ['lung cancer', 'lung carcinoma'],
  },
  {
    icd10_cm: 'C18.9',
    name: 'Malignant neoplasm of colon, unspecified',
    system: 'oncologic',
    synonyms: ['colon cancer', 'colorectal cancer', 'bowel cancer'],
  },
  {
    icd10_cm: 'C43.9',
    name: 'Malignant melanoma of skin, unspecified',
    system: 'oncologic',
    synonyms: ['melanoma', 'skin cancer'],
  },
  {
    icd10_cm: 'C85.90',
    name: 'Non-Hodgkin lymphoma, unspecified, unspecified site',
    system: 'oncologic',
    synonyms: ['lymphoma', 'non-hodgkin lymphoma'],
  },
  {
    icd10_cm: 'C90.00',
    name: 'Multiple myeloma not having achieved remission',
    system: 'oncologic',
    synonyms: ['multiple myeloma', 'myeloma'],
  },
  {
    icd10_cm: 'C56.9',
    name: 'Malignant neoplasm of unspecified ovary',
    system: 'oncologic',
    synonyms: ['ovarian cancer'],
  },
  {
    icd10_cm: 'C25.9',
    name: 'Malignant neoplasm of pancreas, unspecified',
    system: 'oncologic',
    synonyms: ['pancreatic cancer'],
  },
  {
    icd10_cm: 'C22.0',
    name: 'Malignant neoplasm of liver and intrahepatic bile duct',
    system: 'oncologic',
    synonyms: ['liver cancer', 'hepatocellular carcinoma'],
  },
  {
    icd10_cm: 'C67.9',
    name: 'Malignant neoplasm of bladder, unspecified',
    system: 'oncologic',
    synonyms: ['bladder cancer'],
  },
  {
    icd10_cm: 'C64.9',
    name: 'Malignant neoplasm of unspecified kidney, except renal pelvis',
    system: 'oncologic',
    synonyms: ['kidney cancer', 'renal cancer', 'renal cell carcinoma'],
  },
  {
    icd10_cm: 'C73',
    name: 'Malignant neoplasm of thyroid gland',
    system: 'oncologic',
    synonyms: ['thyroid cancer'],
  },
  {
    icd10_cm: 'C71.9',
    name: 'Malignant neoplasm of brain, unspecified',
    system: 'oncologic',
    synonyms: ['brain cancer', 'brain tumor'],
  },
  {
    icd10_cm: 'C54.1',
    name: 'Malignant neoplasm of endometrium',
    system: 'oncologic',
    synonyms: ['endometrial cancer', 'uterine cancer'],
  },
  {
    icd10_cm: 'C95.90',
    name: 'Leukemia, unspecified, not having achieved remission',
    system: 'hematologic',
    synonyms: ['leukemia'],
  },
  {
    icd10_cm: 'D64.9',
    name: 'Anemia, unspecified',
    system: 'hematologic',
    synonyms: ['anemia', 'low blood count'],
  },
  {
    icd10_cm: 'D50.9',
    name: 'Iron deficiency anemia, unspecified',
    system: 'hematologic',
    synonyms: ['iron deficiency anemia', 'low iron'],
  },

  // ── Infectious ──
  {
    icd10_cm: 'B20',
    name: 'Human immunodeficiency virus (HIV) disease',
    system: 'infectious',
    synonyms: ['hiv', 'hiv positive', 'human immunodeficiency virus'],
  },
  {
    icd10_cm: 'B18.2',
    name: 'Chronic viral hepatitis C',
    system: 'infectious',
    synonyms: ['hepatitis c', 'chronic hepatitis c', 'hep c'],
  },
  {
    icd10_cm: 'A15.0',
    name: 'Tuberculosis of lung',
    system: 'infectious',
    synonyms: ['tuberculosis', 'tb'],
  },
  {
    icd10_cm: 'A41.9',
    name: 'Sepsis, unspecified organism',
    system: 'infectious',
    synonyms: ['sepsis', 'septicemia', 'blood poisoning'],
  },
  {
    icd10_cm: 'B16.9',
    name: 'Chronic viral hepatitis B without delta-agent',
    system: 'infectious',
    synonyms: ['hepatitis b', 'hep b'],
  },

  // ── Gynecologic ──
  {
    icd10_cm: 'N80.9',
    name: 'Endometriosis, unspecified',
    system: 'gynecologic',
    synonyms: ['endometriosis'],
  },
  {
    icd10_cm: 'D25.9',
    name: 'Leiomyoma of uterus, unspecified',
    system: 'gynecologic',
    synonyms: ['uterine fibroids', 'fibroids', 'leiomyoma', 'uterine leiomyoma'],
  },
  {
    icd10_cm: 'E28.2',
    name: 'Polycystic ovarian syndrome',
    system: 'gynecologic',
    synonyms: ['polycystic ovary syndrome', 'polycystic ovarian syndrome', 'pcos'],
  },
  {
    icd10_cm: 'N83.20',
    name: 'Unspecified ovarian cysts',
    system: 'gynecologic',
    synonyms: ['ovarian cyst', 'ovarian cysts'],
  },
  {
    icd10_cm: 'N97.9',
    name: 'Female infertility, unspecified',
    system: 'gynecologic',
    synonyms: ['infertility', 'female infertility', 'unable to conceive'],
  },

  // ── Urologic ──
  {
    icd10_cm: 'N40.1',
    name: 'Benign prostatic hyperplasia with lower urinary tract symptoms',
    system: 'urologic',
    synonyms: ['benign prostatic hyperplasia', 'enlarged prostate', 'bph', 'prostate enlargement'],
  },
  {
    icd10_cm: 'R32',
    name: 'Unspecified urinary incontinence',
    system: 'urologic',
    synonyms: ['urinary incontinence', 'incontinence'],
  },
  {
    icd10_cm: 'N32.81',
    name: 'Overactive bladder',
    system: 'urologic',
    synonyms: ['overactive bladder', 'oab'],
  },
  {
    icd10_cm: 'N52.9',
    name: 'Male erectile dysfunction, unspecified',
    system: 'urologic',
    synonyms: ['erectile dysfunction', 'impotence', 'male erectile dysfunction'],
  },
  {
    icd10_cm: 'N46.9',
    name: 'Male infertility, unspecified',
    system: 'urologic',
    synonyms: ['male infertility', 'low sperm count', 'azoospermia'],
  },

  // ── Dermatologic ──
  {
    icd10_cm: 'L20.9',
    name: 'Atopic dermatitis, unspecified',
    system: 'dermatologic',
    synonyms: ['eczema', 'atopic dermatitis', 'atopic eczema'],
  },
  {
    icd10_cm: 'L50.9',
    name: 'Urticaria, unspecified',
    system: 'dermatologic',
    synonyms: ['chronic urticaria', 'urticaria', 'hives'],
  },
  {
    icd10_cm: 'L80',
    name: 'Vitiligo',
    system: 'dermatologic',
    synonyms: ['vitiligo'],
  },
  {
    icd10_cm: 'L71.9',
    name: 'Rosacea, unspecified',
    system: 'dermatologic',
    synonyms: ['rosacea'],
  },
  {
    icd10_cm: 'L63.9',
    name: 'Alopecia areata, unspecified',
    system: 'dermatologic',
    synonyms: ['alopecia areata', 'alopecia'],
  },

  // ── Ophthalmologic / otologic ──
  {
    icd10_cm: 'H25.9',
    name: 'Unspecified age-related cataract',
    system: 'ophthalmologic',
    synonyms: ['cataract', 'cataracts'],
  },
  {
    icd10_cm: 'H40.9',
    name: 'Unspecified glaucoma',
    system: 'ophthalmologic',
    synonyms: ['glaucoma'],
  },
  {
    icd10_cm: 'H35.31',
    name: 'Nonexudative age-related macular degeneration',
    system: 'ophthalmologic',
    synonyms: ['age-related macular degeneration', 'macular degeneration'],
  },
  {
    icd10_cm: 'E11.319',
    name: 'Type 2 diabetes mellitus with unspecified diabetic retinopathy without macular edema',
    system: 'ophthalmologic',
    synonyms: ['diabetic retinopathy'],
  },
  {
    icd10_cm: 'H91.90',
    name: 'Unspecified hearing loss, unspecified ear',
    system: 'ent',
    synonyms: ['hearing loss', 'deafness', 'loss of hearing'],
  },
  {
    icd10_cm: 'H93.19',
    name: 'Tinnitus, unspecified ear',
    system: 'ent',
    synonyms: ['tinnitus', 'ringing in the ears'],
  },
  {
    icd10_cm: 'J32.9',
    name: 'Chronic sinusitis, unspecified',
    system: 'ent',
    synonyms: ['chronic sinusitis', 'sinusitis'],
  },
  {
    icd10_cm: 'H81.10',
    name: 'Benign paroxysmal positional vertigo, unspecified ear',
    system: 'ent',
    synonyms: ['benign paroxysmal positional vertigo', 'vertigo', 'bppv'],
  },
  {
    icd10_cm: 'K05.30',
    name: 'Chronic periodontitis, unspecified',
    system: 'ent',
    synonyms: ['periodontitis', 'gum disease', 'periodontal disease'],
  },

  // ── Congenital / developmental ──
  {
    icd10_cm: 'Q90.9',
    name: 'Down syndrome, unspecified',
    system: 'congenital',
    synonyms: ['down syndrome', 'trisomy 21'],
  },
  {
    icd10_cm: 'G80.9',
    name: 'Cerebral palsy, unspecified',
    system: 'congenital',
    synonyms: ['cerebral palsy'],
  },
  {
    icd10_cm: 'Q24.9',
    name: 'Congenital malformation of heart, unspecified',
    system: 'congenital',
    synonyms: ['congenital heart disease', 'congenital heart defect', 'congenital heart condition'],
  },
  {
    icd10_cm: 'E84.9',
    name: 'Cystic fibrosis, unspecified',
    system: 'congenital',
    synonyms: ['cystic fibrosis'],
  },
  {
    icd10_cm: 'Q05.9',
    name: 'Spina bifida, unspecified',
    system: 'congenital',
    synonyms: ['spina bifida'],
  },

  // ── Neurological / immune, other ──
  {
    icd10_cm: 'F84.0',
    name: 'Autistic disorder',
    system: 'mental_health',
    synonyms: ['autism', 'autism spectrum disorder', 'autistic disorder'],
  },
  {
    icd10_cm: 'G70.00',
    name: 'Myasthenia gravis without (acute) exacerbation',
    system: 'autoimmune_inflammatory',
    synonyms: ['myasthenia gravis', 'myasthenia'],
  },
  {
    icd10_cm: 'D86.9',
    name: 'Sarcoidosis, unspecified',
    system: 'autoimmune_inflammatory',
    synonyms: ['sarcoidosis'],
  },
  {
    icd10_cm: 'G56.00',
    name: 'Carpal tunnel syndrome, unspecified upper limb',
    system: 'neurological',
    synonyms: ['carpal tunnel syndrome', 'carpal tunnel'],
  },
  {
    icd10_cm: 'Q61.3',
    name: 'Polycystic kidney, unspecified',
    system: 'renal',
    synonyms: ['polycystic kidney disease', 'polycystic kidneys', 'pkd'],
  },

  // ── Musculoskeletal, other ──
  {
    icd10_cm: 'M41.9',
    name: 'Scoliosis, unspecified',
    system: 'musculoskeletal',
    synonyms: ['scoliosis'],
  },
  {
    icd10_cm: 'M51.9',
    name: 'Unspecified thoracic, thoracolumbar and lumbosacral intervertebral disc disorder',
    system: 'musculoskeletal',
    synonyms: [
      'herniated disc',
      'herniated disk',
      'slipped disc',
      'bulging disc',
      'disc herniation',
    ],
  },
  {
    icd10_cm: 'M48.00',
    name: 'Spinal stenosis, site unspecified',
    system: 'musculoskeletal',
    synonyms: ['spinal stenosis', 'stenosis of the spine'],
  },
  {
    icd10_cm: 'M75.100',
    name: 'Unspecified rotator cuff tear or rupture of unspecified shoulder, not traumatic',
    system: 'musculoskeletal',
    synonyms: ['rotator cuff tear', 'rotator cuff injury', 'rotator cuff'],
  },
  {
    icd10_cm: 'M72.2',
    name: 'Plantar fascial fibromatosis',
    system: 'musculoskeletal',
    synonyms: ['plantar fasciitis'],
  },

  // ── Gastrointestinal, other ──
  {
    icd10_cm: 'K57.32',
    name: 'Diverticulitis of large intestine without perforation or abscess without bleeding',
    system: 'gastrointestinal',
    synonyms: ['diverticulitis', 'diverticulosis', 'diverticular disease'],
  },
  {
    icd10_cm: 'K80.20',
    name: 'Calculus of gallbladder without cholecystitis without obstruction',
    system: 'gastrointestinal',
    // "gall stone" is the spaced spelling the collision sweep measured as gated
    // but unmatchable; the alias index derives "gall stones" as its plural.
    synonyms: ['gallstones', 'gall stone', 'gallbladder disease', 'cholelithiasis'],
  },
  {
    icd10_cm: 'K44.9',
    name: 'Diaphragmatic hernia without obstruction or gangrene',
    system: 'gastrointestinal',
    synonyms: ['hiatal hernia', 'diaphragmatic hernia'],
  },
  {
    icd10_cm: 'K64.9',
    name: 'Unspecified hemorrhoids',
    system: 'gastrointestinal',
    synonyms: ['hemorrhoids', 'hemorrhoid', 'piles'],
  },
  {
    icd10_cm: 'K29.50',
    name: 'Unspecified chronic gastritis without bleeding',
    system: 'gastrointestinal',
    synonyms: ['chronic gastritis', 'gastritis'],
  },

  // ── Hematologic, other ──
  {
    icd10_cm: 'D57.1',
    name: 'Sickle-cell disease without crisis',
    system: 'hematologic',
    synonyms: ['sickle cell disease', 'sickle cell anemia', 'sickle cell'],
  },
  {
    icd10_cm: 'D56.9',
    name: 'Thalassemia, unspecified',
    system: 'hematologic',
    synonyms: ['thalassemia'],
  },
  {
    icd10_cm: 'D66',
    name: 'Hereditary factor VIII deficiency',
    system: 'hematologic',
    synonyms: ['hemophilia'],
  },
  {
    icd10_cm: 'D68.0',
    name: "Von Willebrand's disease",
    system: 'hematologic',
    synonyms: ['von willebrand disease', 'von willebrand'],
  },
  {
    icd10_cm: 'D69.6',
    name: 'Thrombocytopenia, unspecified',
    system: 'hematologic',
    synonyms: ['thrombocytopenia', 'low platelets'],
  },

  // ── Infectious, other ──
  {
    icd10_cm: 'B02.9',
    name: 'Zoster without complications',
    system: 'infectious',
    synonyms: ['shingles', 'herpes zoster', 'zoster'],
  },
  {
    icd10_cm: 'A69.20',
    name: 'Lyme disease, unspecified',
    system: 'infectious',
    synonyms: ['lyme disease', 'lyme'],
  },
  {
    icd10_cm: 'M86.9',
    name: 'Osteomyelitis, unspecified',
    system: 'infectious',
    synonyms: ['osteomyelitis'],
  },
  {
    icd10_cm: 'U09.9',
    name: 'Post COVID-19 condition, unspecified',
    system: 'infectious',
    synonyms: ['long covid', 'post-covid condition'],
  },

  // ── Oncologic, other ──
  {
    icd10_cm: 'C16.9',
    name: 'Malignant neoplasm of stomach, unspecified',
    system: 'oncologic',
    synonyms: ['stomach cancer', 'gastric cancer'],
  },
  {
    icd10_cm: 'C15.9',
    name: 'Malignant neoplasm of esophagus, unspecified',
    system: 'oncologic',
    synonyms: ['esophageal cancer', 'cancer of the esophagus'],
  },
  {
    icd10_cm: 'C53.9',
    name: 'Malignant neoplasm of cervix uteri, unspecified',
    system: 'oncologic',
    synonyms: ['cervical cancer', 'cancer of the cervix'],
  },
  {
    icd10_cm: 'C62.90',
    name: 'Malignant neoplasm of unspecified testis, unspecified side',
    system: 'oncologic',
    synonyms: ['testicular cancer', 'testicular'],
  },
  {
    icd10_cm: 'C44.90',
    name: 'Unspecified malignant neoplasm of skin, unspecified',
    system: 'oncologic',
    synonyms: ['non-melanoma skin cancer', 'basal cell carcinoma', 'squamous cell carcinoma'],
  },

  // ── Endocrine, other ──
  {
    icd10_cm: 'E21.3',
    name: 'Hyperparathyroidism, unspecified',
    system: 'metabolic',
    synonyms: ['hyperparathyroidism', 'parathyroid disease'],
  },
  {
    icd10_cm: 'E23.0',
    name: 'Hypopituitarism',
    system: 'metabolic',
    synonyms: ['hypopituitarism', 'pituitary disorder'],
  },
  {
    icd10_cm: 'E24.9',
    name: "Cushing's syndrome, unspecified",
    system: 'metabolic',
    synonyms: ["cushing's syndrome", 'cushing syndrome', 'cushing'],
  },
  {
    icd10_cm: 'E23.2',
    name: 'Diabetes insipidus',
    system: 'metabolic',
    synonyms: ['diabetes insipidus'],
  },
  {
    icd10_cm: 'E04.1',
    name: 'Nontoxic single thyroid nodule',
    system: 'metabolic',
    synonyms: ['thyroid nodule', 'thyroid nodules'],
  },

  // ── Respiratory, other ──
  {
    icd10_cm: 'J84.10',
    name: 'Pulmonary fibrosis, unspecified',
    system: 'respiratory',
    synonyms: ['pulmonary fibrosis', 'idiopathic pulmonary fibrosis', 'lung fibrosis'],
  },
  {
    icd10_cm: 'J47.9',
    name: 'Bronchiectasis, uncomplicated',
    system: 'respiratory',
    synonyms: ['bronchiectasis'],
  },
  {
    icd10_cm: 'I27.20',
    name: 'Pulmonary hypertension, unspecified',
    system: 'cardiovascular',
    synonyms: [
      'pulmonary hypertension',
      'primary pulmonary hypertension',
      'primary pulmonary arterial hypertension',
    ],
  },

  // ── Mental health, other ──
  {
    icd10_cm: 'F40.10',
    name: 'Social phobia, unspecified',
    system: 'mental_health',
    synonyms: ['social anxiety disorder', 'social anxiety', 'social phobia'],
  },
  {
    icd10_cm: 'F40.00',
    name: 'Agoraphobia, unspecified',
    system: 'mental_health',
    synonyms: ['agoraphobia'],
  },
  {
    icd10_cm: 'F50.9',
    name: 'Eating disorder, unspecified',
    system: 'mental_health',
    synonyms: ['eating disorder', 'anorexia nervosa', 'anorexia', 'bulimia nervosa', 'bulimia'],
  },
  {
    icd10_cm: 'F53.0',
    name: 'Postpartum depression, unspecified',
    system: 'mental_health',
    synonyms: ['postpartum depression', 'postnatal depression'],
  },

  // ── Residual gap (1.3.0) — carrier-relevant chronic rows outside the ──
  // ── earlier scopes, declared in RESIDUAL_SCOPE (tests) ──
  {
    icd10_cm: 'I83.90',
    name: 'Asymptomatic varicose veins of unspecified lower extremity',
    system: 'cardiovascular',
    synonyms: ['varicose veins', 'varicose vein'],
  },
  {
    icd10_cm: 'M54.30',
    name: 'Sciatica, unspecified side',
    system: 'musculoskeletal',
    synonyms: ['sciatica'],
  },
  {
    icd10_cm: 'E87.5',
    name: 'Hyperpotassemia',
    system: 'metabolic',
    synonyms: ['hyperkalemia', 'high potassium'],
  },
  {
    icd10_cm: 'D51.9',
    name: 'Vitamin B12 deficiency anemia, unspecified',
    system: 'hematologic',
    synonyms: ['vitamin b12 deficiency', 'b12 deficiency', 'low b12'],
  },
  {
    icd10_cm: 'E83.110',
    name: 'Hereditary hemochromatosis',
    system: 'metabolic',
    synonyms: ['hemochromatosis'],
  },
  {
    icd10_cm: 'D55.0',
    name: 'Anemia due to glucose-6-phosphate dehydrogenase [G6PD] deficiency',
    system: 'hematologic',
    synonyms: [
      'g6pd deficiency',
      'glucose-6-phosphate dehydrogenase deficiency',
      'glucose 6 phosphate dehydrogenase deficiency',
    ],
  },
  {
    icd10_cm: 'Q79.60',
    name: 'Ehlers-Danlos syndrome, unspecified',
    system: 'congenital',
    synonyms: ['ehlers-danlos syndrome', 'ehlers danlos', 'eds'],
  },
  {
    icd10_cm: 'Q87.40',
    name: 'Marfan syndrome, unspecified',
    system: 'congenital',
    synonyms: ['marfan syndrome', 'marfans syndrome', 'marfan'],
  },
  {
    icd10_cm: 'G51.0',
    name: "Bell's palsy",
    system: 'neurological',
    synonyms: ["bell's palsy", 'bells palsy', 'bell palsy'],
  },
  {
    icd10_cm: 'G44.009',
    name: 'Cluster headache syndrome, unspecified, not intractable',
    system: 'neurological',
    synonyms: ['cluster headache', 'cluster headaches'],
  },
  {
    icd10_cm: 'M75.00',
    name: 'Adhesive capsulitis of unspecified shoulder',
    system: 'musculoskeletal',
    synonyms: ['frozen shoulder', 'adhesive capsulitis'],
  },
  {
    icd10_cm: 'M21.40',
    name: 'Flat foot [pes planus] (acquired), unspecified foot',
    system: 'musculoskeletal',
    synonyms: ['flat feet', 'flat foot', 'pes planus'],
  },
  {
    icd10_cm: 'M20.10',
    name: 'Hallux valgus (acquired), unspecified foot',
    system: 'musculoskeletal',
    synonyms: ['bunions', 'bunion', 'hallux valgus'],
  },
  {
    icd10_cm: 'O14.90',
    name: 'Unspecified pre-eclampsia, unspecified trimester',
    system: 'gynecologic',
    synonyms: ['preeclampsia', 'pre-eclampsia'],
  },
  {
    icd10_cm: 'H04.129',
    name: 'Dry eye syndrome, unspecified',
    system: 'ophthalmologic',
    synonyms: ['dry eye syndrome', 'dry eyes', 'dry eye'],
  },
  {
    icd10_cm: 'N95.1',
    name: 'Menopausal and female climacteric states',
    system: 'gynecologic',
    synonyms: ['menopause', 'perimenopause', 'postmenopausal'],
  },
  {
    icd10_cm: 'L43.9',
    name: 'Lichen planus, unspecified',
    system: 'dermatologic',
    synonyms: ['lichen planus'],
  },
  {
    icd10_cm: 'D18.00',
    name: 'Hemangioma unspecified site',
    system: 'dermatologic',
    synonyms: ['hemangioma'],
  },
  {
    icd10_cm: 'B07.0',
    name: 'Plantar wart',
    system: 'dermatologic',
    synonyms: ['plantar wart', 'plantar warts'],
  },
  {
    icd10_cm: 'H00.1',
    name: 'Chalazion',
    system: 'ophthalmologic',
    synonyms: ['chalazion', 'chalazions'],
  },
  {
    icd10_cm: 'I73.00',
    name: "Raynaud's syndrome without gangrene",
    system: 'cardiovascular',
    synonyms: ['raynauds phenomenon', 'raynauds syndrome', 'raynauds'],
  },
  {
    icd10_cm: 'E04.9',
    name: 'Nontoxic goiter, unspecified',
    system: 'metabolic',
    synonyms: ['goiter', 'enlarged thyroid'],
  },
  {
    icd10_cm: 'G25.0',
    name: 'Essential tremor',
    system: 'neurological',
    synonyms: ['essential tremor'],
  },
  {
    icd10_cm: 'N60.29',
    name: 'Fibroadenosis of unspecified breast',
    system: 'gynecologic',
    synonyms: ['fibrocystic breast changes', 'fibrocystic breasts', 'fibrocystic breast disease'],
  },
  {
    icd10_cm: 'K60.2',
    name: 'Anal fissure, unspecified',
    system: 'gastrointestinal',
    synonyms: ['anal fissure', 'anal fissures'],
  },
  {
    icd10_cm: 'K22.70',
    name: "Barrett's esophagus without dysplasia",
    system: 'gastrointestinal',
    synonyms: ['barretts esophagus', 'barrett esophagus'],
  },
  {
    icd10_cm: 'K40.90',
    name: 'Unilateral inguinal hernia, without obstruction or gangrene, not specified as recurrent',
    system: 'gastrointestinal',
    synonyms: ['inguinal hernia', 'groin hernia'],
  },
  {
    icd10_cm: 'N30.10',
    name: 'Interstitial cystitis (chronic) without hematuria',
    system: 'urologic',
    synonyms: ['interstitial cystitis', 'painful bladder syndrome'],
  },
  {
    icd10_cm: 'L57.0',
    name: 'Actinic keratosis',
    system: 'dermatologic',
    synonyms: ['actinic keratosis', 'actinic keratoses', 'solar keratosis'],
  },
  {
    icd10_cm: 'N81.4',
    name: 'Uterovaginal prolapse, unspecified',
    system: 'gynecologic',
    synonyms: ['uterine prolapse', 'prolapsed uterus', 'pelvic organ prolapse'],
  },
  {
    icd10_cm: 'N94.6',
    name: 'Dysmenorrhea, unspecified',
    system: 'gynecologic',
    synonyms: ['dysmenorrhea', 'painful periods'],
  },
  {
    icd10_cm: 'N94.3',
    name: 'Premenstrual tension syndrome',
    system: 'gynecologic',
    synonyms: ['premenstrual syndrome', 'premenstrual tension', 'pms'],
  },
  {
    icd10_cm: 'E73.9',
    name: 'Lactose intolerance, unspecified',
    system: 'gastrointestinal',
    synonyms: ['lactose intolerance'],
  },
  {
    icd10_cm: 'N28.1',
    name: 'Cyst of kidney, acquired',
    system: 'urologic',
    synonyms: ['kidney cyst', 'kidney cysts', 'renal cyst', 'renal cysts'],
  },
  {
    icd10_cm: 'L21.9',
    name: 'Seborrheic dermatitis, unspecified',
    system: 'dermatologic',
    synonyms: ['seborrheic dermatitis'],
  },
  {
    icd10_cm: 'M67.40',
    name: 'Ganglion, unspecified site',
    system: 'musculoskeletal',
    synonyms: ['ganglion cyst', 'ganglion cysts'],
  },
  {
    icd10_cm: 'M77.10',
    name: 'Lateral epicondylitis, unspecified elbow',
    system: 'musculoskeletal',
    synonyms: ['tennis elbow', 'lateral epicondylitis'],
  },
  {
    icd10_cm: 'M65.30',
    name: 'Trigger finger, unspecified finger',
    system: 'musculoskeletal',
    synonyms: ['trigger finger', 'trigger thumb'],
  },
  {
    icd10_cm: 'M71.9',
    name: 'Bursopathy, unspecified',
    system: 'musculoskeletal',
    synonyms: ['bursitis'],
  },
  {
    icd10_cm: 'L23.9',
    name: 'Allergic contact dermatitis, unspecified cause',
    system: 'dermatologic',
    synonyms: ['contact dermatitis', 'allergic contact dermatitis'],
  },
  {
    icd10_cm: 'K60.3',
    name: 'Anal fistula',
    system: 'gastrointestinal',
    synonyms: ['anal fistula'],
  },

  // ── Probe gap (1.4.0) — the 237-phrase carrier-questionnaire sweep found ──
  // ── these named diagnoses neither gated nor mapped. Batches of five. ──
  {
    icd10_cm: 'I42.9',
    name: 'Cardiomyopathy, unspecified',
    system: 'cardiovascular',
    synonyms: ['cardiomyopathy', 'dilated cardiomyopathy', 'hypertrophic cardiomyopathy'],
  },
  {
    icd10_cm: 'I40.9',
    name: 'Acute myocarditis, unspecified',
    system: 'cardiovascular',
    synonyms: ['myocarditis'],
  },
  {
    icd10_cm: 'I30.9',
    name: 'Acute pericarditis, unspecified',
    system: 'cardiovascular',
    synonyms: ['pericarditis'],
  },
  {
    icd10_cm: 'I47.9',
    name: 'Paroxysmal tachycardia, unspecified',
    system: 'cardiovascular',
    synonyms: ['paroxysmal tachycardia', 'supraventricular tachycardia', 'svt'],
  },
  {
    icd10_cm: 'E78.1',
    name: 'Pure hyperglyceridemia',
    system: 'metabolic',
    synonyms: ['high triglycerides', 'high triglyceride', 'hypertriglyceridemia'],
  },
  {
    icd10_cm: 'E87.1',
    name: 'Hypo-osmolality and hyponatremia',
    system: 'metabolic',
    synonyms: ['hyponatremia', 'low sodium'],
  },
  {
    icd10_cm: 'E83.52',
    name: 'Hypercalcemia',
    system: 'metabolic',
    synonyms: ['hypercalcemia', 'high calcium'],
  },
  {
    icd10_cm: 'E79.0',
    name: 'Hyperuricemia without signs of inflammatory arthritis and tophaceous disease',
    system: 'metabolic',
    synonyms: ['hyperuricemia', 'high uric acid'],
  },
  {
    icd10_cm: 'E29.1',
    name: 'Testicular hypofunction',
    system: 'metabolic',
    synonyms: ['low testosterone', 'testosterone deficiency', 'hypogonadism'],
  },
  {
    icd10_cm: 'E20.9',
    name: 'Hypoparathyroidism, unspecified',
    system: 'metabolic',
    synonyms: ['hypoparathyroidism'],
  },
  {
    icd10_cm: 'N05.9',
    name: 'Unspecified nephritic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['glomerulonephritis', 'nephritic syndrome'],
  },
  {
    icd10_cm: 'J33.9',
    name: 'Nasal polyp, unspecified',
    system: 'ent',
    synonyms: ['nasal polyps', 'nasal polyp'],
  },
  {
    icd10_cm: 'R09.1',
    name: 'Pleurisy',
    system: 'respiratory',
    synonyms: ['pleurisy'],
  },
  {
    icd10_cm: 'J93.9',
    name: 'Pneumothorax, unspecified',
    system: 'respiratory',
    synonyms: ['pneumothorax', 'collapsed lung'],
  },
  {
    icd10_cm: 'K31.84',
    name: 'Gastroparesis',
    system: 'gastrointestinal',
    synonyms: ['gastroparesis'],
  },
  {
    icd10_cm: 'G44.209',
    name: 'Tension-type headache, unspecified, not intractable',
    system: 'neurological',
    synonyms: ['tension headache', 'tension headaches', 'tension-type headache'],
  },
  {
    icd10_cm: 'F95.2',
    name: "Tourette's disorder",
    system: 'mental_health',
    synonyms: ['tourette syndrome', "tourette's syndrome", 'tourettes'],
  },
  {
    icd10_cm: 'G91.9',
    name: 'Hydrocephalus, unspecified',
    system: 'neurological',
    synonyms: ['hydrocephalus'],
  },
  {
    icd10_cm: 'G71.0',
    name: 'Muscular dystrophy',
    system: 'neurological',
    synonyms: ['muscular dystrophy'],
  },
  {
    icd10_cm: 'H33.20',
    name: 'Retinal detachment, unspecified',
    system: 'ophthalmologic',
    synonyms: ['retinal detachment', 'detached retina'],
  },
  {
    icd10_cm: 'Q35.9',
    name: 'Cleft palate, unspecified',
    system: 'congenital',
    synonyms: ['cleft palate'],
  },
  {
    icd10_cm: 'Q66.89',
    name: 'Other congenital deformities of feet',
    system: 'congenital',
    synonyms: ['club foot', 'clubfoot'],
  },
  {
    icd10_cm: 'Q96.9',
    name: "Turner's syndrome, unspecified",
    system: 'congenital',
    synonyms: ['turner syndrome', 'turners syndrome'],
  },
  {
    icd10_cm: 'Q99.2',
    name: 'Fragile X chromosome',
    system: 'congenital',
    synonyms: ['fragile x syndrome', 'fragile x'],
  },
  {
    icd10_cm: 'D45',
    name: 'Polycythemia vera',
    system: 'hematologic',
    synonyms: ['polycythemia vera', 'polycythemia'],
  },
  {
    icd10_cm: 'L70.0',
    name: 'Acne vulgaris',
    system: 'dermatologic',
    synonyms: ['acne', 'acne vulgaris'],
  },
  {
    icd10_cm: 'L91.0',
    name: 'Hypertrophic scar',
    system: 'dermatologic',
    synonyms: ['keloid', 'keloids'],
  },
  {
    icd10_cm: 'I89.0',
    name: 'Lymphedema, not elsewhere classified',
    system: 'cardiovascular',
    synonyms: ['lymphedema'],
  },
  {
    icd10_cm: 'I86.1',
    name: 'Scrotal varices',
    system: 'urologic',
    synonyms: ['varicocele'],
  },
  {
    icd10_cm: 'B00.9',
    name: 'Herpesviral infection, unspecified',
    system: 'infectious',
    synonyms: ['herpes', 'herpes simplex'],
  },

  // ── Critical-illness sweep (1.6.0) — the carrier covered-condition lists ──
  // ── named these diagnoses, and they were neither gated nor mapped. ──
  {
    icd10_cm: 'A86',
    name: 'Unspecified viral encephalitis',
    system: 'neurological',
    synonyms: ['encephalitis', 'viral encephalitis'],
  },
  {
    icd10_cm: 'A80.9',
    name: 'Acute poliomyelitis, unspecified',
    system: 'neurological',
    synonyms: ['poliomyelitis', 'polio'],
  },
  {
    icd10_cm: 'G00.9',
    name: 'Bacterial meningitis, unspecified',
    system: 'neurological',
    synonyms: ['bacterial meningitis'],
  },
  {
    icd10_cm: 'G12.29',
    name: 'Other motor neuron disease',
    system: 'neurological',
    synonyms: ['motor neurone disease', 'motor neuron disease'],
  },
  {
    icd10_cm: 'R40.20',
    name: 'Unspecified coma',
    system: 'neurological',
    synonyms: ['coma', 'in a coma', 'comatose'],
  },
  {
    icd10_cm: 'G82.20',
    name: 'Paraplegia, unspecified',
    system: 'neurological',
    synonyms: ['paraplegia', 'paraplegic'],
  },
  {
    icd10_cm: 'K72.90',
    name: 'Hepatic failure, unspecified without coma',
    system: 'gastrointestinal',
    synonyms: ['liver failure', 'hepatic failure', 'end stage liver failure'],
  },
  {
    icd10_cm: 'K76.9',
    name: 'Liver disease, unspecified',
    system: 'gastrointestinal',
    synonyms: ['liver disease', 'chronic liver disease'],
  },
  {
    icd10_cm: 'D61.9',
    name: 'Aplastic anemia, unspecified',
    system: 'hematologic',
    synonyms: ['aplastic anemia'],
  },
  {
    icd10_cm: 'D33.2',
    name: 'Benign neoplasm of brain, unspecified',
    system: 'oncologic',
    synonyms: ['benign brain tumour'],
  },

  // ── ICD-10 Chapter IX sweep (1.7.0) — the WHO tabular list's three-character ──
  // ── category titles, the first codebook enumeration used as a source. ──
  // ── The haemorrhagic strokes are here; both spellings are reached by the ──
  // ── declared spelling variants, because the vocabulary carried only ──
  // ── "stroke" and the American spelling. ──
  {
    icd10_cm: 'I60.9',
    name: 'Nontraumatic subarachnoid hemorrhage, unspecified',
    system: 'cardiovascular',
    synonyms: ['subarachnoid hemorrhage'],
  },
  {
    icd10_cm: 'I61.9',
    name: 'Nontraumatic intracerebral hemorrhage, unspecified',
    system: 'cardiovascular',
    synonyms: ['intracerebral hemorrhage'],
  },
  {
    icd10_cm: 'I62.9',
    name: 'Nontraumatic intracranial hemorrhage, unspecified',
    system: 'cardiovascular',
    synonyms: ['nontraumatic intracranial hemorrhage', 'intracranial hemorrhage'],
  },
  {
    icd10_cm: 'I80.9',
    name: 'Phlebitis and thrombophlebitis of unspecified site',
    system: 'cardiovascular',
    synonyms: ['phlebitis', 'thrombophlebitis'],
  },
  {
    icd10_cm: 'I88.9',
    name: 'Nonspecific lymphadenitis, unspecified',
    system: 'hematologic',
    synonyms: ['nonspecific lymphadenitis', 'lymphadenitis'],
  },
  {
    icd10_cm: 'I44.30',
    name: 'Unspecified atrioventricular block',
    system: 'cardiovascular',
    synonyms: ['atrioventricular block', 'heart block', 'bundle branch block'],
  },

  // ── ICD-10 Chapter XIV sweep (1.9.0) — the N00–N99 three-character category ──
  // ── titles, the chapter the stone family sits in. Six batches of five named ──
  // ── diagnoses; the “other …” category constructs are gated, not coded.    ──

  // Batch 1 — the nephritic syndromes and isolated proteinuria, the N00–N06
  // family whose unspecified members already carried N04.9 and N05.9.
  {
    icd10_cm: 'N00.9',
    name: 'Acute nephritic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['acute nephritic syndrome'],
  },
  {
    icd10_cm: 'N01.9',
    name: 'Rapidly progressive nephritic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['rapidly progressive nephritic syndrome'],
  },
  {
    icd10_cm: 'N02.9',
    name: 'Recurrent and persistent hematuria with unspecified morphologic changes',
    system: 'renal',
    // The bare word "hematuria" is deliberately NOT an alias: a single episode
    // codes to hematuria, unspecified (R31.9), so the row keeps its own wording.
    synonyms: ['recurrent and persistent hematuria'],
  },
  {
    icd10_cm: 'N03.9',
    name: 'Chronic nephritic syndrome with unspecified morphologic changes',
    system: 'renal',
    synonyms: ['chronic nephritic syndrome'],
  },
  {
    icd10_cm: 'N06.9',
    name: 'Isolated proteinuria with unspecified morphologic lesion',
    system: 'renal',
    // The N06 category is titled "…with specified morphological lesion"; the
    // billable member is the unspecified-lesion row, so only the stateable
    // "isolated proteinuria" is an alias and the category title stays gated.
    synonyms: ['isolated proteinuria'],
  },

  // Batch 2 — tubulo-interstitial nephritis and kidney failure. The alias
  // move beside these rows is recorded in the 1.9.0 changelog entry.
  {
    icd10_cm: 'N10',
    name: 'Acute pyelonephritis',
    system: 'renal',
    synonyms: ['acute pyelonephritis', 'pyelonephritis'],
  },
  {
    icd10_cm: 'N11.9',
    name: 'Chronic tubulo-interstitial nephritis, unspecified',
    system: 'renal',
    synonyms: ['chronic tubulo-interstitial nephritis'],
  },
  {
    icd10_cm: 'N12',
    name: 'Tubulo-interstitial nephritis, not specified as acute or chronic',
    system: 'renal',
    // Both spellings of the compound are curated: exact matching means the
    // hyphenated form would not cover the unhyphenated one.
    synonyms: ['tubulo-interstitial nephritis', 'tubulointerstitial nephritis'],
  },
  {
    icd10_cm: 'N17.9',
    name: 'Acute kidney failure, unspecified',
    system: 'renal',
    synonyms: ['acute kidney failure', 'acute kidney injury', 'acute renal failure'],
  },
  {
    icd10_cm: 'N19',
    name: 'Unspecified kidney failure',
    system: 'renal',
    // "kidney failure" moved here from N18.6 in 1.9.0: an unqualified statement
    // is the unspecified row, and end stage renal disease keeps its own name,
    // dialysis, and ESRD.
    synonyms: ['unspecified kidney failure', 'kidney failure', 'renal failure'],
  },

  // Batch 3 — obstructive uropathy, calculi and the bladder.
  {
    icd10_cm: 'N13.9',
    name: 'Obstructive and reflux uropathy, unspecified',
    system: 'renal',
    synonyms: ['obstructive and reflux uropathy', 'obstructive uropathy', 'reflux uropathy'],
  },
  {
    icd10_cm: 'N21.9',
    name: 'Calculus of lower urinary tract, unspecified',
    system: 'urologic',
    synonyms: ['calculus of lower urinary tract'],
  },
  {
    icd10_cm: 'N23',
    name: 'Unspecified renal colic',
    system: 'renal',
    synonyms: ['renal colic', 'unspecified renal colic'],
  },
  {
    icd10_cm: 'N30.90',
    name: 'Cystitis, unspecified without hematuria',
    system: 'urologic',
    synonyms: ['cystitis'],
  },
  {
    icd10_cm: 'N31.9',
    name: 'Neuromuscular dysfunction of bladder, unspecified',
    system: 'urologic',
    synonyms: ['neurogenic bladder', 'neuromuscular dysfunction of bladder'],
  },

  // Batch 4 — the urethra and the male genital organs. N34.1 is the code
  // coders use for urethritis stated without further detail.
  {
    icd10_cm: 'N34.1',
    name: 'Nonspecific urethritis',
    system: 'urologic',
    synonyms: ['nonspecific urethritis', 'urethritis'],
  },
  {
    icd10_cm: 'N43.3',
    name: 'Hydrocele, unspecified',
    system: 'urologic',
    synonyms: ['hydrocele'],
  },
  {
    icd10_cm: 'N43.40',
    name: 'Spermatocele of epididymis, unspecified',
    system: 'urologic',
    synonyms: ['spermatocele'],
  },
  {
    icd10_cm: 'N45.1',
    name: 'Epididymitis',
    system: 'urologic',
    synonyms: ['epididymitis'],
  },
  {
    icd10_cm: 'N45.2',
    name: 'Orchitis',
    system: 'urologic',
    synonyms: ['orchitis'],
  },

  // Batch 5 — breast and female pelvic organs. The breast codes carry
  // "unspecified breast" because FY2026 requires a side for the site-specific
  // members (N60.91/N60.92, N63.10-N63.12), and the visitor's side is unknown.
  {
    icd10_cm: 'N60.99',
    name: 'Unspecified benign mammary dysplasia of unspecified breast',
    system: 'gynecologic',
    synonyms: ['benign mammary dysplasia'],
  },
  {
    icd10_cm: 'N62',
    name: 'Hypertrophy of breast',
    system: 'gynecologic',
    synonyms: ['hypertrophy of breast', 'breast hypertrophy'],
  },
  {
    icd10_cm: 'N63.0',
    name: 'Unspecified lump in unspecified breast',
    system: 'gynecologic',
    // The site-free row the lump context rule needed: "breast lump" is the
    // stateable form, and N63 itself is a header now. Site-qualified so the
    // person's own word chooses it: "lump in my breast" resolves here, while a
    // bare "lump" resolves to nothing (the site could be anywhere) and a
    // side-stated lump ("lump in my left breast") also defers — FY2026's side
    // members are quadrant-specific (N63.11–N63.14 right, N63.2x left), so a
    // side alone still is not enough to choose a billable code. Both deferrals
    // are tested, not incidental.
    synonyms: ['unspecified lump in breast', 'breast lump', 'lump in breast', 'lump'],
    appliesWhen: { site: ['breast'] },
  },
  {
    icd10_cm: 'N70.91',
    name: 'Salpingitis, unspecified',
    system: 'gynecologic',
    synonyms: ['salpingitis'],
  },
  {
    icd10_cm: 'N70.92',
    name: 'Oophoritis, unspecified',
    system: 'gynecologic',
    synonyms: ['oophoritis'],
  },

  // Batch 6 — the female genital tract, the cervix and reproductive loss.
  {
    icd10_cm: 'N75.9',
    name: "Disease of Bartholin's gland, unspecified",
    system: 'gynecologic',
    synonyms: ['disease of bartholins gland', 'diseases of bartholins gland'],
  },
  {
    icd10_cm: 'N81.9',
    name: 'Female genital prolapse, unspecified',
    system: 'gynecologic',
    synonyms: ['female genital prolapse'],
  },
  {
    icd10_cm: 'N86',
    name: 'Erosion and ectropion of cervix uteri',
    system: 'gynecologic',
    synonyms: ['erosion and ectropion of cervix uteri', 'cervical erosion'],
  },
  {
    icd10_cm: 'N87.9',
    name: 'Dysplasia of cervix uteri, unspecified',
    system: 'gynecologic',
    synonyms: ['dysplasia of cervix uteri', 'cervical dysplasia'],
  },
  {
    icd10_cm: 'N96',
    name: 'Recurrent pregnancy loss',
    system: 'gynecologic',
    synonyms: ['recurrent pregnancy loss', 'recurrent miscarriage'],
  },

  // ── FY2026 qualifier splits (1.10.0) — rows whose code depends on something ──
  // the person stated elsewhere rather than on more clinical detail. The
  // deferred row of 1.9.0 is the worked example: FY2026 split urethral stricture
  // into sex-specific codes, so the same words resolve to different codes
  // depending on the sex the consented profile records — and to nothing at all
  // when it records neither, which is the never-guess rule as data.
  {
    icd10_cm: 'N35.919',
    name: 'Unspecified urethral stricture, male, unspecified site',
    system: 'urologic',
    // The billable unspecified-site member beneath the N35.91 header: CM pushes
    // the male row down to meatal / bulbous / membranous / anterior, which is
    // detail nobody states at intake. N35.91 itself is a header, so this is the
    // most general *billable* male code that still identifies the condition.
    synonyms: ['urethral stricture', 'stricture of urethra'],
    appliesWhen: { sex: ['male'] },
  },
  {
    icd10_cm: 'N35.92',
    name: 'Unspecified urethral stricture, female',
    system: 'urologic',
    synonyms: ['urethral stricture', 'stricture of urethra'],
    appliesWhen: { sex: ['female'] },
  },

  // ── ICD-10 Chapter XVIII sweep (1.11.0) — the R00–R99 category titles that ──
  // name a discrete finding a person can state, in five batches of five. A
  // symptom code is not a diagnosis, so the vocabulary carries only the rows
  // whose *finding* is its own entity with a billable unspecified member: a
  // nosebleed, a fit, a swollen gland. Everything else the chapter enumerates is
  // a description of experience (cough, pain, nausea) or a lab/imaging
  // construct, and is gated instead of coded — see the phase-2 doc for the
  // closure and the gate suite for the scope ledger.

  // Batch 1 — bleeding and the urinary tract.
  {
    icd10_cm: 'R04.0',
    name: 'Epistaxis',
    system: 'respiratory',
    synonyms: ['epistaxis', 'nosebleed', 'nose bleed'],
  },
  {
    icd10_cm: 'R04.2',
    name: 'Hemoptysis',
    system: 'respiratory',
    synonyms: ['hemoptysis', 'coughing up blood'],
  },
  {
    icd10_cm: 'R30.0',
    name: 'Dysuria',
    system: 'urologic',
    synonyms: ['dysuria', 'painful urination'],
  },
  {
    icd10_cm: 'R31.9',
    name: 'Hematuria, unspecified',
    system: 'urologic',
    synonyms: ['hematuria', 'blood in urine'],
  },
  {
    icd10_cm: 'R33.9',
    name: 'Retention of urine, unspecified',
    system: 'urologic',
    synonyms: ['urinary retention', 'retention of urine'],
  },

  // Batch 2 — urinary output, collapse and the nervous system.
  {
    icd10_cm: 'R34',
    name: 'Anuria and oliguria',
    system: 'urologic',
    synonyms: ['anuria', 'oliguria'],
  },
  {
    icd10_cm: 'R35.1',
    name: 'Nocturia',
    system: 'urologic',
    synonyms: ['nocturia'],
  },
  {
    icd10_cm: 'R55',
    name: 'Syncope and collapse',
    system: 'neurological',
    synonyms: ['syncope', 'fainting', 'fainted'],
  },
  {
    icd10_cm: 'R56.9',
    name: 'Unspecified convulsions',
    system: 'neurological',
    synonyms: ['convulsions', 'convulsion'],
  },
  {
    icd10_cm: 'R20.2',
    name: 'Paresthesia of skin',
    system: 'neurological',
    synonyms: ['paresthesia', 'pins and needles'],
  },

  // Batch 3 — the liver, the spleen and the lymph nodes. R18 is a header whose
  // members are malignant (R18.0) and other (R18.8) ascites; a plain statement
  // of ascites is the “other” row, since malignancy is not something the person
  // said.
  {
    icd10_cm: 'R17',
    name: 'Unspecified jaundice',
    system: 'gastrointestinal',
    synonyms: ['jaundice'],
  },
  {
    icd10_cm: 'R18.8',
    name: 'Other ascites',
    system: 'gastrointestinal',
    synonyms: ['ascites'],
  },
  {
    icd10_cm: 'R16.0',
    name: 'Hepatomegaly, not elsewhere classified',
    system: 'gastrointestinal',
    synonyms: ['hepatomegaly', 'enlarged liver'],
  },
  {
    icd10_cm: 'R16.1',
    name: 'Splenomegaly, not elsewhere classified',
    system: 'gastrointestinal',
    synonyms: ['splenomegaly', 'enlarged spleen'],
  },
  {
    icd10_cm: 'R59.9',
    name: 'Enlarged lymph nodes, unspecified',
    system: 'hematologic',
    synonyms: ['enlarged lymph nodes', 'swollen lymph nodes', 'swollen glands'],
  },

  // Batch 4 — fluid, swallowing and the urine findings.
  {
    icd10_cm: 'R60.9',
    name: 'Edema, unspecified',
    system: 'cardiovascular',
    synonyms: ['edema'],
  },
  {
    icd10_cm: 'R13.10',
    name: 'Dysphagia, unspecified',
    system: 'gastrointestinal',
    synonyms: ['dysphagia', 'difficulty swallowing', 'trouble swallowing'],
  },
  {
    icd10_cm: 'R80.9',
    name: 'Proteinuria, unspecified',
    system: 'renal',
    synonyms: ['proteinuria'],
  },
  {
    icd10_cm: 'R81',
    name: 'Glycosuria',
    system: 'renal',
    synonyms: ['glycosuria', 'sugar in urine'],
  },
  {
    icd10_cm: 'R73.9',
    name: 'Hyperglycemia, unspecified',
    system: 'metabolic',
    synonyms: ['hyperglycemia', 'high blood sugar'],
  },

  // Batch 5 — the lab findings and the two chemosensory/neurological rows.
  {
    icd10_cm: 'R74.01',
    name: 'Elevation of levels of liver transaminase levels',
    system: 'gastrointestinal',
    synonyms: [
      'elevated liver enzymes',
      'raised liver enzymes',
      'abnormal liver enzymes',
      'high liver enzymes',
    ],
  },
  {
    icd10_cm: 'R97.20',
    name: 'Elevated prostate specific antigen [PSA]',
    system: 'oncologic',
    // The marker is stated by its abbreviation far more often than by its name:
    // "my PSA came back high". `psa` is word-matched by the gate and carries the
    // public-service-announcement collision as a recorded tradeoff, the same way
    // `veins` carries its metaphor.
    synonyms: ['elevated psa', 'high psa', 'raised psa', 'prostate specific antigen'],
  },
  {
    icd10_cm: 'R70.0',
    name: 'Elevated erythrocyte sedimentation rate',
    system: 'hematologic',
    synonyms: ['elevated esr', 'high esr', 'raised esr', 'erythrocyte sedimentation rate'],
  },
  {
    icd10_cm: 'R43.0',
    name: 'Anosmia',
    system: 'neurological',
    synonyms: ['anosmia', 'loss of smell'],
  },
  {
    icd10_cm: 'R47.01',
    name: 'Aphasia',
    system: 'neurological',
    synonyms: ['aphasia'],
  },

  // Coda — the rest of R35. Batch 2 mapped its nocturia member; the category's
  // other two stateable members are here so the row that made "polyuria" a
  // chapter title resolves too. R35 itself is a non-billable header, and the
  // unspecified member the header would have implied does not exist: FY2026
  // offers R35.89 ("other polyuria") in its place, the same shape as R18.8.
  {
    icd10_cm: 'R35.0',
    name: 'Frequency of micturition',
    system: 'urologic',
    synonyms: [
      'frequency of micturition',
      'urinary frequency',
      'frequency of urination',
      'urinating frequently',
      'peeing frequently',
    ],
  },
  {
    icd10_cm: 'R35.89',
    name: 'Other polyuria',
    system: 'urologic',
    synonyms: ['polyuria', 'passing a lot of urine'],
  },

  // ── ICD-10 Chapter XXI sweep (1.12.0) — the Z00–Z99 category titles that ──
  // state something a person reports about themselves, in eight batches of
  // five. This chapter is where the vocabulary had been thinnest and where a
  // carrier's questions actually live: family history, personal history,
  // genetic and carrier status, and drug allergy. Every row here is the
  // *history/status* code for the statement — "history of breast cancer" is
  // Z85.3, not the neoplasm's own code — which is what makes the phrasing the
  // alias rather than the disease name.
  //
  // The chapter's remaining rows are not statements at all (encounters,
  // aftercare, socioeconomic circumstances, device and prosthesis states), and
  // are declared non-stateable in the corpus file with their reasons, exactly
  // as the three R00–R99 rows were.

  // Batch 1 — family history of malignant neoplasm.
  {
    icd10_cm: 'Z80.3',
    name: 'Family history of malignant neoplasm of breast',
    system: 'oncologic',
    synonyms: [
      'family history of breast cancer',
      'breast cancer in the family',
      'breast cancer runs in my family',
      'mother had breast cancer',
      'my sister had breast cancer',
    ],
  },
  {
    icd10_cm: 'Z80.9',
    name: 'Family history of malignant neoplasm, unspecified',
    system: 'oncologic',
    synonyms: [
      'family history of cancer',
      'cancer in the family',
      'cancer runs in my family',
      'my father died of cancer',
    ],
  },
  {
    icd10_cm: 'Z80.0',
    name: 'Family history of malignant neoplasm of digestive organs',
    system: 'oncologic',
    synonyms: [
      'family history of colon cancer',
      'family history of bowel cancer',
      'family history of stomach cancer',
      'colon cancer runs in my family',
    ],
  },
  {
    icd10_cm: 'Z80.42',
    name: 'Family history of malignant neoplasm of prostate',
    system: 'oncologic',
    synonyms: [
      'family history of prostate cancer',
      'my father had prostate cancer',
      'prostate cancer runs in my family',
    ],
  },
  {
    // Z83.71 is a non-billable header (the same FY2026 shape as N35.9 and
    // R35): the colony-polyp family is split by histology, and a person who
    // says "family history of polyps" has not said which kind — so the
    // unspecified member is the honest row rather than a guess at "adenomatous".
    icd10_cm: 'Z83.719',
    name: 'Family history of colon polyps, unspecified',
    system: 'gastrointestinal',
    synonyms: [
      'family history of colon polyps',
      'family history of polyps',
      'polyps run in my family',
    ],
  },

  // Batch 2 — family history of the circulatory and metabolic rows.
  {
    icd10_cm: 'Z82.3',
    name: 'Family history of stroke',
    system: 'cardiovascular',
    synonyms: [
      'family history of stroke',
      'stroke runs in my family',
      'my father had a stroke',
      'my mother had a stroke',
    ],
  },
  {
    icd10_cm: 'Z82.49',
    name: 'Family history of ischemic heart disease and other diseases of the circulatory system',
    system: 'cardiovascular',
    synonyms: [
      'family history of heart disease',
      'heart disease runs in my family',
      'my father died of a heart attack',
      'my father had a heart attack',
      'family history of heart attack',
    ],
  },
  {
    icd10_cm: 'Z82.41',
    name: 'Family history of sudden cardiac death',
    system: 'cardiovascular',
    synonyms: [
      'family history of sudden cardiac death',
      'family history of sudden death',
      'sudden cardiac death in the family',
    ],
  },
  {
    icd10_cm: 'Z83.3',
    name: 'Family history of diabetes mellitus',
    system: 'metabolic',
    synonyms: [
      'family history of diabetes',
      'diabetes runs in my family',
      'my mother has diabetes',
    ],
  },
  {
    icd10_cm: 'Z83.42',
    name: 'Family history of familial hypercholesterolemia',
    system: 'metabolic',
    synonyms: [
      'family history of high cholesterol',
      'family history of familial hypercholesterolemia',
      'high cholesterol runs in my family',
    ],
  },

  // Batch 3 — family history of the remaining conditions a carrier asks about.
  {
    icd10_cm: 'Z82.5',
    name: 'Family history of asthma and other chronic lower respiratory diseases',
    system: 'respiratory',
    synonyms: ['family history of asthma', 'asthma runs in my family'],
  },
  {
    icd10_cm: 'Z82.0',
    name: 'Family history of epilepsy and other diseases of the nervous system',
    system: 'neurological',
    synonyms: ['family history of epilepsy', 'epilepsy runs in my family'],
  },
  {
    icd10_cm: 'Z81.8',
    name: 'Family history of other mental and behavioral disorders',
    system: 'mental_health',
    synonyms: [
      'family history of mental illness',
      'mental illness runs in my family',
      'family history of depression',
      'family history of bipolar',
    ],
  },
  {
    icd10_cm: 'Z81.1',
    name: 'Family history of alcohol abuse and dependence',
    system: 'mental_health',
    synonyms: [
      'family history of alcoholism',
      'alcoholism runs in my family',
      'family history of alcohol abuse',
    ],
  },
  {
    icd10_cm: 'Z80.6',
    name: 'Family history of leukemia',
    system: 'oncologic',
    synonyms: ['family history of leukemia'],
  },

  // Batch 4 — genetic susceptibility and carrier status, the rows this chapter
  // owns that no other chapter has.
  {
    icd10_cm: 'Z14.1',
    name: 'Cystic fibrosis carrier',
    system: 'congenital',
    synonyms: [
      'cystic fibrosis carrier',
      'carrier of cystic fibrosis',
      'cf carrier',
      'i carry the cf gene',
    ],
  },
  {
    icd10_cm: 'Z14.8',
    name: 'Genetic carrier of other disease',
    system: 'congenital',
    synonyms: [
      'genetic carrier',
      'carrier of a genetic condition',
      'carrier of a genetic disease',
      'i carry a genetic mutation',
    ],
  },
  {
    icd10_cm: 'Z15.01',
    name: 'Genetic susceptibility to malignant neoplasm of breast',
    system: 'oncologic',
    synonyms: [
      'brca1',
      'brca2',
      'brca mutation',
      'brca gene',
      'i carry the brca gene',
      'genetic susceptibility to breast cancer',
    ],
  },
  {
    // The status row, not the disease: "hiv positive" already belongs to B20
    // (the infection a person is stating), and this row is the clinician's
    // *asymptomatic* variant — reached only by the phrasing that says so.
    // Claiming the same alias for both is exactly what the crosswalk's
    // duplicate check refuses, and it refused this one while it was being
    // written.
    icd10_cm: 'Z21',
    name: 'Asymptomatic human immunodeficiency virus [HIV] infection status',
    system: 'infectious',
    synonyms: ['asymptomatic hiv', 'hiv infection status', 'hiv status'],
  },
  {
    icd10_cm: 'Z66',
    name: 'Do not resuscitate',
    system: 'status',
    synonyms: ['dnr', 'do not resuscitate', 'dnr order', 'do not resuscitate order'],
  },

  // Batch 5 — personal history of an infectious disease. "I had it" is not the
  // disease's own code: the acute code would say the person has it now.
  {
    icd10_cm: 'Z86.11',
    name: 'Personal history of tuberculosis',
    system: 'infectious',
    synonyms: [
      'history of tuberculosis',
      'history of tb',
      'past tuberculosis',
      'treated for tuberculosis',
    ],
  },
  {
    icd10_cm: 'Z86.15',
    name: 'Personal history of latent tuberculosis infection',
    system: 'infectious',
    synonyms: [
      'history of latent tuberculosis',
      'history of latent tb',
      'treated for latent tb',
      'latent tb infection history',
    ],
  },
  {
    icd10_cm: 'Z86.16',
    name: 'Personal history of COVID-19',
    system: 'infectious',
    synonyms: ['history of covid', 'history of covid-19', 'had covid', 'past covid infection'],
  },
  {
    icd10_cm: 'Z86.14',
    name: 'Personal history of Methicillin resistant Staphylococcus aureus infection',
    system: 'infectious',
    synonyms: ['history of mrsa', 'past mrsa', 'had mrsa', 'previous mrsa infection'],
  },
  {
    icd10_cm: 'Z86.13',
    name: 'Personal history of malaria',
    system: 'infectious',
    synonyms: ['history of malaria', 'past malaria', 'had malaria'],
  },

  // Batch 6 — personal history of the circulatory events a carrier asks about
  // by name, because "have you ever had" is the question and the answer is a
  // history code.
  {
    icd10_cm: 'Z86.73',
    name: 'Personal history of transient ischemic attack (TIA), and cerebral infarction without residual deficits',
    system: 'neurological',
    synonyms: [
      'history of tia',
      'history of transient ischemic attack',
      'history of stroke',
      'history of mini stroke',
      'past stroke',
      'previous stroke',
    ],
  },
  {
    icd10_cm: 'Z86.711',
    name: 'Personal history of pulmonary embolism',
    system: 'cardiovascular',
    synonyms: [
      'history of pulmonary embolism',
      'history of pulmonary embolus',
      'past pulmonary embolism',
      'treated for pulmonary embolism',
    ],
  },
  {
    // The generic "blood clots" a person states lands here: the more specific
    // pulmonary-embolism row above is what a named PE resolves to, and Z86.711
    // excludes it from this one.
    icd10_cm: 'Z86.718',
    name: 'Personal history of other venous thrombosis and embolism',
    system: 'cardiovascular',
    synonyms: [
      'history of dvt',
      'history of deep vein thrombosis',
      'history of blood clots',
      'history of venous thrombosis',
      'history of blood clot',
    ],
  },
  {
    icd10_cm: 'Z86.74',
    name: 'Personal history of sudden cardiac arrest',
    system: 'cardiovascular',
    synonyms: [
      'history of cardiac arrest',
      'history of sudden cardiac arrest',
      'survived a cardiac arrest',
      'survived cardiac arrest',
    ],
  },
  {
    icd10_cm: 'Z86.72',
    name: 'Personal history of thrombophlebitis',
    system: 'cardiovascular',
    synonyms: ['history of thrombophlebitis', 'past thrombophlebitis'],
  },

  // Batch 7 — personal history of cancer and of the metabolic row a pregnancy
  // questionnaire turns on.
  {
    icd10_cm: 'Z85.3',
    name: 'Personal history of malignant neoplasm of breast',
    system: 'oncologic',
    synonyms: [
      'history of breast cancer',
      'breast cancer survivor',
      'past breast cancer',
      'treated for breast cancer',
    ],
  },
  {
    icd10_cm: 'Z85.038',
    name: 'Personal history of other malignant neoplasm of large intestine',
    system: 'oncologic',
    synonyms: [
      'history of colon cancer',
      'history of bowel cancer',
      'colon cancer survivor',
      'treated for colon cancer',
    ],
  },
  {
    icd10_cm: 'Z85.820',
    name: 'Personal history of malignant melanoma of skin',
    system: 'oncologic',
    synonyms: ['history of melanoma', 'melanoma survivor', 'past melanoma', 'melanoma removed'],
  },
  {
    icd10_cm: 'Z85.9',
    name: 'Personal history of malignant neoplasm, unspecified',
    system: 'oncologic',
    synonyms: ['history of cancer', 'cancer survivor', 'past cancer', 'treated for cancer'],
  },
  {
    icd10_cm: 'Z86.32',
    name: 'Personal history of gestational diabetes',
    system: 'metabolic',
    synonyms: [
      'history of gestational diabetes',
      'past gestational diabetes',
      'had gestational diabetes',
      'diabetes in pregnancy history',
    ],
  },

  // Batch 8 — personal history of the mental-health rows and the drug allergy,
  // the two areas where a carrier's questionnaire and this product's own
  // subject matter overlap most directly.
  {
    icd10_cm: 'Z86.51',
    name: 'Personal history of combat and operational stress reaction',
    system: 'mental_health',
    synonyms: [
      'history of combat stress',
      'combat stress reaction history',
      'history of operational stress',
    ],
  },
  {
    icd10_cm: 'Z86.59',
    name: 'Personal history of other mental and behavioral disorders',
    system: 'mental_health',
    synonyms: [
      'history of depression',
      'history of anxiety',
      'history of mental illness',
      'treated for depression',
    ],
  },
  {
    // The code chapter files this as a *status* rather than a disease, and the
    // canonical name says so — a drug allergy is a fact about the person that
    // every medical history asks for, and no body system owns it.
    icd10_cm: 'Z88.0',
    name: 'Allergy status to penicillin',
    system: 'status',
    synonyms: ['penicillin allergy', 'allergic to penicillin', 'penicillin hypersensitivity'],
  },
  {
    icd10_cm: 'Z86.61',
    name: 'Personal history of infections of the central nervous system',
    system: 'neurological',
    synonyms: [
      'history of meningitis',
      'history of encephalitis',
      'past meningitis',
      'treated for meningitis',
    ],
  },
  {
    icd10_cm: 'Z91.49',
    name: 'Other personal history of psychological trauma, not elsewhere classified',
    system: 'mental_health',
    synonyms: [
      'history of psychological trauma',
      'history of childhood trauma',
      // 'history of abuse', 'abused as a child' and 'history of childhood abuse'
      // moved to the Z62.81/Z91.41 rows in 1.13.0: the first is claimed by two
      // rows and needs a setting marker, the others name childhood and belong to
      // Z62.819. A trauma that is not named as abuse stays here.
    ],
  },
  // ── 1.13.0 — the Chapter XXI closure: the ten rows the sweep had gated ────
  // The two deferrals this release closes. Both splits run along an axis the
  // person's words carry — intent, and setting — so each pair shares the bare
  // phrase and separates by a `words` marker. Order inside a pair is part of the
  // contract: the row that reads the marker more specifically is declared first,
  // and a phrase that witnesses both sets resolves to it (pinned by a test).
  {
    icd10_cm: 'Z91.51',
    name: 'Personal history of suicidal behavior',
    system: 'mental_health',
    synonyms: [
      'history of suicidal behavior',
      'history of attempted suicide',
      'previous suicide attempt',
      // The code's own inclusion terms.
      'history of parasuicide',
      'history of self poisoning',
      // Shared with Z91.52: the parent Z91.5 title, which the two members split
      // by intent and which neither may claim without the person naming it.
      'history of self harm',
    ],
    appliesWhen: { words: ['suicid', 'parasuicide', 'self poison'] },
  },
  {
    icd10_cm: 'Z91.52',
    name: 'Personal history of nonsuicidal self-harm',
    system: 'mental_health',
    synonyms: [
      'history of self harm',
      'history of cutting',
      'history of self mutilation',
      'history of self injury',
      // Inclusion terms: the wording that names the intent (or its absence) is
      // what separates this row from Z91.51, so the code's own phrases lead.
      'history of nonsuicidal self injury',
      'self inflicted injury without suicidal intent',
    ],
    appliesWhen: {
      words: ['nonsuicidal', 'self mutilation', 'self injury', 'self inflicted', 'cutting'],
    },
  },
  {
    icd10_cm: 'Z62.810',
    name: 'Personal history of physical and sexual abuse in childhood',
    system: 'psychosocial',
    synonyms: [
      'physical abuse as a child',
      'sexual abuse as a child',
      'physically and sexually abused as a child',
      'beaten as a child',
      'molested as a child',
    ],
  },
  {
    icd10_cm: 'Z62.811',
    name: 'Personal history of psychological abuse in childhood',
    system: 'psychosocial',
    synonyms: [
      'emotional abuse as a child',
      'psychological abuse as a child',
      'verbally abused as a child',
    ],
  },
  {
    icd10_cm: 'Z62.812',
    name: 'Personal history of neglect in childhood',
    system: 'psychosocial',
    synonyms: ['neglected as a child', 'childhood neglect', 'history of childhood neglect'],
  },
  {
    icd10_cm: 'Z62.819',
    name: 'Personal history of unspecified abuse in childhood',
    system: 'psychosocial',
    synonyms: [
      'abused as a child',
      'childhood abuse',
      'history of childhood abuse',
      'history of child abuse',
      'history of being victim of child abuse',
      'abused by my parents',
      'my parents abused me',
      'abusive parenting',
      // Shared with Z91.419 — the phrase of unstated setting, which the codebook
      // gives no home to. Declared first so a phrase naming both settings (rare,
      // and never stated plainly) resolves here rather than nowhere.
      'history of abuse',
    ],
    appliesWhen: {
      words: [
        'childhood',
        'as a child',
        'child abuse',
        'growing up',
        'when i was young',
        'my parents',
        'abusive parenting',
      ],
    },
  },
  {
    icd10_cm: 'Z91.410',
    name: 'Personal history of adult physical and sexual abuse',
    system: 'psychosocial',
    synonyms: [
      'physical abuse as an adult',
      'sexual abuse as an adult',
      'physically and sexually abused as an adult',
      'raped as an adult',
      'assaulted by my partner',
      'beaten by my partner',
    ],
  },
  {
    icd10_cm: 'Z91.411',
    name: 'Personal history of adult psychological abuse',
    system: 'psychosocial',
    synonyms: [
      'emotional abuse as an adult',
      'psychological abuse as an adult',
      'emotionally abused by my partner',
      'verbally abused by my partner',
    ],
  },
  {
    icd10_cm: 'Z91.412',
    name: 'Personal history of adult neglect',
    system: 'psychosocial',
    synonyms: [
      'neglected as an adult',
      'adult neglect',
      'neglected by my partner',
      'neglected by my carer',
    ],
  },
  {
    icd10_cm: 'Z91.419',
    name: 'Personal history of unspecified adult abuse',
    system: 'psychosocial',
    synonyms: [
      'abused as an adult',
      'adult abuse',
      'history of adulthood abuse',
      'domestic abuse',
      'domestic violence',
      // 'abused by my partner', 'my partner abused me' and 'history of
      // intimate partner abuse' moved to the Z62.815/Z91.414 pair in 1.14.0.
      // The first two name an intimate partner — 1.13.0 gave them to this row
      // only because the specific row did not exist yet — and the third is
      // that pair's shared wording now, asserting neither setting on its own.
      'abused by my ex',
      'history of elder abuse',
      // Shared with Z62.819 — see the note on that row. Unwitnessed, it resolves
      // to neither row rather than to a setting the person did not state.
      'history of abuse',
    ],
    appliesWhen: {
      words: [
        'as an adult',
        'adult',
        'adulthood',
        'domestic',
        // 'intimate partner' was this row's witness of adulthood in 1.13.0,
        // when no intimate-partner row existed. It moved to Z91.414 with the
        // wording it witnessed; left here, it would let this row keep claiming
        // the phrase the new pair owns.
        'my partner',
        'my ex',
        'my husband',
        'my wife',
        'my spouse',
        'my boyfriend',
        'my girlfriend',
        'my carer',
        'elder',
      ],
    },
  },
  // ── 1.14.0 — the rest of the abuse family, completed ──────────────────────
  // The 1.13.0 release mapped the family's *unspecified* members and left the
  // named kinds recorded as deferrals; this release adds the kinds. There are
  // three pairs, and the codebook decides each one's shape rather than the
  // family being made uniform: the financial and intimate-partner pairs are
  // setting-qualified in both titles ("child..."/"adult..."), so each shares
  // its generic wording with disjoint markers exactly the way the abuse pair
  // does; the forced-labor pair is not, and does not — see the Z91.42 row.
  {
    icd10_cm: 'Z62.813',
    name: 'Personal history of forced labor or sexual exploitation in childhood',
    system: 'psychosocial',
    synonyms: [
      'forced labor as a child',
      'forced labor in childhood',
      'childhood forced labor',
      'trafficked as a child',
      'sexual exploitation as a child',
      'sexually exploited as a child',
      // The lay phrasings the probe surfaced as disclosures: "I was forced to
      // work as a child", "I was forced into labor". Both are gated (their
      // bare forms are the terms), and the bare forms are the Z91.42 row's.
      'forced to work as a child',
      'forced into labor as a child',
      // The long forms are declared rather than left to the marker residual,
      // because the wording they would strip to ("forced labor") belongs to
      // Z91.42 outright — it is not a shared generic this row could claim.
      // The British spelling "forced labour" is not declared here: the spelling
      // variant mechanism reaches it from "forced labor" wherever the word
      // occurs, which is what replaced the duplicated aliases in 1.15.0.
      'history of forced labor as a child',
    ],
  },
  {
    icd10_cm: 'Z91.42',
    name: 'Personal history of forced labor or sexual exploitation',
    system: 'psychosocial',
    synonyms: [
      'forced labor',
      'trafficked',
      'sex trafficking',
      'sexual exploitation',
      // The bare lay forms; the childhood row declares the marked ones.
      'forced to work',
      'forced into labor',
    ],
  },
  {
    icd10_cm: 'Z62.814',
    name: 'Personal history of child financial abuse',
    system: 'psychosocial',
    synonyms: [
      'financial abuse as a child',
      'financially abused as a child',
      'childhood financial abuse',
      // Shared with Z91.413 — the wording of unstated setting, which neither
      // member's title names. Unwitnessed it resolves to neither row.
      'financial abuse',
      'history of financial abuse',
    ],
    appliesWhen: {
      words: ['childhood', 'as a child', 'growing up', 'when i was young', 'my parents'],
    },
  },
  {
    icd10_cm: 'Z91.413',
    name: 'Personal history of adult financial abuse',
    system: 'psychosocial',
    synonyms: [
      'financial abuse as an adult',
      'financially abused as an adult',
      'adult financial abuse',
      'financial abuse by my partner',
      'financially abused by my partner',
      // Shared with Z62.814 — see the note on that row.
      'financial abuse',
      'history of financial abuse',
    ],
    appliesWhen: {
      words: [
        'adult',
        'as an adult',
        'adulthood',
        'my partner',
        'my husband',
        'my wife',
        'my spouse',
        'my boyfriend',
        'my girlfriend',
      ],
    },
  },
  {
    icd10_cm: 'Z62.815',
    name: 'Personal history of intimate partner abuse in childhood',
    system: 'psychosocial',
    synonyms: [
      'intimate partner abuse as a child',
      'intimate partner abuse in childhood',
      'abused by my partner as a child',
      // Shared with Z91.414 — the pair was split the same way the abuse pair
      // was, and the bare wording names neither setting.
      'intimate partner abuse',
      'history of intimate partner abuse',
    ],
    appliesWhen: {
      words: ['childhood', 'as a child', 'growing up', 'when i was young'],
    },
  },
  {
    icd10_cm: 'Z91.414',
    name: 'Personal history of adult intimate partner abuse',
    system: 'psychosocial',
    synonyms: [
      'intimate partner abuse as an adult',
      'intimate partner abuse in adulthood',
      // Both moved off Z91.419 in this release: the unspecified adult row had
      // them only because this row did not exist.
      'abused by my partner',
      'my partner abused me',
      // Shared with Z62.815 — see the note on that row.
      'intimate partner abuse',
      'history of intimate partner abuse',
    ],
    appliesWhen: {
      words: [
        'adult',
        'as an adult',
        'adulthood',
        'my partner',
        'my husband',
        'my wife',
        'my spouse',
        'my boyfriend',
        'my girlfriend',
      ],
    },
  },
];

/**
 * Normalizes stated condition text for exact alias matching.
 *
 * Deliberately conservative: lowercase, decompose accents, drop apostrophes,
 * unify separators/punctuation, and collapse whitespace. It does not stem,
 * spell-correct, or expand — anything not literally in the alias index stays
 * unmapped rather than being guessed at. Apostrophes are removed (not
 * preserved) so "Crohn's disease" matches the curated "crohns disease" alias.
 */
export function normalizeConditionText(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      // Drop combining diacritics so "sjögren" matches the curated "sjogren"
      .replace(/[\u0300-\u036f]/g, '')
      // Apostrophes disappear rather than becoming a separator
      .replace(/['\u2018\u2019\u02bc]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(a|an|the)\s+/, '')
  );
}

/**
 * Declared spelling variants — the one place a British/American orthography
 * difference is written down.
 *
 * Each group lists the interchangeable spellings of a single word. An alias is
 * claimed in every declared spelling of it (word by word, plural carried
 * across), so a word the curated list carries both ways is curated **once**
 * rather than duplicated in `synonyms` — which is what `['anemia', 'anaemia']`
 * and the forty other pairs like it used to be. The mechanism also reaches the
 * same word wherever else it appears in an alias ("sickle cell anemia" is
 * reached as "sickle cell anaemia" without a second entry), which is the point
 * of declaring the spelling rather than listing the phrase.
 *
 * Two properties keep it honest. It is word-declared, never a blanket rewrite
 * (`-our` → `-or`, `-ae-` → `-e-`): a token is substituted only when its exact
 * spelling appears here, so "your" is never folded into "yor" and "four" is
 * never read as "for". And a group is admitted by a rule rather than by taste —
 * every word declared below is one the curated alias list already wrote both
 * ways, so the declaration replaces duplication instead of inventing coverage
 * the vocabulary never had.
 */
export const SPELLING_VARIANT_GROUPS: readonly (readonly string[])[] = [
  // -ae- / -e-
  ['anemia', 'anaemia'],
  ['apnea', 'apnoea'],
  ['celiac', 'coeliac'],
  ['hemangioma', 'haemangioma'],
  ['hemochromatosis', 'haemochromatosis'],
  ['hemophilia', 'haemophilia'],
  ['hemorrhage', 'haemorrhage'],
  ['hemorrhoid', 'haemorrhoid'],
  ['hypercalcemia', 'hypercalcaemia'],
  ['hyperkalemia', 'hyperkalaemia'],
  ['hypertriglyceridemia', 'hypertriglyceridaemia'],
  ['hyperuricemia', 'hyperuricaemia'],
  ['hyponatremia', 'hyponatraemia'],
  ['ischemic', 'ischaemic'],
  ['leukemia', 'leukaemia'],
  ['polycythemia', 'polycythaemia'],
  ['thalassemia', 'thalassaemia'],
  // -oe- / -e-
  ['dysmenorrhea', 'dysmenorrhoea'],
  ['edema', 'oedema'],
  ['esophageal', 'oesophageal'],
  ['esophagus', 'oesophagus'],
  ['lymphedema', 'lymphoedema'],
  ['seborrheic', 'seborrhoeic'],
  // -or / -our
  ['labor', 'labour'],
  ['tumor', 'tumour'],
  // -er / -re
  ['goiter', 'goitre'],
];

/** Declared word → its other spellings, built once at module load. */
const SPELLING_VARIANTS: ReadonlyMap<string, readonly string[]> = new Map(
  SPELLING_VARIANT_GROUPS.flatMap((group) =>
    group.map((word) => [word, group.filter((other) => other !== word)] as const),
  ),
);

/**
 * The declared alternative spellings of one token. A trailing "s" is carried
 * across, so a declared singular spelling covers its plural — that is how
 * `haemorrhoid`/`hemorrhoid` reaches "haemorrhoids" without declaring the plural
 * as its own word.
 */
function variantTokens(token: string): readonly string[] {
  const direct = SPELLING_VARIANTS.get(token);
  if (direct) return direct;
  if (token.endsWith('s')) {
    const variants = SPELLING_VARIANTS.get(token.slice(0, -1));
    if (variants) return variants.map((word) => `${word}s`);
  }
  return [];
}

/**
 * The declared variants of an alias — the phrase rewritten in each declared
 * spelling, combining the variants of every declared word in it. Returned
 * normalized and without the alias itself. Exported so the release that deleted
 * the duplicated `synonyms` can be shown to still resolve every spelling it
 * removed, and so a test can prove the mechanism rewrites only declared words.
 */
export function spellingVariantKeys(alias: string): string[] {
  const tokens = normalizeConditionText(alias).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const alternatives = tokens.map(variantTokens);
  if (alternatives.every((spellings) => spellings.length === 0)) return [];

  let keys = [''];
  tokens.forEach((token, index) => {
    const options = [token, ...alternatives[index]];
    keys = keys.flatMap((prefix) =>
      options.map((option) => (prefix ? `${prefix} ${option}` : option)),
    );
  });

  const base = tokens.join(' ');
  return [...new Set(keys)].filter((key) => key !== base);
}

/**
 * Every normalized key an alias claims: the alias itself plus each declared
 * spelling variant of it. The one entry point both the index and the ambiguity
 * check build from, so a variant is claimed — and checked — exactly where a
 * curated alias is.
 */
function aliasKeys(alias: string): string[] {
  const base = normalizeConditionText(alias);
  if (!base) return [];
  return [base, ...spellingVariantKeys(alias)];
}

/**
 * Alias index (normalized alias → the entries that claim it, in vocabulary
 * order). Built once at module load. Also registers the canonical name, the
 * code, the declared spelling variants of each alias, and a naive plural of
 * every key (unless it already ends in "s"), since all of them come from the
 * curated list and can never introduce an uncurated match.
 *
 * A curated alias beats a derived plural: plurals are derived after every
 * entry has registered its own wordings, so a plural is only ever added where
 * no curated alias claimed that key.
 *
 * Most keys have exactly one claimant, which is why resolution is unchanged for
 * them. A key with several claimants is a qualifier-split family (sex / site):
 * the FIRST match in vocabulary order wins deterministically, and a claim set
 * that is not provably disjoint is flagged by `findDuplicateAliases()` (locked
 * by test) rather than resolved silently at runtime.
 */
function buildAliasIndex(): Map<string, CanonicalCondition[]> {
  const index = new Map<string, CanonicalCondition[]>();
  const claim = (key: string, condition: CanonicalCondition) => {
    if (!key) return;
    const claimants = index.get(key);
    if (claimants) {
      if (!claimants.includes(condition)) claimants.push(condition);
    } else {
      index.set(key, [condition]);
    }
  };

  for (const condition of CANONICAL_CONDITIONS) {
    for (const alias of [condition.name, condition.icd10_cm, ...condition.synonyms]) {
      for (const key of aliasKeys(alias)) claim(key, condition);
    }
  }

  // Naive plural of a curated alias ("migraine" → "migraines"), inheriting
  // every claimant of its singular so a split family stays split. Never applied
  // to an alias that already ends in "s" ("diabetes", "ms"), so no junk
  // variants like "diabetesss" enter the index.
  for (const [key, claimants] of [...index.entries()]) {
    if (key.endsWith('s')) continue;
    const plural = `${key}s`;
    if (!index.has(plural)) index.set(plural, claimants.slice());
  }

  return index;
}

/** Escapes a literal for the site-word patterns. */
function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The site words any row declares, longest first so a multi-word value is tried
 * before a shorter one that could match inside it.
 */
const DECLARED_SITES: readonly string[] = [
  ...new Set(CANONICAL_CONDITIONS.flatMap((condition) => condition.appliesWhen?.site ?? [])),
].sort((a, b) => b.length - a.length || a.localeCompare(b));

/**
 * The marker words any row declares, longest first — the same treatment the site
 * words get, because a marker is reachable the same way: it is what a marked
 * phrase strips to arrive at the wording its rows share.
 */
const DECLARED_MARKERS: readonly string[] = [
  ...new Set(CANONICAL_CONDITIONS.flatMap((condition) => condition.appliesWhen?.words ?? [])),
].sort((a, b) => b.length - a.length || a.localeCompare(b));

/**
 * Connectors and possessives a qualifier value leaves behind when it is removed
 * from a phrase ("calculus in my bladder" → "calculus"). Qualifier values
 * themselves are never filler, so a side-stated lump keeps its side — or a
 * childhood-stated abuse its setting — and cannot collapse onto the side- or
 * setting-free row.
 */
const QUALIFIER_FILLER_WORDS = new Set([
  'a',
  'an',
  'the',
  'my',
  'his',
  'her',
  'their',
  'our',
  'your',
  'in',
  'on',
  'of',
  'at',
  'to',
  'from',
  'into',
  'near',
  'under',
  'around',
]);

/** True when the phrase names this value at a word start ("ureter" → "ureteric"). */
function namesSite(normalizedPhrase: string, value: string): boolean {
  return new RegExp(`\\b${escapeRegExpLiteral(value)}`).test(normalizedPhrase);
}

/**
 * The phrase with one occurrence of a qualifier value — a site or a marker —
 * removed and its connectors dropped, or null when nothing usable is left. This
 * is what makes the spelled-out codebook forms reachable: "ureteric calculus"
 * strips to "calculus", which the site-qualified rows claim, and "history of
 * abuse as a child" strips to "history of abuse", the wording both abuse rows
 * claim and neither can resolve alone.
 */
function residualAfterQualifier(normalizedPhrase: string, value: string): string | null {
  const tokens = normalizedPhrase.split(' ');
  const valueTokens = value.split(' ');
  for (let start = 0; start + valueTokens.length <= tokens.length; start++) {
    // Word-prefix, like namesSite(): the declared site "ureter" strips
    // "ureteric" and "ureters", so one declared value covers its adjectives.
    const matches = valueTokens.every((token, offset) => tokens[start + offset].startsWith(token));
    if (!matches) continue;
    const residual = withoutFiller(
      tokens.filter((_, index) => index < start || index >= start + valueTokens.length).join(' '),
    );
    return residual.length > 0 ? residual : null;
  }
  return null;
}

/** The phrase with its connectors and possessives removed. */
function withoutFiller(normalizedPhrase: string): string {
  return normalizedPhrase
    .split(' ')
    .filter((token) => !QUALIFIER_FILLER_WORDS.has(token))
    .join(' ');
}

/**
 * Site-parameterized aliases: the residual of every synonym of a site-qualified
 * row, so a phrase that names the site resolves even though the exact wording
 * was never curated. Rows keep re-checking their own site against the original
 * phrase, so a residual can never land on the wrong organ.
 */
function buildSiteAliasIndex(): Map<string, CanonicalCondition[]> {
  const index = new Map<string, CanonicalCondition[]>();
  for (const condition of CANONICAL_CONDITIONS) {
    const sites = condition.appliesWhen?.site;
    if (!sites) continue;
    for (const synonym of condition.synonyms) {
      const key = normalizeConditionText(synonym);
      if (!key) continue;
      // A synonym that names its own site registers its residual ("bladder
      // stones" → "stones"); one that does not ("calculus") registers as itself,
      // which is the form a site-bearing phrase's residual lands on.
      const siteInKey = sites.find((site) => namesSite(key, site));
      const target = siteInKey ? residualAfterQualifier(key, siteInKey) : key;
      if (!target) continue;
      const claimants = index.get(target);
      if (claimants) {
        if (!claimants.includes(condition)) claimants.push(condition);
      } else {
        index.set(target, [condition]);
      }
    }
  }
  return index;
}

/**
 * Marker-shared aliases: the *generic* wording of every marker-qualified row —
 * the wording that names no marker of its own ("history of abuse", "history of
 * self harm") — so a phrase that does name one strips down to it ("history of
 * abuse as a child" → "history of abuse") and the rows re-check their own marker
 * against the original phrase. Only the generic wording registers: a marker
 * stripped out of a longer alias leaves a fragment ("history of child abuse"
 * minus "child abuse" is just "history"), and a fragment that resolves on its
 * own would be a mapping nobody curated.
 *
 * The generic wording registers twice when it carries connectors — as written
 * and with them dropped — because the residual lookup strips them the way a site
 * residual does ("history of abuse as a child" leaves "history abuse"). A
 * one-word site value never needed that second form; a shared phrase does, and
 * this is the only place the two dimensions differ.
 */
function buildMarkerAliasIndex(): Map<string, CanonicalCondition[]> {
  const index = new Map<string, CanonicalCondition[]>();
  for (const condition of CANONICAL_CONDITIONS) {
    const markers = condition.appliesWhen?.words;
    if (!markers) continue;
    for (const synonym of condition.synonyms) {
      const key = normalizeConditionText(synonym);
      if (!key || markers.some((marker) => namesSite(key, marker))) continue;
      for (const registration of new Set([key, withoutFiller(key)])) {
        if (!registration) continue;
        const claimants = index.get(registration);
        if (claimants) {
          if (!claimants.includes(condition)) claimants.push(condition);
        } else {
          index.set(registration, [condition]);
        }
      }
    }
  }
  return index;
}

const aliasIndex = buildAliasIndex();
const siteAliasIndex = buildSiteAliasIndex();
const markerAliasIndex = buildMarkerAliasIndex();
const codeIndex = new Map<string, CanonicalCondition>(
  CANONICAL_CONDITIONS.map((condition) => [condition.icd10_cm, condition]),
);

/**
 * The same lookup keyed by normalized text, so a stated code resolves the way a
 * stated name does. Codes short-circuit the qualifier check: the code names the
 * row outright, so "N20.0" resolves without the phrase naming a kidney the way
 * the wording "calculus" now has to.
 */
const normalizedCodeIndex = new Map<string, CanonicalCondition>(
  CANONICAL_CONDITIONS.map((condition) => [normalizeConditionText(condition.icd10_cm), condition]),
);

/**
 * True when the phrase satisfies every dimension the qualifier declares. Sex
 * comes only from the context (never inferred from prose); a site and a marker
 * have to be in the person's own words. An absent or unknown value fails rather
 * than picking a sibling.
 */
function qualifierMatches(
  qualifier: ConditionQualifier | undefined,
  normalizedPhrase: string,
  context: ConditionResolutionContext,
): boolean {
  if (!qualifier) return true;
  if (qualifier.sex && !(context.sex && qualifier.sex.includes(context.sex))) return false;
  if (qualifier.site && !qualifier.site.some((site) => namesSite(normalizedPhrase, site))) {
    return false;
  }
  if (qualifier.words && !qualifier.words.some((word) => namesSite(normalizedPhrase, word))) {
    return false;
  }
  return true;
}

/** First matching claimant in vocabulary order; null when none applies. */
function resolveClaimants(
  claimants: readonly CanonicalCondition[] | undefined,
  normalizedPhrase: string,
  context: ConditionResolutionContext,
): CanonicalCondition | null {
  if (!claimants) return null;
  for (const claimant of claimants) {
    if (qualifierMatches(claimant.appliesWhen, normalizedPhrase, context)) return claimant;
  }
  return null;
}

/**
 * Two rows' qualifiers are disjoint when they can never apply to the same
 * person and phrase — the condition that lets sibling rows share an alias
 * instead of being flagged as an ambiguity. A qualifier on only one side, or
 * qualifiers on different dimensions, are not provably disjoint.
 */
function qualifiersAreDisjoint(a?: ConditionQualifier, b?: ConditionQualifier): boolean {
  if (!a || !b) return false;
  if (a.sex && b.sex && !a.sex.some((sex) => b.sex!.includes(sex))) return true;
  if (a.site && b.site) {
    const disjoint = !a.site.some((site) => b.site!.includes(site));
    // Site values are matched at a word start, so "breast" and "left breast"
    // would both match "left breast" — only outright different words are safe.
    if (disjoint) return true;
  }
  if (a.words && b.words) {
    const disjoint = !a.words.some((word) => b.words!.includes(word));
    // Same word-start caveat as sites: "child" and "childhood" would both
    // match "childhood", so sibling markers have to be outright different
    // values. Marker sets being disjoint is what makes the shared alias safe;
    // a phrase that names both sets is a judgement call the resolver makes
    // deterministically (first declared sibling wins) rather than silently.
    if (disjoint) return true;
  }
  return false;
}

/**
 * Reports aliases claimed by more than one vocabulary entry whose claims are
 * NOT made disjoint by a declared qualifier (build hygiene). Exposed so a test
 * can assert the vocabulary stays unambiguous.
 */
export function findDuplicateAliases(): string[] {
  const seen = new Map<string, CanonicalCondition[]>();
  for (const condition of CANONICAL_CONDITIONS) {
    for (const alias of [condition.name, condition.icd10_cm, ...condition.synonyms]) {
      // Derived spelling variants are real claims in the index, so ambiguity is
      // checked across them too rather than only across curated aliases.
      for (const key of aliasKeys(alias)) {
        const claimants = seen.get(key) ?? [];
        if (!claimants.includes(condition)) claimants.push(condition);
        seen.set(key, claimants);
      }
    }
  }
  return [...seen.entries()]
    .filter(([, claimants]) => {
      if (new Set(claimants.map((c) => c.icd10_cm)).size < 2) return false;
      return claimants.some((claimant, index) =>
        claimants
          .slice(index + 1)
          .some((other) => !qualifiersAreDisjoint(claimant.appliesWhen, other.appliesWhen)),
      );
    })
    .map(([alias]) => alias);
}

/**
 * Resolves one stated condition to a canonical vocabulary entry.
 *
 * Exact (normalized) match only — returns null rather than guessing. The
 * context may choose between qualifier-split siblings (a sex from the profile),
 * and a site word in the person's own words may reach a site-qualified row, but
 * neither ever widens what the curated list already claims.
 */
export function findCanonicalCondition(
  stated: string,
  context: ConditionResolutionContext = {},
): CanonicalCondition | null {
  const key = normalizeConditionText(stated);
  if (!key) return null;

  const byCode = normalizedCodeIndex.get(key);
  if (byCode) return byCode;

  const direct = resolveClaimants(aliasIndex.get(key), key, context);
  if (direct) return direct;

  for (const site of DECLARED_SITES) {
    if (!namesSite(key, site)) continue;
    const residual = residualAfterQualifier(key, site);
    if (!residual) continue;
    const viaSite = resolveClaimants(siteAliasIndex.get(residual), key, context);
    if (viaSite) return viaSite;
  }

  // The same treatment for a marker, which is what makes the two Chapter XXI
  // splits qualifier-aware rather than alias-precise: "history of abuse as a
  // child" reaches the wording both abuse rows claim, and only the row whose
  // marker the phrase actually names can take it.
  for (const marker of DECLARED_MARKERS) {
    if (!namesSite(key, marker)) continue;
    const residual = residualAfterQualifier(key, marker);
    if (!residual) continue;
    const viaMarker = resolveClaimants(markerAliasIndex.get(residual), key, context);
    if (viaMarker) return viaMarker;
  }

  return null;
}

/**
 * Maps the profile's gender field onto the codebook's sex split. Only an
 * explicit male/female answer is usable: "other", "prefer_not_to_say" and an
 * absent answer are all unknown, and unknown defers a sex-qualified row rather
 * than inferring which code applies.
 */
export function conditionSexFromGender(gender: string | null | undefined): ConditionSex | null {
  return gender === 'male' || gender === 'female' ? gender : null;
}

/**
 * Looks a vocabulary entry up by ICD-10-CM code (case-insensitive; surrounding
 * whitespace ignored). An unknown or differently-subcoded code returns null —
 * codes are never narrowed or widened to fit.
 */
export function getCanonicalConditionByCode(icd10Cm: string): CanonicalCondition | null {
  return codeIndex.get(icd10Cm.trim().toUpperCase()) ?? null;
}

/** Lists the vocabulary (copy — callers cannot mutate the index). */
export function listCanonicalConditions(): CanonicalCondition[] {
  return CANONICAL_CONDITIONS.slice();
}

/**
 * Free-text search over the vocabulary for internal/broker tooling.
 * Matches canonical names, synonyms, and codes (substring, case-insensitive) —
 * this searches the VOCABULARY only and never a user's stated conditions.
 */
export function searchCanonicalConditions(query: string): CanonicalCondition[] {
  const needle = normalizeConditionText(query);
  if (!needle) return [];
  return CANONICAL_CONDITIONS.filter((condition) => {
    if (condition.icd10_cm.toLowerCase().includes(needle)) return true;
    return [condition.name, ...condition.synonyms].some((alias) =>
      normalizeConditionText(alias).includes(needle),
    );
  });
}

/** Builds a vocabulary-tagged canonical ref from an entry. */
export function toCanonicalRef(condition: CanonicalCondition): CanonicalConditionRef {
  return {
    icd10_cm: condition.icd10_cm,
    name: condition.name,
    system: condition.system,
    vocabulary: CONDITION_VOCABULARY_ID,
    vocabulary_version: CONDITION_VOCABULARY_VERSION,
  };
}

/**
 * Maps stated conditions onto canonical refs without applying a consent gate.
 * INTERNAL to this module and its tests: production callers must use
 * `mapConsentedMedicalConditions()` so the §9.1 gate can never be skipped.
 */
function mapConditions(
  stated: string[],
  context: ConditionResolutionContext = {},
): ConditionMappingResult {
  const canonical: CanonicalConditionRef[] = [];
  const unmapped: string[] = [];
  const seenCodes = new Set<string>();

  for (const entry of stated) {
    if (typeof entry !== 'string') continue;
    const statedText = entry.trim();
    if (statedText.length === 0) continue;

    const match = findCanonicalCondition(statedText, context);
    if (match === null) {
      // Never guess. Keep the user's own words, deduplicated.
      if (!unmapped.includes(statedText)) unmapped.push(statedText);
      continue;
    }
    if (seenCodes.has(match.icd10_cm)) continue;
    seenCodes.add(match.icd10_cm);
    canonical.push(toCanonicalRef(match));
  }

  return {
    vocabulary: CONDITION_VOCABULARY_ID,
    vocabulary_version: CONDITION_VOCABULARY_VERSION,
    canonical,
    unmapped,
  };
}

export interface MedicalConsentState {
  medical_consent_affirmed: boolean;
  medical_consent_version: string | null;
}

export interface MapConsentedConditionsInput {
  /** Conditions as stated by the user (verbatim, from the consented flow). */
  medicalConditions: string[];
  /** Consent as recorded on the response/lead — both fields are required. */
  consent: MedicalConsentState;
  /** Live feature-flag state: true = Phase 2 medical capture is closed. */
  healthDataCollectionDisabled: boolean;
  /**
   * The sex the codebook's split rows resolve against, taken from the consented
   * profile's gender via `conditionSexFromGender`. Absent/null means unknown,
   * which defers a sex-qualified row rather than choosing one of its siblings.
   */
  sex?: ConditionSex | null;
}

/**
 * The Phase-2 / §9.1 consent gate, in one place so every entry point that
 * processes a person's stated conditions fails closed identically and the gate
 * cannot drift between them. Today that is `mapConsentedMedicalConditions()`
 * (capture) and `screenConsentedConditions()` in condition-screening.ts
 * (query) — screening a captured profile is still a use of sensitive health
 * data, so it must clear the same gate rather than becoming a side door.
 *
 * Fail-closed — false when ANY of these is true:
 *   - `healthDataCollectionDisabled` (Phase 2 capture not approved/enabled);
 *   - medical consent is not affirmatively given (absent consent is included:
 *     a caller passing null fails closed rather than throwing);
 *   - medical consent has no current version (ambiguous/unversioned consent is
 *     not consent).
 */
export function isMedicalProcessingPermitted(input: {
  consent: MedicalConsentState | null | undefined;
  healthDataCollectionDisabled: boolean;
}): boolean {
  if (input.healthDataCollectionDisabled) return false;
  const consent = input.consent;
  if (!consent || !consent.medical_consent_affirmed) return false;
  if (!consent.medical_consent_version) return false;
  return true;
}

/**
 * The single production capture entry point: maps a consented profile's stated
 * conditions onto canonical refs.
 *
 * Fail-closed — returns null unless `isMedicalProcessingPermitted()` clears and
 * the stated conditions are an array.
 *
 * Callers must treat null as "no medical data may be processed": return no
 * canonical output, store nothing, and log nothing.
 */
export function mapConsentedMedicalConditions(
  input: MapConsentedConditionsInput,
): ConditionMappingResult | null {
  if (!isMedicalProcessingPermitted(input)) return null;
  if (!Array.isArray(input.medicalConditions)) return null;
  if (input.medicalConditions.length === 0) {
    return {
      vocabulary: CONDITION_VOCABULARY_ID,
      vocabulary_version: CONDITION_VOCABULARY_VERSION,
      canonical: [],
      unmapped: [],
    };
  }
  return mapConditions(input.medicalConditions, { sex: input.sex ?? null });
}

/**
 * Groups canonical refs by body system, most-represented first, for internal
 * rollups and broker queries. Pure: no clinical interpretation is added.
 */
export function groupConditionsBySystem(refs: CanonicalConditionRef[]): ConditionSystemGroup[] {
  const groups = new Map<ConditionSystem, Set<string>>();
  for (const ref of refs) {
    const codes = groups.get(ref.system) ?? new Set<string>();
    codes.add(ref.icd10_cm);
    groups.set(ref.system, codes);
  }
  return [...groups.entries()]
    .map(([system, codes]) => ({
      system,
      count: codes.size,
      icd10_cm: [...codes].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.system.localeCompare(b.system));
}
