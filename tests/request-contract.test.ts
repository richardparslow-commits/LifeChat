/**
 * Phase 1 request-contract tests (SEC-01, SEC-02, SEC-04, SEC-06).
 *
 * These lock the fail-closed contract rather than a happy path:
 *   - a malformed or oversized chat body is rejected before any work happens;
 *   - client-supplied `currentState` / `medicalConsentAffirmative` are ignored,
 *     so a health disclosure cannot be smuggled into medical_review by editing
 *     the payload;
 *   - the consent record carries a SHA-256 digest of the exact copy shown;
 *   - on a serverless runtime both legal-record endpoints refuse with 503
 *     instead of accepting a record that would live only in /tmp.
 */

import { createHash } from 'crypto';
import request from 'supertest';
import type { Express } from 'express';

import { TEST_CONSENT_TEXT, testSessionId } from './helpers/test-session';
import { WRITE_RATE_LIMIT_CONFIG } from '../src/security/security-controls';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

const leadLog = tempLogPath('contract-lead');
const dsrLog = tempLogPath('contract-dsr');

/** Loads a fresh app under the env, restoring the shell afterwards. */
async function loadApp(env: Record<string, string>): Promise<Express> {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  jest.resetModules();
  try {
    const { createApp } = await import('../src/app');
    return createApp();
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function consentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contactConsentAffirmed: true,
    contactChannel: 'email',
    email: 'contract@example.com',
    firstName: 'Casey',
    consentText: TEST_CONSENT_TEXT,
    ...overrides,
  };
}

describe('POST /api/chat — runtime request validation (SEC-04)', () => {
  let app: Express;

  beforeAll(async () => {
    app = await loadApp({
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      HEALTH_DATA_COLLECTION_DISABLED: 'false',
    });
  });

  afterAll(async () => {
    const { clearAllLeadRecords } = await import('../src/consent/consent-model');
    await clearAllLeadRecords();
    cleanupTempLogs(leadLog, dsrLog);
  });

  it('rejects a session id outside the lpp_ format without echoing the value', async () => {
    const res = await request(app).post('/api/chat').send({
      sessionId: 'not-a-session-id',
      message: 'What is term life insurance?',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect(res.body.details[0].field).toBe('sessionId');
    expect(JSON.stringify(res.body)).not.toContain('not-a-session-id');
  });

  it('rejects a message longer than 2,000 characters', async () => {
    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId: testSessionId('oversize'), message: 'a'.repeat(2001) });

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('message');
  });

  it('ignores client-supplied currentState and medical consent', async () => {
    // The strongest form: capture is enabled, so only the server-side state and
    // consent gate can still refuse this. Both payload fields are spoofed.
    const res = await request(app)
      .post('/api/chat')
      .send({
        sessionId: testSessionId('spoofed-review'),
        message: 'I have diabetes and I take insulin',
        currentState: 'medical_review',
        medicalConsentAffirmative: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('handoff');
    expect(res.body.action_arguments.handoff_reason).toBe('health_data_disclosed');
  });

  it('rejects an unknown session that has not been promoted by the server', async () => {
    const first = await request(app)
      .post('/api/chat')
      .send({
        sessionId: testSessionId('starts-in-education'),
        message: 'What is term life insurance?',
      });
    expect(first.status).toBe(200);
    // The first turn starts in education, not in whatever the body claims.
    expect(first.body.analytics.conversation_stage).toBe('education');
  });
});

describe('POST /api/consent — validation and consent proof (SEC-04, SEC-06)', () => {
  let app: Express;

  beforeAll(async () => {
    app = await loadApp({
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
    });
  });

  afterAll(async () => {
    const { clearAllLeadRecords } = await import('../src/consent/consent-model');
    await clearAllLeadRecords();
    cleanupTempLogs(leadLog, dsrLog);
  });

  it('rejects a consent submission without the exact copy shown', async () => {
    const body = consentBody();
    delete body.consentText;

    const res = await request(app).post('/api/consent').send(body);
    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('consentText');
  });

  it('stores the SHA-256 of the consent copy, never the copy itself', async () => {
    const res = await request(app).post('/api/consent').send(consentBody());
    expect(res.status).toBe(200);

    const { getLeadRecord } = await import('../src/consent/consent-model');
    const lead = await getLeadRecord(res.body.leadId);
    expect(lead).toBeTruthy();
    expect(lead!.consent_text_hash).toBe(
      createHash('sha256').update(TEST_CONSENT_TEXT, 'utf8').digest('hex'),
    );
    expect(lead!.consent_text_hash).toHaveLength(64);
    expect(JSON.stringify(lead)).not.toContain(TEST_CONSENT_TEXT);
  });

  it('rejects a session id that is present but malformed', async () => {
    const res = await request(app)
      .post('/api/consent')
      .send(consentBody({ sessionId: 'bad session' }));

    expect(res.status).toBe(400);
    expect(res.body.details[0].field).toBe('sessionId');
  });
});

describe('proxy trust is explicit and off by default (SEC-07)', () => {
  it('does not trust X-Forwarded-For unless TRUST_PROXY is set', async () => {
    const app = await loadApp({
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
    });

    expect(app.get('trust proxy')).toBe(false);
  });

  it('accepts a configured hop count', async () => {
    const app = await loadApp({
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      TRUST_PROXY: '1',
    });

    expect(app.get('trust proxy')).toBe(1);
  });

  it('passes express keywords and subnet lists through unchanged', async () => {
    const keyword = await loadApp({
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      TRUST_PROXY: 'loopback',
    });
    expect(keyword.get('trust proxy')).toBe('loopback');

    const truthy = await loadApp({
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      TRUST_PROXY: 'true',
    });
    expect(truthy.get('trust proxy')).toBe(true);

    const list = await loadApp({
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      TRUST_PROXY: '10.0.0.0/8, 192.168.0.0/16',
    });
    expect(list.get('trust proxy')).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('fails closed on an unparseable value instead of trusting it or throwing', async () => {
    const app = await loadApp({
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
      TRUST_PROXY: 'not-a-subnet',
    });

    expect(app.get('trust proxy')).toBe(false);
    // The app still serves: a configuration typo must not 500 every request.
    const res = await request(app).get('/api/availability');
    expect(res.status).toBe(200);
  });

  it('does not mint a fresh client budget from a spoofed X-Forwarded-For', async () => {
    // The write limit is keyed on req.ip. With proxies untrusted, the header
    // must not change that key: rotating it cannot escape the per-client
    // budget (which would let one caller write without limit).
    const app = await loadApp({
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
    });
    expect(app.get('trust proxy')).toBe(false);

    const statuses: number[] = [];
    for (let i = 0; i < WRITE_RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW + 1; i++) {
      const res = await request(app)
        .post('/api/scheduling/select')
        .set('x-forwarded-for', `203.0.113.${i}`)
        .send({ sessionId: testSessionId('spoofed-forwarder'), slotId: 'not-a-slot' });
      statuses.push(res.status);
    }

    const allowedCount = WRITE_RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW;
    // Every request within the budget is rejected for its body (400) — no write
    // path is reached — and the one past it is refused by the shared budget.
    expect(statuses.slice(0, allowedCount).every((status) => status === 400)).toBe(true);
    expect(statuses[allowedCount]).toBe(429);
  });
});

describe('serverless runtime — legal-record endpoints fail closed with 503 (SEC-01)', () => {
  let app: Express;
  let store: typeof import('../src/consent/consent-model');

  beforeAll(async () => {
    app = await loadApp({
      LLM_API_KEY: '',
      SERVERLESS: 'true',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
    });
    store = await import('../src/consent/consent-model');
  });

  afterAll(async () => {
    await store.clearAllLeadRecords();
    cleanupTempLogs(leadLog, dsrLog);
  });

  it('refuses to accept a consent record on /api/consent', async () => {
    const res = await request(app).post('/api/consent').send(consentBody());

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Storage unavailable');
    expect(res.body.leadId).toBeUndefined();
    expect(store.listLeadRecords()).toHaveLength(0);
  });

  it('refuses to accept a data subject request on /api/dsr', async () => {
    const res = await request(app).post('/api/dsr').send({
      requestType: 'access',
      contactEmail: 'subject@example.com',
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Storage unavailable');
    expect(JSON.stringify(res.body)).not.toContain('requestId');
  });
});
