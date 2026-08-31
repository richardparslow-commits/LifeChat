/**
 * Tests for lead-record persistence and at-rest encryption
 * (src/consent/consent-model.ts).
 *
 * Verifies that consent/lead records survive a simulated process restart
 * (loaded from the JSONL log at module init) and are encrypted at rest when
 * RECORD_ENCRYPTION_KEY is set — lead records and their consent artifacts are
 * legal records under TDPSA retention / consent-proof requirements.
 */

// Use a temp lead log path before importing so tests don't touch the real file
process.env.LEAD_LOG_PATH = `data/lead-test-${Date.now()}.jsonl`;

import {
  clearAllLeadRecords,
  createLeadRecord,
  getLeadRecord,
  listLeadRecords,
  saveLeadRecord,
} from '../src/consent/consent-model';

beforeEach(() => {
  clearAllLeadRecords();
});

afterAll(() => {
  clearAllLeadRecords();
  delete process.env.LEAD_LOG_PATH;
});

describe('lead record store', () => {
  test('saveLeadRecord stores a record retrievable by id', () => {
    const lead = createLeadRecord('article-1', '/term-life', 'term_life');
    saveLeadRecord(lead);
    expect(getLeadRecord(lead.lead_id)).toBe(lead);
    expect(listLeadRecords()).toHaveLength(1);
  });

  test('clearAllLeadRecords empties the store', () => {
    saveLeadRecord(createLeadRecord('a', '/a', 't'));
    clearAllLeadRecords();
    expect(listLeadRecords()).toHaveLength(0);
  });
});

/**
 * Persistence tests — verify lead (consent) records survive a simulated
 * process restart by reloading the module and checking that the JSONL-backed
 * store is populated from disk.
 */
describe('lead persistence across restarts', () => {
  test('a saved lead is loaded after a simulated restart', async () => {
    const lead = createLeadRecord('article-2', '/whole-life', 'whole_life');
    lead.first_name = 'Alex';
    lead.email = 'alex@example.com';
    lead.contact_channel = 'email';
    saveLeadRecord(lead);
    const submittedId = lead.lead_id;

    jest.resetModules();
    const reloaded = await import('../src/consent/consent-model');

    const found = reloaded.getLeadRecord(submittedId);
    expect(found).toBeDefined();
    expect(found?.sanitized_canonical_path).toBe('/whole-life');
    expect(found?.first_name).toBe('Alex');
    expect(found?.email).toBe('alex@example.com');
    expect(found?.contact_channel).toBe('email');

    reloaded.clearAllLeadRecords();
  });

  test('multiple saved leads are all loaded after a simulated restart', async () => {
    saveLeadRecord(createLeadRecord('a', '/a', 't1'));
    saveLeadRecord(createLeadRecord('b', '/b', 't2'));
    expect(listLeadRecords()).toHaveLength(2);

    jest.resetModules();
    const reloaded = await import('../src/consent/consent-model');
    expect(reloaded.listLeadRecords()).toHaveLength(2);
    reloaded.clearAllLeadRecords();
  });

  test('clearAllLeadRecords removes the JSONL file so a restart starts empty', async () => {
    saveLeadRecord(createLeadRecord('a', '/a', 't'));
    clearAllLeadRecords();
    expect(listLeadRecords()).toHaveLength(0);

    jest.resetModules();
    const reloaded = await import('../src/consent/consent-model');
    expect(reloaded.listLeadRecords()).toHaveLength(0);
  });
});

/**
 * At-rest encryption tests — verify leads are written as encrypted envelopes
 * (never plaintext PII) when RECORD_ENCRYPTION_KEY is set, and decrypt on reload.
 */
describe('lead at-rest encryption', () => {
  const encryptedLog = `data/lead-enc-${Date.now()}.jsonl`;
  const key = 'test-encryption-key-999';

  afterAll(async () => {
    process.env.RECORD_ENCRYPTION_KEY = key;
    process.env.LEAD_LOG_PATH = encryptedLog;
    jest.resetModules();
    const mod = await import('../src/consent/consent-model');
    mod.clearAllLeadRecords();
    delete process.env.RECORD_ENCRYPTION_KEY;
    delete process.env.LEAD_LOG_PATH;
    jest.resetModules();
    await import('../src/consent/consent-model');
  });

  async function loadEncryptedModule() {
    process.env.RECORD_ENCRYPTION_KEY = key;
    process.env.LEAD_LOG_PATH = encryptedLog;
    jest.resetModules();
    return await import('../src/consent/consent-model');
  }

  afterEach(() => {
    delete process.env.RECORD_ENCRYPTION_KEY;
    delete process.env.LEAD_LOG_PATH;
  });

  test('writes an encrypted envelope, not plaintext PII, when a key is configured', async () => {
    const mod = await loadEncryptedModule();
    const lead = mod.createLeadRecord('article-3', '/term-life', 'term_life');
    lead.first_name = 'Sam';
    lead.email = 'sam@example.com';
    lead.phone = '5125551234';
    mod.saveLeadRecord(lead);

    const { readFileSync } = await import('fs');
    const line = readFileSync(encryptedLog, 'utf8').trim();
    // No plaintext PII should appear on disk
    expect(line).not.toContain('sam@example.com');
    expect(line).not.toContain('5125551234');
    expect(line).not.toContain('Sam');
    // Encrypted envelope markers
    expect(line).toContain('"v":1');
    expect(line).toContain('"alg":"aes-256-gcm"');
    expect(line).toContain('"iv"');
    expect(line).toContain('"data"');
  });

  test('decrypts encrypted leads on reload so in-memory lookup still works', async () => {
    const first = await loadEncryptedModule();
    const lead = first.createLeadRecord('article-4', '/iul', 'iul');
    lead.email = 'reencrypt@example.com';
    lead.first_name = 'Riley';
    first.saveLeadRecord(lead);

    jest.resetModules();
    const reloaded = await import('../src/consent/consent-model');
    const found = reloaded.getLeadRecord(lead.lead_id);
    expect(found).toBeDefined();
    expect(found?.email).toBe('reencrypt@example.com');
    expect(found?.first_name).toBe('Riley');

    reloaded.clearAllLeadRecords();
  });
});

/**
 * Fail-closed tests — verify a lead is NOT stored or acknowledged when it
 * could not be durably persisted (mirrors the DSR fail-closed behavior in
 * tests/dsr.test.ts). The consent artifact is the TDPSA consent proof, so a
 * lost write must never be confirmed to the consumer.
 */
describe('lead fail-closed persistence', () => {
  afterEach(() => {
    delete process.env.LEAD_LOG_PATH;
  });

  test('saveLeadRecord returns false and stores nothing when the log cannot be written', async () => {
    process.env.LEAD_LOG_PATH = '/dev/null/leads.jsonl';
    jest.resetModules();
    const mod = await import('../src/consent/consent-model');

    const lead = mod.createLeadRecord('article-5', '/term-life', 'term_life');
    lead.email = 'failclosed@example.com';

    expect(mod.saveLeadRecord(lead)).toBe(false);
    // Not acknowledged — nothing in the in-memory store either
    expect(mod.getLeadRecord(lead.lead_id)).toBeUndefined();
    expect(mod.listLeadRecords()).toHaveLength(0);
  });

  test('in-memory store is not polluted across repeated persistence failures', async () => {
    process.env.LEAD_LOG_PATH = '/dev/null/leads.jsonl';
    jest.resetModules();
    const mod = await import('../src/consent/consent-model');

    for (let i = 0; i < 3; i++) {
      const lead = mod.createLeadRecord(`article-${i}`, '/x', 'general');
      expect(mod.saveLeadRecord(lead)).toBe(false);
    }
    expect(mod.listLeadRecords()).toHaveLength(0);
  });
});

/**
 * Keyless-startup warning — when the log holds encrypted records but
 * RECORD_ENCRYPTION_KEY is not configured, the loader must warn instead of
 * silently dropping the consent artifacts (an operational trap).
 */
describe('lead keyless-startup warning', () => {
  const encLog = `data/lead-keyless-${Date.now()}.jsonl`;
  const plainLog = `data/lead-keyless-plain-${Date.now()}.jsonl`;
  const key = 'warning-test-key-999';
  const originalKey = process.env.RECORD_ENCRYPTION_KEY;
  const originalLog = process.env.LEAD_LOG_PATH;

  function restoreEnv() {
    if (originalKey === undefined) {
      delete process.env.RECORD_ENCRYPTION_KEY;
    } else {
      process.env.RECORD_ENCRYPTION_KEY = originalKey;
    }
    process.env.LEAD_LOG_PATH = originalLog as string;
  }

  afterEach(() => {
    restoreEnv();
  });

  afterAll(async () => {
    // Remove the encrypted test log created during these tests
    process.env.RECORD_ENCRYPTION_KEY = key;
    process.env.LEAD_LOG_PATH = encLog;
    jest.resetModules();
    const mod = await import('../src/consent/consent-model');
    mod.clearAllLeadRecords();
    jest.resetModules();
    await import('../src/consent/consent-model');
    restoreEnv();
  });

  test('warns and loads nothing when encrypted records exist but no key is set', async () => {
    // Write one encrypted lead with the key configured
    process.env.RECORD_ENCRYPTION_KEY = key;
    process.env.LEAD_LOG_PATH = encLog;
    jest.resetModules();
    const withKey = await import('../src/consent/consent-model');
    const lead = withKey.createLeadRecord('article-k', '/term-life', 'term_life');
    lead.email = 'keyless@example.com';
    expect(withKey.saveLeadRecord(lead)).toBe(true);

    // Reload without the key — must warn and load zero records
    delete process.env.RECORD_ENCRYPTION_KEY;
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const noKey = await import('../src/consent/consent-model');
      expect(noKey.listLeadRecords()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('RECORD_ENCRYPTION_KEY'));
      expect(warnSpy.mock.calls[0][0]).toContain('skipped');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('does not warn for a plaintext log without a key', async () => {
    const { unlinkSync, existsSync } = await import('fs');
    process.env.LEAD_LOG_PATH = plainLog; // no key
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mod = await import('../src/consent/consent-model');
      const lead = mod.createLeadRecord('article-p', '/faq', 'general');
      lead.email = 'plain@example.com';
      expect(mod.saveLeadRecord(lead)).toBe(true);
      // plaintext log loads fine without a key — no warning expected
      jest.resetModules();
      await import('../src/consent/consent-model');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      if (existsSync(plainLog)) {
        unlinkSync(plainLog);
      }
    }
  });
});
