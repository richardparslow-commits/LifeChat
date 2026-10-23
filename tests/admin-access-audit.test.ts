/**
 * Admin read-access audit (M-04).
 *
 * Every operator read that returns data — session history, DSR status, system
 * prompt, RAG search, session count, readiness — must leave a PII-free entry,
 * and must be refused if that entry cannot be written. The lead export has its
 * own richer entry in the lead-access log; it is not double-audited here.
 *
 * The entries are checked for what they must never contain: the admin key, a
 * query string, an address passed as a session id, or a filesystem path.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';

import request from 'supertest';
import type { Express } from 'express';

import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

const ADMIN_KEY = 'admin-audit-test-key-0123456789abcdef';
const auditLog = tempLogPath('admin-access');

process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.ADMIN_ACCESS_LOG_PATH = auditLog;

import { ADMIN_READ_ROUTES, adminKeyId } from '../src/privacy/admin-access-audit';
import { clearAllDsrRecords, submitDsr } from '../src/privacy/dsr';
import { clearAllSessions } from '../src/llm/session-store';

type Entry = {
  audit_id: string;
  event: string;
  at: string;
  route: string;
  record_id: string | null;
  actor_key_id: string;
  status: number;
};

/** Parsed audit entries; a missing log reads as empty. */
function entries(): Entry[] {
  if (!existsSync(auditLog)) return [];
  return readFileSync(auditLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Entry);
}

function clearAuditLog(): void {
  rmSync(auditLog, { force: true });
}

/** The request that exercises each audited read, keyed by route label. */
function requestFor(route: string, dsrId: string) {
  switch (route) {
    case 'GET /api/admin/health':
      return request(app).get('/api/admin/health');
    case 'GET /api/dsr/:requestId':
      return request(app).get(`/api/dsr/${dsrId}`);
    case 'GET /api/rag/search':
      return request(app).get('/api/rag/search').query({ q: 'my email is a@b.com' });
    case 'GET /api/session/:sessionId/history':
      return request(app).get('/api/session/lpp_auditsession01/history');
    case 'GET /api/sessions':
      return request(app).get('/api/sessions');
    case 'GET /api/system-prompt':
      return request(app).get('/api/system-prompt');
    default:
      throw new Error(`no request for ${route}`);
  }
}

let app: Express;

beforeAll(() => {
  // Load late so config sees the env set at the top of the file.
  app = (jest.requireActual('../src/app') as typeof import('../src/app')).createApp();
});

beforeEach(async () => {
  clearAuditLog();
  await clearAllDsrRecords();
  clearAllSessions();
});

afterAll(async () => {
  await clearAllDsrRecords();
  cleanupTempLogs(auditLog);
  delete process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_ACCESS_LOG_PATH;
});

describe('admin read-access audit', () => {
  it('records every operator read with a non-secret actor and no payload content', async () => {
    const dsr = await submitDsr({ requestType: 'access', contactEmail: 'subject@example.com' });
    expect(dsr.ok).toBe(true);
    if (!dsr.ok) return;

    for (const route of ADMIN_READ_ROUTES) {
      const res = await requestFor(route, dsr.record.request_id).set('x-admin-key', ADMIN_KEY);
      expect({ route, status: res.status }).toEqual({ route, status: 200 });
    }

    const recorded = entries();
    expect(recorded.map((entry) => entry.route).sort()).toEqual([...ADMIN_READ_ROUTES].sort());
    for (const entry of recorded) {
      expect(entry.event).toBe('admin_read');
      expect(entry.status).toBe(200);
      expect(entry.actor_key_id).toBe(adminKeyId());
      expect(entry.actor_key_id).toMatch(/^[0-9a-f]{12}$/);
      expect(new Date(entry.at).toString()).not.toBe('Invalid Date');
    }

    const history = recorded.find((entry) => entry.route === 'GET /api/session/:sessionId/history');
    expect(history?.record_id).toBe('lpp_auditsession01');
    const dsrEntry = recorded.find((entry) => entry.route === 'GET /api/dsr/:requestId');
    expect(dsrEntry?.record_id).toBe(dsr.record.request_id);
    expect(recorded.find((entry) => entry.route === 'GET /api/admin/health')?.record_id).toBeNull();

    // The log is accountability data, not a copy of what was read.
    const raw = readFileSync(auditLog, 'utf8');
    for (const secret of [ADMIN_KEY, 'subject@example.com', 'a@b.com', 'my email', '.jsonl']) {
      expect(raw).not.toContain(secret);
    }
  });

  it('redacts a path parameter that is not an opaque record id', async () => {
    const res = await request(app)
      .get('/api/session/a%40b.com/history')
      .set('x-admin-key', ADMIN_KEY);
    expect(res.status).toBe(200);

    const [entry] = entries();
    expect(entry.record_id).toBe('unrecognized');
    expect(readFileSync(auditLog, 'utf8')).not.toContain('a@b.com');
  });

  it('writes nothing for a request that fails authentication', async () => {
    const res = await request(app).get('/api/system-prompt');
    expect(res.status).toBe(401);
    expect(entries()).toEqual([]);
  });

  it('leaves the lead export to its own audit trail', async () => {
    const res = await request(app).get('/api/admin/leads').set('x-admin-key', ADMIN_KEY);
    expect(res.status).toBe(200);
    // exportLeads records page size, ids and suppression in the lead-access
    // log; duplicating that in this one would split the export's evidence.
    expect(entries()).toEqual([]);
  });
});

describe('admin read-access audit fails closed', () => {
  const blockedPath = tempLogPath('admin-access-blocked');

  beforeAll(() => {
    // A directory where the log file should be: the append fails at the OS.
    mkdirSync(blockedPath, { recursive: true });
    process.env.ADMIN_ACCESS_LOG_PATH = blockedPath;
    jest.resetModules();
  });

  afterAll(() => {
    rmSync(blockedPath, { recursive: true, force: true });
    process.env.ADMIN_ACCESS_LOG_PATH = auditLog;
    delete process.env.ADMIN_API_KEY;
    jest.resetModules();
  });

  it('refuses the read instead of returning data it cannot log', async () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require('../src/app') as typeof import('../src/app');
      app = fresh.createApp();
    });

    const prompt = await request(app).get('/api/system-prompt').set('x-admin-key', ADMIN_KEY);
    expect(prompt.status).toBe(503);
    expect(prompt.body.error).toBe('Audit unavailable');
    expect(prompt.body.systemPrompt).toBeUndefined();

    const sessions = await request(app).get('/api/sessions').set('x-admin-key', ADMIN_KEY);
    expect(sessions.status).toBe(503);
    expect(sessions.body.activeSessions).toBeUndefined();
  });
});
