/**
 * The derived session → lead index (C-07).
 *
 * Consent lookup used to decrypt and scan the whole lead log on the first turn
 * of every session, which measured ~1.4 s for 3,397 records. The index is the
 * durable, PII-free answer: one `{ session_id, lead_id, created_at }` line per
 * consenting session, written with the lead and rebuilt from the log whenever it
 * is missing or older than the log.
 *
 * These tests cover the properties that make that safe: no PII leaves the
 * encrypted record, a restart answers from the index without reading the log,
 * a stale or missing index is repaired rather than trusted, an erasure rewrite
 * cannot leave a deleted session resolving, and the lookup stays O(1) at scale.
 */

import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// The log reader resolves `createReadStream` from the fs module at call time,
// so wrapping it here records every file the store opens during this suite.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, createReadStream: jest.fn(actual.createReadStream) };
});

import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

const leadLog = tempLogPath('session-index-lead');
const indexLog = tempLogPath('session-index-index');

process.env.LEAD_LOG_PATH = leadLog;
process.env.LEAD_SESSION_INDEX_PATH = indexLog;

import { config } from '../src/config/app-config';
import { appendJsonlLine } from '../src/persistence/jsonl-log';

type LeadStore = typeof import('../src/consent/consent-model');

/** Loads a fresh module instance, as a process restart would. */
async function loadStore(): Promise<LeadStore> {
  jest.resetModules();
  return await import('../src/consent/consent-model');
}

/** Loads a fresh instance over empty storage (the index and log are removed). */
async function resetStorage(): Promise<LeadStore> {
  const store = await loadStore();
  await store.clearAllLeadRecords();
  return store;
}

/** A complete, current consent artifact so lookups can verify it. */
function consentedLead(store: LeadStore, sessionId: string, email: string) {
  const lead = store.createLeadRecord('article-1', '/term-life', 'term_life');
  lead.session_id = sessionId;
  lead.first_name = 'Dana';
  lead.email = email;
  lead.phone = '(512) 555-0100';
  lead.contact_channel = 'email';
  lead.contact_consent_version = config.contactConsentVersion;
  lead.consent_timestamp = new Date().toISOString();
  lead.consent_text_hash = 'sha256:test-copy';
  return lead;
}

/** Parsed index lines; missing file reads as empty. */
function readIndex(): Array<Record<string, unknown>> {
  if (!existsSync(indexLog)) return [];
  return readFileSync(indexLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  await resetStorage();
});

afterAll(async () => {
  const store = await loadStore();
  await store.clearAllLeadRecords();
  cleanupTempLogs(leadLog, indexLog);
  delete process.env.LEAD_LOG_PATH;
  delete process.env.LEAD_SESSION_INDEX_PATH;
  jest.resetModules();
});

describe('the index is derived and PII-free', () => {
  it('writes only session_id, lead_id and created_at', async () => {
    const store = await resetStorage();
    const lead = consentedLead(store, 'lpp_indexpurity01', 'dana@example.com');

    expect(await store.saveLeadRecord(lead)).toBe(true);

    expect(readIndex()).toEqual([
      { session_id: 'lpp_indexpurity01', lead_id: lead.lead_id, created_at: lead.created_at },
    ]);

    // The record is the only place the contact details live; the index must not
    // leak them, or it becomes an unencrypted copy of the lead log.
    const raw = readFileSync(indexLog, 'utf8');
    for (const secret of ['dana@example.com', 'Dana', '555-0100']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('removes the index file when the records are cleared', async () => {
    const store = await resetStorage();
    await store.saveLeadRecord(consentedLead(store, 'lpp_clearindex0001', 'a@example.com'));
    expect(existsSync(indexLog)).toBe(true);

    await store.clearAllLeadRecords();
    expect(existsSync(indexLog)).toBe(false);
  });
});

describe('lookup after a restart', () => {
  it('answers an unknown session from the index without reading the lead log', async () => {
    const store = await resetStorage();
    await store.saveLeadRecord(consentedLead(store, 'lpp_knownsession01', 'known@example.com'));

    const restarted = await loadStore();
    await restarted.ensureLeadRecordsLoaded();
    await restarted.ensureSessionIndexLoaded();

    const streamed = jest.requireMock<typeof import('fs')>('fs').createReadStream as jest.Mock;
    // Prove the spy sees the log being read at all, so an empty result below
    // means "not read" rather than "not observable".
    expect(streamed.mock.calls.some(([path]) => String(path) === leadLog)).toBe(true);
    const readsBeforeLookup = streamed.mock.calls.length;

    const result = await restarted.getVerifiedContactConsent('lpp_neverseen00001');

    expect(result).toEqual({ ok: false, reason: 'no_consent_record' });
    const lookupReads = streamed.mock.calls.slice(readsBeforeLookup);
    expect(lookupReads.some(([path]) => String(path) === leadLog)).toBe(false);
  });

  it('still verifies a known session after a restart', async () => {
    const store = await resetStorage();
    const lead = consentedLead(store, 'lpp_knownsession02', 'known@example.com');
    await store.saveLeadRecord(lead);

    const restarted = await loadStore();
    const result = await restarted.getVerifiedContactConsent('lpp_knownsession02');
    expect(result.ok && result.consent.leadId).toBe(lead.lead_id);
  });
});

describe('index repair', () => {
  it('rebuilds a missing index from the lead log', async () => {
    const store = await resetStorage();
    const lead = consentedLead(store, 'lpp_missingindex1', 'rebuild@example.com');
    await store.saveLeadRecord(lead);

    // Simulate a deployment that never had the index (or lost it).
    const { unlinkSync } = await import('fs');
    unlinkSync(indexLog);

    const restarted = await loadStore();
    const result = await restarted.getVerifiedContactConsent('lpp_missingindex1');
    expect(result.ok && result.consent.leadId).toBe(lead.lead_id);
    expect(readIndex().map((entry) => entry.session_id)).toEqual(['lpp_missingindex1']);
  });

  it('rebuilds when the log is newer than the index', async () => {
    const store = await resetStorage();
    await store.saveLeadRecord(consentedLead(store, 'lpp_firstindex001', 'first@example.com'));

    // A record the index never saw: the append failed, or another process wrote
    // the log. The lead is durable, so the repaired index must find it.
    const late = consentedLead(store, 'lpp_secondindex01', 'second@example.com');
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    utimesSync(indexLog, oneMinuteAgo, oneMinuteAgo);
    expect(await appendJsonlLine(leadLog, JSON.stringify(late))).toBe(true);

    const restarted = await loadStore();
    const result = await restarted.getVerifiedContactConsent('lpp_secondindex01');
    expect(result.ok && result.consent.leadId).toBe(late.lead_id);
    expect(
      readIndex()
        .map((entry) => entry.session_id)
        .sort(),
    ).toEqual(['lpp_firstindex001', 'lpp_secondindex01']);
  });

  it('leaves the index untouched when the log cannot be read', async () => {
    const store = await resetStorage();
    const lead = consentedLead(store, 'lpp_unreadable001', 'keep@example.com');
    await store.saveLeadRecord(lead);
    const before = readIndex();

    // A directory at the log path fails the read at the OS level, which is what
    // a mid-stream I/O error does: a truncated rebuild must not overwrite a
    // good index with a shorter one that would then look authoritative.
    const { unlinkSync, mkdirSync, rmdirSync } = await import('fs');
    unlinkSync(leadLog);
    mkdirSync(leadLog);

    try {
      const result = await store.rebuildLeadSessionIndex();
      expect(result.written).toBe(false);
      expect(result.sessionsIndexed).toBe(0);
      expect(readIndex()).toEqual(before);

      // The in-memory mapping is untouched too, so a loaded consent still verifies.
      const verified = await store.getVerifiedContactConsent('lpp_unreadable001');
      expect(verified.ok && verified.consent.leadId).toBe(lead.lead_id);
    } finally {
      rmdirSync(leadLog);
    }
  });

  it('drops the mapping when an erasure rewrite removes the record', async () => {
    const store = await resetStorage();
    await store.saveLeadRecord(consentedLead(store, 'lpp_erasedindex01', 'erased@example.com'));
    expect((await store.getVerifiedContactConsent('lpp_erasedindex01')).ok).toBe(true);

    // The rewrite an erasure performs, then the reload it triggers.
    writeFileSync(leadLog, '');
    await store.reloadLeadRecords();

    expect(await store.getVerifiedContactConsent('lpp_erasedindex01')).toEqual({
      ok: false,
      reason: 'no_consent_record',
    });
    expect(readIndex()).toEqual([]);

    const restarted = await loadStore();
    expect(await restarted.getVerifiedContactConsent('lpp_erasedindex01')).toEqual({
      ok: false,
      reason: 'no_consent_record',
    });
  });
});

describe('scale', () => {
  const BULK = 50_000;

  it(`answers from a ${BULK.toLocaleString('en-US')}-entry index in under 50 ms`, async () => {
    const store = await resetStorage();

    mkdirSync(dirname(indexLog), { recursive: true });
    const lines = Array.from({ length: BULK }, (_, i) =>
      JSON.stringify({
        session_id: `lpp_bulk${String(i).padStart(9, '0')}`,
        lead_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    writeFileSync(indexLog, `${lines.join('\n')}\n`);

    // Hydration is boot work; the lookup is what the chat path pays for.
    await store.ensureSessionIndexLoaded();

    const started = Date.now();
    const result = await store.getVerifiedContactConsent('lpp_notintheindex1');
    const elapsed = Date.now() - started;

    expect(result).toEqual({ ok: false, reason: 'no_consent_record' });
    expect(elapsed).toBeLessThan(50);
  });
});
