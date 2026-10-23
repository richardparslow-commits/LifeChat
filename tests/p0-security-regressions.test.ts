/**
 * Regressions for the P0 findings in docs/security-architecture-audit-2026-10-21.md.
 *
 * Each test fails against the pre-fix behaviour:
 *
 *   SEC-01  admin routes were open when ADMIN_API_KEY was absent, in every mode;
 *   SEC-02  a caller could mint a fresh session id per request for a fresh budget;
 *   SEC-04  send_transactional_confirmation returned `authorized: true` with no
 *           transport, so the model's "I've emailed you" stood;
 *   SEC-06  an unauthenticated DSR could suppress a real lead's contact path;
 *   SEC-07  /api/consent accepted a record with no reachable contact channel.
 *
 * SEC-05 (provider bodies reaching the client) is pinned in
 * tests/llm-client-error-leak.test.ts and in the orchestrator fallback test.
 */

import { createHash } from 'crypto';
import request from 'supertest';
import type { Express } from 'express';

import { TEST_CONSENT_TEXT, testSessionId } from './helpers/test-session';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

const leadLog = tempLogPath('p0-lead');
const dsrLog = tempLogPath('p0-dsr');
const ADMIN_KEY = 'p0-admin-secret-0123456789abcdef';

jest.mock('../src/llm/llm-client', () => {
  const actual = jest.requireActual('../src/llm/llm-client');
  return { ...actual, callLLM: jest.fn() };
});

type CallLLM = typeof import('../src/llm/llm-client').callLLM;
let mockCallLLM: jest.MockedFunction<CallLLM>;

/**
 * Builds a fresh app under the given env, then restores the shell. Modules are
 * reset first so `config` is read under the overrides; the returned app keeps
 * the registry it was built in.
 */
async function freshApp(overrides: Record<string, string | undefined> = {}): Promise<Express> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  jest.resetModules();
  try {
    const llm = await import('../src/llm/llm-client');
    mockCallLLM = llm.callLLM as jest.MockedFunction<CallLLM>;
    mockCallLLM.mockReset();
    // Default: the provider is unreachable, which exercises the deterministic
    // fallback path without a network call.
    mockCallLLM.mockResolvedValue({
      success: false,
      content: null,
      error: 'api_error_500',
      latencyMs: 1,
    });

    const { createApp } = await import('../src/app');
    return createApp();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

/** A full schema-valid model reply, with overrides applied last. */
function modelReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    assistant_message: 'Term life insurance covers a set period.',
    state: 'education',
    citations: [],
    lead_data: {
      first_name: null,
      email: null,
      phone: null,
      goal_category: null,
      timeline_category: null,
      current_coverage_category: null,
      policy_type_seeking: null,
      coverage_amount_seeking: null,
      contact_channel: null,
      time_zone: null,
      preferred_contact_window: null,
      medical_profile: null,
    },
    consent: {
      privacy_notice_version: '1.0.0',
      contact_consent_version: null,
      contact_consent_affirmed: false,
      medical_consent_version: null,
      medical_consent_affirmed: false,
      do_not_contact: false,
    },
    proposed_action: 'none',
    action_arguments: {},
    visual_card: null,
    risk_flags: [],
    analytics: {
      event_name: 'ai_answer_shown',
      topic_category: null,
      conversation_stage: 'education',
      fallback_type: null,
      handoff_reason: null,
      error_code: null,
    },
    ...overrides,
  });
}

beforeAll(() => {
  process.env.LEAD_LOG_PATH = leadLog;
  process.env.DSR_LOG_PATH = dsrLog;
  process.env.LLM_API_KEY = '';
});

afterAll(async () => {
  const { clearAllLeadRecords } = await import('../src/consent/consent-model');
  const { clearAllDsrRecords } = await import('../src/privacy/dsr');
  await clearAllLeadRecords();
  await clearAllDsrRecords();
  cleanupTempLogs(leadLog, dsrLog);
});

describe('SEC-01 — admin routes fail closed without a key', () => {
  it('answers 503 (never 200) outside pilot mode', async () => {
    const app = await freshApp({ PILOT_MODE: 'false', ADMIN_API_KEY: '' });

    for (const path of [
      '/api/system-prompt',
      '/api/sessions',
      '/api/session/lpp_abcdefghijkl/history',
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
    }

    const killSwitch = await request(app).post('/api/admin/kill-switch').send({ active: true });
    expect(killSwitch.status).toBe(503);
    expect(killSwitch.body.error).toBe('Admin authentication is not configured');
  });

  it('treats an absent PILOT_MODE in production as non-pilot', async () => {
    const app = await freshApp({
      NODE_ENV: 'production',
      PILOT_MODE: undefined,
      ADMIN_API_KEY: '',
    });

    const res = await request(app).get('/api/system-prompt');
    expect(res.status).toBe(503);
  });

  it('fails closed even in an explicit pilot with no key', async () => {
    // Pilot mode is not an authentication mode. The audit reproduced 200 on
    // PII-export and history routes under exactly this configuration.
    const app = await freshApp({ PILOT_MODE: 'true', ADMIN_API_KEY: '' });
    for (const path of [
      '/api/system-prompt',
      '/api/sessions',
      '/api/session/lpp_abcdefghijkl/history',
      '/api/admin/leads',
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Admin authentication is not configured');
    }
    const killSwitch = await request(app).post('/api/admin/kill-switch').send({ active: true });
    expect(killSwitch.status).toBe(503);
    expect(killSwitch.body.error).toBe('Admin authentication is not configured');
  });

  it('refuses a non-loopback admin request when no key is configured', async () => {
    // TRUST_PROXY=1 makes req.ip the address in X-Forwarded-For, so this
    // request is indistinguishable from one arriving over the network. The
    // old middleware allowed it in pilot mode; it must now answer 503.
    const app = await freshApp({
      PILOT_MODE: 'true',
      ADMIN_API_KEY: '',
      TRUST_PROXY: '1',
    });
    const res = await request(app).get('/api/admin/leads').set('X-Forwarded-For', '203.0.113.9');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Admin authentication is not configured');
  });
});

describe('SEC-02 — the chat budget belongs to the client, not the session id', () => {
  it('caps one client even when every request carries a new session id', async () => {
    const app = await freshApp({ PILOT_MODE: 'true', LLM_API_KEY: '' });

    // The audit probe, reproduced exactly: 200 distinct caller-minted ids from
    // one client. Before the client budget every one was admitted and carried
    // its own 50k-token window. The ceiling now admits only the client's
    // budget and refuses the rest, whatever id is in the body.
    const { CHAT_CLIENT_LIMIT_CONFIG } = await import('../src/security/security-controls');
    const probeSize = 200;
    const statuses: number[] = [];
    for (let i = 0; i < probeSize; i += 1) {
      const res = await request(app)
        .post('/api/chat')
        .send({
          sessionId: testSessionId(`churn-${i}`),
          message: 'What is term life insurance?',
        });
      statuses.push(res.status);
    }

    const admitted = statuses.filter((status) => status === 200).length;
    const refused = statuses.filter((status) => status === 429).length;
    expect(admitted).toBe(CHAT_CLIENT_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW);
    expect(refused).toBe(probeSize - admitted);

    // The refusal names the budget, so an operator can tell a spend control
    // from a provider outage.
    const blocked = await request(app)
      .post('/api/chat')
      .send({ sessionId: testSessionId('churn-after-cap'), message: 'And whole life?' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.analytics.error_code).toBe('client_rate_limit_exceeded');
  }, 30_000);

  it('keeps separate client budgets and counts tokens against the client', async () => {
    const controls = await import('../src/security/security-controls');
    controls.clearAllRateLimits();

    for (let i = 0; i < 30; i += 1) {
      expect(controls.checkChatClientLimit('203.0.113.10').allowed).toBe(true);
    }
    expect(controls.checkChatClientLimit('203.0.113.10')).toEqual({
      allowed: false,
      reason: 'client_rate_limit_exceeded',
    });
    // A different visitor is unaffected by the first client's exhaustion.
    expect(controls.checkChatClientLimit('203.0.113.11').allowed).toBe(true);

    controls.clearAllRateLimits();
    expect(controls.checkChatClientLimit('203.0.113.12').allowed).toBe(true);
    controls.incrementChatTokens('lpp_tokenbudget', '203.0.113.12', 60_000);
    expect(controls.checkChatClientLimit('203.0.113.12')).toEqual({
      allowed: false,
      reason: 'client_token_budget_exceeded',
    });
  });

  it('has a process-wide ceiling so many source addresses cannot exceed total spend', async () => {
    const controls = await import('../src/security/security-controls');
    controls.clearAllRateLimits();

    const { MAX_REQUESTS_PER_WINDOW } = controls.CHAT_CLIENT_LIMIT_CONFIG;
    const { MAX_REQUESTS_PER_WINDOW: GLOBAL_MAX } = controls.CHAT_GLOBAL_LIMIT_CONFIG;
    const clients = Math.ceil(GLOBAL_MAX / MAX_REQUESTS_PER_WINDOW);

    for (let client = 0; client < clients; client += 1) {
      for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i += 1) {
        controls.checkChatClientLimit(`198.51.100.${client}`);
      }
    }

    expect(controls.checkChatClientLimit('198.51.100.250')).toEqual({
      allowed: false,
      reason: 'global_rate_limit_exceeded',
    });
  });
});

describe('SEC-04 — a confirmation is never authorized without a transport', () => {
  it('drops the proposal and corrects the model message', async () => {
    const app = await freshApp({ PILOT_MODE: 'true', LLM_API_KEY: '' });
    const sessionId = testSessionId('confirm-transport');

    const consent = await request(app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'confirm@example.com',
      sessionId,
      consentText: TEST_CONSENT_TEXT,
    });
    expect(consent.status).toBe(200);

    // Put the session where the model would legitimately propose a
    // confirmation, then have it claim one.
    const store = await import('../src/llm/session-store');
    store.setSessionState(sessionId, 'consent');
    mockCallLLM.mockResolvedValue({
      success: true,
      content: modelReply({
        assistant_message: "I've emailed your confirmation for Tuesday at 9.",
        state: 'confirmation',
        proposed_action: 'send_transactional_confirmation',
        action_arguments: { appointment_id: 'apt_model_invented' },
      }),
      latencyMs: 1,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'Please send my confirmation.' });

    expect(res.status).toBe(200);
    expect(res.body.proposed_action).toBe('none');
    expect(res.body.action_arguments).toEqual({});
    expect(res.body.risk_flags).toContain('tool_action_blocked');
    expect(res.body.analytics.error_code).toBe('tool_action_blocked');
    // The model's prose claimed a delivery; the route must correct it.
    expect(res.body.assistant_message).toContain("I couldn't confirm that");
    expect(JSON.stringify(res.body)).not.toContain('apt_model_invented');
  });
});

describe('SEC-06 — only a verified DSR may suppress a lead', () => {
  it('records new requests unverified and verifies them only through the admin route', async () => {
    const app = await freshApp({ PILOT_MODE: 'true', ADMIN_API_KEY: ADMIN_KEY });

    const created = await request(app)
      .post('/api/dsr')
      .send({ requestType: 'deletion', contactEmail: 'victim@example.com' });
    expect(created.status).toBe(200);
    const requestId = created.body.requestId as string;

    const before = await request(app).get(`/api/dsr/${requestId}`).set('x-admin-key', ADMIN_KEY);
    expect(before.status).toBe(200);
    expect(before.body.verified).toBe(false);
    expect(before.body.verifiedAt).toBeNull();

    const verified = await request(app)
      .post(`/api/dsr/${requestId}/verify`)
      .set('x-admin-key', ADMIN_KEY)
      .send({});
    expect(verified.status).toBe(200);
    expect(verified.body.verified).toBe(true);
    expect(verified.body.verifiedAt).toEqual(expect.any(String));

    const after = await request(app).get(`/api/dsr/${requestId}`).set('x-admin-key', ADMIN_KEY);
    expect(after.body.verified).toBe(true);
  });

  it('refuses verification outside pilot mode without a key', async () => {
    const app = await freshApp({ PILOT_MODE: 'false', ADMIN_API_KEY: '' });
    const res = await request(app).post('/api/dsr/any-id/verify').send({});
    expect(res.status).toBe(503);
  });
});

describe('C-02 — the model cannot author the response envelope', () => {
  it('replaces model lead_data, consent, medical consent, and state with server facts', async () => {
    const app = await freshApp({ PILOT_MODE: 'true', LLM_API_KEY: 'test-key' });
    const sessionId = testSessionId('forged-envelope');

    // The model claims a contact consent, invents an email, attaches a medical
    // profile with medical consent, and chooses the consent state. None of it
    // is backed by a record or a session flag.
    mockCallLLM.mockResolvedValue({
      success: true,
      content: modelReply({
        state: 'consent',
        lead_data: {
          first_name: 'Forged',
          email: 'model@example.com',
          medical_profile: {
            medical_conditions: ['diabetes'],
            medications: [],
          },
        },
        consent: {
          privacy_notice_version: '0.0.0',
          contact_consent_version: '1.0.0',
          contact_consent_affirmed: true,
          medical_consent_version: '1.0.0',
          medical_consent_affirmed: true,
          do_not_contact: false,
        },
        analytics: {
          event_name: 'ai_answer_shown',
          topic_category: 'jane.doe@example.com',
          conversation_stage: 'consent',
          fallback_type: null,
          handoff_reason: null,
          error_code: null,
        },
      }),
      latencyMs: 1,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'What is term life insurance?' });

    expect(res.status).toBe(200);
    const store = await import('../src/llm/session-store');
    expect(res.body.state).toBe(store.getSessionState(sessionId));
    expect(res.body.state).not.toBe('consent');
    expect(res.body.lead_data).toEqual({
      first_name: null,
      email: null,
      phone: null,
      goal_category: null,
      timeline_category: null,
      current_coverage_category: null,
      policy_type_seeking: null,
      coverage_amount_seeking: null,
      contact_channel: null,
      time_zone: null,
      preferred_contact_window: null,
      medical_profile: null,
    });
    expect(res.body.consent).toEqual({
      privacy_notice_version: expect.any(String),
      contact_consent_version: null,
      contact_consent_affirmed: false,
      medical_consent_version: null,
      medical_consent_affirmed: false,
      do_not_contact: false,
    });
    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain('model@example.com');
    expect(payload).not.toContain('jane.doe@example.com');
  });

  it('reports the verified record when consent exists, not the model copy', async () => {
    const app = await freshApp({ PILOT_MODE: 'true', LLM_API_KEY: 'test-key' });
    const sessionId = testSessionId('verified-envelope');

    const consent = await request(app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'verified@example.com',
      sessionId,
      consentText: TEST_CONSENT_TEXT,
    });
    expect(consent.status).toBe(200);

    mockCallLLM.mockResolvedValue({
      success: true,
      content: modelReply({
        lead_data: { email: 'model@example.com' },
        consent: {
          contact_consent_version: null,
          contact_consent_affirmed: false,
          do_not_contact: false,
        },
      }),
      latencyMs: 1,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'What is term life insurance?' });

    expect(res.status).toBe(200);
    expect(res.body.lead_data.email).toBe('verified@example.com');
    expect(res.body.consent).toMatchObject({
      contact_consent_version: '1.1.0',
      contact_consent_affirmed: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('model@example.com');
  });
});

describe('C-03 — consent hash is over the approved copy', () => {
  it('rejects a one-character consentText instead of recording v1.0.0 consent', async () => {
    const app = await freshApp({ PILOT_MODE: 'true', LLM_API_KEY: '' });

    const res = await request(app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'shortcopy@example.com',
      consentText: 'x',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Consent copy mismatch');
  });

  it('hashes the canonical copy, not the presentation the caller submitted', async () => {
    const app = await freshApp({ PILOT_MODE: 'true', LLM_API_KEY: '' });
    const submitted = `  ${TEST_CONSENT_TEXT.replace(' ', '   ')}  `;

    const res = await request(app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'canonical@example.com',
      consentText: submitted,
    });

    expect(res.status).toBe(200);
    const { getLeadRecord } = await import('../src/consent/consent-model');
    const lead = await getLeadRecord(res.body.leadId as string);
    expect(lead!.consent_text_hash).toBe(
      createHash('sha256').update(TEST_CONSENT_TEXT, 'utf8').digest('hex'),
    );
  });
});

describe('C-04 — topicCategory is categorical', () => {
  it('never emits a caller-supplied email into analytics', async () => {
    const app = await freshApp({ PILOT_MODE: 'true', LLM_API_KEY: '' });
    const email = 'jane.doe@example.com';

    const res = await request(app)
      .post('/api/chat')
      .send({
        sessionId: testSessionId('topic-injection'),
        message: 'What is term life insurance?',
        topicCategory: email,
      });

    expect(res.status).toBe(200);
    expect(res.body.analytics.topic_category).toBe('other');
    expect(JSON.stringify(res.body)).not.toContain(email);
  });

  it('keeps a known category', async () => {
    const app = await freshApp({ PILOT_MODE: 'true', LLM_API_KEY: '' });
    const res = await request(app)
      .post('/api/chat')
      .send({
        sessionId: testSessionId('topic-known'),
        message: 'What is term life insurance?',
        topicCategory: 'term_life',
      });

    expect(res.status).toBe(200);
    expect(res.body.analytics.topic_category).toBe('term_life');
  });
});

describe('C-05 — medical consent version is server-owned', () => {
  const medicalEnv = {
    PILOT_MODE: 'true',
    LLM_API_KEY: '',
    HEALTH_DATA_COLLECTION_DISABLED: 'false',
    RECORD_ENCRYPTION_KEY: 'k'.repeat(40),
  };

  it('rejects a caller-labelled version that is not the current one', async () => {
    const app = await freshApp(medicalEnv);
    const res = await request(app)
      .post('/api/consent')
      .send({
        contactConsentAffirmed: true,
        contactChannel: 'email',
        email: 'oldversion@example.com',
        consentText: TEST_CONSENT_TEXT,
        medicalConsentAffirmed: true,
        medicalConsentVersion: '0.0.1',
        medicalProfile: { medical_conditions: [], medications: [] },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Affirmative current medical consent required');
    expect(res.body.leadId).toBeUndefined();
  });

  it('stores the configured current version, not the caller string', async () => {
    const app = await freshApp(medicalEnv);
    const res = await request(app)
      .post('/api/consent')
      .send({
        contactConsentAffirmed: true,
        contactChannel: 'email',
        email: 'currentversion@example.com',
        consentText: TEST_CONSENT_TEXT,
        medicalConsentAffirmed: true,
        medicalConsentVersion: '1.1.0',
        medicalProfile: { medical_conditions: [], medications: [] },
      });

    expect(res.status).toBe(200);
    const { getLeadRecord } = await import('../src/consent/consent-model');
    const lead = await getLeadRecord(res.body.leadId as string);
    expect(lead!.medical_consent_version).toBe('1.1.0');
  });
});

describe('SEC-07 — consent needs a reachable channel', () => {
  let app: Express;

  beforeAll(async () => {
    app = await freshApp({ PILOT_MODE: 'true', LLM_API_KEY: '' });
  });

  it('rejects a record with no contact channel', async () => {
    const res = await request(app).post('/api/consent').send({
      contactConsentAffirmed: true,
      email: 'nochannel@example.com',
      consentText: TEST_CONSENT_TEXT,
    });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain('contactChannel');
  });

  it('rejects an email channel with no email', async () => {
    const res = await request(app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      consentText: TEST_CONSENT_TEXT,
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({
      field: 'email',
      message: 'email is required for the email channel',
    });
  });

  it('rejects a phone channel with no phone', async () => {
    const res = await request(app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'phone',
      consentText: TEST_CONSENT_TEXT,
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toContainEqual({
      field: 'phone',
      message: 'phone is required for the phone channel',
    });
  });
});
