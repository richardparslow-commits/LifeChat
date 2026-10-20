/**
 * Cache transparency for the lead and DSR record stores.
 *
 * Both stores cap their in-memory LRU in front of an append-only JSONL log.
 * Eviction used to change what could be looked up: a record older than the
 * cache was unreachable through getLeadRecord()/getDsrRecord() even though it
 * was still on disk. These tests shrink the LRU to one entry (the mock below)
 * so eviction happens on the second write, then assert the lookup miss reloads
 * the record from the log — including through the operator-facing DSR route —
 * and leaves the cache primed for the next read.
 */

import request from 'supertest';
import type { Express } from 'express';

import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

const leadLog = tempLogPath('reload-lead');
const dsrLog = tempLogPath('reload-dsr');
const encryptedLeadLog = tempLogPath('reload-lead-encrypted');

// One cached entry per store: the second write evicts the first.
jest.mock('../src/persistence/bounded-lru', () => {
  const actual = jest.requireActual<typeof import('../src/persistence/bounded-lru')>(
    '../src/persistence/bounded-lru',
  );

  class SingleEntryCache<K, V> extends actual.BoundedLruCache<K, V> {
    constructor() {
      super(1);
    }
  }

  return { BoundedLruCache: SingleEntryCache };
});

describe('record lookups reload evicted entries from the JSONL log', () => {
  let leads: typeof import('../src/consent/consent-model');
  let dsrs: typeof import('../src/privacy/dsr');
  let createApp: (typeof import('../src/app'))['createApp'];
  let app: Express;
  const previousAdminKey = process.env.ADMIN_API_KEY;

  beforeAll(async () => {
    process.env.LEAD_LOG_PATH = leadLog;
    process.env.DSR_LOG_PATH = dsrLog;
    // Operator routes are open with no admin key configured (pilot mode); make
    // sure an unrelated value in the shell cannot turn this into a 401 test.
    delete process.env.ADMIN_API_KEY;
    jest.resetModules();

    const [leadStore, dsrStore, appModule] = await Promise.all([
      import('../src/consent/consent-model'),
      import('../src/privacy/dsr'),
      import('../src/app'),
    ]);
    leads = leadStore;
    dsrs = dsrStore;
    createApp = appModule.createApp;
    app = createApp();
  });

  afterAll(async () => {
    await leads.clearAllLeadRecords();
    await dsrs.clearAllDsrRecords();
    cleanupTempLogs(leadLog, dsrLog);
    delete process.env.LEAD_LOG_PATH;
    delete process.env.DSR_LOG_PATH;
    if (previousAdminKey === undefined) {
      delete process.env.ADMIN_API_KEY;
    } else {
      process.env.ADMIN_API_KEY = previousAdminKey;
    }
  });

  beforeEach(async () => {
    await leads.clearAllLeadRecords();
    await dsrs.clearAllDsrRecords();
  });

  it('reloads an evicted lead from the log and re-caches it', async () => {
    const first = leads.createLeadRecord('article-1', '/term-life', 'term_life');
    first.email = 'evicted@example.com';
    expect(await leads.saveLeadRecord(first)).toBe(true);

    const second = leads.createLeadRecord('article-2', '/whole-life', 'whole_life');
    expect(await leads.saveLeadRecord(second)).toBe(true);

    // The exact state a full cache reaches in production: the first record is
    // no longer in memory, and only the newest survives the bound.
    expect(leads.listLeadRecords().map((record) => record.lead_id)).toEqual([second.lead_id]);

    const found = await leads.getLeadRecord(first.lead_id);
    expect(found?.email).toBe('evicted@example.com');
    expect(found?.sanitized_canonical_path).toBe('/term-life');

    // The reload primes the cache: the second lookup is the same object.
    expect(await leads.getLeadRecord(first.lead_id)).toBe(found);
  });

  it('reloads an evicted DSR and keeps its response detail intact', async () => {
    const first = await dsrs.submitDsr({
      requestType: 'access',
      contactEmail: 'first@example.com',
      detail: 'please send my data',
    });
    const second = await dsrs.submitDsr({
      requestType: 'deletion',
      contactEmail: 'second@example.com',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;

    expect(dsrs.listDsrRecords().map((record) => record.request_id)).toEqual([
      second.record.request_id,
    ]);

    const found = await dsrs.getDsrRecord(first.record.request_id);
    expect(found?.request_type).toBe('access');
    expect(found?.contact_email).toBe('first@example.com');
    expect(found?.detail).toBe('please send my data');
  });

  it('serves an evicted DSR through the operator lookup route', async () => {
    const first = await dsrs.submitDsr({
      requestType: 'portability',
      contactEmail: 'operator@example.com',
    });
    const second = await dsrs.submitDsr({
      requestType: 'correction',
      contactEmail: 'second@example.com',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;

    // The route must not report "not found" for a record that exists on disk,
    // merely because the bounded cache dropped it.
    const res = await request(app).get(`/api/dsr/${first.record.request_id}`);
    expect(res.status).toBe(200);
    expect(res.body.requestId).toBe(first.record.request_id);
    expect(res.body.requestType).toBe('portability');
  });

  it('returns undefined for an id that is neither cached nor in the log', async () => {
    await leads.saveLeadRecord(leads.createLeadRecord('a', '/a', 'general'));
    await dsrs.submitDsr({ requestType: 'access', contactEmail: 'a@example.com' });

    await expect(
      leads.getLeadRecord('00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeUndefined();
    await expect(
      dsrs.getDsrRecord('00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeUndefined();
  });
});

describe('encrypted records reload from disk after eviction', () => {
  const key = `reload-test-encryption-key-${'h'.repeat(24)}`;
  let leads: typeof import('../src/consent/consent-model');

  beforeAll(async () => {
    process.env.RECORD_ENCRYPTION_KEY = key;
    process.env.LEAD_LOG_PATH = encryptedLeadLog;
    jest.resetModules();
    leads = await import('../src/consent/consent-model');
  });

  afterAll(async () => {
    await leads.clearAllLeadRecords();
    cleanupTempLogs(encryptedLeadLog);
    delete process.env.RECORD_ENCRYPTION_KEY;
    delete process.env.LEAD_LOG_PATH;
  });

  it('decrypts the log line when reloading an evicted lead', async () => {
    const first = leads.createLeadRecord('article-1', '/iul', 'iul');
    first.email = 'encrypted@example.com';
    expect(await leads.saveLeadRecord(first)).toBe(true);

    const second = leads.createLeadRecord('article-2', '/term-life', 'term_life');
    expect(await leads.saveLeadRecord(second)).toBe(true);
    expect(leads.listLeadRecords()).toHaveLength(1);

    const found = await leads.getLeadRecord(first.lead_id);
    expect(found?.email).toBe('encrypted@example.com');
    expect(found?.sanitized_canonical_path).toBe('/iul');
  });
});
