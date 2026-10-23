/**
 * SEC-18 — a consented medical profile is never written in plaintext.
 *
 * The encryption boundary used to fall back to plaintext whenever the
 * application was in pilot mode, which is the default. A pilot deployment with
 * the medical flow enabled and no RECORD_ENCRYPTION_KEY therefore wrote date of
 * birth, conditions and medications to `lead-records.jsonl` in clear — a TDPSA
 * sensitive-data exposure from a backup or a disk snapshot.
 *
 * Two independent controls are locked here:
 *   1. `/api/consent` refuses a medical payload with 503 before anything is
 *      created when no key is configured, in pilot mode too.
 *   2. The writer itself refuses the plaintext fallback for a lead carrying a
 *      medical profile, so a different caller cannot bypass the route.
 */

import { existsSync, readFileSync } from 'fs';
import type { Express } from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { TEST_CONSENT_TEXT } from './helpers/test-session';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

/** A synthetic, low-entropy key long enough for the 32-character floor. */
const TEST_RECORD_ENCRYPTION_KEY = 'test-key-'.repeat(4);

const CONSENT_BODY = {
  contactConsentAffirmed: true,
  contactChannel: 'email',
  email: 'visitor@example.com',
  firstName: 'Sam',
  consentText: TEST_CONSENT_TEXT,
};

const MEDICAL_PROFILE = {
  date_of_birth: '1985-06-15',
  gender: 'female',
  height_inches: 66,
  weight_lbs: 150,
  tobacco_nicotine_use: 'none',
  medical_conditions: ['diabetes'],
  medications: ['metformin'],
  diabetes: { diabetes_type: 'type2', treatment_method: 'pills', last_a1c: '6.8' },
  cancer: null,
};

interface LoadedApp {
  app: Express;
  cleanup: () => Promise<void>;
  leadLog: string;
}

/**
 * Loads the entry point as a fresh module with the given environment and a
 * private lead log, then restores the environment.
 */
async function loadApp(env: Record<string, string>): Promise<LoadedApp> {
  jest.resetModules();
  const previous = { ...process.env };
  const leadLog = tempLogPath('medical-encryption-lead');

  process.env.LIFECHAT_PORT = '0';
  process.env.LLM_API_KEY = '';
  process.env.LEAD_LOG_PATH = leadLog;
  process.env.HEALTH_DATA_COLLECTION_DISABLED = 'false';
  process.env.PILOT_MODE = 'true';
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  const { app, server } = (await import('../src/index')) as {
    app: Express;
    server: Server;
  };

  for (const key of [
    'LIFECHAT_PORT',
    'LLM_API_KEY',
    'LEAD_LOG_PATH',
    'HEALTH_DATA_COLLECTION_DISABLED',
    'PILOT_MODE',
    'RECORD_ENCRYPTION_KEY',
  ]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }

  return {
    app,
    leadLog,
    cleanup: () =>
      new Promise<void>((resolve) => {
        cleanupTempLogs(leadLog);
        server.close(() => resolve());
      }),
  };
}

describe('medical payload without a record-encryption key', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    // An explicit empty value: a defined env var is not overwritten by dotenv,
    // so a developer's .env key cannot make this test pass for the wrong reason.
    loaded = await loadApp({ RECORD_ENCRYPTION_KEY: '' });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('refuses the consented profile with 503 and stores nothing', async () => {
    const res = await request(loaded.app)
      .post('/api/consent')
      .send({
        ...CONSENT_BODY,
        medicalProfile: MEDICAL_PROFILE,
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.1.0',
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Secure storage unavailable');
    expect(res.body.leadId).toBeUndefined();
    // Nothing reached the log: not the medical record, not a contact-only one.
    expect(existsSync(loaded.leadLog)).toBe(false);
  });

  it('still accepts a contact-only submission, so the refusal is specific', async () => {
    const res = await request(loaded.app).post('/api/consent').send(CONSENT_BODY);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('created');
    expect(existsSync(loaded.leadLog)).toBe(true);
  });
});

describe('medical payload with a record-encryption key', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({ RECORD_ENCRYPTION_KEY: TEST_RECORD_ENCRYPTION_KEY });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('stores the profile as an authenticated envelope, not as readable text', async () => {
    const res = await request(loaded.app)
      .post('/api/consent')
      .send({
        ...CONSENT_BODY,
        medicalProfile: MEDICAL_PROFILE,
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.1.0',
      });

    expect(res.status).toBe(200);
    expect(res.body.leadId).toBeTruthy();

    const { isEncryptedRecordLine } = (await import('../src/privacy/record-encryption')) as {
      isEncryptedRecordLine: (line: string) => boolean;
    };
    const lines = readFileSync(loaded.leadLog, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(isEncryptedRecordLine(lines[0])).toBe(true);
    // Neither the health facts nor the contact details are readable at rest.
    expect(lines[0]).not.toContain('diabetes');
    expect(lines[0]).not.toContain('metformin');
    expect(lines[0]).not.toContain('1985-06-15');
    expect(lines[0]).not.toContain(CONSENT_BODY.email);
  });
});

describe('encryption boundary', () => {
  const loadEncryption = async (env: Record<string, string | undefined>) => {
    jest.resetModules();
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return import('../src/privacy/record-encryption');
  };

  it('refuses plaintext for a medical payload even in pilot mode', async () => {
    const mod = await loadEncryption({ PILOT_MODE: 'true', RECORD_ENCRYPTION_KEY: undefined });

    // The ordinary pilot fallback still works…
    expect(mod.encryptRecordLine('{"lead":"plain"}')).toBe('{"lead":"plain"}');
    // …but a caller that marks the payload as medical fails closed instead.
    expect(() => mod.encryptRecordLine('{"medical":true}', { requireEncryption: true })).toThrow(
      /medical information/,
    );
  });

  it('encrypts a medical payload in pilot mode when a key is configured', async () => {
    const mod = await loadEncryption({
      PILOT_MODE: 'true',
      RECORD_ENCRYPTION_KEY: TEST_RECORD_ENCRYPTION_KEY,
    });

    const line = mod.encryptRecordLine('{"medical":true}', { requireEncryption: true });
    expect(mod.isEncryptedRecordLine(line)).toBe(true);
    expect(mod.decryptRecordLine(line)).toBe('{"medical":true}');
  });

  afterAll(() => {
    delete process.env.RECORD_ENCRYPTION_KEY;
    delete process.env.PILOT_MODE;
    jest.resetModules();
  });
});
