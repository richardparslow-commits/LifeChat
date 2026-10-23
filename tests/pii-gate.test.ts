/**
 * PII gate for POST /api/chat (Section 8 — no PII to the model).
 *
 * A message flagged `pii` by detectSensitiveData must be blocked before the
 * orchestrator runs: no LLM call, no raw identifier in session history, and a
 * deterministic licensed-broker handoff. The orchestrator is mocked so the
 * assertions are about whether it was called at all, and with what, rather than
 * about the fallback shape an unreachable LLM produces.
 *
 * The mock is also why the benign control test exists: "generateResponse was
 * not called" is only meaningful if the same wiring calls it for a normal turn.
 */

import request from 'supertest';
import type { Express } from 'express';

import { STATIC_SAFE_FALLBACK, type AssistantResponse } from '../src/schema/response-schema';

jest.mock('../src/llm/orchestrator', () => ({
  ...jest.requireActual('../src/llm/orchestrator'),
  generateResponse: jest.fn(),
}));

const EMAIL = 'jane.doe@example.com';
const SSN = '123-45-6789';
const PHONE = '(512) 555-1234';
const CARD = '4111 1111 1111 1111';

describe('POST /api/chat — PII never reaches the orchestrator', () => {
  const ADMIN_KEY = 'pii-admin-secret-0123456789abcdef';
  const previousEnv = {
    HEALTH_DATA_COLLECTION_DISABLED: process.env.HEALTH_DATA_COLLECTION_DISABLED,
    LLM_API_KEY: process.env.LLM_API_KEY,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  };

  let app: Express;
  let generateResponse: jest.Mock;
  let benign: AssistantResponse;
  let sessions: typeof import('../src/llm/session-store');

  beforeAll(async () => {
    // Consented medical capture ON: the medical_review case below is the path
    // that could otherwise carry an identifier past the health classification.
    process.env.HEALTH_DATA_COLLECTION_DISABLED = 'false';
    process.env.LLM_API_KEY = 'test-key';
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    jest.resetModules();

    const [{ createApp }, orchestrator, sessionStore] = await Promise.all([
      import('../src/app'),
      import('../src/llm/orchestrator'),
      import('../src/llm/session-store'),
    ]);
    app = createApp();
    generateResponse = orchestrator.generateResponse as unknown as jest.Mock;
    sessions = sessionStore;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  beforeEach(() => {
    // clearMocks is on, so the resolved value is installed per test.
    benign = {
      ...STATIC_SAFE_FALLBACK,
      assistant_message: 'Term life insurance pays a fixed death benefit for a set term.',
      state: 'education',
      risk_flags: [],
    };
    generateResponse.mockResolvedValue({
      response: benign,
      latencyMs: 0,
      tokenUsage: { inputTokens: 12, outputTokens: 8 },
    });
  });

  /** Server-side medical consent + state, as /api/consent records it. */
  function seedMedicalReview(sessionId: string): void {
    sessions.setSessionState(sessionId, 'medical_review');
    sessions.setMedicalConsentAffirmative(sessionId, true);
  }

  it('calls the orchestrator for a benign message (control)', async () => {
    const res = await request(app).post('/api/chat').send({
      sessionId: 'lpp_pii-control-01',
      message: 'How does term life insurance work?',
    });

    expect(res.status).toBe(200);
    expect(generateResponse).toHaveBeenCalledTimes(1);
    expect(res.body.assistant_message).toBe(benign.assistant_message);
  });

  it.each([
    ['an email address', `My email is ${EMAIL}`, EMAIL, 'lpp_pii-email-01'],
    ['an SSN', `My SSN is ${SSN}`, SSN, 'lpp_pii-ssn-0001'],
    ['a phone number', `Call me at ${PHONE}`, PHONE, 'lpp_pii-phone-01'],
    ['a card number', `My card is ${CARD}`, CARD, 'lpp_pii-card-0001'],
  ])('blocks %s before the orchestrator and hands off', async (label, message, secret, id) => {
    const res = await request(app).post('/api/chat').send({ sessionId: id, message });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('handoff');
    expect(res.body.proposed_action).toBe('request_human_handoff');
    expect(res.body.action_arguments.handoff_reason).toBe('pii_disclosed');
    expect(res.body.risk_flags).toContain('sensitive_data_disclosed');
    // The reply must not echo the identifier back.
    expect(JSON.stringify(res.body)).not.toContain(secret);
    // The decisive assertion: the model was never invoked for this turn.
    expect(generateResponse).not.toHaveBeenCalled();
  });

  it('redacts the identifier from history so a later turn cannot replay it', async () => {
    const sessionId = 'lpp_pii-history-01';

    const blocked = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: `My email is ${EMAIL}` });
    expect(blocked.body.action_arguments.handoff_reason).toBe('pii_disclosed');
    expect(generateResponse).not.toHaveBeenCalled();

    const next = await request(app).post('/api/chat').send({
      sessionId,
      message: 'How does term life insurance work?',
    });
    expect(next.status).toBe(200);
    expect(generateResponse).toHaveBeenCalledTimes(1);

    const [orchestratorInput] = generateResponse.mock.calls[0];
    expect(orchestratorInput.userMessage).toBe('How does term life insurance work?');
    // The redacted placeholder is retained, the identifier is not.
    expect(orchestratorInput.conversationHistory.length).toBeGreaterThan(0);
    expect(JSON.stringify(generateResponse.mock.calls)).toContain('REDACTED');
    expect(JSON.stringify(generateResponse.mock.calls)).not.toContain(EMAIL);

    const history = await request(app)
      .get(`/api/session/${sessionId}/history`)
      .set('x-admin-key', ADMIN_KEY);
    expect(JSON.stringify(history.body)).not.toContain(EMAIL);
  });

  it('blocks an identifier that arrives alongside a consented health disclosure', async () => {
    // "health_data" outranks "pii" in detectSensitiveData, and medical_review is
    // allowed to pass health data to the model. The independent identifier check
    // must still stop this message.
    const sessionId = 'lpp_pii-medical-01';
    seedMedicalReview(sessionId);
    const res = await request(app)
      .post('/api/chat')
      .send({
        sessionId,
        message: `I have diabetes and my email is ${EMAIL}`,
      });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('handoff');
    expect(res.body.action_arguments.handoff_reason).toBe('pii_disclosed');
    expect(JSON.stringify(res.body)).not.toContain(EMAIL);
    expect(generateResponse).not.toHaveBeenCalled();
  });

  it('still allows consented health data without identifiers into medical_review', async () => {
    // Guard against over-blocking: the flow itself must keep working.
    const sessionId = 'lpp_pii-medical-02';
    seedMedicalReview(sessionId);
    const res = await request(app).post('/api/chat').send({
      sessionId,
      message: 'I have diabetes and I take insulin',
    });

    expect(res.status).toBe(200);
    expect(res.body.state).not.toBe('handoff');
    expect(generateResponse).toHaveBeenCalledTimes(1);
  });
});
