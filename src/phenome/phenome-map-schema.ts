/**
 * Machine-readable phenome map — schema and rule validator.
 *
 * `docs/phenome-mapping-rules.md` §14 specifies the row schema and §1–§13 the
 * rules a row must satisfy. This module turns both into code: a zod schema for
 * the shape, and `validatePhenomeMap()` for the cross-field rules that a schema
 * cannot express (tier caps, independence, precision gates, mediation, causal
 * language, verification).
 *
 * Why this exists: a map written only as a markdown table cannot be checked.
 * `evidence_tier` in a table is an assertion; `evidence_tier` in a validated
 * row is a claim the build can hold you to. Every rule below cites the rule id
 * it enforces, so a failure names the rule rather than just a field.
 *
 * Two output channels, deliberately separated:
 *
 *   violations       hard rule breaches. A row cannot carry a tier its own
 *                    evidence does not support.
 *   declaredTensions rule/verdict conflicts where the reviewed sources' grades
 *                    disagree with a rule's strict reading. These do NOT fail
 *                    the build — they are recorded in the map's
 *                    `rule_tensions`, and the test asserts the ledger matches
 *                    the actual conflicts in both directions, so a tension can
 *                    neither be hidden nor invented.
 */

import { z } from 'zod';

/** Map identity. Printed on any report derived from the map. */
export const PHENOME_MAP_ID = 'ptsd-phenome-map';
export const PHENOME_MAP_VERSION = '1.1.0';

/** The three source syntheses, keyed as in the rules document. */
export const SOURCE_DOCUMENTS = ['A', 'B', 'C'] as const;
export type SourceDocument = (typeof SOURCE_DOCUMENTS)[number];

/**
 * The §12 domain sweep. Pre-declared before searching, so the map cannot
 * quietly become "the conditions that happened to appear". Every domain needs
 * at least one row, including rows whose verdict is `D`.
 */
export const PHENOME_DOMAINS = [
  { number: 1, key: 'cardiovascular' },
  { number: 2, key: 'cerebrovascular' },
  { number: 3, key: 'metabolic_endocrine' },
  { number: 4, key: 'renal_urinary' },
  { number: 5, key: 'immune_autoimmune' },
  { number: 6, key: 'inflammatory_vascular_intermediates' },
  { number: 7, key: 'neurodegenerative_cognitive' },
  { number: 8, key: 'neurological' },
  { number: 9, key: 'sleep' },
  { number: 10, key: 'respiratory' },
  { number: 11, key: 'gastrointestinal_hepatobiliary' },
  { number: 12, key: 'musculoskeletal_functional_somatic' },
  { number: 13, key: 'oncologic' },
  { number: 14, key: 'hematologic_cellular_aging' },
  { number: 15, key: 'infectious' },
  { number: 16, key: 'mortality' },
  { number: 17, key: 'psychiatric_substance_use' },
  { number: 18, key: 'iatrogenic_treatment_related' },
  { number: 19, key: 'reproductive_transgenerational' },
  { number: 20, key: 'injury_external_causes' },
] as const;

export type PhenomeDomainKey = (typeof PHENOME_DOMAINS)[number]['key'];
export const PHENOME_DOMAIN_NUMBERS = PHENOME_DOMAINS.map((domain) => domain.number);

/** R4 — the three exposure strata, never pooled. */
export const EXPOSURE_STRATA = ['dx', 'prob', 'trauma'] as const;

/** R9 — ascertainment strength, strongest first. */
export const ASCERTAINMENT_GRADES = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;

/** R14 — designs are reported as a set, never reduced to one label. */
export const DESIGNS = [
  'meta-analysis of prospective cohorts',
  'prospective cohort',
  'population-matched retrospective cohort',
  'registry/administrative cohort',
  'case-control',
  'cross-sectional',
  'MR/genetic instrument',
  'interventional',
  'case series',
] as const;

/** R8 — incidence and prevalence are different outcomes. */
export const OUTCOME_KINDS = [
  'incidence',
  'prevalence',
  'intermediate marker',
  'mortality',
] as const;

/** R32 — every edge is directed, and bidirectional edges get two rows. */
export const DIRECTIONS = ['index_to_outcome', 'outcome_to_index'] as const;

/** R2 — the estimator exactly as published. */
export const ESTIMATORS = [
  'HR',
  'OR',
  'RR',
  'prevalence',
  'prevalence ratio',
  'mean difference',
  'g',
  'proportion',
] as const;

/** R19 — magnitude bands. A label, never a verdict. */
export const MAGNITUDE_BANDS = [
  'strong',
  'moderate',
  'modest',
  'marginal',
  'null_or_uncertain',
  'not_applicable',
] as const;

/** R25 — attenuation is a three-state field (plus "no adjusted model"). */
export const ATTENUATION_STATES = [
  'persists',
  'attenuates',
  'eliminated',
  'not_applicable',
] as const;

/** §11 — evidence grading. `X` is refuted, `D` is insufficient. */
export const EVIDENCE_TIERS = ['A', 'B', 'C', 'D', 'X'] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/** R40 — mechanistic tiers. */
export const MECHANISM_TIERS = ['m1', 'm2', 'm3', 'm4', 'none'] as const;

/** R12 — outcome classes, with the minimum lag each is allowed. */
export const OUTCOME_CLASSES = [
  'cardiovascular_clinical',
  'metabolic',
  'functional_somatic',
  'autoimmune',
  'neurodegenerative',
  'mortality',
  'other',
] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

export const MINIMUM_LAG_MONTHS: Record<OutcomeClass, number> = {
  metabolic: 12,
  functional_somatic: 12,
  autoimmune: 12,
  cardiovascular_clinical: 12,
  neurodegenerative: 24,
  // R33: mortality is reported as year 1 and >1 year separately, so the lag is
  // carried by the mortality_window field rather than by a single minimum.
  mortality: 0,
  other: 0,
};

/** R24 — the mandatory adjustment set. */
export const MANDATORY_ADJUSTMENT_SET = [
  'age',
  'sex',
  'calendar_era',
  'socioeconomic_position',
  'smoking',
  'adiposity',
  'substance_use',
  'psychiatric_comorbidity',
  'head_injury',
  'medication_exposure',
] as const;

/** Three-state covariate adjustment. `not_reported` is a statement, not a zero. */
export const COVARIATE_STATES = ['yes', 'no', 'not_reported'] as const;

/** R42 — tier and causal language are locked together. */
export const TIER_CAUSAL_PHRASES: Record<EvidenceTier, string[]> = {
  A: ['is an established risk factor for', 'is an established risk factor'],
  B: ['is associated with an increased risk of', 'is a probable risk factor for'],
  C: ['has been associated with', 'evidence is suggestive but limited that'],
  D: ['insufficient evidence to determine', 'no studies identified'],
  X: ['the evidence does not support'],
};

/** R41/R42 — causal terms require an m4 instrument or m3 intervention *and* A-tier epidemiology. */
export const FORBIDDEN_CAUSAL_TERMS = [
  'causes',
  'caused',
  'causal agent',
  'causally',
  'definitively',
  'proven',
  'proves',
];

/**
 * R3 — the sources' own adjectives, entered as findings rather than as evidence.
 * These are forbidden anywhere in the map: "enter the estimate, not the
 * adjective."
 */
export const FORBIDDEN_SOURCE_ADJECTIVES = [
  'unequivocally',
  'staggering',
  'profound',
  'profoundly',
  'definitive link',
];

/** R1 — verification state. `unverified` is the default and the honest one. */
export const VERIFICATION_STATES = ['verified', 'unverified'] as const;

/** R33 — the acute mortality window is never pooled with long-term follow-up. */
export const MORTALITY_WINDOWS = ['year_1', 'after_year_1'] as const;

/** R37 — effect-modifier dimensions. */
export const SUBGROUP_DIMENSIONS = ['sex', 'age', 'genotype', 'ancestry', 'other'] as const;

const NumericEstimateSchema = z.object({
  /** R2 — the estimator, exactly as published. Never converted. */
  estimator: z.enum(ESTIMATORS),
  /** The number as the source wrote it ("1.55 (1.46–1.77)", "55–61% increase"). */
  raw: z.string().min(1),
  /** Parsed value where a single ratio/percentage exists, else null. */
  value: z.number().nullable().default(null),
  ci_low: z.number().nullable().default(null),
  ci_high: z.number().nullable().default(null),
  /** Which model produced it (least-adjusted, fully-adjusted, or a named model). */
  model_label: z.string().min(1),
  /** R19 — the band, which must agree with the value and CI. */
  magnitude_band: z.enum(MAGNITUDE_BANDS),
});
export type NumericEstimate = z.infer<typeof NumericEstimateSchema>;

const PopulationSchema = z.object({
  name: z.string().min(1),
  /**
   * R16 — the cohort family. Two publications from one data system are one
   * population, and independence is counted from this field.
   */
  independence_group: z.string().min(1),
  n: z.number().nullable().default(null),
  follow_up: z.string().nullable().default(null),
  era: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  sex_distribution: z.string().nullable().default(null),
});

const MediatorSchema = z.object({
  name: z.string().min(1),
  /** R30 — a proportion, or the explicit gap. Never left blank. */
  proportion_mediated: z.string().min(1),
});

const ConflictSchema = z.object({
  source_document: z.enum(SOURCE_DOCUMENTS),
  reported_as: z.string().min(1),
  /** Null when the source reports the conflict as prose or a range, not a number. */
  value: z.number().nullable().default(null),
  /** R44 — an unresolved conflict is recorded as a range, never averaged away. */
  resolved: z.boolean(),
});

const SubgroupSchema = z.object({
  dimension: z.enum(SUBGROUP_DIMENSIONS),
  label: z.string().min(1),
  estimate: NumericEstimateSchema,
  /** R37 — a CI crossing 1 is imprecision, not proof of absence. */
  null_not_absence: z.boolean(),
  modifiers: z.string().nullable().default(null),
});

const ExposureSchema = z.object({
  condition: z.string().min(1),
  /** R4 — mandatory for the index condition; null only for R45 exception rows. */
  stratum: z.enum(EXPOSURE_STRATA).nullable(),
  definition: z.string().min(1),
  ascertainment: z.string().min(1),
  /** R6 — epochs are effect modifiers, not covariates. */
  epoch: z.string().min(1),
});

const OutcomeSchema = z.object({
  name: z.string().min(1),
  /** R11 — ICD-10-CM and/or phecode; null when the outcome is unresolvable. */
  codes: z.array(z.string()).default([]),
  definition: z.string().min(1),
  /** R9 — (a)–(g). */
  ascertainment: z.enum(ASCERTAINMENT_GRADES),
  kind: z.enum(OUTCOME_KINDS),
  /**
   * R9 — whether the outcome is severe (life-threatening or a major clinical
   * event). Required rather than optional, because it is what decides whether
   * screen- or self-report-based ascertainment caps at B or at C.
   */
  severity: z.enum(['severe', 'not_severe']),
});

export const PhenomeRowSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  /** §12 domain number. */
  domain: z.number().int().min(1).max(20),
  outcome_class: z.enum(OUTCOME_CLASSES),
  exposure: ExposureSchema,
  outcome: OutcomeSchema,
  direction: z.enum(DIRECTIONS),
  /** Empty only for a `D` row that identified no study to describe (R14/R43). */
  designs: z.array(z.enum(DESIGNS)),
  populations: z.array(PopulationSchema),
  /** R33 — required when the outcome is mortality. */
  mortality_window: z.enum(MORTALITY_WINDOWS).nullable(),
  estimate: z.object({
    /** The estimate the row's tier is graded on. */
    primary: NumericEstimateSchema,
    /** R25 — both models, so attenuation is inspectable rather than asserted. */
    least_adjusted: NumericEstimateSchema.nullable(),
    fully_adjusted: NumericEstimateSchema.nullable(),
    attenuation: z.enum(ATTENUATION_STATES),
    /** R20 — events are required for tier A. */
    events: z.number().nullable().default(null),
    events_reported_as: z.string().nullable().default(null),
    /** R21 — mandatory alongside every relative estimate. */
    absolute_risk: z.string().min(1),
    /** R22 — a gradient strengthens but never substitutes. */
    dose_response: z.boolean(),
    /** R22 — the gradient, or null when the row reports no dose-response. */
    dose_response_detail: z.string().nullable().default(null),
    /** R15 — pooled estimates disclose studies, N, and heterogeneity. */
    pooled: z
      .object({
        studies: z.number().nullable().default(null),
        total_n: z.number().nullable().default(null),
        heterogeneity_i2: z.string().min(1),
      })
      .nullable(),
  }),
  adjustment_set: z.object({
    /** R24 — how completely the adjustment set is known. */
    completeness: z.enum(['enumerated', 'asserted', 'not_reported']),
    mandatory: z.record(z.string(), z.enum(COVARIATE_STATES)).default({}),
    outcome_specific: z.array(z.string()).default([]),
  }),
  /** R29/R30 — a row whose association runs through an intermediary. */
  mediators: z.array(MediatorSchema).default([]),
  /** R30/§11 — the M modifier, recorded *with* a tier and never instead of one. */
  mediated: z.boolean(),
  /** R12 — the lag applied, per outcome class. */
  lag_months: z.number().int().min(0),
  /** R37/R38 — effect modifiers with real magnitudes. */
  subgroups: z.array(SubgroupSchema).default([]),
  /** R40 — m1–m4, or none. */
  mechanism_tier: z.enum(MECHANISM_TIERS),
  /** §11 — the grade, applied to this exposure stratum and this outcome only. */
  evidence_tier: z.enum(EVIDENCE_TIERS),
  /** R42 — the wording the tier licenses. */
  causal_language: z.string().min(1),
  /** Why this tier and not the one above or below it — names the deciding rule. */
  verdict_basis: z.string().min(1),
  /** R44 — conflicting estimates, all of them. */
  conflicts: z.array(ConflictSchema).default([]),
  /** R26 — stated, never implied. */
  residual_confounding: z.string().min(1),
  /** R45 — true only for a row whose exposure is not the index condition. */
  attribution_exception: z.boolean().default(false),
  /** R35/R36 — the population composition this row generalizes from. */
  populations_note: z.string().min(1),
  /** R46 — detection-bias assessment. */
  notes: z.string().min(1),
  source: z.object({
    documents: z.array(z.enum(SOURCE_DOCUMENTS)).min(1),
    locator: z.string().min(1),
    /** R1 — the primary source to open before promotion to `verified`. */
    primary_source_url: z.string().nullable(),
  }),
  verification: z.object({
    status: z.enum(VERIFICATION_STATES),
    verifier: z.string().nullable(),
    date: z.string().nullable(),
  }),
});
export type PhenomeRow = z.infer<typeof PhenomeRowSchema>;

export const PhenomeMapSchema = z.object({
  map_id: z.string().min(1),
  map_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  map_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  index_condition: z.string().min(1),
  rules_document: z.string().min(1),
  rules_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** R43 — "no studies identified" needs a date and a scope to mean anything. */
  search_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  search_scope: z.string().min(1),
  /** §0 condition 6 / R35 — what the data source structurally cannot see. */
  ascertainment_boundary: z.string().min(1),
  /** R13 — exclusions, written down before the analysis. */
  exclusion_rules: z.array(z.string().min(1)).min(1),
  /** §16 — two reviewers, two lenses. */
  review: z.object({
    status: z.enum(['signed', 'unsigned']),
    clinician: z.string().nullable(),
    actuary: z.string().nullable(),
  }),
  /**
   * §0 condition 7 — a map may not claim completeness while unsigned. Enforced
   * rather than promised.
   */
  claims_complete: z.boolean(),
  /** R1 — unverified rows that also lack a primary source URL, with the reason. */
  verification_gaps: z.array(z.object({ row_id: z.string().min(1), reason: z.string().min(1) })),
  /** Rule/verdict conflicts, declared rather than hidden or silently waived. */
  rule_tensions: z
    .array(
      z.object({
        row_id: z.string().min(1),
        rule: z.string().min(1),
        description: z.string().min(1),
        resolution: z.string().min(1),
      }),
    )
    .default([]),
  /**
   * Review items that block the claim in §0 but are not rule breaches —
   * recorded here because a map that hides its own soft edges is the failure
   * mode the rules document exists to prevent. Structured, so "which rows" is a
   * question the test can answer rather than a sentence a reader has to trust.
   */
  open_items: z
    .array(
      z.object({
        category: z.enum(['tier_a_gate', 'verification', 'coverage', 'other']),
        row_id: z.string().nullable(),
        item: z.string().min(1),
      }),
    )
    .default([]),
  rows: z.array(PhenomeRowSchema).min(1),
});
export type PhenomeMap = z.infer<typeof PhenomeMapSchema>;

/** A hard rule breach. `rule` is the id in docs/phenome-mapping-rules.md. */
export interface RuleViolation {
  rule: string;
  row_id: string | null;
  message: string;
}

const TIER_CAP_RANK: Record<EvidenceTier, number> = { A: 4, B: 3, C: 2, X: 1, D: 0 };

/** Lowest tier permitted for a row's ascertainment grade (R9). */
function ascertainmentCap(grade: PhenomeRow['outcome']['ascertainment']): EvidenceTier {
  if (grade === 'a' || grade === 'b' || grade === 'c') return 'A';
  if (grade === 'd' || grade === 'e' || grade === 'f') return 'B';
  return 'C';
}

/** R9 — screen/self-report caps at C when the outcome is severe. */
function severeOutcomeCap(row: PhenomeRow): EvidenceTier | null {
  if (row.outcome.severity !== 'severe') return null;
  return row.outcome.ascertainment === 'e' || row.outcome.ascertainment === 'f' ? 'C' : null;
}

/** R19 — the band a value and its CI actually fall in. */
export function magnitudeBand(
  value: number | null,
  ciLow: number | null,
  ciHigh: number | null,
): (typeof MAGNITUDE_BANDS)[number] {
  if (value === null) return 'not_applicable';
  if (ciLow !== null && ciHigh !== null && ciLow <= 1 && 1 <= ciHigh) return 'null_or_uncertain';
  if (value < 1.05) return 'null_or_uncertain';
  if (value < 1.2) return 'marginal';
  if (value < 1.5) return 'modest';
  if (value < 2) return 'moderate';
  return 'strong';
}

/** R16 — distinct cohort families, which is not the same as distinct papers. */
export function independentPopulationCount(row: PhenomeRow): number {
  return new Set(row.populations.map((population) => population.independence_group)).size;
}

/** R20 — the precision gate: does the row's own numbers exclude 1.00? */
function excludesNull(row: PhenomeRow): boolean {
  const { ci_low, ci_high } = row.estimate.primary;
  if (ci_low === null || ci_high === null) return false;
  return ci_low > 1 || ci_high < 1;
}

/** R9/R10/R40 — the highest tier this row's design allows. */
export function tierCeiling(row: PhenomeRow): { tier: EvidenceTier; rule: string } {
  let ceiling: EvidenceTier = ascertainmentCap(row.outcome.ascertainment);
  let rule = 'R9';
  const severeCap = severeOutcomeCap(row);
  if (severeCap && TIER_CAP_RANK[severeCap] < TIER_CAP_RANK[ceiling]) {
    ceiling = severeCap;
  }
  // R10/R40: a biomarker-only row is not evidence that a clinical outcome
  // occurs, unless the marker prospectively predicted incident disease (m2).
  if (row.outcome.kind === 'intermediate marker' && row.mechanism_tier !== 'm2') {
    const cap: EvidenceTier = 'C';
    if (TIER_CAP_RANK[cap] < TIER_CAP_RANK[ceiling]) {
      ceiling = cap;
      rule = 'R10/R40';
    }
  }
  return { tier: ceiling, rule };
}

function everyString(value: unknown, visit: (text: string, path: string) => void, path = ''): void {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => everyString(item, visit, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      everyString(item, visit, path ? `${path}.${key}` : key);
    }
  }
}

/** R42 — the tier's permitted wording, checked as a phrase rather than a vibe. */
function causalLanguageProblem(row: PhenomeRow): string | null {
  const permitted = TIER_CAUSAL_PHRASES[row.evidence_tier];
  const licensed = permitted.some((phrase) => row.causal_language.toLowerCase().includes(phrase));
  if (!licensed) {
    return `causal_language for tier ${row.evidence_tier} must contain one of: ${permitted
      .map((phrase) => `"${phrase}"`)
      .join(' / ')}`;
  }
  const allowsCausal =
    row.evidence_tier === 'A' && (row.mechanism_tier === 'm3' || row.mechanism_tier === 'm4');
  if (!allowsCausal) {
    const found = FORBIDDEN_CAUSAL_TERMS.find((term) =>
      row.causal_language.toLowerCase().includes(term),
    );
    if (found) {
      return `"${found}" requires an m3/m4 mechanism plus A-tier epidemiology (R41/R42)`;
    }
  }
  return null;
}

/**
 * Validates the map shape and then the cross-field rules.
 *
 * Returns schema errors and rule violations rather than throwing, so a caller
 * (or a test) can report every problem in one pass instead of fixing them one
 * build at a time.
 */
export function validatePhenomeMap(input: unknown): {
  map: PhenomeMap | null;
  schemaErrors: string[];
  violations: RuleViolation[];
} {
  const parsed = PhenomeMapSchema.safeParse(input);
  if (!parsed.success) {
    return {
      map: null,
      schemaErrors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
      violations: [],
    };
  }

  const map = parsed.data;
  const violations: RuleViolation[] = [];
  const push = (rule: string, rowId: string | null, message: string) =>
    violations.push({ rule, row_id: rowId, message });

  // §0 condition 7 — completeness is not available to an unsigned map.
  if (map.claims_complete && map.review.status !== 'signed') {
    push('§0.7', null, 'claims_complete requires a signed review (clinician and actuary)');
  }
  if (map.review.status === 'signed' && (!map.review.clinician || !map.review.actuary)) {
    push('§16', null, 'a signed review names both reviewers (clinician and actuary)');
  }

  // R7 — the trauma stratum is mandatory: without it the map cannot separate the
  // stress response from the event.
  if (!map.rows.some((row) => row.exposure.stratum === 'trauma')) {
    push('R7', null, 'no row carries the `trauma` stratum (trauma-exposed without PTSD)');
  }

  // R33 — the acute window is never pooled with long-term follow-up.
  const mortalityWindows = new Set(
    map.rows.filter((row) => row.outcome_class === 'mortality').map((row) => row.mortality_window),
  );
  if (mortalityWindows.has('year_1') !== mortalityWindows.has('after_year_1')) {
    push(
      'R33',
      null,
      'mortality rows must report year 1 and >1 year as separate rows, never one alone',
    );
  }

  // §12 / R43 — coverage of the pre-declared sweep.
  const coveredDomains = new Set(map.rows.map((row) => row.domain));
  for (const domain of PHENOME_DOMAINS) {
    if (!coveredDomains.has(domain.number)) {
      push('R43', null, `domain ${domain.number} (${domain.key}) has no row`);
    }
  }

  const ids = new Set<string>();
  const addedCodes = new Set<string>();

  for (const row of map.rows) {
    const id = row.id;

    if (ids.has(id)) push('§14', id, `duplicate row id`);
    ids.add(id);

    // R4 — the exposure stratum is pinned for the index condition and never
    // pooled. A row that identified no study has no stratum to pin: it is a
    // coverage finding, not an exposure, so R4 does not apply to it (R43).
    const identifiesNoStudy = row.evidence_tier === 'D' && row.designs.length === 0;
    if (
      row.exposure.condition === map.index_condition &&
      row.exposure.stratum === null &&
      !identifiesNoStudy
    ) {
      push('R4', id, 'a PTSD row must pin an exposure stratum (dx | prob | trauma)');
    }
    // R45 — an association belongs to the exposure that produced it.
    if (row.exposure.condition !== map.index_condition && !row.attribution_exception) {
      push(
        'R45',
        id,
        `exposure "${row.exposure.condition}" is not the index condition; set attribution_exception with the reason`,
      );
    }

    // R9 / R10 / R40 — the row cannot outrank its own design.
    const ceiling = tierCeiling(row);
    if (TIER_CAP_RANK[row.evidence_tier] > TIER_CAP_RANK[ceiling.tier]) {
      push(
        ceiling.rule,
        id,
        `tier ${row.evidence_tier} exceeds the ceiling ${ceiling.tier} (${ceiling.rule}) set by ascertainment (${row.outcome.ascertainment})${
          row.outcome.kind === 'intermediate marker' ? ', an intermediate-marker outcome' : ''
        }${row.outcome.severity === 'severe' ? ', and a severe outcome' : ''}`,
      );
    }

    // R11 — `M` is recorded with a tier, never instead of one, and only for A–C.
    if (
      row.mediated &&
      row.evidence_tier !== 'A' &&
      row.evidence_tier !== 'B' &&
      row.evidence_tier !== 'C'
    ) {
      push('R11', id, `mediated rows are graded A–C with the M modifier, not ${row.evidence_tier}`);
    }
    if (row.mediated && row.mediators.length === 0) {
      push('R11/R29', id, 'mediated is true but no mediator is named');
    }

    // R8 — prevalence data cannot license an incidence claim.
    if (
      row.outcome.kind === 'prevalence' &&
      /inciden|risk of developing|new-onset/i.test(row.causal_language)
    ) {
      push('R8', id, 'a prevalence row may not carry an incidence claim');
    }

    // R12 — the latency window the class requires.
    const minimumLag = MINIMUM_LAG_MONTHS[row.outcome_class];
    if (row.lag_months < minimumLag) {
      push(
        'R12',
        id,
        `lag_months ${row.lag_months} is below the ${minimumLag}-month minimum for ${row.outcome_class}`,
      );
    }

    // R33 — mortality rows declare their window.
    if (row.outcome_class === 'mortality' && row.mortality_window === null) {
      push('R33', id, 'a mortality row must state whether it covers year 1 or after year 1');
    }
    if (row.outcome_class !== 'mortality' && row.mortality_window !== null) {
      push('R33', id, 'mortality_window is set on a non-mortality row');
    }

    // R14 — designs as a set, reported as a set rather than one label.
    if (new Set(row.designs).size !== row.designs.length) {
      push('R14', id, 'duplicate design in the design set');
    }
    if (row.designs.length === 0 && row.evidence_tier !== 'D') {
      push('R14', id, 'a row with evidence must name its design(s)');
    }

    // R35/R36 — a row with evidence names the populations it generalizes from.
    if (row.populations.length === 0 && row.evidence_tier !== 'D') {
      push('R35', id, 'a row with evidence must name its population(s)');
    }

    // R15 — a pooled estimate discloses what it pooled.
    const isPooled = row.designs.some(
      (design) => design === 'meta-analysis of prospective cohorts',
    );
    if (isPooled && row.estimate.pooled === null) {
      push('R15', id, 'a pooled/meta-analytic row must disclose studies, N, and heterogeneity');
    }

    // R18 — a genetic instrument stands alone, and is m4 by construction.
    if (row.designs.includes('MR/genetic instrument') && row.mechanism_tier !== 'm4') {
      push('R18', id, 'an MR row is a genetic instrument and must be mechanism tier m4');
    }

    // R19 — the declared band must match the declared number.
    const declaredBand = row.estimate.primary.magnitude_band;
    const computedBand = magnitudeBand(
      row.estimate.primary.value,
      row.estimate.primary.ci_low,
      row.estimate.primary.ci_high,
    );
    if (declaredBand !== computedBand) {
      push(
        'R19',
        id,
        `magnitude_band "${declaredBand}" does not match the value/CI (computed "${computedBand}")`,
      );
    }

    // R2 — a CI is all or nothing, and an adjusted pair needs an attenuation state.
    for (const [label, estimate] of Object.entries({
      primary: row.estimate.primary,
      least_adjusted: row.estimate.least_adjusted,
      fully_adjusted: row.estimate.fully_adjusted,
    })) {
      if (!estimate) continue;
      if ((estimate.ci_low === null) !== (estimate.ci_high === null)) {
        push('R2', id, `${label}: ci_low and ci_high must be recorded together`);
      }
      if (estimate.value !== null && estimate.ci_low !== null && estimate.ci_low > estimate.value) {
        push('R2', id, `${label}: ci_low is above the point estimate`);
      }
    }
    if (
      row.estimate.least_adjusted &&
      row.estimate.fully_adjusted &&
      row.estimate.attenuation === 'not_applicable'
    ) {
      push('R25', id, 'both models are present, so attenuation cannot be not_applicable');
    }

    // R20/R21 — the precision and anchoring gates for tier A.
    if (row.evidence_tier === 'A') {
      if (!excludesNull(row)) {
        push('R20', id, 'tier A requires a confidence interval that excludes 1.00');
      }
      if (row.estimate.attenuation !== 'persists') {
        push(
          'R25',
          id,
          `tier A requires the effect to persist under adjustment, not ${row.estimate.attenuation}`,
        );
      }
      if (!['a', 'b', 'c'].includes(row.outcome.ascertainment)) {
        push('R9', id, `tier A requires (a)–(c) ascertainment, not (${row.outcome.ascertainment})`);
      }
    }

    // R24 — the mandatory adjustment set, to the extent it is knowable.
    if (
      (row.evidence_tier === 'A' || row.evidence_tier === 'B') &&
      row.adjustment_set.completeness === 'not_reported'
    ) {
      push(
        'R24',
        id,
        `tier ${row.evidence_tier} requires the mandatory adjustment set to be at least asserted`,
      );
    }
    if (row.adjustment_set.completeness === 'enumerated') {
      const missing = MANDATORY_ADJUSTMENT_SET.filter(
        (covariate) =>
          (row.adjustment_set.mandatory[covariate] ?? 'not_reported') === 'not_reported',
      );
      if (missing.length > 0) {
        push('R24', id, `enumerated adjustment set is missing: ${missing.join(', ')}`);
      }
    }
    const unknownCovariates = Object.keys(row.adjustment_set.mandatory).filter(
      (covariate) => !(MANDATORY_ADJUSTMENT_SET as readonly string[]).includes(covariate),
    );
    if (unknownCovariates.length > 0) {
      push('R24', id, `unknown mandatory covariate(s): ${unknownCovariates.join(', ')}`);
    }
    if (row.evidence_tier === 'A') {
      const adjustedAway = Object.entries(row.adjustment_set.mandatory)
        .filter(([, state]) => state === 'no')
        .map(([covariate]) => covariate);
      if (adjustedAway.length > 0) {
        push('R24', id, `tier A row does not adjust for: ${adjustedAway.join(', ')}`);
      }
    }

    // R16 — any tier above C needs the same association from ≥2 non-overlapping populations.
    const populations = independentPopulationCount(row);
    if ((row.evidence_tier === 'A' || row.evidence_tier === 'B') && populations < 2) {
      push(
        'R16',
        id,
        `tier ${row.evidence_tier} rests on ${populations} independent population(s); R16 requires ≥2 that do not overlap`,
      );
    }

    // R30 — a mediator carries its proportion or the explicit gap.
    for (const mediator of row.mediators) {
      if (mediator.proportion_mediated.trim().length === 0) {
        push('R30', id, `mediator "${mediator.name}" carries no proportion and no gap statement`);
      }
    }

    // R37 — subgroup effects come with CIs, and a null subgroup is not proof.
    for (const subgroup of row.subgroups) {
      if ((subgroup.estimate.ci_low === null) !== (subgroup.estimate.ci_high === null)) {
        push('R37', id, `${subgroup.label}: subgroup CI must be recorded on both sides`);
      }
      const crosses =
        subgroup.estimate.ci_low !== null &&
        subgroup.estimate.ci_high !== null &&
        subgroup.estimate.ci_low <= 1 &&
        1 <= subgroup.estimate.ci_high;
      if (crosses && !subgroup.null_not_absence) {
        push(
          'R37',
          id,
          `${subgroup.label}: CI crosses 1.00, which is imprecision, not evidence of absence`,
        );
      }
    }

    // R44 — conflicts are recorded, and an unresolved one is documented.
    const conflictValues = row.conflicts
      .map((conflict) => conflict.value)
      .filter((value) => value !== null);
    if (new Set(conflictValues).size !== conflictValues.length) {
      push('R44', id, 'two conflict entries report the same value, so one is not a conflict');
    }
    if (row.conflicts.some((conflict) => !conflict.resolved) && row.notes.trim().length === 0) {
      push('R44', id, 'an unresolved conflict must be documented in notes');
    }

    // R42 — tier and language are locked together.
    const languageProblem = causalLanguageProblem(row);
    if (languageProblem) push('R42', id, languageProblem);

    // R3 — the sources' adjectives are findings, not evidence.
    everyString(row, (text, path) => {
      const found = FORBIDDEN_SOURCE_ADJECTIVES.find((adjective) =>
        text.toLowerCase().includes(adjective),
      );
      if (found) {
        push('R3', id, `"${found}" appears in ${path}; enter the estimate, not the adjective`);
      }
    });

    // R43 — an empty domain row says so, with a date and a scope.
    if (row.evidence_tier === 'D' && !/no studies identified/i.test(row.verdict_basis)) {
      push('R43', id, 'a D row must state "no studies identified in sources reviewed"');
    }

    // R1 — verification, and the promotion path.
    if (row.verification.status === 'verified') {
      if (!row.verification.verifier || !row.verification.date || !row.source.primary_source_url) {
        push('R1', id, 'a verified row names its verifier, date, and primary source URL');
      }
    } else if (!row.source.primary_source_url) {
      const declared = map.verification_gaps.some((gap) => gap.row_id === row.id);
      if (!declared) {
        push(
          'R1',
          id,
          'an unverified row with no primary source URL must be declared in verification_gaps',
        );
      }
    }

    // R11 — codes are what make an outcome queryable later.
    for (const code of row.outcome.codes) {
      if (addedCodes.has(`${row.id}:${code}`)) push('R11', id, `duplicate outcome code ${code}`);
      addedCodes.add(`${row.id}:${code}`);
    }
  }

  // The gap ledger is two-way: a declared gap must be a real gap.
  for (const gap of map.verification_gaps) {
    const row = map.rows.find((candidate) => candidate.id === gap.row_id);
    if (!row) {
      push('R1', gap.row_id, 'verification_gaps names a row that does not exist');
      continue;
    }
    if (row.verification.status === 'verified' || row.source.primary_source_url) {
      push('R1', gap.row_id, 'verification_gaps declares a gap the row does not have');
    }
  }

  // The tension ledger is two-way as well: a knowing deviation names a real row,
  // because a rule tension about a row that does not exist is not a decision
  // anyone can make (R16/R20/R25 can only be waived for an actual estimate).
  for (const tension of map.rule_tensions) {
    const row = map.rows.find((candidate) => candidate.id === tension.row_id);
    if (!row) {
      push('§16', tension.row_id, 'rule_tensions names a row that does not exist');
    }
  }

  return { map, schemaErrors: [], violations };
}

/**
 * Rule/verdict conflicts, grouped by rule, for the map's `rule_tensions` ledger.
 *
 * A tension is a violation a reviewer may knowingly accept (for example a grade
 * the sources support on a design rule this rule set reads more strictly).
 * Nothing here is waived automatically: the test suite requires every tension to
 * correspond to a real violation and every real violation to be either absent or
 * declared.
 */
export function findRuleTensions(map: PhenomeMap): RuleViolation[] {
  const { violations } = validatePhenomeMap(map);
  return violations.filter((violation) => violation.row_id !== null);
}

/**
 * The tier A gates a row cannot yet demonstrate from what its source records.
 *
 * R20 (events stated or derivable), R21 (absolute risk anchored), and R24 (the
 * mandatory adjustment set enumerated) are A-tier requirements. A synthesis can
 * assert all three without printing any of them, in which case the row holds `A`
 * on the source's word rather than on a checkable number. That is worth
 * surfacing and not worth failing the build over — so it is a computed audit,
 * and the test locks which rows it holds for, forcing a deliberate update when a
 * primary source finally supplies the numbers (R1).
 */
export interface TierAGateGap {
  row_id: string;
  missing: string[];
}

export function auditTierAGateGaps(map: PhenomeMap): TierAGateGap[] {
  const gaps: TierAGateGap[] = [];
  for (const row of map.rows) {
    if (row.evidence_tier !== 'A') continue;
    const missing: string[] = [];
    if (row.estimate.events === null) missing.push('events not stated or derivable (R20)');
    if (/not reported/i.test(row.estimate.absolute_risk))
      missing.push('absolute risk not anchored (R21)');
    if (row.adjustment_set.completeness !== 'enumerated') {
      missing.push('mandatory adjustment set asserted, not enumerated (R24)');
    }
    if (missing.length > 0) gaps.push({ row_id: row.id, missing });
  }
  return gaps;
}

/** Groups violations by rule id, for a readable report. */
export function summarizeViolations(violations: RuleViolation[]): Record<string, string[]> {
  const summary: Record<string, string[]> = {};
  for (const violation of violations) {
    const key = violation.rule;
    summary[key] = summary[key] ?? [];
    summary[key].push(`${violation.row_id ?? '(map)'}: ${violation.message}`);
  }
  return summary;
}
