/**
 * Lead export (SEC-08).
 *
 * The audit found the record system write-only from the API: a broker could
 * retrieve a lead only with filesystem access and the encryption key. These
 * tests pin the read path that closes that gap:
 *
 *   - it is admin-only outside pilot mode;
 *   - it is paginated, newest first, with a stable cursor;
 *   - it reads the durable log, not the bounded serving cache;
 *   - it refuses a partial export when a line cannot be decoded;
 *   - it marks a lead suppressed by a *verified* deletion, and only then;
 *   - it writes a PII-free access audit line before returning records, and
 *     refuses the export when that write fails.
 */

import { appendFile, readFile, unlink, writeFile } from 'fs/promises';
import request from 'supertest';
import type { Express } from 'express';

import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';
import type { LeadRecord } from '../src/consent/consent-model';

type AppModules = {
  app: Express;
  leads: typeof import('../src/consent/consent-model');
  dsrs: typeof import('../src/privacy/dsr');
};

/** Builds an app under `env`; the returned registry keeps those values. */
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

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

async function saveLead(
  modules: AppModules,
  overrides: Partial<LeadRecord> = {},
): Promise<LeadRecord> {
  const lead = modules.leads.createLeadRecord('term-life-101', '/term-life', 'term_life');
  Object.assign(lead, overrides);
  expect(await modules.leads.saveLeadRecord(lead)).toBe(true);
  return lead;
}

const ADMIN_KEY = 'a'.repeat(40);

/** Admin read with the key the suite configured. */
function adminGet(app: Express, path: string) {
  return request(app).get(path).set('x-admin-key', ADMIN_KEY);
}

function auditLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('lead export pagination, ordering, and completeness', () => {
  const leadLog = tempLogPath('export-lead');
  const dsrLog = tempLogPath('export-dsr');
  const accessLog = tempLogPath('export-access');
  let modules: AppModules;

  beforeAll(async () => {
    modules = await loadModules({
      PILOT_MODE: 'true',
      ADMIN_API_KEY: ADMIN_KEY,
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      LEAD_ACCESS_LOG_PATH: accessLog,
      RECORD_ENCRYPTION_KEY: '',
    });
  });

  beforeEach(async () => {
    await modules.leads.clearAllLeadRecords();
    await modules.dsrs.clearAllDsrRecords();
    await removeIfPresent(accessLog);
  });

  afterAll(async () => {
    await modules.leads.clearAllLeadRecords();
    await modules.dsrs.clearAllDsrRecords();
    cleanupTempLogs(leadLog, dsrLog, accessLog);
  });

  it('returns the newest records first across two pages without overlap', async () => {
    const oldest = await saveLead(modules, {
      created_at: '2026-01-01T00:00:00.000Z',
      first_name: 'Oldest',
      email: 'oldest@example.com',
      contact_channel: 'email',
    });
    const middle = await saveLead(modules, {
      created_at: '2026-01-02T00:00:00.000Z',
      first_name: 'Middle',
      email: 'middle@example.com',
      contact_channel: 'email',
    });
    const newest = await saveLead(modules, {
      created_at: '2026-01-03T00:00:00.000Z',
      first_name: 'Newest',
      email: 'newest@example.com',
      contact_channel: 'email',
    });

    const first = await adminGet(modules.app, '/api/admin/leads?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(3);
    expect(first.body.count).toBe(2);
    expect(first.body.leads.map((lead: LeadRecord) => lead.lead_id)).toEqual([
      newest.lead_id,
      middle.lead_id,
    ]);
    expect(first.body.nextCursor).toBe('2');

    const second = await adminGet(
      modules.app,
      `/api/admin/leads?limit=2&cursor=${first.body.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.count).toBe(1);
    expect(second.body.total).toBe(3);
    expect(second.body.leads.map((lead: LeadRecord) => lead.lead_id)).toEqual([oldest.lead_id]);
    // The last page must say so, or a caller polls forever.
    expect(second.body.nextCursor).toBeNull();

    const returned = [...first.body.leads, ...second.body.leads].map(
      (lead: LeadRecord) => lead.lead_id,
    );
    expect(new Set(returned).size).toBe(3);

    // The export carries the contact decision next to the contact detail.
    expect(first.body.leads[0]).toMatchObject({
      contactable: true,
      suppression: null,
    });

    const written = auditLines(await readFile(accessLog, 'utf8'));
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      event: 'lead_export',
      limit: 2,
      offset: 0,
      returned: 2,
      total: 3,
      suppressed: 0,
      more: true,
    });
    expect(written[1]).toMatchObject({ event: 'lead_export', offset: 2, returned: 1, more: false });
    expect(written[0].lead_ids).toEqual([newest.lead_id, middle.lead_id]);

    // The audit line identifies records, never people.
    const auditText = await readFile(accessLog, 'utf8');
    expect(auditText).not.toContain('oldest@example.com');
    expect(auditText).not.toContain('newest@example.com');
    expect(auditText).not.toContain('Newest');
    expect(auditText).not.toContain('Middle');
  });

  it('rejects malformed paging input instead of coercing it', async () => {
    await saveLead(modules, { created_at: '2026-01-01T00:00:00.000Z' });

    for (const query of ['limit=0', 'limit=101', 'limit=lots', 'cursor=lots', 'cursor=-1']) {
      const res = await adminGet(modules.app, `/api/admin/leads?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toMatch(/^invalid_/);
    }

    // A cursor past the end is not invalid; it is an empty last page.
    const past = await adminGet(modules.app, '/api/admin/leads?cursor=999');
    expect(past.status).toBe(200);
    expect(past.body.count).toBe(0);
    expect(past.body.nextCursor).toBeNull();
  });

  it('reads the durable log, not the bounded cache, and decrypts at rest', async () => {
    const key = 'k'.repeat(40);
    const encryptedLeadLog = tempLogPath('export-encrypted-lead');
    const encryptedAccessLog = tempLogPath('export-encrypted-access');
    const encryptedDsrLog = tempLogPath('export-encrypted-dsr');
    const env = {
      PILOT_MODE: 'true',
      ADMIN_API_KEY: ADMIN_KEY,
      LLM_API_KEY: '',
      LEAD_LOG_PATH: encryptedLeadLog,
      DSR_LOG_PATH: encryptedDsrLog,
      LEAD_ACCESS_LOG_PATH: encryptedAccessLog,
      RECORD_ENCRYPTION_KEY: key,
    };

    try {
      const writer = await loadModules(env);
      const saved = await saveLead(writer, {
        created_at: '2026-02-01T00:00:00.000Z',
        email: 'encrypted@example.com',
        contact_channel: 'email',
      });
      const onDisk = await readFile(encryptedLeadLog, 'utf8');
      expect(onDisk).not.toContain('encrypted@example.com');
      expect(onDisk).toContain('aes-256-gcm');

      // A new registry has an empty cache. The record must still be exported,
      // decrypted, because the log is the record set.
      const reader = await loadModules(env);
      const res = await adminGet(reader.app, '/api/admin/leads');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.leads[0]).toMatchObject({
        lead_id: saved.lead_id,
        email: 'encrypted@example.com',
      });
    } finally {
      cleanupTempLogs(encryptedLeadLog, encryptedAccessLog, encryptedDsrLog);
    }
  });

  it('refuses the export when a record line cannot be decoded', async () => {
    await saveLead(modules, { created_at: '2026-01-01T00:00:00.000Z' });
    await removeIfPresent(accessLog);
    // A well-formed envelope whose auth tag does not verify, as a wrong key or
    // corruption would produce. Decoding fails; the page must not be returned.
    await appendFile(
      leadLog,
      `${JSON.stringify({
        v: 1,
        alg: 'aes-256-gcm',
        iv: 'AAAAAAAAAAAAAAAA',
        tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
        data: 'AAAAAAAAAAAAAAAA',
      })}\n`,
    );

    const res = await adminGet(modules.app, '/api/admin/leads');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('records_unreadable');
    expect(res.body.leads).toBeUndefined();
    // Nothing was disclosed, so nothing should have been audited either.
    await expect(readFile(accessLog, 'utf8')).rejects.toThrow();
  });

  it('refuses the export when a deletion-request line cannot be decoded', async () => {
    await saveLead(modules, { created_at: '2026-01-01T00:00:00.000Z' });
    await removeIfPresent(accessLog);
    // Suppression cannot be computed from a line nobody can read, and guessing
    // "not suppressed" would invite contact with someone who asked for deletion.
    await appendFile(
      dsrLog,
      `${JSON.stringify({
        v: 1,
        alg: 'aes-256-gcm',
        iv: 'AAAAAAAAAAAAAAAA',
        tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
        data: 'AAAAAAAAAAAAAAAA',
      })}\n`,
    );

    const res = await adminGet(modules.app, '/api/admin/leads');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('records_unreadable');
    expect(res.body.leads).toBeUndefined();
    await expect(readFile(accessLog, 'utf8')).rejects.toThrow();
  });

  it('marks a lead suppressed only by a verified deletion request', async () => {
    const victim = await saveLead(modules, {
      created_at: '2026-01-02T00:00:00.000Z',
      email: 'victim@example.com',
      contact_channel: 'email',
    });
    const other = await saveLead(modules, {
      created_at: '2026-01-01T00:00:00.000Z',
      email: 'other@example.com',
      contact_channel: 'email',
    });

    const created = await request(modules.app)
      .post('/api/dsr')
      .send({ requestType: 'deletion', contactEmail: 'victim@example.com' });
    expect(created.status).toBe(200);
    const requestId = created.body.requestId as string;

    // Intake alone confers no suppression authority (SEC-06).
    const beforeVerification = await adminGet(modules.app, '/api/admin/leads');
    expect(
      beforeVerification.body.leads.find((lead: LeadRecord) => lead.lead_id === victim.lead_id),
    ).toMatchObject({ contactable: true, suppression: null });

    const verified = await request(modules.app)
      .post(`/api/dsr/${requestId}/verify`)
      .set('x-admin-key', ADMIN_KEY)
      .send({});
    expect(verified.status).toBe(200);

    const res = await adminGet(modules.app, '/api/admin/leads');
    expect(res.status).toBe(200);
    const byId = new Map<string, LeadRecord & { contactable: boolean; suppression: string | null }>(
      res.body.leads.map((lead: LeadRecord & { contactable: boolean }) => [lead.lead_id, lead]),
    );
    expect(byId.get(victim.lead_id)).toMatchObject({
      contactable: false,
      suppression: 'verified_deletion',
    });
    expect(byId.get(other.lead_id)).toMatchObject({ contactable: true, suppression: null });

    const audit = auditLines(await readFile(accessLog, 'utf8'));
    expect(audit[audit.length - 1]).toMatchObject({ suppressed: 1 });
  });
});

describe('lead export authorization', () => {
  const leadLog = tempLogPath('export-auth-lead');
  const dsrLog = tempLogPath('export-auth-dsr');
  const accessLog = tempLogPath('export-auth-access');
  const adminKey = ADMIN_KEY;

  afterAll(() => {
    cleanupTempLogs(leadLog, dsrLog, accessLog);
  });

  it('requires the admin key outside pilot mode', async () => {
    const modules = await loadModules({
      NODE_ENV: 'production',
      PILOT_MODE: 'false',
      ADMIN_API_KEY: adminKey,
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      LEAD_ACCESS_LOG_PATH: accessLog,
      RECORD_ENCRYPTION_KEY: '',
    });

    const anonymous = await request(modules.app).get('/api/admin/leads');
    expect(anonymous.status).toBe(401);

    const wrong = await request(modules.app)
      .get('/api/admin/leads')
      .set('x-admin-key', 'b'.repeat(40));
    expect(wrong.status).toBe(401);

    const authorized = await request(modules.app)
      .get('/api/admin/leads')
      .set('x-admin-key', adminKey);
    expect(authorized.status).toBe(200);
    expect(authorized.body.total).toBe(0);
    expect(authorized.body.leads).toEqual([]);
  });
});

describe('lead export fails closed when the access audit cannot be written', () => {
  const leadLog = tempLogPath('export-audit-lead');
  const dsrLog = tempLogPath('export-audit-dsr');
  const blockedParent = tempLogPath('export-audit-parent');
  const accessLog = `${blockedParent}/nested/access.jsonl`;

  beforeAll(async () => {
    // A regular file where the audit log's parent directory must be, so the
    // append's mkdir fails and `appendJsonlLine` resolves false.
    await writeFile(blockedParent, 'not a directory\n');
  });

  afterAll(() => {
    cleanupTempLogs(leadLog, dsrLog, blockedParent);
  });

  it('refuses the page and discloses no records', async () => {
    const modules = await loadModules({
      PILOT_MODE: 'true',
      ADMIN_API_KEY: ADMIN_KEY,
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      LEAD_ACCESS_LOG_PATH: accessLog,
      RECORD_ENCRYPTION_KEY: '',
    });
    await saveLead(modules, {
      created_at: '2026-01-01T00:00:00.000Z',
      email: 'logged@example.com',
      contact_channel: 'email',
    });

    const res = await adminGet(modules.app, '/api/admin/leads');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('audit_unavailable');
    expect(res.body.leads).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('logged@example.com');
  });
});
