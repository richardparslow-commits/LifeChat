/**
 * Consented-profile screening over the crosswalk's qualifier dimensions.
 *
 * Four things are locked here:
 *   1. The axis registry agrees with the vocabulary in every direction — every
 *      code exists, every member's codebook title carries its value's signal, a
 *      value signal never matches a sibling value's members, the marker-bearing
 *      rows are all on a marker axis in the right value, and the maltreatment
 *      family is exactly its two setting values plus the declared unstated
 *      member. A future release that adds or renames a row fails until the axis
 *      records the decision.
 *   2. A screen answers the underwriter's question from the captured refs — the
 *      setting of an abuse history (childhood / adult / unstated), the intent of
 *      a self-harm history (suicidal / nonsuicidal), the organ and the sex split
 *      a qualifier chose — and refuses a malformed query loudly instead of
 *      answering "no".
 *   3. Screening clears the capture path's consent gate, unchanged: the two
 *      entry points agree on every fail-closed state.
 *   4. The boundary: a profile captured through POST /api/consent screens — the
 *      lead record it stores answers the childhood/adult and suicidal/nonsuicidal
 *      questions from its canonical refs alone, exactly as a broker reads them
 *      off storage, and a record without a medical profile offers nothing.
 */

import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';
import {
  CONDITION_VOCABULARY_ID,
  CONDITION_VOCABULARY_VERSION,
  getCanonicalConditionByCode,
  isMedicalProcessingPermitted,
  listCanonicalConditions,
  mapConsentedMedicalConditions,
  type CanonicalConditionRef,
  type MedicalConsentState,
} from '../src/medical/condition-crosswalk';
import {
  CONDITION_SCREEN_AXES,
  CONDITION_SCREEN_UNSTATED_VALUE,
  getConditionScreenAxis,
  listConditionScreenAxes,
  screenAxisValuesForCode,
  screenConsentedConditions,
  type ConditionScreenFilter,
} from '../src/medical/condition-screening';

/** Consent state in the shape the gate expects. */
function consent(
  overrides: Partial<{
    medical_consent_affirmed: boolean;
    medical_consent_version: string | null;
  }> = {},
) {
  return {
    medical_consent_affirmed: true,
    medical_consent_version: '1.0.0',
    ...overrides,
  };
}

/** Captures through the gated mapping entry point, with capture enabled. */
function capture(conditions: string[], sex?: 'male' | 'female'): CanonicalConditionRef[] {
  const mapping = mapConsentedMedicalConditions({
    medicalConditions: conditions,
    consent: consent(),
    healthDataCollectionDisabled: false,
    sex: sex ?? null,
  });
  expect(mapping).not.toBeNull();
  return mapping!.canonical;
}

/** Screens captured refs with a valid consent state. */
function ask(
  canonicalConditions: readonly CanonicalConditionRef[],
  filters: readonly ConditionScreenFilter[],
) {
  return screenConsentedConditions({
    canonicalConditions,
    consent: consent(),
    healthDataCollectionDisabled: false,
    filters,
  });
}

/** Word-start match, the rule the crosswalk uses for title signals. */
function titleNames(rowName: string, signal: string): boolean {
  return new RegExp(`\\b${signal}`).test(rowName.toLowerCase());
}

describe('Screen axes — the registry agrees with the vocabulary', () => {
  test('every axis is a distinction with named values and stable ids', () => {
    for (const axis of CONDITION_SCREEN_AXES) {
      expect(axis.id).toMatch(/^[a-z][a-z_]*$/);
      expect(axis.label.trim().length).toBeGreaterThan(0);
      expect(axis.question.trim().length).toBeGreaterThan(0);
      expect(['sex', 'site', 'words']).toContain(axis.dimension);
      // A one-value axis is not a distinction.
      expect(axis.values.length).toBeGreaterThanOrEqual(2);
      expect(new Set(axis.values.map((value) => value.id)).size).toBe(axis.values.length);
      for (const value of axis.values) {
        expect(value.id).toMatch(/^[a-z][a-z_]*$/);
        expect(value.id).not.toBe(CONDITION_SCREEN_UNSTATED_VALUE);
        expect(value.label.trim().length).toBeGreaterThan(0);
        expect(value.codes.length).toBeGreaterThan(0);
      }
    }
  });

  test('every code exists, is claimed once per axis, and its title carries the value signal', () => {
    for (const axis of CONDITION_SCREEN_AXES) {
      const claimed: string[] = [];
      for (const value of axis.values) {
        for (const code of value.codes) {
          const row = getCanonicalConditionByCode(code);
          expect(row).not.toBeNull();
          expect(titleNames(row!.name, value.title_signal)).toBe(true);
          claimed.push(code);
        }
      }
      for (const code of axis.unstated?.codes ?? []) {
        const row = getCanonicalConditionByCode(code);
        expect(row).not.toBeNull();
        claimed.push(code);
      }
      expect(new Set(claimed).size).toBe(claimed.length);
    }
  });

  test('a value signal never matches a sibling value’s members', () => {
    for (const axis of CONDITION_SCREEN_AXES) {
      for (const value of axis.values) {
        for (const other of axis.values) {
          if (other === value) continue;
          for (const code of other.codes) {
            const row = getCanonicalConditionByCode(code)!;
            expect(titleNames(row.name, value.title_signal)).toBe(false);
          }
        }
      }
    }
  });

  test('an “adult” that is an age range is not on the setting axis', () => {
    // G47.33 is titled "Obstructive sleep apnea (adult) (pediatric)" — the word
    // appears, the distinction does not. This is why the setting axis is proved
    // against the family rather than by sweeping titles for substrings.
    expect(screenAxisValuesForCode('G47.33')).toEqual([]);
    expect(screenAxisValuesForCode('Z91.419')).toEqual([
      { axis: 'abuse_setting', value: 'adult', label: 'In adulthood' },
    ]);
  });

  test('the maltreatment family is exactly its two setting values plus the unstated member', () => {
    const axis = getConditionScreenAxis('abuse_setting')!;
    const onAxis = [
      ...axis.values.flatMap((value) => value.codes),
      ...(axis.unstated?.codes ?? []),
    ].sort();
    const psychosocial = listCanonicalConditions()
      .filter((row) => row.system === 'psychosocial')
      .map((row) => row.icd10_cm)
      .sort();
    expect(onAxis).toEqual(psychosocial);
    expect(axis.unstated?.codes).toEqual(['Z91.42']);
  });

  test('the marker-bearing rows are all on a marker axis, in the right value', () => {
    const markerRows = listCanonicalConditions().filter((row) => row.appliesWhen?.words?.length);
    expect(markerRows.map((row) => row.icd10_cm).sort()).toEqual([
      'Z62.814',
      'Z62.815',
      'Z62.819',
      'Z91.413',
      'Z91.414',
      'Z91.419',
      'Z91.51',
      'Z91.52',
    ]);
    for (const [code, axis, value] of [
      ['Z91.51', 'self_harm_intent', 'suicidal'],
      ['Z91.52', 'self_harm_intent', 'nonsuicidal'],
      ['Z62.819', 'abuse_setting', 'childhood'],
      ['Z62.814', 'abuse_setting', 'childhood'],
      ['Z62.815', 'abuse_setting', 'childhood'],
      ['Z91.419', 'abuse_setting', 'adult'],
      ['Z91.413', 'abuse_setting', 'adult'],
      ['Z91.414', 'abuse_setting', 'adult'],
    ] as const) {
      expect(screenAxisValuesForCode(code)).toEqual([expect.objectContaining({ axis, value })]);
    }
  });

  test('the self-harm axis covers every row the codebook names suicidal or nonsuicidal', () => {
    const axis = getConditionScreenAxis('self_harm_intent')!;
    const onAxis = axis.values.flatMap((value) => value.codes).sort();
    const named = listCanonicalConditions()
      .filter((row) => /\bsuicidal\b|\bnonsuicidal\b/.test(row.name.toLowerCase()))
      .map((row) => row.icd10_cm)
      .sort();
    expect(onAxis).toEqual(named);
  });

  test('the site and sex axes cover exactly the rows that declare those dimensions', () => {
    const siteRows = listCanonicalConditions()
      .filter((row) => row.appliesWhen?.site?.length)
      .map((row) => row.icd10_cm)
      .sort();
    const siteAxis = getConditionScreenAxis('resolved_site')!;
    expect(siteAxis.values.flatMap((value) => value.codes).sort()).toEqual(siteRows);
    expect(siteAxis.unstated?.codes ?? []).toEqual([]);

    const sexRows = listCanonicalConditions()
      .filter((row) => row.appliesWhen?.sex?.length)
      .map((row) => row.icd10_cm)
      .sort();
    const sexAxis = getConditionScreenAxis('resolved_sex')!;
    expect(sexAxis.values.flatMap((value) => value.codes).sort()).toEqual(sexRows);
    expect(sexAxis.unstated?.codes ?? []).toEqual([]);
  });

  test('each sex/site value id is one of the words the row itself declares', () => {
    for (const axis of CONDITION_SCREEN_AXES.filter(
      (candidate) => candidate.dimension !== 'words',
    )) {
      for (const value of axis.values) {
        for (const code of value.codes) {
          const row = getCanonicalConditionByCode(code)!;
          const declared = axis.dimension === 'site' ? row.appliesWhen?.site : row.appliesWhen?.sex;
          expect(declared).toContain(value.id);
        }
      }
    }
  });

  test('lookup helpers answer for axes and codes', () => {
    expect(getConditionScreenAxis('abuse_setting')?.dimension).toBe('words');
    expect(getConditionScreenAxis('nope')).toBeNull();
    expect(screenAxisValuesForCode('I10')).toEqual([]);
    expect(screenAxisValuesForCode(' z62.819 ')).toHaveLength(1);
    // The exported list is a copy: mutating it cannot change the registry.
    const listed = listConditionScreenAxes();
    listed.pop();
    expect(listConditionScreenAxes()).toHaveLength(CONDITION_SCREEN_AXES.length);
  });
});

describe('Screening a captured profile', () => {
  test('answers the setting of an abuse history, in both directions', () => {
    const childhood = ask(capture(['abused as a child']), [
      { axis: 'abuse_setting', values: ['childhood'] },
    ]);
    expect(childhood?.positive).toBe(true);
    expect(childhood?.matched_codes).toEqual(['Z62.819']);
    expect(childhood?.matched[0]).toMatchObject({
      axis: 'abuse_setting',
      value: 'childhood',
      value_label: 'In childhood',
      vocabulary: CONDITION_VOCABULARY_ID,
      vocabulary_version: CONDITION_VOCABULARY_VERSION,
    });

    // The wording that reaches the row by stripping its marker screens the same way.
    expect(
      ask(capture(['history of abuse as a child']), [
        { axis: 'abuse_setting', values: ['childhood'] },
      ])?.matched_codes,
    ).toEqual(['Z62.819']);

    // An adult history answers the adult value and misses the childhood one.
    const adult = capture(['abused as an adult']);
    expect(ask(adult, [{ axis: 'abuse_setting', values: ['adult'] }])?.matched_codes).toEqual([
      'Z91.419',
    ]);
    expect(ask(adult, [{ axis: 'abuse_setting', values: ['childhood'] }])?.positive).toBe(false);
  });

  test('reports a setting the code cannot state as unstated, never as either value', () => {
    const refs = capture(['forced labor']);
    expect(refs.map((ref) => ref.icd10_cm)).toEqual(['Z91.42']);
    expect(ask(refs, [{ axis: 'abuse_setting', values: ['childhood'] }])?.positive).toBe(false);
    expect(ask(refs, [{ axis: 'abuse_setting', values: ['adult'] }])?.positive).toBe(false);

    const unstated = ask(refs, [
      { axis: 'abuse_setting', values: [CONDITION_SCREEN_UNSTATED_VALUE] },
    ]);
    expect(unstated?.positive).toBe(true);
    expect(unstated?.matched[0]).toMatchObject({
      value: 'unstated',
      value_label: 'The code carries no setting',
    });

    // Asking the axis without naming a value includes the unstated answer rather
    // than dropping the row — "the code does not say" is an answer.
    const any = ask(refs, [{ axis: 'abuse_setting' }]);
    expect(any?.matched.map((match) => match.value)).toEqual(['unstated']);
  });

  test('answers the intent of a self-harm history — suicidal or not', () => {
    expect(
      ask(capture(['history of attempted suicide']), [
        { axis: 'self_harm_intent', values: ['suicidal'] },
      ])?.matched_codes,
    ).toEqual(['Z91.51']);
    expect(
      ask(capture(['history of cutting']), [{ axis: 'self_harm_intent', values: ['nonsuicidal'] }])
        ?.matched_codes,
    ).toEqual(['Z91.52']);

    // The opposite value is a clean miss, not the same answer twice.
    expect(
      ask(capture(['history of attempted suicide']), [
        { axis: 'self_harm_intent', values: ['nonsuicidal'] },
      ])?.positive,
    ).toBe(false);
    expect(
      ask(capture(['history of cutting']), [{ axis: 'self_harm_intent', values: ['suicidal'] }])
        ?.positive,
    ).toBe(false);

    // The bare wording asserts neither intent, so nothing is captured to screen.
    expect(capture(['history of self harm'])).toEqual([]);
  });

  test('answers the organ and the sex split a qualifier chose', () => {
    expect(
      ask(capture(['bladder calculus']), [{ axis: 'resolved_site', values: ['bladder'] }])
        ?.matched_codes,
    ).toEqual(['N21.0']);
    expect(
      ask(capture(['ureteric calculus']), [{ axis: 'resolved_site', values: ['ureter'] }])
        ?.matched_codes,
    ).toEqual(['N20.1']);

    expect(
      ask(capture(['urethral stricture'], 'female'), [{ axis: 'resolved_sex', values: ['female'] }])
        ?.matched_codes,
    ).toEqual(['N35.92']);
    expect(
      ask(capture(['urethral stricture'], 'male'), [{ axis: 'resolved_sex', values: ['male'] }])
        ?.matched_codes,
    ).toEqual(['N35.919']);
    // No recorded sex defers the row (the crosswalk's never-guess outcome), so
    // there is nothing for the sex axis to screen.
    expect(capture(['urethral stricture'])).toEqual([]);
  });

  test('asks each criterion independently, and names the conjunctive answer', () => {
    const filters: ConditionScreenFilter[] = [
      { axis: 'abuse_setting', values: ['childhood'] },
      { axis: 'self_harm_intent', values: ['suicidal'] },
    ];

    // A lone childhood history answers one criterion and not the other: the
    // screen found something, but it is not the conjunctive screen.
    const combined = ask(capture(['abused as a child']), filters);
    expect(combined?.positive).toBe(true);
    expect(combined?.all_answered).toBe(false);
    expect(combined?.screened).toBe(1);
    expect(combined?.answers).toEqual([
      {
        axis: 'abuse_setting',
        values: ['childhood'],
        positive: true,
        matched_codes: ['Z62.819'],
      },
      {
        axis: 'self_harm_intent',
        values: ['suicidal'],
        positive: false,
        matched_codes: [],
      },
    ]);

    // A profile that answers both: each captured ref speaks for its own filter.
    const both = ask(capture(['abused as a child', 'history of attempted suicide']), [
      { axis: 'abuse_setting' },
      { axis: 'self_harm_intent', values: ['suicidal'] },
    ]);
    expect(both?.all_answered).toBe(true);
    expect(both?.matched.map((match) => [match.axis, match.value])).toEqual([
      ['abuse_setting', 'childhood'],
      ['self_harm_intent', 'suicidal'],
    ]);
    expect(both?.matched_codes).toEqual(['Z62.819', 'Z91.51']);
    // A filter that names no values reports them as absent, not as empty ones.
    expect(both?.answers[0]).toEqual({
      axis: 'abuse_setting',
      positive: true,
      matched_codes: ['Z62.819'],
    });
  });

  test('counts what was screened, dedupes by code, and misses cleanly', () => {
    const duplicated = [...capture(['abused as a child']), ...capture(['abused as a child'])];
    const result = ask(duplicated, [{ axis: 'abuse_setting', values: ['childhood'] }]);
    expect(result?.screened).toBe(1);
    expect(result?.matched).toHaveLength(1);

    const none = ask(capture(['hypertension']), [{ axis: 'abuse_setting', values: ['adult'] }]);
    expect(none?.positive).toBe(false);
    expect(none?.screened).toBe(1);
    expect(none?.matched).toEqual([]);
    expect(none?.matched_codes).toEqual([]);
  });

  test('refuses a malformed query loudly rather than answering “no”', () => {
    const refs = capture(['abused as a child']);
    const screenWith = (filters: unknown) =>
      screenConsentedConditions({
        canonicalConditions: refs,
        consent: consent(),
        healthDataCollectionDisabled: false,
        filters: filters as ConditionScreenFilter[],
      });
    expect(() => screenWith([])).toThrow(/at least one axis/);
    expect(() => screenWith([{ axis: 'abuse_stting' }])).toThrow(/unknown condition screen axis/);
    expect(() => screenWith([{ axis: 'abuse_setting', values: ['childhoood'] }])).toThrow(
      /has no value/,
    );
    expect(() => screenWith([{ axis: 'abuse_setting', values: 'childhood' }])).toThrow(
      /array of value ids/,
    );
  });

  test('matches by code, so a ref from an older vocabulary version still screens', () => {
    const stored: CanonicalConditionRef[] = [
      {
        icd10_cm: 'Z62.819',
        name: 'Personal history of unspecified abuse in childhood',
        system: 'psychosocial',
        vocabulary: CONDITION_VOCABULARY_ID,
        vocabulary_version: '1.13.0',
      },
    ];
    const result = ask(stored, [{ axis: 'abuse_setting', values: ['childhood'] }]);
    expect(result?.matched_codes).toEqual(['Z62.819']);
    expect(result?.matched[0].vocabulary_version).toBe('1.13.0');
  });

  test('a ref from a foreign vocabulary is not screenable by these axes', () => {
    const foreign = capture(['abused as a child']).map((ref) => ({
      ...ref,
      vocabulary: 'some-other-vocabulary',
    }));
    const result = ask(foreign, [{ axis: 'abuse_setting', values: ['childhood'] }]);
    expect(result?.screened).toBe(0);
    expect(result?.positive).toBe(false);
  });
});

describe('Screening clears the same consent gate as capture', () => {
  const refs = capture(['abused as a child']);
  const filters: ConditionScreenFilter[] = [{ axis: 'abuse_setting' }];

  test('the gate helper is fail-closed, absent consent included', () => {
    expect(
      isMedicalProcessingPermitted({ consent: null, healthDataCollectionDisabled: false }),
    ).toBe(false);
    expect(
      isMedicalProcessingPermitted({ consent: undefined, healthDataCollectionDisabled: false }),
    ).toBe(false);
    expect(
      isMedicalProcessingPermitted({
        consent: consent({ medical_consent_affirmed: false }),
        healthDataCollectionDisabled: false,
      }),
    ).toBe(false);
    expect(
      isMedicalProcessingPermitted({
        consent: consent({ medical_consent_version: null }),
        healthDataCollectionDisabled: false,
      }),
    ).toBe(false);
    expect(
      isMedicalProcessingPermitted({
        consent: consent(),
        healthDataCollectionDisabled: true,
      }),
    ).toBe(false);
    expect(
      isMedicalProcessingPermitted({ consent: consent(), healthDataCollectionDisabled: false }),
    ).toBe(true);
  });

  test('returns null when Phase 2 capture is disabled', () => {
    expect(
      screenConsentedConditions({
        canonicalConditions: refs,
        consent: consent(),
        healthDataCollectionDisabled: true,
        filters,
      }),
    ).toBeNull();
  });

  test('returns null without affirmative medical consent', () => {
    expect(
      screenConsentedConditions({
        canonicalConditions: refs,
        consent: consent({ medical_consent_affirmed: false }),
        healthDataCollectionDisabled: false,
        filters,
      }),
    ).toBeNull();
  });

  test('returns null without a current consent version (unversioned consent is not consent)', () => {
    for (const version of [null, '']) {
      expect(
        screenConsentedConditions({
          canonicalConditions: refs,
          consent: consent({ medical_consent_version: version }),
          healthDataCollectionDisabled: false,
          filters,
        }),
      ).toBeNull();
    }
  });

  test('returns null when the captured refs field is not an array', () => {
    expect(
      screenConsentedConditions({
        canonicalConditions: 'Z62.819' as unknown as CanonicalConditionRef[],
        consent: consent(),
        healthDataCollectionDisabled: false,
        filters,
      }),
    ).toBeNull();
  });

  test('both entry points agree on the gate across every consent state', () => {
    const states: (MedicalConsentState | null | undefined)[] = [
      consent(),
      consent({ medical_consent_affirmed: false }),
      consent({ medical_consent_version: null }),
      null,
      undefined,
    ];
    for (const healthDataCollectionDisabled of [true, false]) {
      for (const state of states) {
        const mapping = mapConsentedMedicalConditions({
          medicalConditions: ['abused as a child'],
          consent: state as MedicalConsentState,
          healthDataCollectionDisabled,
        });
        const screening = screenConsentedConditions({
          canonicalConditions: refs,
          consent: state,
          healthDataCollectionDisabled,
          filters,
        });
        expect(screening === null).toBe(mapping === null);
      }
    }
  });
});

// ── The boundary: capture through /api/consent, screen what storage holds ────

interface LoadedApp {
  app: Express;
  cleanup: () => Promise<void>;
}

/** Loads a fresh app with medical capture enabled and a temp lead log. */
async function loadApp(flagValue: string): Promise<LoadedApp> {
  jest.resetModules();
  const previous = { ...process.env };
  process.env.HEALTH_DATA_COLLECTION_DISABLED = flagValue;
  process.env.LIFECHAT_PORT = '0';
  process.env.LLM_API_KEY = '';
  const leadLogPath = tempLogPath('lead-screening-test');
  process.env.LEAD_LOG_PATH = leadLogPath;

  const { app, server } = (await import('../src/index')) as {
    app: Express;
    server: Server;
  };

  return {
    app,
    cleanup: () =>
      new Promise<void>((resolve) => {
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

interface StoredLead {
  medical_consent_version: string | null;
  medical_consent_timestamp: string | null;
  medical_profile: {
    medical_conditions: string[];
    canonical_conditions: CanonicalConditionRef[];
  } | null;
}

/** The shape a screen reads off a stored lead record, as a broker would. */
async function storedProfile(leadId: string): Promise<StoredLead['medical_profile']> {
  const { getLeadRecord } = (await import('../src/consent/consent-model')) as {
    getLeadRecord: (id: string) => StoredLead | undefined;
  };
  return getLeadRecord(leadId)?.medical_profile ?? null;
}

/** The lead's own consent fields, reshaped for the screening gate. */
async function storedConsent(leadId: string): Promise<MedicalConsentState> {
  const { getLeadRecord } = (await import('../src/consent/consent-model')) as {
    getLeadRecord: (id: string) => StoredLead | undefined;
  };
  const lead = getLeadRecord(leadId);
  return {
    medical_consent_affirmed: lead!.medical_consent_version !== null,
    medical_consent_version: lead!.medical_consent_version,
  };
}

describe('/api/consent → screening — the stored lead record answers the qualifier questions', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp('false');
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  /** Captures a medical profile through the endpoint, as the chat flow would submit it. */
  async function captureProfile(
    medicalConditions: string[],
  ): Promise<{ leadId: string; body: unknown }> {
    const res = await request(loaded.app)
      .post('/api/consent')
      .send({
        contactConsentAffirmed: true,
        contactChannel: 'email',
        email: 'visitor@example.com',
        firstName: 'Sam',
        medicalProfile: { gender: 'female', medical_conditions: medicalConditions },
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.0.0',
      });
    expect(res.status).toBe(200);
    expect(res.body.leadId).toBeTruthy();
    return { leadId: res.body.leadId as string, body: res.body };
  }

  test('a consented profile capture answers both qualifier questions from storage alone', async () => {
    const { leadId, body } = await captureProfile([
      'abused as a child',
      'history of attempted suicide',
      'hypertension',
    ]);

    // The screen reads ONLY what storage holds — the lead's canonical refs and
    // the lead's own consent fields. The stated wording never reaches it.
    const profile = await storedProfile(leadId);
    expect(profile).not.toBeNull();
    const stored = screenConsentedConditions({
      canonicalConditions: profile!.canonical_conditions,
      consent: await storedConsent(leadId),
      healthDataCollectionDisabled: false,
      filters: [
        { axis: 'abuse_setting', values: ['childhood'] },
        { axis: 'self_harm_intent', values: ['suicidal'] },
      ],
    });

    // Both criteria answer from the record: the setting is childhood (Z62.819),
    // the intent was suicidal (Z91.51) — and hypertension answered neither,
    // which is screened and counted, not an error.
    expect(stored).not.toBeNull();
    expect(stored!.screened).toBe(3);
    expect(stored!.all_answered).toBe(true);
    expect(stored!.matched.map((match) => [match.axis, match.value, match.icd10_cm])).toEqual([
      ['abuse_setting', 'childhood', 'Z62.819'],
      ['self_harm_intent', 'suicidal', 'Z91.51'],
    ]);
    expect(stored!.answers).toEqual([
      {
        axis: 'abuse_setting',
        values: ['childhood'],
        positive: true,
        matched_codes: ['Z62.819'],
      },
      {
        axis: 'self_harm_intent',
        values: ['suicidal'],
        positive: true,
        matched_codes: ['Z91.51'],
      },
    ]);

    // The verbatim wording stayed verbatim in storage, and the capture response
    // never echoed any of it back to the client.
    expect(profile!.medical_conditions).toEqual([
      'abused as a child',
      'history of attempted suicide',
      'hypertension',
    ]);
    expect(JSON.stringify(body)).not.toContain('Z62.819');
    expect(JSON.stringify(body)).not.toContain('suicide');
    expect(JSON.stringify(body)).not.toContain('abused');
  });

  test('the same distinctions one value over answer adult and nonsuicidal, and miss cleanly', async () => {
    const { leadId } = await captureProfile(['abused as an adult', 'history of cutting']);
    const profile = await storedProfile(leadId);
    const screen = async (filters: ConditionScreenFilter[]) =>
      screenConsentedConditions({
        canonicalConditions: profile!.canonical_conditions,
        consent: await storedConsent(leadId),
        healthDataCollectionDisabled: false,
        filters,
      });

    expect((await screen([{ axis: 'abuse_setting', values: ['adult'] }]))?.matched_codes).toEqual([
      'Z91.419',
    ]);
    expect((await screen([{ axis: 'abuse_setting', values: ['childhood'] }]))?.positive).toBe(
      false,
    );
    expect(
      (await screen([{ axis: 'self_harm_intent', values: ['nonsuicidal'] }]))?.matched_codes,
    ).toEqual(['Z91.52']);
    expect((await screen([{ axis: 'self_harm_intent', values: ['suicidal'] }]))?.positive).toBe(
      false,
    );

    // The conjunctive screen a broker would actually ask — a CHILDHOOD abuse
    // history AND a suicidal self-harm history — is not answered by this
    // record: each filter is asked independently and only all_answered answers
    // the conjunction, which here is false. (positive is the screen-found-
    // something bit — matched.length > 0 — and it is false too: no stored ref
    // answers either asked value.)
    const both = await screen([
      { axis: 'abuse_setting', values: ['childhood'] },
      { axis: 'self_harm_intent', values: ['suicidal'] },
    ]);
    expect(both?.positive).toBe(false);
    expect(both?.all_answered).toBe(false);
  });

  test('a contact-only lead record offers a screen nothing, and the gate agrees', async () => {
    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'quiet@example.com',
      firstName: 'Alex',
    });
    expect(res.status).toBe(200);

    const profile = await storedProfile(res.body.leadId);
    expect(profile).toBeNull();
    const stored = screenConsentedConditions({
      canonicalConditions: [],
      consent: await storedConsent(res.body.leadId),
      healthDataCollectionDisabled: false,
      filters: [{ axis: 'abuse_setting', values: ['childhood'] }],
    });
    // A contact-only record carries no medical consent, so the screening gate
    // refuses exactly the way the capture path did — fail-closed at the boundary.
    expect(stored).toBeNull();
  });
});
