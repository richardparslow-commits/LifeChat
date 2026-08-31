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
