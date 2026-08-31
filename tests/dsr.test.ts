/**
 * Tests for the Data Subject Request intake (src/privacy/dsr.ts)
 *
 * Verifies TDPSA request-type validation, contact-email validation,
 * record creation, and the in-memory store.
 */

// Use a temp DSR log path before importing so tests don't touch the real file
process.env.DSR_LOG_PATH = `data/dsr-test-${Date.now()}.jsonl`;

import {
  clearAllDsrRecords,
  DSR_REQUEST_TYPES,
  DSR_RESPONSE_SLA_DAYS,
  getDsrRecord,
  listDsrRecords,
  submitDsr,
} from '../src/privacy/dsr';

beforeEach(() => {
  clearAllDsrRecords();
});

describe('submitDsr — validation', () => {
  test('accepts every TDPSA request type', () => {
    for (const requestType of DSR_REQUEST_TYPES) {
      const result = submitDsr({
        requestType,
        contactEmail: 'user@example.com',
      });
      expect(result.ok).toBe(true);
    }
  });

  test('rejects an unknown request type', () => {
    const result = submitDsr({
      requestType: 'nuclear_option',
      contactEmail: 'user@example.com',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('requestType must be one of');
    }
  });

  test('rejects an invalid contact email', () => {
    const result = submitDsr({
      requestType: 'deletion',
      contactEmail: 'not-an-email',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('valid contact email');
    }
  });
});

describe('submitDsr — record creation', () => {
  test('creates a received record with id, timestamp, and status', () => {
    const result = submitDsr({
      requestType: 'access',
      contactEmail: 'user@example.com',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.request_id).toBeTruthy();
    expect(result.record.created_at).toBeTruthy();
    expect(result.record.request_type).toBe('access');
    expect(result.record.contact_email).toBe('user@example.com');
    expect(result.record.status).toBe('received');
    expect(result.record.detail).toBeNull();
  });

  test('trims and stores the optional detail', () => {
    const result = submitDsr({
      requestType: 'correction',
      contactEmail: 'user@example.com',
      detail: '  my phone number changed  ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.detail).toBe('my phone number changed');
  });

  test('45-day TDPSA response SLA is exposed', () => {
    expect(DSR_RESPONSE_SLA_DAYS).toBe(45);
  });
});

describe('DSR store', () => {
  test('getDsrRecord returns the record by id', () => {
    const result = submitDsr({
      requestType: 'portability',
      contactEmail: 'user@example.com',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getDsrRecord(result.record.request_id)?.request_type).toBe('portability');
  });

  test('getDsrRecord returns undefined for an unknown id', () => {
    expect(getDsrRecord('does-not-exist')).toBeUndefined();
  });

  test('listDsrRecords returns all submitted records', () => {
    submitDsr({ requestType: 'access', contactEmail: 'a@example.com' });
    submitDsr({ requestType: 'deletion', contactEmail: 'b@example.com' });
    expect(listDsrRecords()).toHaveLength(2);
  });

  test('clearAllDsrRecords empties the store', () => {
    submitDsr({ requestType: 'access', contactEmail: 'a@example.com' });
    clearAllDsrRecords();
    expect(listDsrRecords()).toHaveLength(0);
  });
});

/**
 * Persistence tests — verify DSR records survive a simulated process restart.
 *
 * Each test submits one or more records (which append to the JSONL log),
 * then calls jest.resetModules() to drop the module from the require cache.
 * The next dynamic import() re-runs loadDsrRecordsFromDisk() at module init,
 * simulating a fresh process start. The reloaded module should see all
 * previously persisted records in its in-memory store.
 */

describe('DSR persistence across restarts', () => {
  test('a submitted record is loaded after a simulated restart', async () => {
    // 1. Submit a record (persists to JSONL)
    const result = submitDsr({
      requestType: 'access',
      contactEmail: 'persist@example.com',
      detail: 'please send my data',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const submittedId = result.record.request_id;

    // 2. Simulate a process restart: drop the module and re-import.
    //    loadDsrRecordsFromDisk() runs at module init on the fresh import.
    jest.resetModules();
    const reloaded = await import('../src/privacy/dsr');

    // 3. The reloaded module should have the record in its in-memory store.
    const found = reloaded.getDsrRecord(submittedId);
    expect(found).toBeDefined();
    expect(found?.request_type).toBe('access');
    expect(found?.contact_email).toBe('persist@example.com');
    expect(found?.detail).toBe('please send my data');
    expect(found?.status).toBe('received');

    // Cleanup: delete the JSONL file so it doesn't leak into other tests.
    reloaded.clearAllDsrRecords();
  });

  test('multiple submitted records are all loaded after a simulated restart', async () => {
    // Submit three records of different types
    const r1 = submitDsr({ requestType: 'access', contactEmail: 'a@example.com' });
    const r2 = submitDsr({ requestType: 'deletion', contactEmail: 'b@example.com' });
    const r3 = submitDsr({
      requestType: 'correction',
      contactEmail: 'c@example.com',
      detail: 'fix my name',
    });
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    if (!(r1.ok && r2.ok && r3.ok)) return;

    jest.resetModules();
    const reloaded = await import('../src/privacy/dsr');

    expect(reloaded.listDsrRecords()).toHaveLength(3);
    expect(reloaded.getDsrRecord(r1.record.request_id)?.request_type).toBe('access');
    expect(reloaded.getDsrRecord(r2.record.request_id)?.request_type).toBe('deletion');
    expect(reloaded.getDsrRecord(r3.record.request_id)?.detail).toBe('fix my name');

    reloaded.clearAllDsrRecords();
  });

  test('clearAllDsrRecords removes the JSONL file so a restart starts empty', async () => {
    submitDsr({ requestType: 'access', contactEmail: 'clear@example.com' });
    expect(listDsrRecords()).toHaveLength(1);

    // Clear both memory and disk
    clearAllDsrRecords();
    expect(listDsrRecords()).toHaveLength(0);

    // Simulate a restart — the reloaded module should find no records
    jest.resetModules();
    const reloaded = await import('../src/privacy/dsr');
    expect(reloaded.listDsrRecords()).toHaveLength(0);
  });
});

/**
 * At-rest encryption tests — verify that when RECORD_ENCRYPTION_KEY is set,
 * DSR records are written as AES-256-GCM envelopes (never plaintext JSON)
 * and are still decoded correctly on reload.
 */
describe('DSR at-rest encryption', () => {
  const encryptedLog = `data/dsr-enc-${Date.now()}.jsonl`;
  const key = 'test-encryption-key-123';

  afterAll(async () => {
    // Clean up the encrypted log file created during these tests
    process.env.RECORD_ENCRYPTION_KEY = key;
    process.env.DSR_LOG_PATH = encryptedLog;
    jest.resetModules();
    const mod = await import('../src/privacy/dsr');
    mod.clearAllDsrRecords();
    delete process.env.RECORD_ENCRYPTION_KEY;
    delete process.env.DSR_LOG_PATH;
    jest.resetModules();
    await import('../src/privacy/dsr');
  });

  // NOTE: reload the module per test because config is read at module init.
  async function loadEncryptedModule() {
    process.env.RECORD_ENCRYPTION_KEY = key;
    process.env.DSR_LOG_PATH = encryptedLog;
    jest.resetModules();
    return await import('../src/privacy/dsr');
  }

  afterEach(() => {
    delete process.env.RECORD_ENCRYPTION_KEY;
    delete process.env.DSR_LOG_PATH;
  });

  test('writes an encrypted envelope, not plaintext, when a key is configured', async () => {
    const mod = await loadEncryptedModule();
    const result = mod.submitDsr({
      requestType: 'access',
      contactEmail: 'encrypted@example.com',
      detail: 'sensitive PII detail',
    });
    expect(result.ok).toBe(true);

    const { readFileSync } = await import('fs');
    const line = readFileSync(encryptedLog, 'utf8').trim();
    // No plaintext fields should appear on disk
    expect(line).not.toContain('encrypted@example.com');
    expect(line).not.toContain('sensitive PII detail');
    // The line should be an AES-256-GCM envelope
    expect(line).toContain('"v":1');
    expect(line).toContain('"alg":"aes-256-gcm"');
    expect(line).toContain('"iv"');
    expect(line).toContain('"data"');
  });

  test('decrypts encrypted records on reload so in-memory lookup still works', async () => {
    const first = await loadEncryptedModule();
    const result = first.submitDsr({
      requestType: 'deletion',
      contactEmail: 'reencrypt@example.com',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Simulate a restart — the reloaded module loads + decrypts from disk
    jest.resetModules();
    const reloaded = await import('../src/privacy/dsr');
    const found = reloaded.getDsrRecord(result.record.request_id);
    expect(found).toBeDefined();
    expect(found?.contact_email).toBe('reencrypt@example.com');
    expect(found?.request_type).toBe('deletion');

    reloaded.clearAllDsrRecords();
  });

  test('cannot decrypt encrypted records without the correct key', async () => {
    const first = await loadEncryptedModule();
    first.submitDsr({ requestType: 'access', contactEmail: 'wrongkey@example.com' });

    // Reload with a DIFFERENT key — the auth-tag check fails and the line is
    // skipped (never silently misread).
    process.env.RECORD_ENCRYPTION_KEY = 'a-different-key';
    process.env.DSR_LOG_PATH = encryptedLog;
    jest.resetModules();
    const reloaded = await import('../src/privacy/dsr');
    // No records load because the stored envelope can't be authenticated
    expect(reloaded.listDsrRecords()).toHaveLength(0);
  });
});

/**
 * Fail-closed tests — verify a DSR is NOT acknowledged when it could not be
 * durably persisted (e.g. a read-only or unwritable log path). This prevents
 * telling the consumer a TDPSA request was received when it may have been lost.
 */
describe('DSR fail-closed persistence', () => {
  test('submitDsr returns ok:false (not acknowledged) when the log cannot be written', async () => {
    process.env.DSR_LOG_PATH = '/dev/null/records.jsonl';
    jest.resetModules();
    const mod = await import('../src/privacy/dsr');

    const result = mod.submitDsr({
      requestType: 'deletion',
      contactEmail: 'user@example.com',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('could not securely store');
      expect(result.reason).toContain('privacy@lifepolicypilot.blog');
    }
    // Nothing was added to the in-memory store either
    expect(mod.listDsrRecords()).toHaveLength(0);
  });

  test('in-memory store is not polluted when persistence fails', async () => {
    process.env.DSR_LOG_PATH = '/dev/null/records.jsonl';
    jest.resetModules();
    const mod = await import('../src/privacy/dsr');

    // submit many — none should be stored or acknowledged
    for (let i = 0; i < 3; i++) {
      const r = mod.submitDsr({
        requestType: 'access',
        contactEmail: 'u@example.com',
      });
      expect(r.ok).toBe(false);
    }
    expect(mod.listDsrRecords()).toHaveLength(0);
  });
});

/**
 * Keyless-startup warning — when the log holds encrypted records but
 * RECORD_ENCRYPTION_KEY is not configured, the loader must warn instead of
 * silently dropping the records (an operational trap).
 */
describe('DSR keyless-startup warning', () => {
  const encLog = `data/dsr-keyless-${Date.now()}.jsonl`;
  const plainLog = `data/dsr-keyless-plain-${Date.now()}.jsonl`;
  // dsr.ts imports validateEmail from consent-model, so the lead loader runs
  // transitively — point it at an empty temp file so the real dev log's
  // encrypted records do not trigger a warning mid-test.
  const tempLeadLog = `data/dsr-keyless-lead-${Date.now()}.jsonl`;
  const key = 'warning-test-key-123';
  const originalKey = process.env.RECORD_ENCRYPTION_KEY;
  const originalLog = process.env.DSR_LOG_PATH;
  const originalLeadLog = process.env.LEAD_LOG_PATH;

  function restoreEnv() {
    if (originalKey === undefined) {
      delete process.env.RECORD_ENCRYPTION_KEY;
    } else {
      process.env.RECORD_ENCRYPTION_KEY = originalKey;
    }
    process.env.DSR_LOG_PATH = originalLog as string;
    if (originalLeadLog === undefined) {
      delete process.env.LEAD_LOG_PATH;
    } else {
      process.env.LEAD_LOG_PATH = originalLeadLog;
    }
  }

  function useTempEnv() {
    process.env.LEAD_LOG_PATH = tempLeadLog;
  }

  afterEach(() => {
    restoreEnv();
  });

  afterAll(async () => {
    // Remove the encrypted test logs created during these tests
    process.env.RECORD_ENCRYPTION_KEY = key;
    process.env.DSR_LOG_PATH = encLog;
    process.env.LEAD_LOG_PATH = tempLeadLog;
    jest.resetModules();
    const mod = await import('../src/privacy/dsr');
    mod.clearAllDsrRecords();
    jest.resetModules();
    await import('../src/privacy/dsr');
    restoreEnv();
  });

  test('warns and loads nothing when encrypted records exist but no key is set', async () => {
    // Write one encrypted record with the key configured
    process.env.RECORD_ENCRYPTION_KEY = key;
    process.env.DSR_LOG_PATH = encLog;
    useTempEnv();
    jest.resetModules();
    const withKey = await import('../src/privacy/dsr');
    const created = withKey.submitDsr({
      requestType: 'access',
      contactEmail: 'keyless@example.com',
    });
    expect(created.ok).toBe(true);

    // Reload without the key — must warn and load zero records
    delete process.env.RECORD_ENCRYPTION_KEY;
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const noKey = await import('../src/privacy/dsr');
      expect(noKey.listDsrRecords()).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('RECORD_ENCRYPTION_KEY'));
      expect(warnSpy.mock.calls[0][0]).toContain('skipped');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('does not warn for a plaintext log without a key', async () => {
    const { unlinkSync, existsSync } = await import('fs');
    process.env.DSR_LOG_PATH = plainLog; // no key
    useTempEnv();
    jest.resetModules();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mod = await import('../src/privacy/dsr');
      const r = mod.submitDsr({
        requestType: 'access',
        contactEmail: 'plain@example.com',
      });
      expect(r.ok).toBe(true);
      // plaintext log loads fine without a key — no warning expected
      jest.resetModules();
      await import('../src/privacy/dsr');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      if (existsSync(plainLog)) {
        unlinkSync(plainLog);
      }
    }
  });
});
