/**
 * Canonical medical-condition crosswalk.
 *
 * Two things are locked here:
 *   1. The mapping behavior — exact matching only, verbatim preservation of
 *      unmapped text, dedupe, ordering, and the vocabulary's build hygiene.
 *   2. The consent gate — `mapConsentedMedicalConditions()` is fail-closed, and
 *      the /api/consent endpoint refuses to store a medical profile without an
 *      enabled flow plus affirmative, versioned medical consent.
 */

import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';
import {
  CANONICAL_CONDITIONS,
  CONDITION_DATA_CLASSIFICATION,
  CONDITION_SYSTEMS,
  CONDITION_VOCABULARY_CHANGELOG,
  CONDITION_VOCABULARY_ID,
  CONDITION_VOCABULARY_VERSION,
  findCanonicalCondition,
  findDuplicateAliases,
  getCanonicalConditionByCode,
  groupConditionsBySystem,
  listCanonicalConditions,
  mapConsentedMedicalConditions,
  normalizeConditionText,
  searchCanonicalConditions,
  toCanonicalRef,
  type CanonicalConditionRef,
} from '../src/medical/condition-crosswalk';

/** Numeric semver comparison: negative, zero, or positive. */
function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
  const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

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

/** Maps through the gated entry point with capture enabled. */
function mapConditions(conditions: string[]) {
  return mapConsentedMedicalConditions({
    medicalConditions: conditions,
    consent: consent(),
    healthDataCollectionDisabled: false,
  });
}

describe('Condition crosswalk — vocabulary hygiene', () => {
  test('every ICD-10-CM code is unique', () => {
    const codes = CANONICAL_CONDITIONS.map((c) => c.icd10_cm);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test('every canonical name is unique', () => {
    const names = CANONICAL_CONDITIONS.map((c) => c.name.toUpperCase());
    expect(new Set(names).size).toBe(names.length);
  });

  test('no alias is claimed by two different conditions', () => {
    expect(findDuplicateAliases()).toEqual([]);
  });

  test('every entry has a code, a name, a system, and at least one synonym', () => {
    for (const condition of CANONICAL_CONDITIONS) {
      expect(condition.icd10_cm).toMatch(/^[A-Z]\d{2}(\.\d+)?$/);
      expect(condition.name.trim().length).toBeGreaterThan(0);
      expect(CONDITION_SYSTEMS).toContain(condition.system);
      expect(condition.synonyms.length).toBeGreaterThan(0);
      for (const synonym of condition.synonyms) {
        expect(synonym.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('the vocabulary is versioned and classified as sensitive health data', () => {
    expect(CONDITION_VOCABULARY_ID).toBe('lifechat-condition-v1');
    expect(CONDITION_VOCABULARY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CONDITION_DATA_CLASSIFICATION).toBe('tdpsa_sensitive_health');
  });

  test('the release history is append-only, newest first, and semver-ordered', () => {
    const versions = CONDITION_VOCABULARY_CHANGELOG.map((revision) => revision.version);
    expect(new Set(versions).size).toBe(versions.length);
    // The published version and the history can never disagree.
    expect(versions[0]).toBe(CONDITION_VOCABULARY_VERSION);
    for (const revision of CONDITION_VOCABULARY_CHANGELOG) {
      expect(revision.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(revision.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(revision.summary.trim().length).toBeGreaterThan(0);
    }
    for (let i = 1; i < versions.length; i++) {
      expect(compareVersions(versions[i - 1], versions[i])).toBeGreaterThan(0);
    }
  });

  test('the release history accounts for the whole vocabulary and its alias moves', () => {
    // Chained counts: each release's total must be the previous total plus what
    // it added. This is what makes an unrecorded vocabulary edit impossible —
    // add or remove a condition and the newest count no longer matches.
    const [newest] = CONDITION_VOCABULARY_CHANGELOG;
    expect(newest.condition_count).toBe(CANONICAL_CONDITIONS.length);
    for (let i = 1; i < CONDITION_VOCABULARY_CHANGELOG.length; i++) {
      const newer = CONDITION_VOCABULARY_CHANGELOG[i - 1];
      const older = CONDITION_VOCABULARY_CHANGELOG[i];
      expect(newer.condition_count).toBe(older.condition_count + newer.added.length);
    }

    const addedCodes = CONDITION_VOCABULARY_CHANGELOG.flatMap((revision) => revision.added);
    expect(new Set(addedCodes).size).toBe(addedCodes.length);
    for (const code of addedCodes) {
      expect(getCanonicalConditionByCode(code)).not.toBeNull();
    }

    // A moved alias is a claim about behavior, so it is checked as behavior:
    // the alias resolves to the new code and no longer to the old one.
    for (const revision of CONDITION_VOCABULARY_CHANGELOG) {
      for (const move of revision.aliases_moved) {
        expect(getCanonicalConditionByCode(move.from)).not.toBeNull();
        expect(getCanonicalConditionByCode(move.to)).not.toBeNull();
        expect(findCanonicalCondition(move.alias)?.icd10_cm).toBe(move.to);
        expect(findCanonicalCondition(move.alias)?.icd10_cm).not.toBe(move.from);
      }
    }
  });

  test('the PTSD phenome outcomes in the review literature are represented', () => {
    // The conditions the attached reviews treat as the strongest PTSD
    // outcomes — a spot check that the vocabulary covers the intended domains.
    const required = [
      'I10', // hypertension
      'I25.10', // coronary heart disease
      'I21.9', // myocardial infarction
      'I50.9', // heart failure
      'I63.9', // stroke
      'E11.9', // type 2 diabetes
      'E88.81', // metabolic syndrome
      'G47.33', // obstructive sleep apnea
      'G47.00', // insomnia
      'G30.9', // Alzheimer's
      'G20', // Parkinson's
      'M32.9', // lupus
      'M06.9', // rheumatoid arthritis
      'G35', // multiple sclerosis
      'M79.7', // fibromyalgia
      'G93.32', // ME/CFS
      'K58.9', // IBS
      'F43.10', // PTSD
    ];
    for (const code of required) {
      expect(getCanonicalConditionByCode(code)).not.toBeNull();
    }
  });

  test('listCanonicalConditions returns a copy, not the live vocabulary', () => {
    const before = listCanonicalConditions().length;
    listCanonicalConditions().pop();
    expect(listCanonicalConditions().length).toBe(before);
  });
});

describe('Condition crosswalk — normalization and exact matching', () => {
  test('normalization lowercases, strips punctuation/separators, and drops leading articles', () => {
    expect(normalizeConditionText('  Type 2 Diabetes  ')).toBe('type 2 diabetes');
    expect(normalizeConditionText('High Blood-Pressure')).toBe('high blood pressure');
    expect(normalizeConditionText("Crohn's disease")).toBe('crohns disease');
    expect(normalizeConditionText('a heart attack')).toBe('heart attack');
    expect(normalizeConditionText('COPD (emphysema)')).toBe('copd emphysema');
    expect(normalizeConditionText('Sjögren syndrome')).toBe('sjogren syndrome');
  });

  test('resolves stated wording, abbreviations, and synonyms to a canonical entry', () => {
    const cases: [string, string][] = [
      ['high blood pressure', 'I10'],
      ['HTN', 'I10'],
      ['type 2 diabetes', 'E11.9'],
      ['insulin dependent diabetes', 'E10.9'],
      ['heart attack', 'I21.9'],
      ['PTSD', 'F43.10'],
      ['complex PTSD', 'F43.10'],
      ['lupus', 'M32.9'],
      ['sleep apnea', 'G47.33'],
      ['CPAP', 'G47.33'],
      ['chronic fatigue syndrome', 'G93.32'],
      ['Parkinsons disease', 'G20'],
      ["Crohn's disease", 'K50.90'],
      ['Sjögren syndrome', 'M35.00'],
      ['high cholesterol', 'E78.5'],
      ['dialysis', 'N18.6'],
    ];
    for (const [stated, expectedCode] of cases) {
      expect(findCanonicalCondition(stated)?.icd10_cm).toBe(expectedCode);
    }
  });

  test('accepts a normalized plural of a curated alias', () => {
    expect(findCanonicalCondition('migraines')?.icd10_cm).toBe('G43.909');
    expect(findCanonicalCondition('migraine')?.icd10_cm).toBe('G43.909');
  });

  test('accepts an ICD-10-CM code as stated input', () => {
    expect(findCanonicalCondition('E11.9')?.name).toBe(
      'Type 2 diabetes mellitus without complications',
    );
  });

  test('never guesses: unmatched or near-miss text resolves to null', () => {
    expect(findCanonicalCondition('chronic lyme disease')).toBeNull();
    expect(findCanonicalCondition('broken left femur')).toBeNull();
    expect(findCanonicalCondition('diabetesss')).toBeNull();
    // "sugar diabetes" is a real lay term but does not say type 1 or 2, so it
    // stays unmapped rather than being coerced onto the type 2 code.
    expect(findCanonicalCondition('sugar diabetes')).toBeNull();
    // No substring matching — a longer phrase containing an alias does not match.
    expect(findCanonicalCondition('high blood pressure reading of 150')).toBeNull();
    expect(findCanonicalCondition('')).toBeNull();
    expect(findCanonicalCondition('   ')).toBeNull();
  });

  test('lookup by code is exact and null-safe', () => {
    expect(getCanonicalConditionByCode('I10')?.system).toBe('cardiovascular');
    expect(getCanonicalConditionByCode(' i10 ')?.icd10_cm).toBe('I10');
    expect(getCanonicalConditionByCode('I10.9')).toBeNull();
  });

  test('vocabulary search matches names, synonyms, and codes (vocabulary only)', () => {
    expect(searchCanonicalConditions('sleep').map((c) => c.icd10_cm)).toEqual(
      expect.arrayContaining(['G47.00', 'G47.33']),
    );
    // "narcolepsy" carries no "sleep" in its name or aliases, so it only
    // surfaces on a term that is actually in the vocabulary.
    expect(searchCanonicalConditions('narcolepsy').map((c) => c.icd10_cm)).toContain('G47.419');
    expect(searchCanonicalConditions('I10').map((c) => c.icd10_cm)).toContain('I10');
    expect(searchCanonicalConditions('')).toEqual([]);
    expect(searchCanonicalConditions('zzzzz')).toEqual([]);
  });

  test('canonical refs are vocabulary-tagged', () => {
    const entry = getCanonicalConditionByCode('E11.9');
    expect(entry).not.toBeNull();
    const ref = toCanonicalRef(entry!);
    expect(ref).toEqual({
      icd10_cm: 'E11.9',
      name: 'Type 2 diabetes mellitus without complications',
      system: 'metabolic',
      vocabulary: CONDITION_VOCABULARY_ID,
      vocabulary_version: CONDITION_VOCABULARY_VERSION,
    });
  });
});

describe('Condition crosswalk — gated mapping (fail-closed)', () => {
  test('returns null when Phase 2 capture is disabled', () => {
    expect(
      mapConsentedMedicalConditions({
        medicalConditions: ['diabetes'],
        consent: consent(),
        healthDataCollectionDisabled: true,
      }),
    ).toBeNull();
  });

  test('returns null without affirmative medical consent', () => {
    expect(
      mapConsentedMedicalConditions({
        medicalConditions: ['diabetes'],
        consent: consent({ medical_consent_affirmed: false }),
        healthDataCollectionDisabled: false,
      }),
    ).toBeNull();
  });

  test('returns null without a current consent version (unversioned consent is not consent)', () => {
    for (const version of [null, '']) {
      expect(
        mapConsentedMedicalConditions({
          medicalConditions: ['diabetes'],
          consent: consent({ medical_consent_version: version }),
          healthDataCollectionDisabled: false,
        }),
      ).toBeNull();
    }
  });

  test('returns null when the conditions field is not an array', () => {
    expect(
      mapConsentedMedicalConditions({
        medicalConditions: 'diabetes' as unknown as string[],
        consent: consent(),
        healthDataCollectionDisabled: false,
      }),
    ).toBeNull();
  });

  test('maps, dedupes, and preserves first-stated order', () => {
    const result = mapConditions(['type 2 diabetes', 'hypertension', 'diabetes', 'HTN']);
    expect(result).not.toBeNull();
    expect(result!.canonical.map((r) => r.icd10_cm)).toEqual(['E11.9', 'I10']);
    expect(result!.unmapped).toEqual([]);
    expect(result!.vocabulary).toBe(CONDITION_VOCABULARY_ID);
    expect(result!.vocabulary_version).toBe(CONDITION_VOCABULARY_VERSION);
  });

  test('keeps unmatched conditions verbatim instead of coercing them onto a code', () => {
    // "brain fog" and "a torn meniscus" are deliberately outside the
    // vocabulary: the first is a symptom, the second an injury detail with no
    // curated code, and neither may be coerced onto a nearby condition.
    const result = mapConditions(['diabetes', 'brain fog', 'a torn meniscus']);
    expect(result!.canonical.map((r) => r.icd10_cm)).toEqual(['E11.9']);
    expect(result!.unmapped).toEqual(['brain fog', 'a torn meniscus']);
  });

  test('ignores blank and non-string entries, and dedupes repeated unmapped text', () => {
    const result = mapConditions([
      '  ',
      'diabetes',
      'unknown condition',
      'unknown condition',
      'diabetes',
    ]);
    expect(result!.canonical).toHaveLength(1);
    expect(result!.unmapped).toEqual(['unknown condition']);
  });

  test('an empty consented profile maps to an empty result, not null', () => {
    const result = mapConditions([]);
    expect(result).not.toBeNull();
    expect(result!.canonical).toEqual([]);
    expect(result!.unmapped).toEqual([]);
  });

  test('no single entry is lost — every stated condition is matched or flagged', () => {
    const stated = ['diabetes', 'PTSD', 'something unlisted', 'migraines'];
    const result = mapConditions(stated);
    expect(result!.canonical.length + result!.unmapped.length).toBe(stated.length);
  });
});

describe('Condition crosswalk — system rollups', () => {
  test('groups refs by body system, most-represented first then alphabetically', () => {
    const refs: CanonicalConditionRef[] = ['E11.9', 'I10', 'I25.10', 'M79.7'].map((code) =>
      toCanonicalRef(getCanonicalConditionByCode(code)!),
    );
    const groups = groupConditionsBySystem(refs);
    expect(groups[0]).toEqual({
      system: 'cardiovascular',
      count: 2,
      icd10_cm: ['I10', 'I25.10'],
    });
    expect(groups.map((g) => g.system)).toEqual(['cardiovascular', 'metabolic', 'musculoskeletal']);
  });

  test('an empty ref list produces no groups', () => {
    expect(groupConditionsBySystem([])).toEqual([]);
  });
});

// ── Endpoint gating ──────────────────────────────────────────────────────────

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
  const leadLogPath = tempLogPath('lead-crosswalk-test');
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

const consentBody = {
  contactConsentAffirmed: true,
  contactChannel: 'email',
  email: 'visitor@example.com',
  firstName: 'Sam',
};

const medicalProfile = {
  date_of_birth: '1985-06-15',
  gender: 'female',
  height_inches: 66,
  weight_lbs: 150,
  tobacco_nicotine_use: 'none',
  medical_conditions: ['diabetes', 'high blood pressure', 'a torn meniscus'],
  medications: ['metformin'],
  diabetes: { diabetes_type: 'type2', treatment_method: 'pills', last_a1c: '6.8' },
  cancer: null,
};

describe('/api/consent — medical profile is refused while capture is disabled', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp('');
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  test('rejects a consented medical payload with 400 and stores nothing', async () => {
    const res = await request(loaded.app)
      .post('/api/consent')
      .send({
        ...consentBody,
        medicalProfile,
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.0.0',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Medical capture is disabled');
    expect(res.body.leadId).toBeUndefined();

    const { listLeadRecords } = (await import('../src/consent/consent-model')) as {
      listLeadRecords: () => unknown[];
    };
    expect(listLeadRecords()).toHaveLength(0);
  });

  test('still accepts an ordinary contact-only submission', async () => {
    const res = await request(loaded.app).post('/api/consent').send(consentBody);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('created');
  });
});

describe('/api/consent — consented medical profile is crosswalked and stored', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp('false');
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  test('refuses a medical payload without affirmative, versioned consent', async () => {
    const { listLeadRecords } = (await import('../src/consent/consent-model')) as {
      listLeadRecords: () => unknown[];
    };
    const before = listLeadRecords().length;

    for (const body of [
      { medicalProfile, medicalConsentAffirmed: false, medicalConsentVersion: '1.0.0' },
      { medicalProfile, medicalConsentAffirmed: true },
      {
        medicalProfile: { diabetes: 'yes' },
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.0.0',
      },
    ]) {
      const res = await request(loaded.app)
        .post('/api/consent')
        .send({ ...consentBody, ...body });
      expect(res.status).toBe(400);
      expect(res.body.leadId).toBeUndefined();
    }

    expect(listLeadRecords().length).toBe(before);
  });

  test('stores the consented profile with canonical refs, keeping stated wording verbatim', async () => {
    const res = await request(loaded.app)
      .post('/api/consent')
      .send({
        ...consentBody,
        medicalProfile,
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.0.0',
      });
    expect(res.status).toBe(200);
    expect(res.body.leadId).toBeTruthy();

    const { getLeadRecord } = (await import('../src/consent/consent-model')) as {
      getLeadRecord: (id: string) =>
        | {
            medical_consent_version: string | null;
            medical_consent_timestamp: string | null;
            medical_profile: {
              medical_conditions: string[];
              canonical_conditions: { icd10_cm: string; vocabulary: string }[];
            } | null;
          }
        | undefined;
    };

    const lead = getLeadRecord(res.body.leadId);
    expect(lead).toBeDefined();
    expect(lead!.medical_consent_version).toBe('1.0.0');
    expect(lead!.medical_consent_timestamp).toBeTruthy();
    // Stated wording is preserved verbatim — the crosswalk is additive.
    expect(lead!.medical_profile!.medical_conditions).toEqual(medicalProfile.medical_conditions);
    expect(lead!.medical_profile!.canonical_conditions.map((c) => c.icd10_cm)).toEqual([
      'E11.9',
      'I10',
    ]);
    expect(lead!.medical_profile!.canonical_conditions[0].vocabulary).toBe(CONDITION_VOCABULARY_ID);

    // The response never echoes medical data back to the client.
    expect(JSON.stringify(res.body)).not.toContain('E11.9');
    expect(JSON.stringify(res.body)).not.toContain('diabetes');
  });

  test('a contact-only submission stores no medical profile and no medical consent', async () => {
    const res = await request(loaded.app).post('/api/consent').send(consentBody);
    expect(res.status).toBe(200);

    const { getLeadRecord } = (await import('../src/consent/consent-model')) as {
      getLeadRecord: (id: string) =>
        | {
            medical_consent_version: string | null;
            medical_profile: unknown;
          }
        | undefined;
    };
    const lead = getLeadRecord(res.body.leadId);
    expect(lead!.medical_profile).toBeNull();
    expect(lead!.medical_consent_version).toBeNull();
  });
});
