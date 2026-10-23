/**
 * Record lifecycle: erasure, DSR status transitions, and retention.
 *
 * The behaviour under test is the one the privacy notice promises and the
 * audit found missing:
 *   - a deletion is fulfilled only for a *verified* deletion request;
 *   - the address is derived from the DSR, so one request cannot erase
 *     somebody else's records;
 *   - erased leads disappear from disk and from the serving cache;
 *   - the DSR survives as a PII-free tombstone that records the fulfilment;
 *   - a log that cannot be decoded aborts the erasure with nothing changed;
 *   - retention removes only expired records, never an open request or an
 *     undated one, and a dry run changes nothing.
 */

import { appendFile, readFile } from 'fs/promises';
import request from 'supertest';
import type { Express } from 'express';

import { TEST_CONSENT_TEXT, testSessionId } from './helpers/test-session';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

const leadLog = tempLogPath('lifecycle-lead');
const dsrLog = tempLogPath('lifecycle-dsr');
const erasureLog = tempLogPath('lifecycle-audit');

const retentionLeadLog = tempLogPath('retention-lead');
const retentionDsrLog = tempLogPath('retention-dsr');
const retentionAuditLog = tempLogPath('retention-audit');
const DSR_ADMIN_KEY = 'dsr-admin-secret-0123456789abcdef';
const RETENTION_ADMIN_KEY = 'retention-admin-0123456789abcdef';

type AppModules = {
  app: Express;
  leads: typeof import('../src/consent/consent-model');
  dsrs: typeof import('../src/privacy/dsr');
};

async function loadModules(env: Record<string, string>): Promise<AppModules> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }

  jest.resetModules();
  try {
    const [leads, dsrs, appModule] = await Promise.all([
      import('../src/consent/consent-model'),
      import('../src/privacy/dsr'),
      import('../src/app'),
    ]);
    return { app: appModule.createApp(), leads, dsrs };
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function submitDeletionAndVerify(
  app: Express,
  email: string,
): Promise<{ requestId: string }> {
  const created = await request(app).post('/api/dsr').send({
    requestType: 'deletion',
    contactEmail: email,
  });
  expect(created.status).toBe(200);
  const requestId = created.body.requestId as string;
  const verified = await request(app)
    .post(`/api/dsr/${requestId}/verify`)
    .set('x-admin-key', DSR_ADMIN_KEY)
    .send({});
  expect(verified.status).toBe(200);
  return { requestId };
}

describe('subject erasure through the operator API', () => {
  let modules: AppModules;

  beforeAll(async () => {
    modules = await loadModules({
      PILOT_MODE: 'true',
      ADMIN_API_KEY: DSR_ADMIN_KEY,
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      ERASURE_LOG_PATH: erasureLog,
      RECORD_ENCRYPTION_KEY: '',
    });
  });

  afterAll(async () => {
    await modules.leads.clearAllLeadRecords();
    await modules.dsrs.clearAllDsrRecords();
    cleanupTempLogs(leadLog, dsrLog, erasureLog);
  });

  it('refuses to erase for an unverified deletion request', async () => {
    const created = await request(modules.app)
      .post('/api/dsr')
      .send({ requestType: 'deletion', contactEmail: 'unverified-erase@example.com' });
    expect(created.status).toBe(200);

    const res = await request(modules.app)
      .post(`/api/dsr/${created.body.requestId}/erase`)
      .set('x-admin-key', DSR_ADMIN_KEY)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_verified');

    // Still unverified, still `received` — not advanced by a failed attempt.
    const status = await request(modules.app)
      .get(`/api/dsr/${created.body.requestId}`)
      .set('x-admin-key', DSR_ADMIN_KEY);
    expect(status.body.status).toBe('received');
  });

  it('refuses to erase for a request that is not a deletion', async () => {
    const created = await request(modules.app)
      .post('/api/dsr')
      .send({ requestType: 'access', contactEmail: 'access-erase@example.com' });
    const requestId = created.body.requestId as string;
    await request(modules.app)
      .post(`/api/dsr/${requestId}/verify`)
      .set('x-admin-key', DSR_ADMIN_KEY)
      .send({});

    const res = await request(modules.app)
      .post(`/api/dsr/${requestId}/erase`)
      .set('x-admin-key', DSR_ADMIN_KEY)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_a_deletion');
  });

  it('erases the subject’s leads, tombstones their DSRs, and records a PII-free audit entry', async () => {
    const email = 'erase-me@example.com';
    const sessionId = testSessionId('erase-me');
    const consent = await request(modules.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email,
      firstName: 'Erin',
      sessionId,
      consentText: TEST_CONSENT_TEXT,
    });
    expect(consent.status).toBe(200);
    const leadId = consent.body.leadId as string;

    // A second DSR for the same person (must be tombstoned, not fulfilled) and
    // a third for somebody else (must be untouched).
    const otherRequest = await request(modules.app)
      .post('/api/dsr')
      .send({ requestType: 'access', contactEmail: email });
    await request(modules.app)
      .post(`/api/dsr/${otherRequest.body.requestId}/verify`)
      .set('x-admin-key', DSR_ADMIN_KEY)
      .send({});
    const bystander = await request(modules.app)
      .post('/api/dsr')
      .send({ requestType: 'deletion', contactEmail: 'bystander@example.com' });
    const { requestId } = await submitDeletionAndVerify(modules.app, email);

    const erased = await request(modules.app)
      .post(`/api/dsr/${requestId}/erase`)
      .set('x-admin-key', DSR_ADMIN_KEY)
      .send({});
    expect(erased.status).toBe(200);
    expect(erased.body.status).toBe('fulfilled');
    expect(erased.body.leadRecordsErased).toBe(1);
    expect(erased.body.dsrRecordsRedacted).toBe(2);
    expect(erased.body.auditRecorded).toBe(true);

    // The lead is gone from disk and from the process that just served it.
    expect(await readFile(leadLog, 'utf8')).not.toContain(leadId);
    expect(await modules.leads.getLeadRecord(leadId)).toBeUndefined();

    // The authorizing request is fulfilled; the other request survives as a
    // tombstone with its status intact.
    const fulfilled = await request(modules.app)
      .get(`/api/dsr/${requestId}`)
      .set('x-admin-key', DSR_ADMIN_KEY);
    expect(fulfilled.body.status).toBe('fulfilled');
    expect(fulfilled.body.verified).toBe(true);
    expect(fulfilled.body.fulfilledAt).toEqual(expect.any(String));

    const access = await request(modules.app)
      .get(`/api/dsr/${otherRequest.body.requestId}`)
      .set('x-admin-key', DSR_ADMIN_KEY);
    expect(access.status).toBe(200);
    expect(access.body.status).toBe('verifying');
    expect(access.body.requestType).toBe('access');

    // The address is nowhere in either log; the bystander is intact.
    const dsrText = await readFile(dsrLog, 'utf8');
    expect(dsrText).not.toContain(email);
    expect(dsrText).toContain('bystander@example.com');

    const auditText = await readFile(erasureLog, 'utf8');
    expect(auditText).not.toContain(email);
    expect(auditText).toContain(requestId);
    expect(auditText).toContain('subject_erasure');

    // Fulfilment is one-way.
    const again = await request(modules.app)
      .post(`/api/dsr/${requestId}/erase`)
      .set('x-admin-key', DSR_ADMIN_KEY)
      .send({});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_fulfilled');
    expect(bystander.status).toBe(200);
  });

  it('leaves every log untouched when a record cannot be decoded', async () => {
    const email = 'corrupt-log@example.com';
    const sessionId = testSessionId('corrupt-log');
    const consent = await request(modules.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email,
      sessionId,
      consentText: TEST_CONSENT_TEXT,
    });
    expect(consent.status).toBe(200);
    const leadId = consent.body.leadId as string;

    const { requestId } = await submitDeletionAndVerify(modules.app, email);

    // An encrypted envelope with no key configured: the erasure cannot tell
    // whether it belongs to the subject, so it must not guess.
    await appendFile(
      dsrLog,
      `${JSON.stringify({
        v: 1,
        alg: 'aes-256-gcm',
        iv: 'AAAAAAAAAAAAAAAA',
        tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
        data: 'AAAA',
      })}\n`,
      'utf8',
    );

    const res = await request(modules.app)
      .post(`/api/dsr/${requestId}/erase`)
      .set('x-admin-key', DSR_ADMIN_KEY)
      .send({});
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('undecodable_record');

    // Nothing was rewritten: the lead is still present in the log and the DSR
    // is still awaiting fulfilment.
    expect(await readFile(leadLog, 'utf8')).toContain(leadId);
    const status = await request(modules.app)
      .get(`/api/dsr/${requestId}`)
      .set('x-admin-key', DSR_ADMIN_KEY);
    expect(status.body.status).toBe('verifying');
  });
});

describe('erasure with records encrypted at rest', () => {
  const encryptedLeadLog = tempLogPath('lifecycle-encrypted-lead');
  const encryptedDsrLog = tempLogPath('lifecycle-encrypted-dsr');
  const encryptedAuditLog = tempLogPath('lifecycle-encrypted-audit');
  let modules: AppModules;

  beforeAll(async () => {
    modules = await loadModules({
      PILOT_MODE: 'true',
      ADMIN_API_KEY: DSR_ADMIN_KEY,
      LLM_API_KEY: '',
      LEAD_LOG_PATH: encryptedLeadLog,
      DSR_LOG_PATH: encryptedDsrLog,
      ERASURE_LOG_PATH: encryptedAuditLog,
      RECORD_ENCRYPTION_KEY: `lifecycle-test-key-${'k'.repeat(24)}`,
    });
  });

  afterAll(async () => {
    await modules.leads.clearAllLeadRecords();
    await modules.dsrs.clearAllDsrRecords();
    cleanupTempLogs(encryptedLeadLog, encryptedDsrLog, encryptedAuditLog);
  });

  it('rewrites encrypted logs without exposing the address or the plaintext', async () => {
    const email = 'encrypted-erase@example.com';
    const consent = await request(modules.app)
      .post('/api/consent')
      .send({
        contactConsentAffirmed: true,
        contactChannel: 'email',
        email,
        sessionId: testSessionId('encrypted-erase'),
        consentText: TEST_CONSENT_TEXT,
      });
    expect(consent.status).toBe(200);

    const { requestId } = await submitDeletionAndVerify(modules.app, email);
    const erased = await request(modules.app)
      .post(`/api/dsr/${requestId}/erase`)
      .set('x-admin-key', DSR_ADMIN_KEY)
      .send({});
    expect(erased.status).toBe(200);
    expect(erased.body.leadRecordsErased).toBe(1);

    const leadText = await readFile(encryptedLeadLog, 'utf8').catch(() => '');
    expect(leadText).not.toContain(email);
    expect(leadText.trim() === '' || leadText.trim().startsWith('{"v":1')).toBe(true);

    // The tombstone is still readable through the app (decrypted on load) and
    // remains fulfilled after the rewrite.
    const status = await request(modules.app)
      .get(`/api/dsr/${requestId}`)
      .set('x-admin-key', DSR_ADMIN_KEY);
    expect(status.body.status).toBe('fulfilled');
    expect(status.body.verified).toBe(true);

    const dsrText = await readFile(encryptedDsrLog, 'utf8');
    expect(dsrText).not.toContain(email);

    // The audit log is intentionally not encrypted: it contains no PII.
    const audit = await readFile(encryptedAuditLog, 'utf8');
    expect(audit).toContain('subject_erasure');
    expect(audit).not.toContain(email);
  });
});

describe('retention sweep', () => {
  let modules: AppModules;

  beforeAll(async () => {
    modules = await loadModules({
      PILOT_MODE: 'true',
      ADMIN_API_KEY: RETENTION_ADMIN_KEY,
      LLM_API_KEY: '',
      LEAD_LOG_PATH: retentionLeadLog,
      DSR_LOG_PATH: retentionDsrLog,
      ERASURE_LOG_PATH: retentionAuditLog,
      RECORD_ENCRYPTION_KEY: '',
    });
  });

  afterAll(async () => {
    await modules.leads.clearAllLeadRecords();
    await modules.dsrs.clearAllDsrRecords();
    cleanupTempLogs(retentionLeadLog, retentionDsrLog, retentionAuditLog);
  });

  it('removes only expired records, keeps open requests, and supports a dry run', async () => {
    const oldLead = modules.leads.createLeadRecord('old', '/old', 'general');
    oldLead.created_at = '2020-01-01T00:00:00.000Z';
    oldLead.email = 'old-lead@example.com';
    expect(await modules.leads.saveLeadRecord(oldLead)).toBe(true);

    const newLead = modules.leads.createLeadRecord('new', '/new', 'general');
    newLead.email = 'new-lead@example.com';
    expect(await modules.leads.saveLeadRecord(newLead)).toBe(true);

    const old = (status: string, requestId: string) => ({
      request_id: requestId,
      created_at: '2020-01-01T00:00:00.000Z',
      request_type: 'deletion',
      contact_email: 'erased',
      detail: null,
      status,
      verified: true,
      verified_at: '2020-01-02T00:00:00.000Z',
      fulfilled_at: status === 'fulfilled' ? '2020-01-03T00:00:00.000Z' : null,
    });

    await appendFile(
      retentionDsrLog,
      [
        JSON.stringify(old('fulfilled', 'old-fulfilled')),
        JSON.stringify(old('received', 'old-open')),
        JSON.stringify({
          ...old('fulfilled', 'undated'),
          created_at: '',
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    const dry = await request(modules.app)
      .post('/api/admin/retention/sweep')
      .set('x-admin-key', RETENTION_ADMIN_KEY)
      .send({ dryRun: true, retentionDays: 365 });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.leadRecordsRemoved).toBe(1);
    expect(dry.body.dsrRecordsRemoved).toBe(1);
    expect(dry.body.auditRecorded).toBe(false);

    // A dry run changes nothing.
    expect(await readFile(retentionLeadLog, 'utf8')).toContain('old-lead@example.com');
    expect(await readFile(retentionDsrLog, 'utf8')).toContain('old-fulfilled');

    const real = await request(modules.app)
      .post('/api/admin/retention/sweep')
      .set('x-admin-key', RETENTION_ADMIN_KEY)
      .send({ retentionDays: 365 });
    expect(real.status).toBe(200);
    expect(real.body.leadRecordsRemoved).toBe(1);
    expect(real.body.dsrRecordsRemoved).toBe(1);
    expect(real.body.undatedRecordsKept).toBe(1);
    expect(real.body.auditRecorded).toBe(true);

    const leadsAfter = await readFile(retentionLeadLog, 'utf8');
    expect(leadsAfter).not.toContain('old-lead@example.com');
    expect(leadsAfter).toContain('new-lead@example.com');

    const dsrsAfter = await readFile(retentionDsrLog, 'utf8');
    expect(dsrsAfter).not.toContain('old-fulfilled');
    // An open request is evidence of an outstanding obligation: kept.
    expect(dsrsAfter).toContain('old-open');
    // So is a record whose age cannot be established.
    expect(dsrsAfter).toContain('undated');

    const audit = await readFile(retentionAuditLog, 'utf8');
    expect(audit).toContain('retention_sweep');
    expect(audit).not.toContain('@example.com');
  });

  it('answers 503 outside pilot mode without a key', async () => {
    const locked = await loadModules({
      PILOT_MODE: 'false',
      ADMIN_API_KEY: '',
      LEAD_LOG_PATH: retentionLeadLog,
      DSR_LOG_PATH: retentionDsrLog,
      ERASURE_LOG_PATH: retentionAuditLog,
    });
    const res = await request(locked.app).post('/api/admin/retention/sweep').send({});
    expect(res.status).toBe(503);
  });
});
