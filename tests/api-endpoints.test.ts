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
