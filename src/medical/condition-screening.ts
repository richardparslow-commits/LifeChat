/**
 * Consented-profile screening over the crosswalk's qualifier dimensions.
 *
 * The crosswalk resolves a stated condition onto one canonical code, and since
 * 1.10.0 some rows are *siblings that differ only by a qualifier*: the codebook
 * split urethral stricture by sex, the stone and lump rows by organ, and the
 * Chapter XXI maltreatment and self-harm families by what the person's own
 * words name — the setting of an abuse history (childhood or adult) and the
 * intent of a self-harm history (suicidal or nonsuicidal). The stored
 * `CanonicalConditionRef` records the code that won, but a broker querying a
 * profile should not have to reverse-engineer "Z62.819 means the childhood
 * member" from a code list, and should never infer a distinction from a code
 * silently. This module is the name for that distinction: a small, declared
 * registry of **screen axes**, each carrying the codebook's own values and the
 * codes whose titles express them, so an underwriter can ask the question in
 * words — "was the abuse in childhood or adulthood?", "was the self-harm
 * suicidal?" — and get back the captured refs that answer it.
 *
 * What this module is:
 *
 *   - DECLARED, NOT INFERRED. An axis value lists its ICD-10-CM codes, and a
 *     test proves each member code's codebook title carries the value's
 *     `title_signal` (word-start, the same matching rule the crosswalk uses) and
 *     that the axis's membership agrees with the vocabulary in every direction:
 *     every marker-bearing row is on a marker axis, every site- and sex-declaring
 *     row is on the matching axis, and the psychosocial maltreatment family is
 *     exactly the union of the `abuse_setting` values plus its declared
 *     `unstated` member. A future release that adds or renames a row fails the
 *     build until the axis records the decision.
 *   - HONEST ABOUT WHAT IS NOT DISTINGUISHED. An axis may declare `unstated`
 *     codes: rows it governs whose title names no value. `abuse_setting` has
 *     one — Z91.42, "personal history of forced labor or sexual exploitation",
 *     whose title carries no setting word. Screening for `childhood` or `adult`
 *     never matches it; screening the axis without naming a value returns it as
 *     `unstated`, because "the code does not say" is an answer and a silent
 *     omission reads as "no history here".
 *   - GATED. `screenConsentedConditions()` is the only production entry point
 *     and clears the same `isMedicalProcessingPermitted()` gate the capture path
 *     does: querying a consented profile is a use of TDPSA sensitive health
 *     data, so this is not a side door around §9.1. It reads only the stored
 *     canonical refs — never the verbatim `medical_conditions` — and returns
 *     `null` unless the flow is enabled AND medical consent is affirmed AND
 *     versioned.
 *   - ONE CRITERION AT A TIME, OR ALL OF THEM. Each filter is a full question
 *     ("the setting is childhood", "the intent was suicidal"), asked
 *     independently over the captured refs. The result reports every ref that
 *     answered any of them (`matched`), each filter's own answer (`answers`),
 *     and the conjunctive reading (`all_answered`), so "childhood abuse **and**
 *     a suicidal history" is answered honestly rather than collapsed into one
 *     yes.
 *   - NOT A JUDGMENT. A screen reports which captured code answers an axis, and
 *     with which vocabulary version the ref was mapped. It is not an
 *     underwriting finding, an eligibility decision, a rating, or a carrier
 *     rule, and nothing here is shown to the user.
 *
 * Matching is by code, so a profile mapped under an older vocabulary version
 * screens the same way (each match carries the version it was mapped with);
 * unknown axes and unknown value ids are refused loudly rather than matching
 * nothing, because a typo in broker tooling must not read as "no history".
 */

import {
  CONDITION_VOCABULARY_ID,
  isMedicalProcessingPermitted,
  type CanonicalConditionRef,
  type ConditionSystem,
  type MedicalConsentState,
} from './condition-crosswalk';

/**
 * The reserved filter value naming the rows an axis governs whose codebook
 * title declares no value. Never used as a regular axis value id.
 */
export const CONDITION_SCREEN_UNSTATED_VALUE = 'unstated';

/** The qualifier dimension an axis reports on, as the crosswalk declares it. */
export type ConditionQualifierDimension = 'sex' | 'site' | 'words';

/** One side of a distinction the vocabulary makes. */
export interface ConditionScreenAxisValue {
  id: string;
  label: string;
  /**
   * The word every member code's codebook title carries, matched at a word
   * start (so `child` covers "in childhood" and `suicidal` does not match
   * "nonsuicidal"). Exists so the axis membership is verifiable from the titles
   * rather than from a maintainer's memory; the test suite asserts it.
   */
  title_signal: string;
  /** The ICD-10-CM codes whose captured ref answers this value. */
  codes: readonly string[];
}

/** A named distinction an underwriter can screen a consented profile on. */
export interface ConditionScreenAxis {
  id: string;
  label: string;
  /** The question, in the terms a screen is asked. */
  question: string;
  dimension: ConditionQualifierDimension;
  values: readonly ConditionScreenAxisValue[];
  /**
   * Rows the axis governs whose codebook title names no value — reported as
   * `unstated`, never matched by a named value. Absent means every governed row
   * carries a value.
   */
  unstated?: { label: string; codes: readonly string[] };
}

/**
 * The committed axes. Each one is a distinction the vocabulary now carries in
 * sibling rows rather than a new clinical claim about a person: the codes are
 * existing vocabulary entries, and the values are the codebook's own words.
 */
export const CONDITION_SCREEN_AXES: readonly ConditionScreenAxis[] = [
  {
    id: 'abuse_setting',
    label: 'Setting of a captured abuse, neglect or exploitation history',
    question:
      'Does the captured abuse, neglect or exploitation history say the setting — childhood or adulthood?',
    dimension: 'words',
    values: [
      {
        id: 'childhood',
        label: 'In childhood',
        title_signal: 'child',
        codes: ['Z62.810', 'Z62.811', 'Z62.812', 'Z62.813', 'Z62.814', 'Z62.815', 'Z62.819'],
      },
      {
        id: 'adult',
        label: 'In adulthood',
        title_signal: 'adult',
        codes: ['Z91.410', 'Z91.411', 'Z91.412', 'Z91.413', 'Z91.414', 'Z91.419'],
      },
    ],
    // Z91.42 ("personal history of forced labor or sexual exploitation") is a
    // member of this family whose title carries no setting word: the bare
    // wording resolves to it because that is the only billable home, not because
    // the setting is adult. A screen must report it as unstated rather than let
    // it fall out of every value's answer as if no history had been captured.
    unstated: {
      label: 'The code carries no setting',
      codes: ['Z91.42'],
    },
  },
  {
    id: 'self_harm_intent',
    label: 'Intent of a captured self-harm history',
    question:
      'Does the captured self-harm history record suicidal behavior or nonsuicidal self-harm?',
    dimension: 'words',
    values: [
      {
        id: 'suicidal',
        label: 'Suicidal behavior',
        title_signal: 'suicidal',
        codes: ['Z91.51'],
      },
      {
        id: 'nonsuicidal',
        label: 'Nonsuicidal self-harm',
        title_signal: 'nonsuicidal',
        codes: ['Z91.52'],
      },
    ],
  },
  {
    id: 'resolved_site',
    label: 'Organ a site-qualified condition resolved on',
    question: 'Which organ did the wording name — where the site-qualified condition resolved?',
    dimension: 'site',
    values: [
      { id: 'kidney', label: 'In the kidney', title_signal: 'kidney', codes: ['N20.0'] },
      { id: 'ureter', label: 'In the ureter', title_signal: 'ureter', codes: ['N20.1'] },
      { id: 'bladder', label: 'In the bladder', title_signal: 'bladder', codes: ['N21.0'] },
      { id: 'breast', label: 'In the breast', title_signal: 'breast', codes: ['N63.0'] },
    ],
  },
  {
    id: 'resolved_sex',
    label: 'Side of the codebook sex split a condition resolved to',
    question: "Which side of the codebook's sex split did a sex-split condition resolve to?",
    dimension: 'sex',
    values: [
      { id: 'male', label: 'Male member', title_signal: 'male', codes: ['N35.919'] },
      { id: 'female', label: 'Female member', title_signal: 'female', codes: ['N35.92'] },
    ],
  },
];

/** One axis value a stored code answers. */
export interface ConditionScreenAxisValueRef {
  axis: string;
  value: string;
  label: string;
}

const axisById = new Map<string, ConditionScreenAxis>(
  CONDITION_SCREEN_AXES.map((axis) => [axis.id, axis]),
);

const axesByCode = new Map<string, ConditionScreenAxisValueRef[]>();
for (const axis of CONDITION_SCREEN_AXES) {
  for (const value of axis.values) {
    for (const code of value.codes) {
      const entries = axesByCode.get(code) ?? [];
      entries.push({ axis: axis.id, value: value.id, label: value.label });
      axesByCode.set(code, entries);
    }
  }
  for (const code of axis.unstated?.codes ?? []) {
    const entries = axesByCode.get(code) ?? [];
    entries.push({
      axis: axis.id,
      value: CONDITION_SCREEN_UNSTATED_VALUE,
      label: axis.unstated!.label,
    });
    axesByCode.set(code, entries);
  }
}

/** Lists the axes (copy — callers cannot mutate the registry). */
export function listConditionScreenAxes(): ConditionScreenAxis[] {
  return CONDITION_SCREEN_AXES.slice();
}

/** Looks an axis up by id; null for an unknown id (the caller decides how to fail). */
export function getConditionScreenAxis(axisId: string): ConditionScreenAxis | null {
  return axisById.get(axisId) ?? null;
}

/**
 * The axis value(s) a stored code answers — `unstated` included. Empty for a
 * code outside every axis (most of the vocabulary), which is not an error: it
 * means the axis questions do not apply to that row.
 */
export function screenAxisValuesForCode(icd10Cm: string): ConditionScreenAxisValueRef[] {
  return (axesByCode.get(icd10Cm.trim().toUpperCase()) ?? []).slice();
}

/** One axis filter: a question, optionally narrowed to named values. */
export interface ConditionScreenFilter {
  axis: string;
  /**
   * Value ids to match, or the reserved `unstated`; omitted or empty means any
   * answer the axis carries (its values and its unstated rows).
   */
  values?: readonly string[];
}

/** One captured ref that answers one filter. */
export interface ConditionScreenMatch {
  icd10_cm: string;
  name: string;
  system: ConditionSystem;
  /** The vocabulary id + version the ref was mapped with (audit). */
  vocabulary: string;
  vocabulary_version: string;
  /** The filter's axis, and the value the ref answers. */
  axis: string;
  value: string;
  value_label: string;
}

/** One filter's answer: whether any captured ref answered it, and which. */
export interface ConditionScreenAnswer {
  axis: string;
  /** The value ids the filter narrowed to; absent when it asked for any answer. */
  values?: readonly string[];
  positive: boolean;
  matched_codes: string[];
}

export interface ConditionScreenResult {
  /** Screenable captured codes considered, deduplicated. */
  screened: number;
  /** True when at least one filter was answered — the screen found something. */
  positive: boolean;
  /**
   * True when every filter was answered — the conjunctive screen ("childhood
   * abuse **and** a suicidal self-harm history"). Each filter is asked in full
   * independently, so a profile can answer one and not another; `answers`
   * reports them one by one rather than collapsing the screen into one bit.
   */
  all_answered: boolean;
  answers: ConditionScreenAnswer[];
  matched: ConditionScreenMatch[];
  /** Sorted unique matched codes, for tooling. */
  matched_codes: string[];
}

export interface ScreenConsentedConditionsInput {
  /**
   * The captured refs to query, as stored on the consented profile
   * (`MedicalProfile.canonical_conditions`). The verbatim stated conditions are
   * deliberately not accepted: a screen answers what was captured under the
   * version it was captured with, not what today's vocabulary would say.
   */
  canonicalConditions: readonly CanonicalConditionRef[];
  /** Consent as recorded on the response/lead — both fields are required. */
  consent: MedicalConsentState | null | undefined;
  /** Live feature-flag state: true = Phase 2 medical capture is closed. */
  healthDataCollectionDisabled: boolean;
  /**
   * The criteria to ask. At least one; unknown axes or value ids are refused.
   * Each is asked in full independently — see `answers` and `all_answered`.
   */
  filters: readonly ConditionScreenFilter[];
}

/**
 * Validates the filters and returns them unchanged. Throws rather than matching
 * nothing: a misspelled axis or value in broker tooling would otherwise read as
 * the reassuring answer "no such history".
 */
function validateScreenFilters(filters: readonly ConditionScreenFilter[]): void {
  if (!Array.isArray(filters) || filters.length === 0) {
    throw new Error('a condition screen needs at least one axis filter');
  }
  for (const filter of filters) {
    if (!filter || typeof filter.axis !== 'string' || filter.axis.length === 0) {
      throw new Error('a condition screen filter needs an axis id');
    }
    const axis = axisById.get(filter.axis);
    if (!axis) throw new Error(`unknown condition screen axis: ${filter.axis}`);
    if (filter.values === undefined) continue;
    if (!Array.isArray(filter.values)) {
      throw new Error(`condition screen axis ${filter.axis}: values must be an array of value ids`);
    }
    for (const value of filter.values) {
      if (value === CONDITION_SCREEN_UNSTATED_VALUE) continue;
      if (!axis.values.some((candidate) => candidate.id === value)) {
        throw new Error(`condition screen axis ${filter.axis} has no value: ${value}`);
      }
    }
  }
}

/** True when a ref answers a filter (value match, or the filter names no values). */
function filterMatchesValue(
  filter: ConditionScreenFilter,
  entry: ConditionScreenAxisValueRef,
): boolean {
  if (entry.axis !== filter.axis) return false;
  const values = filter.values;
  if (values === undefined || values.length === 0) return true;
  return values.includes(entry.value);
}

/**
 * The production query entry point: screens a consented profile's captured
 * canonical refs against the declared axes.
 *
 * Fail-closed — returns null unless `isMedicalProcessingPermitted()` clears and
 * the captured refs are an array. Callers must treat null as "no medical data
 * may be processed": show nothing, store nothing, log nothing. A malformed
 * query (no filters, an unknown axis, an unknown value id) throws — that is a
 * tooling defect, not an absent consent.
 */
export function screenConsentedConditions(
  input: ScreenConsentedConditionsInput,
): ConditionScreenResult | null {
  if (!isMedicalProcessingPermitted(input)) return null;
  if (!Array.isArray(input.canonicalConditions)) return null;
  validateScreenFilters(input.filters);

  const perFilter = input.filters.map(() => new Set<string>());
  const seenCodes = new Set<string>();
  const matched: ConditionScreenMatch[] = [];
  for (const ref of input.canonicalConditions) {
    if (!ref || typeof ref.icd10_cm !== 'string') continue;
    // Refs from another vocabulary are not screenable by these axes: the values
    // describe this vocabulary's rows, and a foreign code would only collide.
    if (ref.vocabulary && ref.vocabulary !== CONDITION_VOCABULARY_ID) continue;
    const code = ref.icd10_cm;
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);

    const entries = axesByCode.get(code) ?? [];
    input.filters.forEach((filter, index) => {
      const entry = entries.find((candidate) => filterMatchesValue(filter, candidate));
      if (!entry) return;
      perFilter[index].add(code);
      matched.push({
        icd10_cm: code,
        name: ref.name,
        system: ref.system,
        vocabulary: ref.vocabulary,
        vocabulary_version: ref.vocabulary_version,
        axis: entry.axis,
        value: entry.value,
        value_label: entry.label,
      });
    });
  }

  const answers: ConditionScreenAnswer[] = input.filters.map((filter, index) => ({
    axis: filter.axis,
    ...(filter.values === undefined ? {} : { values: [...filter.values] }),
    positive: perFilter[index].size > 0,
    matched_codes: [...perFilter[index]].sort(),
  }));

  return {
    screened: seenCodes.size,
    positive: matched.length > 0,
    all_answered: answers.every((answer) => answer.positive),
    answers,
    matched,
    matched_codes: [...new Set(matched.map((match) => match.icd10_cm))].sort(),
  };
}
