/**
 * End-to-end API tests for /api/chat and /api/consent (Sections 4.4, 4.8, 4.11).
 *
 * Drives the real Express app via supertest. Because src/index.ts reads
 * process.env at module scope and starts a listener on import, each describe
 * block re-imports the app with jest.resetModules() under the env it needs.
 * LLM_API_KEY is emptied so the LLM call fails fast with no network traffic,
 * keeping the orchestration paths deterministic (abstention/fallback).
 */

import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';

interface LoadedApp {
  app: Express;
  cleanup: () => Promise<void>;
}

/**
 * Loads src/index.ts as a fresh module with the given env overrides,
 * then restores the environment so later imports are unaffected.
 */
async function loadApp(env: Record<string, string>): Promise<LoadedApp> {
  jest.resetModules();
  const previous = { ...process.env };
  Object.entries(env).forEach(([key, value]) => {
    process.env[key] = value;
  });

  const { app, server } = (await import('../src/index')) as {
    app: Express;
    server: Server;
  };

  // Restore env after the module has read it
  Object.keys(env).forEach((key) => {
    if (previous[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous[key];
    }
  });

  return {
    app,
    cleanup: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('GET / with the medical capture flag OFF (default)', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('reports healthDataCollection as disabled', async () => {
    const res = await request(loaded.app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.healthDataCollection).toBe('disabled');
  });

  it('blocks health data shared in the education state with a licensed-broker handoff', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-edu-health',
      currentState: 'education',
      message: 'I have diabetes and I take insulin',
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('handoff');
    expect(res.body.risk_flags).toContain('sensitive_data_disclosed');
    expect(res.body.proposed_action).toBe('request_human_handoff');
  });

  it('blocks health data in medical_offer even when a consent flag is sent (flag forces the flow off)', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-medoffer-health',
      currentState: 'medical_offer',
      message: 'I have diabetes and I take insulin',
      medicalConsentAffirmative: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('handoff');
    expect(res.body.risk_flags).toContain('sensitive_data_disclosed');
  });

  it('blocks financial-account data with a licensed-broker handoff and redacts it from history', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-edu-financial',
      currentState: 'education',
      message: 'My routing number is 111000025 and my account number is 409877123456',
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('handoff');
    expect(res.body.risk_flags).toContain('sensitive_data_disclosed');
    expect(res.body.proposed_action).toBe('request_human_handoff');
    expect(res.body.action_arguments.handoff_reason).toBe('financial_account_data_disclosed');
    expect(res.body.assistant_message).toContain('financial-account');
    // The raw numbers must never appear in the reply
    expect(res.body.assistant_message).not.toContain('111000025');
    expect(res.body.assistant_message).not.toContain('409877123456');

    // Session history stores the redacted placeholder, never the numbers
    const history = await request(loaded.app).get('/api/session/off-edu-financial/history');
    expect(JSON.stringify(history.body)).toContain('REDACTED');
    expect(JSON.stringify(history.body)).not.toContain('111000025');
    expect(JSON.stringify(history.body)).not.toContain('409877123456');
  });

  it('does not honor medical consent when the flag is off (state stays medical_offer)', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-medoffer-consent',
      currentState: 'medical_offer',
      message: 'qzxvbnm asdfghj',
      medicalConsentAffirmative: true,
    });
    expect(res.status).toBe(200);
    // The flag forces consent off, so the state machine stays in medical_offer
    // (observable via the stage passed to the orchestrator).
    expect(res.body.analytics.conversation_stage).toBe('medical_offer');
  });

  it('does not abstain on conversational turns in flow states (contact_offer)', async () => {
    // Short conversational replies ("That is everything.") have no RAG
    // evidence; the abstention gate must not block flow-state turns.
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-contactflow',
      currentState: 'contact_offer',
      message: 'That is everything.',
    });
    expect(res.status).toBe(200);
    expect(res.body.analytics.event_name).not.toBe('ai_abstention');
  });

  it('routes a coverage-needs request into the dime_estimator flow (no abstention)', async () => {
    // With userRequestsDimeEstimator, the state machine advances from
    // education to dime_estimator (observable via the stage passed to the
    // orchestrator even when the LLM is unreachable).
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-dime-entry',
      currentState: 'education',
      message: 'How much life insurance do I need?',
      userRequestsDimeEstimator: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.analytics.conversation_stage).toBe('dime_estimator');
    expect(res.body.analytics.event_name).not.toBe('ai_abstention');
  });

  it('does not abstain on DIME answer turns in the dime_estimator state', async () => {
    // Short factual answers to the estimator's questions have no RAG evidence;
    // the abstention gate must not block the collecting turns.
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-dime-step',
      currentState: 'dime_estimator',
      message: 'Yes, I have a mortgage.',
    });
    expect(res.status).toBe(200);
    expect(res.body.analytics.event_name).not.toBe('ai_abstention');
  });

  it('surfaces the compliance matrix on /health with per-flow approval status', async () => {
    const res = await request(loaded.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.compliance.matrixVersion).toBe('1.7.0');
    expect(res.body.compliance.phaseStatus).toBe('pending_counsel_sign_off');
    expect(res.body.compliance.flowCount).toBe(10);
    // Nothing is approved until counsel signs the markdown matrix
    for (const flow of res.body.compliance.flows) {
      expect(flow.approvalStatus).toBe('pending_counsel');
    }
    // Runtime gating: medical review is blocked by the flag; scheduling has
    // no calendar API connected; the rest can execute in pilot mode.
    const byId = (id: string) => res.body.compliance.flows.find((f: { id: string }) => f.id === id);
    expect(byId('F5').runtimeStatus).toBe('gated_by_flag');
    expect(byId('F7').runtimeStatus).toBe('not_connected');
    expect(byId('F2').runtimeStatus).toBe('enabled');
    // FTC substantiation duty documented on the education flow: RAG-grounded
    // answers with abstention as the default when evidence is insufficient.
    const f2Duties: string[] = byId('F2').regulatoryDuties;
    expect(f2Duties.some((d) => d.includes('FTC'))).toBe(true);
    expect(f2Duties.some((d) => d.includes('abstention'))).toBe(true);
    const f10Duties: string[] = byId('F10').regulatoryDuties;
    expect(f10Duties.some((d) => d.includes('FTC'))).toBe(true);
  });

  it('stores the sanitized source URL on the session (query params stripped)', async () => {
    // The raw sourceUrl carries PII in the query string. The /api/chat
    // endpoint must sanitize it (strip query params) and store only the
    // canonical pathname on the session so raw window.location.href never
    // reaches the model or lead records.
    //
    // getSourceUrl must be imported AFTER loadApp (which calls
    // jest.resetModules + import) so it shares the same module instance
    // that the Express app is using.
    const { getSourceUrl } = await import('../src/llm/session-store');

    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-source-url',
      currentState: 'education',
      message: 'What is term life insurance?',
      sourceUrl:
        'https://lifepolicypilot.blog/term-vs-whole-life/?utm_source=google&email=user@example.com',
    });
    expect(res.status).toBe(200);

    // Verify via the session store that only the pathname was stored
    const stored = getSourceUrl('off-source-url');
    expect(stored).toBe('/term-vs-whole-life/');
    expect(stored).not.toContain('utm_source');
    expect(stored).not.toContain('email');
    expect(stored).not.toContain('user@example.com');
  });

  it('does not overwrite a stored source URL on subsequent messages', async () => {
    // First message stores the path; a second message with a different
    // sourceUrl must not overwrite it (mirrors the pageContext pattern).
    const { getSourceUrl } = await import('../src/llm/session-store');

    await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-source-url-persist',
      currentState: 'education',
      message: 'What is term life?',
      sourceUrl: 'https://lifepolicypilot.blog/term-vs-whole-life/?ref=homepage',
    });
    await request(loaded.app).post('/api/chat').send({
      sessionId: 'off-source-url-persist',
      currentState: 'education',
      message: 'And whole life?',
      sourceUrl: 'https://lifepolicypilot.blog/whole-life/?different=true',
    });

    const stored = getSourceUrl('off-source-url-persist');
    expect(stored).toBe('/term-vs-whole-life/');
  });
});

describe('medical capture flag ON (HEALTH_DATA_COLLECTION_DISABLED=false)', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'false',
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('reports healthDataCollection as enabled', async () => {
    const res = await request(loaded.app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.healthDataCollection).toBe('enabled');
  });

  it('still blocks health data outside the consented medical_review state', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'on-edu-health',
      currentState: 'education',
      message: 'I have diabetes and I take insulin',
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('handoff');
    expect(res.body.risk_flags).toContain('sensitive_data_disclosed');
  });

  it('accepts health data in the consented medical_review state (no block, no handoff)', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'on-medreview-health',
      currentState: 'medical_review',
      message: 'I have diabetes and I take insulin',
    });
    expect(res.status).toBe(200);
    // The health-data block (step 4) must NOT fire in medical_review
    expect(res.body.risk_flags).not.toContain('sensitive_data_disclosed');
    expect(res.body.analytics.event_name).not.toBe('ai_handoff_request');
    // The RAG abstention gate must NOT fire either (interview state)
    expect(res.body.analytics.event_name).not.toBe('ai_abstention');
  });

  it('does not short-circuit to abstention on non-corpus answers in medical_review', async () => {
    // The user's short factual answers (birthdate, A1C) have no RAG evidence;
    // the RAG gate must not block the consented interview.
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'on-medreview-nocorpus',
      currentState: 'medical_review',
      message: 'My last A1C was 6.8',
    });
    expect(res.status).toBe(200);
    expect(res.body.analytics.event_name).not.toBe('ai_abstention');
  });

  it('honors medical consent and transitions medical_offer -> medical_review', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'on-medoffer-consent',
      currentState: 'medical_offer',
      message: 'qzxvbnm asdfghj',
      medicalConsentAffirmative: true,
    });
    expect(res.status).toBe(200);
    // The state machine advanced: the endpoint passed medical_review as the
    // orchestrator's current state (observable even when the LLM is unreachable)
    expect(res.body.analytics.conversation_stage).toBe('medical_review');
  });

  it('stays in medical_offer when no consent is given', async () => {
    const res = await request(loaded.app).post('/api/chat').send({
      sessionId: 'on-medoffer-noconsent',
      currentState: 'medical_offer',
      message: 'qzxvbnm asdfghj',
    });
    expect(res.status).toBe(200);
    // Without consent the state machine stays in medical_offer (observable via
    // the stage passed to the orchestrator).
    expect(res.body.analytics.conversation_stage).toBe('medical_offer');
  });

  it('reports medical review as enabled on /health when the flag is flipped', async () => {
    const res = await request(loaded.app).get('/health');
    expect(res.status).toBe(200);
    const f5 = res.body.compliance.flows.find((f: { id: string }) => f.id === 'F5');
    expect(f5.runtimeStatus).toBe('enabled');
    // Approval status is unchanged: enabling the flag is not counsel approval.
    expect(f5.approvalStatus).toBe('pending_counsel');
  });
});

describe('GET /api/disclosure — license & appointment disclosure', () => {
  describe('without a configured license number (fail closed)', () => {
    let loaded: LoadedApp;

    beforeAll(async () => {
      loaded = await loadApp({
        LIFECHAT_PORT: '0',
        LLM_API_KEY: '',
        HEALTH_DATA_COLLECTION_DISABLED: 'true',
        TEXAS_LICENSE_NUMBER: '',
      });
    });

    afterAll(async () => {
      await loaded.cleanup();
    });

    it('serves null (never the placeholder) when no license number is configured', async () => {
      const res = await request(loaded.app).get('/api/disclosure');
      expect(res.status).toBe(200);
      expect(res.body.texasLicenseNumber).toBeNull();
      // The placeholder is never serialized to the client
      expect(JSON.stringify(res.body)).not.toContain('Pending compliance approval');
    });

    it('omits the license line from the first message and includes the appointment disclaimer', async () => {
      const res = await request(loaded.app).get('/api/disclosure');
      expect(res.body.firstMessage).not.toContain('License #');
      expect(res.body.firstMessage).toContain(
        'Richard Parslow is appointed with select carriers. Coverage availability may vary.',
      );
      expect(res.body.appointmentDisclaimer).toBe(
        'Richard Parslow is appointed with select carriers. Coverage availability may vary.',
      );
    });

    it('links the TDPSA privacy notice and exposes the DSR contact', async () => {
      const res = await request(loaded.app).get('/api/disclosure');
      expect(res.body.privacyNoticeUrl).toBe('https://lifepolicypilot.blog/privacy/');
      expect(res.body.privacyNoticeVersion).toBe('1.3.0');
      expect(res.body.dsrEmail).toBe('privacy@lifepolicypilot.blog');
    });
  });

  describe('with a configured license number and appointment list', () => {
    let loaded: LoadedApp;

    beforeAll(async () => {
      loaded = await loadApp({
        LIFECHAT_PORT: '0',
        LLM_API_KEY: '',
        HEALTH_DATA_COLLECTION_DISABLED: 'true',
        TEXAS_LICENSE_NUMBER: '1234567',
        APPOINTED_CARRIERS: 'Carrier A, Carrier B',
      });
    });

    afterAll(async () => {
      await loaded.cleanup();
    });

    it('serves the configured license number and embeds it in the first message', async () => {
      const res = await request(loaded.app).get('/api/disclosure');
      expect(res.body.texasLicenseNumber).toBe('1234567');
      expect(res.body.firstMessage).toContain('Texas license #1234567');
    });

    it('serves the appointed-carrier allowlist and the disclaimer', async () => {
      const res = await request(loaded.app).get('/api/disclosure');
      expect(res.body.appointedCarriers).toEqual(['Carrier A', 'Carrier B']);
      expect(res.body.appointmentDisclaimer).toBeTruthy();
    });
  });
});

describe('POST /api/dsr — TDPSA consumer rights', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('serves the DSR email and a privacy-notice-linked just-in-time notice', async () => {
    const res = await request(loaded.app).get('/api/consent-text');
    expect(res.status).toBe(200);
    expect(res.body.justInTimeNotice).toContain('privacy@lifepolicypilot.blog');
    expect(res.body.privacyNoticeUrl).toBe('https://lifepolicypilot.blog/privacy/');
    expect(res.body.dsrEmail).toBe('privacy@lifepolicypilot.blog');
  });

  it('accepts a deletion request and returns the 45-day TDPSA response window', async () => {
    const res = await request(loaded.app).post('/api/dsr').send({
      requestType: 'deletion',
      contactEmail: 'user@example.com',
      detail: 'Please delete my data',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('received');
    expect(res.body.requestType).toBe('deletion');
    expect(res.body.responseWithinDays).toBe(45);
    expect(res.body.requestId).toBeTruthy();

    // Status lookup for the created request
    const statusRes = await request(loaded.app).get(`/api/dsr/${res.body.requestId}`);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('received');
    expect(statusRes.body.requestType).toBe('deletion');
  });

  it('rejects an unknown request type', async () => {
    const res = await request(loaded.app).post('/api/dsr').send({
      requestType: 'nuclear_option',
      contactEmail: 'user@example.com',
    });
    expect(res.status).toBe(400);
    expect(res.body.reason).toContain('requestType must be one of');
  });

  it('rejects an invalid contact email', async () => {
    const res = await request(loaded.app).post('/api/dsr').send({
      requestType: 'access',
      contactEmail: 'not-an-email',
    });
    expect(res.status).toBe(400);
    expect(res.body.reason).toContain('valid contact email');
  });

  it('returns 404 for an unknown DSR request id', async () => {
    const res = await request(loaded.app).get('/api/dsr/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/dsr fails closed when the log is unwritable', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      DSR_LOG_PATH: '/dev/null/records.jsonl',
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('returns 503 (not 400) when the record could not be durably stored', async () => {
    // A storage failure is a transient server-side condition — the consumer
    // must be able to retry, so it must not be classified as a client error.
    const res = await request(loaded.app).post('/api/dsr').send({
      requestType: 'deletion',
      contactEmail: 'user@example.com',
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Storage unavailable');
    expect(res.body.reason).toContain('could not securely store');
    expect(res.body.requestId).toBeUndefined();
  });
});

describe('POST /api/consent', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('rejects a submission without affirmative consent', async () => {
    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: false,
      contactChannel: 'email',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Affirmative consent required');
  });

  it('rejects an invalid email format', async () => {
    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'not-an-email',
      firstName: 'Test',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email format');
  });

  it('creates a lead with a valid email', async () => {
    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'test@example.com',
      firstName: 'Test',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('created');
    expect(res.body.leadId).toBeTruthy();
  });

  it('rejects an invalid phone format', async () => {
    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'phone',
      phone: '123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid phone format');
  });

  it('creates a lead with a valid phone', async () => {
    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'phone',
      phone: '5125551234',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('created');
    expect(res.body.leadId).toBeTruthy();
  });

  it('uses the stored session source URL over the body value', async () => {
    // A prior chat message validated and stored the canonical path on the
    // session. The consent form body carries a different (hostile) URL — the
    // lead must carry the session's stored path, never the body value.
    const chat = await request(loaded.app).post('/api/chat').send({
      sessionId: 'consent-stored-url',
      currentState: 'education',
      message: 'What is term life insurance?',
      sourceUrl: 'https://lifepolicypilot.blog/term-vs-whole-life/?email=user@example.com',
    });
    expect(chat.status).toBe(200);

    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'test@example.com',
      sessionId: 'consent-stored-url',
      sourceUrl: 'https://evil.example.com/malicious-path?steal=1',
    });
    expect(res.status).toBe(200);

    // Import AFTER loadApp so the module instance matches the app's.
    const { getLeadRecord } = await import('../src/consent/consent-model');
    const lead = getLeadRecord(res.body.leadId);
    expect(lead).toBeTruthy();
    expect(lead!.sanitized_canonical_path).toBe('/term-vs-whole-life/');
    expect(lead!.sanitized_canonical_path).not.toContain('malicious');
    expect(lead!.sanitized_canonical_path).not.toContain('steal');
  });

  it('falls back to the sanitized body URL when the session has no stored URL', async () => {
    // A session id with no prior chat message (or no sourceUrl yet) must fall
    // back to re-sanitizing the body value.
    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'fallback@example.com',
      sessionId: 'consent-no-stored-url',
      sourceUrl: 'https://lifepolicypilot.blog/faq/?utm_source=google',
    });
    expect(res.status).toBe(200);

    const { getLeadRecord } = await import('../src/consent/consent-model');
    const lead = getLeadRecord(res.body.leadId);
    expect(lead).toBeTruthy();
    expect(lead!.sanitized_canonical_path).toBe('/faq/');
    expect(lead!.sanitized_canonical_path).not.toContain('utm_source');
  });

  it('sanitizes the body URL when no session id is provided', async () => {
    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'nosession@example.com',
      sourceUrl: 'https://lifepolicypilot.blog/contact/?email=user@example.com',
    });
    expect(res.status).toBe(200);

    const { getLeadRecord } = await import('../src/consent/consent-model');
    const lead = getLeadRecord(res.body.leadId);
    expect(lead).toBeTruthy();
    expect(lead!.sanitized_canonical_path).toBe('/contact/');
    expect(lead!.sanitized_canonical_path).not.toContain('user@example.com');
  });
});

describe('POST /api/consent fails closed when the lead log is unwritable', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      LEAD_LOG_PATH: '/dev/null/leads.jsonl',
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('returns 500 and does not acknowledge consent when persistence fails', async () => {
    const res = await request(loaded.app).post('/api/consent').send({
      contactConsentAffirmed: true,
      contactChannel: 'email',
      email: 'failclosed@example.com',
      firstName: 'Fail',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Lead storage failed');
    expect(res.body.leadId).toBeUndefined();
  });
});

/**
 * Admin auth middleware tests.
 *
 * Verifies that when ADMIN_API_KEY is set, the four admin endpoints
 * (/api/system-prompt, /api/dsr/:id, /api/session/:id/history, /api/sessions)
 * reject requests without a valid x-admin-key header (401) and accept
 * requests that carry the correct header (200). When no key is configured
 * (pilot/dev default), all endpoints remain accessible without auth.
 */
describe('Admin auth middleware', () => {
  const ADMIN_KEY = 'test-admin-secret-123';

  describe('with ADMIN_API_KEY configured', () => {
    let loaded: LoadedApp;

    beforeAll(async () => {
      loaded = await loadApp({
        LIFECHAT_PORT: '0',
        LLM_API_KEY: '',
        ADMIN_API_KEY: ADMIN_KEY,
      });
    });

    afterAll(async () => {
      await loaded.cleanup();
    });

    it('rejects GET /api/system-prompt without x-admin-key (401)', async () => {
      const res = await request(loaded.app).get('/api/system-prompt');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Admin authentication required');
    });

    it('accepts GET /api/system-prompt with correct x-admin-key (200)', async () => {
      const res = await request(loaded.app).get('/api/system-prompt').set('x-admin-key', ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.body.systemPrompt).toBeTruthy();
    });

    it('rejects GET /api/system-prompt with wrong x-admin-key (401)', async () => {
      const res = await request(loaded.app)
        .get('/api/system-prompt')
        .set('x-admin-key', 'wrong-key');
      expect(res.status).toBe(401);
    });

    it('rejects a wrong key of the same length (401)', async () => {
      // Same length as ADMIN_KEY with a matching prefix — a naive
      // startsWith/prefix-optimized comparison would leak, and a buggy
      // constant-time implementation could accept it. Must still be rejected.
      const sameLengthWrong = 'test-admin-secret-999';
      expect(sameLengthWrong.length).toBe(ADMIN_KEY.length);
      const res = await request(loaded.app)
        .get('/api/system-prompt')
        .set('x-admin-key', sameLengthWrong);
      expect(res.status).toBe(401);
    });

    it('rejects GET /api/sessions without x-admin-key (401)', async () => {
      const res = await request(loaded.app).get('/api/sessions');
      expect(res.status).toBe(401);
    });

    it('accepts GET /api/sessions with correct x-admin-key (200)', async () => {
      const res = await request(loaded.app).get('/api/sessions').set('x-admin-key', ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('activeSessions');
    });

    it('rejects GET /api/session/:id/history without x-admin-key (401)', async () => {
      const res = await request(loaded.app).get('/api/session/test-admin-auth/history');
      expect(res.status).toBe(401);
    });

    it('accepts GET /api/session/:id/history with correct x-admin-key (200)', async () => {
      const res = await request(loaded.app)
        .get('/api/session/test-admin-auth/history')
        .set('x-admin-key', ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe('test-admin-auth');
    });

    it('rejects GET /api/rag/search without x-admin-key (401)', async () => {
      const res = await request(loaded.app).get('/api/rag/search?q=term');
      expect(res.status).toBe(401);
    });

    it('accepts GET /api/rag/search with correct x-admin-key (200)', async () => {
      const res = await request(loaded.app)
        .get('/api/rag/search?q=term')
        .set('x-admin-key', ADMIN_KEY);
      expect(res.status).toBe(200);
    });

    it('rejects DELETE /api/session/:id without x-admin-key (401)', async () => {
      const res = await request(loaded.app).delete('/api/session/test-admin-auth');
      expect(res.status).toBe(401);
    });

    it('accepts DELETE /api/session/:id with correct x-admin-key (200)', async () => {
      const res = await request(loaded.app)
        .delete('/api/session/test-admin-auth')
        .set('x-admin-key', ADMIN_KEY);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cleared');
    });

    it('rejects GET /api/dsr/:id without x-admin-key (401)', async () => {
      const res = await request(loaded.app).get('/api/dsr/00000000-0000-4000-8000-000000000000');
      expect(res.status).toBe(401);
    });

    it('returns 404 (not 401) for unknown DSR id with correct x-admin-key', async () => {
      const res = await request(loaded.app)
        .get('/api/dsr/00000000-0000-4000-8000-000000000000')
        .set('x-admin-key', ADMIN_KEY);
      // Auth passes, then the record lookup returns 404
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('DSR request not found');
    });
  });

  describe('without ADMIN_API_KEY configured (pilot/dev default)', () => {
    let loaded: LoadedApp;

    beforeAll(async () => {
      loaded = await loadApp({
        LIFECHAT_PORT: '0',
        LLM_API_KEY: '',
      });
    });

    afterAll(async () => {
      await loaded.cleanup();
    });

    it('allows GET /api/system-prompt without auth (200)', async () => {
      const res = await request(loaded.app).get('/api/system-prompt');
      expect(res.status).toBe(200);
      expect(res.body.systemPrompt).toBeTruthy();
    });

    it('allows GET /api/sessions without auth (200)', async () => {
      const res = await request(loaded.app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('activeSessions');
    });

    it('allows GET /api/session/:id/history without auth (200)', async () => {
      const res = await request(loaded.app).get('/api/session/test-no-auth/history');
      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe('test-no-auth');
    });
  });
});

/**
 * The `piles` context rule, proven at the endpoint rather than in the
 * classifier.
 *
 * `tests/gate-road-test.test.ts` proves the rule at the gate: the disclosure
 * forms gate, the quantifier/phrasal-verb forms stay silent, and a structural
 * test fails the build if the guard shape is removed. What it cannot prove is
 * what the *endpoint* does with the answer — that a disclosure is actually
 * withheld from the model and recorded as redacted, and that the collision
 * still reaches the orchestrator and is stored verbatim. That is this describe.
 *
 * A fresh app per test, so the rate limiter, session store, and module registry
 * are pristine for each request (the shared-state class of flake the endpoint
 * suites were rebuilt to remove).
 */
describe('POST /api/chat — the piles rule at the endpoint', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  /** Posts one visitor message and returns the response plus the stored history. */
  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  it('hands off "I have piles" as health data and keeps it out of history', async () => {
    const { body, history } = await visitorTurn('piles-endpoint-disclosure', 'I have piles');

    // The gate classified it, so the endpoint took the refusal path.
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect(body.proposed_action).toBe('request_human_handoff');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    expect(analytics(body).event_name).toBe('ai_handoff_request');
    expect(analytics(body).handoff_reason).toBe('health_data_disclosed');
    expect(String(body.assistant_message)).toContain('licensed Texas broker');

    // The disclosure is redacted, not merely flagged: the raw words never sit
    // in the session the next turn would send to the model. The endpoint passes
    // its own category-specific placeholder, and the session store substitutes
    // its canonical one either way — defense in depth, so the stored form is
    // what this asserts ("contained sensitive data, not stored").
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored).not.toContain('I have piles');
    expect(stored.toLowerCase()).not.toContain('piles');
  });

  it('passes "piles of paperwork" through untouched', async () => {
    const { body, history } = await visitorTurn('piles-endpoint-collision', 'piles of paperwork');

    // None of the health-data markers the disclosure set.
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(analytics(body).event_name).not.toBe('ai_handoff_request');
    expect(analytics(body).handoff_reason).not.toBe('health_data_disclosed');
    expect(String(body.assistant_message)).not.toContain("isn't the right place for medical");

    // …and it reached the orchestrator, which is what "untouched" means here:
    // with no API key the request falls through to the static fallback (or the
    // evidence abstention), never to the sensitive-data refusal.
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);

    // The exact text is stored verbatim — the same list `getHistory()` hands the
    // orchestrator as prior context on the next turn.
    const { getHistory } = (await import('../src/llm/session-store')) as {
      getHistory: (sessionId: string) => { role: string; content: string }[];
    };
    const modelFacing = getHistory('piles-endpoint-collision');
    expect(modelFacing[0]).toEqual({ role: 'user', content: 'piles of paperwork' });
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).not.toContain('REDACTED');
    expect(stored).toContain('piles of paperwork');
  });

  const DISCLOSURES = [
    'I have piles',
    'I was diagnosed with piles',
    'my piles are back',
    'bleeding piles again',
    'piles treatment options',
    'do I need to declare piles?',
  ];

  it.each(DISCLOSURES)('gates the disclosure form %p', async (message) => {
    const { body } = await visitorTurn(`piles-disclosure-${message.length}`, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect(analytics(body).event_name).toBe('ai_handoff_request');
  });

  const COLLISIONS = [
    'piles of paperwork',
    'the work piles up before the deadline',
    'her piles of books',
    'we have piles of data to review',
    'Are piles of paperwork a problem?',
    'Ms. Smith called about the policy',
  ];

  it.each(COLLISIONS)('passes the ordinary sense %p through', async (message) => {
    const { body, history } = await visitorTurn(`piles-collision-${message.length}`, message);
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(analytics(body).event_name).not.toBe('ai_handoff_request');
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });
});

/**
 * The same endpoint proof for the two symptom words the Chapter XVIII release
 * added to the registry (`rash`, `pain`) and the tumour marker (`psa`).
 *
 * These are the entries whose ordinary senses are common enough to matter —
 * "a rash decision", "the pain points of the process", "our PSA campaign" — so
 * the classifier is not the interesting part; what the endpoint does with the
 * answer is. A disclosure must hand off and store only the redacted placeholder,
 * and the ordinary sense must reach the orchestrator and be stored verbatim.
 */
describe('POST /api/chat — the Chapter XVIII symptom words at the endpoint', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    // The body travels with the status, so an unexpected code prints what
    // actually answered instead of only the number (the diagnostic the endpoint
    // suites carry after the unreproduced 401 that was seen once).
    expect({ status: res.status, body: res.body }).toEqual({
      status: 200,
      body: expect.anything(),
    });
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  const DISCLOSURES = [
    'I have had a rash for a week',
    'my rash is spreading',
    'a rash on my arm',
    'I have chronic pain',
    'the pain is in my lower back',
    'my PSA came back high',
  ];

  const COLLISIONS = [
    'that would be a rash decision',
    'do not make a rash promise to the client',
    'the pain points in the process',
    'a pain in the neck',
    'our PSA campaign this quarter',
  ];

  it.each(DISCLOSURES)('hands the disclosure %p off as health data, redacted', async (message) => {
    const sessionId = `xviii-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(COLLISIONS)('passes the ordinary sense %p through untouched', async (message) => {
    const sessionId = `xviii-collision-${COLLISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(body.state).not.toBe('handoff');
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });
});

/**
 * The Chapter XXI status vocabulary at the endpoint (1.12.0).
 *
 * The gate suite proves the classification and the road-test corpus proves both
 * directions of every new term; what neither can prove is what the *endpoint*
 * does with the answer. Three tables, and the third one is the interesting one:
 *
 *   - the disclosures the sweep found were travelling unclassified (`I am
 *     pregnant`, `I have a DNR order`, the history rows) must hand off and be
 *     stored only as the redacted placeholder;
 *   - the ordinary sentences the release's negated-auxiliary guard exists for
 *     must reach the orchestrator and be stored verbatim;
 *   - and the sentences the release **accepted as the cost** of gating a status
 *     word — asbestos in a building, the gestation of a regulation, an office
 *     ventilator — must be asserted at the endpoint for what they are: a
 *     handoff of a sentence that is not a disclosure. That is a test of the
 *     trade, not of the feature, and it fails loudly if the gate is ever
 *     narrowed, which is exactly when the recorded trade needs revisiting.
 */
describe('POST /api/chat — the Chapter XXI status vocabulary at the endpoint', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    // The body travels with the status, so an unexpected code prints what
    // actually answered instead of only the number.
    expect({ status: res.status, body: res.body }).toEqual({
      status: 200,
      body: expect.anything(),
    });
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  const DISCLOSURES = [
    'I am pregnant',
    'I have a DNR order',
    'history of breast cancer',
    'I have the BRCA1 mutation',
    'I have a history of blood clots',
    'my blood type is O positive',
    'I was abused as a child',
    'I have a stoma',
  ];

  const COLLISIONS = [
    'do not worry about the deadline',
    'we do not offer that rider',
    'do not hesitate to ask',
    'the family section of the application',
  ];

  const ACCEPTED_COST = [
    'the building has asbestos in the ceiling',
    'the gestation period of the new regulations',
    'the ventilator in the office is broken',
  ];

  it.each(DISCLOSURES)('hands the disclosure %p off as health data, redacted', async (message) => {
    const sessionId = `xxi-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect(body.proposed_action).toBe('request_human_handoff');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    expect(analytics(body).event_name).toBe('ai_handoff_request');
    // Redacted, not merely flagged: the words never sit in the session the next
    // turn would hand the orchestrator.
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(COLLISIONS)('passes the ordinary sentence %p through untouched', async (message) => {
    const sessionId = `xxi-collision-${COLLISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(analytics(body).event_name).not.toBe('ai_handoff_request');
    // …and it reached the orchestrator, which is what "untouched" means here:
    // with no API key the request falls through to the static fallback (or the
    // evidence abstention), never to the sensitive-data refusal.
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });

  it.each(ACCEPTED_COST)(
    'records the accepted cost for %p (gated, not disclosed)',
    async (message) => {
      const sessionId = `xxi-cost-${ACCEPTED_COST.indexOf(message)}`;
      const { body, history } = await visitorTurn(sessionId, message);
      // The handoff is real — this is a status word doing its job on a sentence
      // about a building — and the message is redacted like any other. Both halves
      // are asserted so the trade is visible in the suite rather than only in a
      // comment, and so narrowing the rule later means updating the record.
      expect(body.state).toBe('handoff');
      expect(body.risk_flags).toContain('sensitive_data_disclosed');
      const stored = history.messages.map((entry) => entry.content).join('\n');
      expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
      expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
    },
  );
});

/**
 * The product-provision sense of the suicide words at the endpoint.
 *
 * The gate corpus proves the classification in both directions; what it cannot
 * prove is what the application does with the answer, which is the point of
 * this fix: "the suicide clause in the policy" used to hand off and be redacted
 * as a disclosure — a trade pinned in 1.13.0 — and must now reach the
 * orchestrator and be stored verbatim, while "I have thought about suicide"
 * keeps handing off with the message stored only as the redacted placeholder.
 * The question form is pinned to the topic path, which is the decision it
 * already had: blocked and handed off with the topic copy, not logged as a
 * disclosure.
 */
describe('POST /api/chat — the product-provision sense of the suicide words', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    // The body travels with the status, so an unexpected code prints what
    // actually answered instead of only the number.
    expect({ status: res.status, body: res.body }).toEqual({
      status: 200,
      body: expect.anything(),
    });
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  const PROVISIONS = [
    'the suicide clause in the policy',
    'suicide exclusion',
    'the suicide rider',
    'the suicide clause waiting period',
  ];

  const DISCLOSURES = [
    'I have thought about suicide',
    'history of suicidal behavior',
    'my suicide attempt',
  ];

  it.each(PROVISIONS)('passes the provision sentence %p through untouched', async (message) => {
    const sessionId = `suicide-provision-${PROVISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(analytics(body).event_name).not.toBe('ai_handoff_request');
    // It reached the orchestrator, which is what "untouched" means here: with no
    // API key the request falls through to the static fallback rather than the
    // sensitive-data refusal.
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });

  it.each(DISCLOSURES)('hands the disclosure %p off as health data, redacted', async (message) => {
    const sessionId = `suicide-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it('answers the provision *question* as a contract question, not as a health topic', async () => {
    // 1.13.0 left this on the topic path; it is now decided the other way, and
    // the boundary is owned by the contract-question describe below. Asserted
    // here too, because this is the suite the original decision was pinned in.
    const { body, history } = await visitorTurn(
      'suicide-provision-question',
      'does the suicide exclusion apply after two years?',
    );
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('health_topic_question');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(history.messages.map((entry) => entry.content).join('\n')).toContain(
      'does the suicide exclusion apply after two years?',
    );
  });
});

/**
 * Contract questions at the endpoint — what the decision changes in practice.
 *
 * The gate corpus proves the classification in both directions; what it cannot
 * prove is the thing the visitor experiences. Four tables:
 *
 *   - twenty provision and coverage questions reach the orchestrator and are
 *     stored verbatim: no handoff, no `sensitive_data_disclosed`, no
 *     `health_topic_question` flag, and the visitor is not told that a question
 *     about their contract is a health topic;
 *   - the personally-framed forms of the same questions hand off, redacted, with
 *     the health-data reason — the disclosure path the rule must not touch;
 *   - a sentence describing an act of self-harm keeps the health-topic handoff
 *     even when it names a clause, which is the guard's whole purpose;
 *   - and the two pinned bare-coverage-verb rows ("do you cover treatment?",
 *     "do you cover prescriptions?") still hand off as health data, so the
 *     frame's reliance on a *named product* is asserted rather than assumed.
 */
describe('POST /api/chat — contract questions about the policy’s own wording', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect({ status: res.status, body: res.body }).toEqual({
      status: 200,
      body: expect.anything(),
    });
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  const CONTRACT_QUESTIONS = [
    'does the suicide exclusion apply after two years?',
    'does the policy have a cancer exclusion?',
    'what is the suicide clause in this policy?',
    'how long is the cancer waiting period?',
    'is there a depression exclusion on this plan?',
    'are pre-existing conditions excluded?',
    'does the policy cover HIV?',
    'does the policy cover treatment for cancer?',
    'is cancer covered by the policy?',
    'how does the underwriting treat diabetes?',
    'does the application ask about mental illness?',
    'does the policy ask for a medical exam?',
    'what does the policy say about self-harm?',
    'does the coverage include asthma?',
    'does the policy pay out for a heart attack?',
    'what is the exclusion for self-harm in the policy?',
    'does this plan cover strokes?',
    'can the policy be voided for a cancer diagnosis?',
    'how does the carrier assess sleep apnea?',
    'does the policy require declaring cancer?',
    'does the policy have a child abuse exclusion?',
    'does the application ask about child abuse?',
    'does the policy pay out for child abuse claims?',
  ];

  const PERSONALLY_FRAMED = [
    'does the policy cover my cancer?',
    'will the policy pay out if I die by suicide?',
    'does the suicide exclusion apply to me?',
    'am I covered for my diabetes?',
    'does the policy cover my husband\u2019s cancer?',
    'do I need to declare my cancer?',
    'I have cancer and want to know about the exclusion',
  ];

  it.each(CONTRACT_QUESTIONS)(
    'answers the contract question %p as a product question and stores it verbatim',
    async (message) => {
      const sessionId = `contract-question-${CONTRACT_QUESTIONS.indexOf(message)}`;
      const { body, history } = await visitorTurn(sessionId, message);
      expect(body.state).not.toBe('handoff');
      expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
      expect(body.risk_flags ?? []).not.toContain('health_topic_question');
      expect(analytics(body).event_name).not.toBe('ai_handoff_request');
      // It reached the orchestrator: with no API key the request falls through
      // to the static fallback rather than to the sensitive-data refusal.
      expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
      const stored = history.messages.map((entry) => entry.content).join('\n');
      expect(stored).toContain(message);
      expect(stored).not.toContain('REDACTED');
    },
  );

  it.each(PERSONALLY_FRAMED)(
    'hands the personally-framed question %p off as health data, redacted',
    async (message) => {
      const sessionId = `contract-personal-${PERSONALLY_FRAMED.indexOf(message)}`;
      const { body, history } = await visitorTurn(sessionId, message);
      expect(body.state).toBe('handoff');
      expect(body.risk_flags).toContain('sensitive_data_disclosed');
      expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
        'health_data_disclosed',
      );
      const stored = history.messages.map((entry) => entry.content).join('\n');
      expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
      expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
    },
  );

  it('keeps an act of self-harm on the health-topic path even when it names a clause', async () => {
    const { body } = await visitorTurn(
      'contract-guard-reflexive',
      'does the suicide exclusion apply if someone takes their own life?',
    );
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('health_topic_question');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
  });

  // The act-as-subject payout question — silent at the gate until the
  // three-reading audit, because it names no condition and the question
  // opener's conditional branch was inert. The act's pronoun decides the
  // person: the generic third person is a topic question, the first person
  // and the family form stay disclosures.
  it.each([
    'If someone takes their own life, does the policy pay out?',
    'If someone takes their own life after two years, is the claim denied?',
  ])(
    'answers the conditional payout question %p as a health-topic question, redacted',
    async (message) => {
      const sessionId = `contract-act-topic-${message.length}`;
      const { body, history } = await visitorTurn(sessionId, message);
      expect(body.state).toBe('handoff');
      expect(body.risk_flags).toContain('health_topic_question');
      expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
      const stored = history.messages.map((entry) => entry.content).join('\n');
      expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    },
  );

  it.each([
    'If I kill myself, does the policy pay out?',
    'If my husband takes his own life, does the policy pay out?',
  ])(
    'keeps the personally-framed conditional payout question %p on the health-data path',
    async (message) => {
      const sessionId = `contract-act-personal-${message.length}`;
      const { body } = await visitorTurn(sessionId, message);
      expect(body.state).toBe('handoff');
      expect(body.risk_flags).toContain('sensitive_data_disclosed');
    },
  );

  it.each(['do you cover treatment?', 'do you cover prescriptions?'])(
    'keeps the pinned bare-coverage question %p on the health-data path',
    async (message) => {
      // The frame requires the product to be *named*: the bare coverage verb is
      // the shape the treatment and prescription corpora pinned as the medical
      // sense, and this asserts the contract rule does not reach it.
      const sessionId = `contract-bare-cover-${message.length}`;
      const { body } = await visitorTurn(sessionId, message);
      expect(body.state).toBe('handoff');
      expect(body.risk_flags).toContain('sensitive_data_disclosed');
    },
  );
});

/**
 * The 1.14.0 abuse-family vocabulary at the endpoint, after the topic-mention
 * gate fix.
 *
 * The gate corpus proves the classification in both directions; what it cannot
 * prove is what the application does with the answer. Three tables:
 *
 *   - the disclosures the release's rows are reached by — "I was trafficked as
 *     a child" (Z62.813), "I have a history of financial abuse" (the
 *     Z62.814/Z91.413 shared wording), "abused by my partner" (the alias that
 *     moved to Z91.414 in 1.14.0) — must hand off and be stored only as the
 *     redacted placeholder, including the adversarial row where the same words
 *     sit inside a mention frame;
 *   - the supply-chain and documentary sentences 1.14.0 accepted as trades pass
 *     now that the mention shape is separated from the personal clause, so they
 *     must reach the orchestrator and be stored verbatim;
 *   - and the ordinary senses no declared shape separates — a campaign, a
 *     training, a subject the frame list does not carry — stay gated, recorded
 *     here for what they are: a handoff of a sentence that is not a disclosure.
 *     That is a test of the trade, not of the feature, and it fails loudly if
 *     the gate is ever narrowed further.
 */
describe('POST /api/chat — the abuse-family topic mentions at the endpoint', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    // The body travels with the status, so an unexpected code prints what
    // actually answered instead of only the number.
    expect({ status: res.status, body: res.body }).toEqual({
      status: 200,
      body: expect.anything(),
    });
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  const DISCLOSURES = [
    'I was trafficked as a child',
    'I have a history of financial abuse',
    'abused by my partner',
    'I was forced to work as a child',
    // The adversarial row: the same disclosure inside a mention frame must not
    // be silenced by the strip.
    'the report mentions that I was trafficked as a child',
  ];

  const TOPIC_MENTIONS = [
    'the supply chain report mentions forced labor',
    'the report describes forced labour in the supply chain',
    'the documentary is about trafficking',
    'the charity fights human trafficking',
    'the film examines sexual exploitation',
    'trafficking of illegal goods',
    'financial abuse of the system',
    'we were forced to work overtime during the audit',
  ];

  const ACCEPTED_TRADES = [
    'the blog post mentions forced labor',
    'we discussed forced labour at the board meeting',
  ];

  // Two of the 1.14.0 trades are closed: the compound shape (a term in front of
  // a programme noun) separates a campaign and an awareness programme, so these
  // now pass through the endpoint instead of being handed off for a topic.
  const CLOSED_TRADES = [
    "the charity's anti-trafficking campaign",
    'sex trafficking awareness training',
  ];

  it.each(DISCLOSURES)('hands the disclosure %p off as health data, redacted', async (message) => {
    const sessionId = `abuse-family-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect(body.proposed_action).toBe('request_human_handoff');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    expect(analytics(body).event_name).toBe('ai_handoff_request');
    // Redacted, not merely flagged: the words never sit in the session the next
    // turn would hand the orchestrator.
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(TOPIC_MENTIONS)('passes the topic mention %p through untouched', async (message) => {
    const sessionId = `abuse-family-mention-${TOPIC_MENTIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(analytics(body).event_name).not.toBe('ai_handoff_request');
    // It reached the orchestrator, which is what "untouched" means here: with no
    // API key the request falls through to the static fallback (or the evidence
    // abstention), never to the sensitive-data refusal.
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });

  it.each(CLOSED_TRADES)('passes the closed trade %p through untouched', async (message) => {
    const sessionId = `abuse-family-closed-${CLOSED_TRADES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });

  it.each(ACCEPTED_TRADES)(
    'records the accepted trade for %p (gated, not disclosed)',
    async (message) => {
      const sessionId = `abuse-family-trade-${ACCEPTED_TRADES.indexOf(message)}`;
      const { body, history } = await visitorTurn(sessionId, message);
      // The handoff is real — an ordinary sense of the term doing its job on a
      // sentence that names no history — and the message is redacted like any
      // other. Both halves are asserted so the trade stays visible in the suite
      // rather than only in a comment.
      expect(body.state).toBe('handoff');
      expect(body.risk_flags).toContain('sensitive_data_disclosed');
      const stored = history.messages.map((entry) => entry.content).join('\n');
      expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
      expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
    },
  );
});

describe('POST /api/chat — the maltreatment compound sense is closed at the endpoint', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  // The pinned 1.13.0 trade is the first row: "child abuse policy for our staff"
  // is a policy topic, not a disclosure, so it reaches the orchestrator and is
  // stored verbatim. The disclosures beside it are the direction the shape must
  // never spend — including the two sentences the first measurement showed the
  // strip *did* spend, which is why the first-person guard exists.
  const MALTREATMENT_TOPIC_COMPOUNDS = [
    'child abuse policy for our staff',
    'child abuse training for staff',
    'child abuse awareness training',
    'elder abuse training',
    'self harm awareness training',
    'the policy on child abuse',
    'a study of child abuse',
    'the child abuse hotline',
    'child abuse report form',
    'child neglect policy for our staff',
  ];

  const MALTREATMENT_DISCLOSURES = [
    'I was abused as a child',
    'history of child abuse',
    'the domestic abuse policy did not help me',
    'the child abuse awareness training I attended after my own abuse',
    'the child abuse report form I filed',
    'I called the child abuse hotline',
    'I filled out the domestic abuse report form',
    'I have a history of child neglect',
  ];

  it.each(MALTREATMENT_TOPIC_COMPOUNDS)(
    'passes the maltreatment compound %p through untouched',
    async (message) => {
      const sessionId = `maltreatment-compound-${MALTREATMENT_TOPIC_COMPOUNDS.indexOf(message)}`;
      const { body, history } = await visitorTurn(sessionId, message);
      expect(body.state).not.toBe('handoff');
      expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
      expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
      const stored = history.messages.map((entry) => entry.content).join('\n');
      expect(stored).toContain(message);
      expect(stored).not.toContain('REDACTED');
    },
  );

  it.each(MALTREATMENT_DISCLOSURES)(
    'hands the maltreatment disclosure %p off as health data, redacted',
    async (message) => {
      const sessionId = `maltreatment-disclosure-${MALTREATMENT_DISCLOSURES.indexOf(message)}`;
      const { body, history } = await visitorTurn(sessionId, message);
      expect(body.state).toBe('handoff');
      expect(body.risk_flags).toContain('sensitive_data_disclosed');
      expect(body.proposed_action).toBe('request_human_handoff');
      expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
        'health_data_disclosed',
      );
      const stored = history.messages.map((entry) => entry.content).join('\n');
      expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
      expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
    },
  );
});

/**
 * The `bug` closure at the endpoint — the lay word the deferral ledger retired.
 *
 * The gate corpus proves the classification in both directions; this proves
 * what the visitor gets. The disclosure forms — including "I caught a bug",
 * whose verbs were the half of the ledger reason the shared lists could not
 * solve — hand off with the message stored only as the redacted placeholder,
 * and the software and pest sentences 1.14.0-era reasoning assumed could not be
 * separated reach the orchestrator and are stored verbatim.
 */
describe('POST /api/chat — the lay word "bug" at the endpoint', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  const DISCLOSURES = [
    'I have a stomach bug',
    'my whole family caught a bug',
    'there is a nasty bug going around',
    'I had a vomiting bug all weekend',
  ];

  const COLLISIONS = [
    'there is a bug in the app',
    'we fixed the login bug',
    'use bug spray in the summer',
    'debugging the login bug now',
  ];

  it.each(DISCLOSURES)('hands the illness disclosure %p off, redacted', async (message) => {
    const sessionId = `bug-endpoint-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(COLLISIONS)('passes the ordinary sentence %p through untouched', async (message) => {
    const sessionId = `bug-endpoint-collision-${COLLISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(analytics(body).event_name).not.toBe('ai_handoff_request');
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });
});

describe('POST /api/chat — the self-harm vocabulary\u2019s topic sense is closed at the endpoint', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  // The measured topical sentences: a documentary about suicide and a film
  // examining self-harm are documents, not disclosures, so they reach the
  // orchestrator and are stored verbatim. The personal compounds beside them
  // are the direction the shape must never spend.
  const TOPIC_SENTENCES = [
    'the documentary is about suicide',
    'a film about self-harm',
    'the suicide prevention campaign launches next week',
    'the overdose awareness campaign starts Monday',
    'our self-harm awareness training is next month',
  ];

  const PERSONAL_COMPOUNDS = [
    'my suicide prevention plan is working',
    'my overdose prevention plan',
    'the suicide prevention plan I built with my doctor',
  ];

  const DISCLOSURES = [
    'I have thought about suicide',
    'my suicide attempt was three years ago',
    'I have a history of self-mutilation',
    'history of self-injury',
    'I survived an overdose last year',
  ];

  it.each(TOPIC_SENTENCES)('passes the topic sentence %p through untouched', async (message) => {
    const sessionId = `selfharm-topic-${TOPIC_SENTENCES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });

  it.each(PERSONAL_COMPOUNDS)('gates the personal compound %p, redacted', async (message) => {
    const sessionId = `selfharm-personal-${PERSONAL_COMPOUNDS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(DISCLOSURES)('hands the disclosure %p off, redacted', async (message) => {
    const sessionId = `selfharm-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });
});

describe('POST /api/chat — the hyperbole adjective \u201cmanic\u201d separates at the endpoint', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  // The 1.16.0 boundary's pinned hole, first-person states, and the clinical
  // nouns — the direction the hyperbole strips must never spend.
  const DISCLOSURES = [
    'I am manic',
    "I'm manic",
    'I am manic before deadlines',
    'my manic episodes are back',
    'diagnosed with manic depression',
  ];

  // The hyperbole compounds, the trope and brand names, the television sense,
  // and the hyperbolic verbs — each a sentence a visitor could type, none a
  // disclosure.
  const COLLISIONS = [
    'a manic week at work',
    'manic Monday',
    'a manic episode of my favorite sitcom',
    'manic laughter filled the room',
    'he got manic at the party',
    'my manic Monday',
  ];

  it.each(DISCLOSURES)('hands the manic disclosure %p off, redacted', async (message) => {
    const sessionId = `manic-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(COLLISIONS)('passes the manic hyperbole %p through untouched', async (message) => {
    const sessionId = `manic-collision-${COLLISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });
});

describe('POST /api/chat — the Chapter VI nervous-system vocabulary at the endpoint', () => {
  let loaded: LoadedApp;

  beforeEach(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  // The named-diagnosis rows 1.17.0 mapped, stated the way a visitor states
  // them — each must hand off redacted, never reaching the model.
  const DISCLOSURES = [
    'I have dystonia',
    'I was diagnosed with hemiplegia',
    'I have a muscle disorder',
    'I have trigeminal neuralgia',
    'I have a brain disorder',
  ];

  // The ordinary "muscle" life the new stems must not spend — the gym, the
  // boxes, the stretch — each a benign sentence a visitor could type.
  const COLLISIONS = [
    'he pulled a muscle at the gym',
    'I pulled a muscle moving boxes',
    'stretch every muscle before you run',
  ];

  it.each(DISCLOSURES)('hands the disclosure %p off, redacted', async (message) => {
    const sessionId = `chapter6-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(COLLISIONS)('passes the collision %p through untouched', async (message) => {
    const sessionId = `chapter6-collision-${COLLISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });
});

describe('POST /api/chat — the Chapter X respiratory vocabulary at the endpoint', () => {
  let loaded: Awaited<ReturnType<typeof loadApp>>;

  beforeEach(async () => {
    loaded = await loadApp({
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  // The occupational-lung and acute rows 1.19.0 mapped, stated the way a
  // visitor states them — each must hand off redacted, never reaching the model.
  const DISCLOSURES = [
    'I have asbestosis',
    'I have silicosis',
    'I have black lung disease',
  ];

  // The ordinary industrial/flu life the new stems must not spend — standards,
  // fluid, the coal trade, the temperature — each a benign sentence a visitor
  // could type.
  const COLLISIONS = [
    'the new safety standards apply from January',
    'the fluid reservation was cancelled',
    'my brother works in the coal industry',
    'the office is cold in winter',
  ];

  it.each(DISCLOSURES)('hands the disclosure %p off, redacted', async (message) => {
    const sessionId = `chapter10-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(COLLISIONS)('passes the collision %p through untouched', async (message) => {
    const sessionId = `chapter10-collision-${COLLISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });
});

describe('POST /api/chat - the Chapter XI digestive vocabulary at the endpoint', () => {
  let loaded: Awaited<ReturnType<typeof loadApp>>;

  beforeEach(async () => {
    loaded = await loadApp({
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  // The digestive rows 1.20.0 mapped, stated the way a visitor states them -
  // each must hand off redacted, never reaching the model.
  const DISCLOSURES = [
    'I have appendicitis',
    'I get indigestion after every meal',
    'I have fatty liver disease',
  ];

  // The ordinary document/anatomy life the new stems must not spend - the
  // report appendix, the organ in an educational sentence.
  const COLLISIONS = [
    'the data tables are in the report appendix',
    'the pancreas is part of the digestive tract',
    'the liver filters your blood',
  ];

  it.each(DISCLOSURES)('hands the disclosure %p off, redacted', async (message) => {
    const sessionId = `chapter11-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(COLLISIONS)('passes the collision %p through untouched', async (message) => {
    const sessionId = `chapter11-collision-${COLLISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });
});

describe('POST /api/chat - the Chapter XII skin vocabulary at the endpoint', () => {
  let loaded: Awaited<ReturnType<typeof loadApp>>;

  beforeEach(async () => {
    loaded = await loadApp({
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  // The skin rows 1.21.0 mapped, stated the way a visitor states them - each
  // must hand off redacted, never reaching the model.
  const DISCLOSURES = [
    'I have impetigo',
    'I have pemphigoid',
    'I have lichen sclerosus',
  ];

  // The ordinary cosmetics/food life the new stems must not spend.
  const COLLISIONS = [
    'this serum is for pigmentation correction',
    'we grilled corns and peppers',
    'the exfoliation step comes after cleansing',
  ];

  it.each(DISCLOSURES)('hands the disclosure %p off, redacted', async (message) => {
    const sessionId = `chapter12-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(COLLISIONS)('passes the collision %p through untouched', async (message) => {
    const sessionId = `chapter12-collision-${COLLISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });
});

describe('POST /api/chat - the Chapter XIII musculoskeletal vocabulary at the endpoint', () => {
  let loaded: Awaited<ReturnType<typeof loadApp>>;

  beforeEach(async () => {
    loaded = await loadApp({
      LLM_API_KEY: '',
      HEALTH_DATA_COLLECTION_DISABLED: 'true',
    });
  });

  afterEach(async () => {
    await loaded.cleanup();
  });

  async function visitorTurn(
    sessionId: string,
    message: string,
  ): Promise<{
    body: Record<string, unknown>;
    history: { messages: { role: string; content: string }[] };
  }> {
    const res = await request(loaded.app)
      .post('/api/chat')
      .send({ sessionId, currentState: 'education', message });
    expect(res.status).toBe(200);
    const history = await request(loaded.app).get(`/api/session/${sessionId}/history`);
    expect(history.status).toBe(200);
    return { body: res.body as Record<string, unknown>, history: history.body };
  }

  function analytics(body: Record<string, unknown>): Record<string, unknown> {
    return (body.analytics ?? {}) as Record<string, unknown>;
  }

  // The musculoskeletal rows 1.22.0 mapped, stated the way a visitor states
  // them - each must hand off redacted, never reaching the model.
  const DISCLOSURES = [
    'I have osteomalacia',
    'I have polymyalgia rheumatica',
    'I have a stress fracture',
  ];

  // The ordinary engineering/anatomy life the new stems must not spend.
  const COLLISIONS = [
    'the spine of the report lists the exhibits',
    'a biomechanical analysis of the golf swing',
    'the joint venture closed last week',
  ];

  it.each(DISCLOSURES)('hands the disclosure %p off, redacted', async (message) => {
    const sessionId = `chapter13-disclosure-${DISCLOSURES.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).toBe('handoff');
    expect(body.risk_flags).toContain('sensitive_data_disclosed');
    expect((body.action_arguments as Record<string, unknown>).handoff_reason).toBe(
      'health_data_disclosed',
    );
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain('[USER MESSAGE REDACTED — contained sensitive data, not stored]');
    expect(stored.toLowerCase()).not.toContain(message.toLowerCase());
  });

  it.each(COLLISIONS)('passes the collision %p through untouched', async (message) => {
    const sessionId = `chapter13-collision-${COLLISIONS.indexOf(message)}`;
    const { body, history } = await visitorTurn(sessionId, message);
    expect(body.state).not.toBe('handoff');
    expect(body.risk_flags ?? []).not.toContain('sensitive_data_disclosed');
    expect(['ai_fallback_shown', 'ai_abstention']).toContain(analytics(body).event_name);
    const stored = history.messages.map((entry) => entry.content).join('\n');
    expect(stored).toContain(message);
    expect(stored).not.toContain('REDACTED');
  });
});
