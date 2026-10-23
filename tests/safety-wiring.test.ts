/**
 * The two safety controls that used to be dead code, now wired into the chat
 * pipeline:
 *
 *  - EMERGENCY_RESPONSE / detectImmediateCrisis (Section 5 / ARCH-03): a
 *    present-tense crisis disclosure short-circuits the flow, is never sent to
 *    the model, and is never stored verbatim.
 *  - authorizeToolAction (Section 4.8 / ARCH-02): a side effect the model
 *    proposes is dropped unless the server's own state authorizes it. The
 *    model's reported consent is not evidence.
 *
 * The negative table matters as much as the positive one: the existing medical
 * gate owns history disclosures ("I have thought about suicide") and coverage
 * questions ("If I kill myself, does the policy pay out?"). Those must keep
 * reaching that gate rather than being answered with 911/988.
 */

import request from 'supertest';
import type { Express } from 'express';

import { callLLM } from '../src/llm/llm-client';
import { detectImmediateCrisis, EMERGENCY_RESPONSE } from '../src/handoff/human-escalation';

jest.mock('../src/llm/llm-client', () => {
  const actual = jest.requireActual('../src/llm/llm-client');
  return { ...actual, callLLM: jest.fn() };
});

/**
 * Re-bound after every jest.resetModules(): each module registry has its own
 * mock instance, and a stale reference would leave the app calling the real
 * (unmocked) client.
 */
let mockCallLLM: jest.MockedFunction<typeof callLLM>;

const ADMIN_KEY = 'safety-admin-secret-0123456789abcdef';

async function freshApp(): Promise<Express> {
  jest.resetModules();
  const previousAdminKey = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  const llm = await import('../src/llm/llm-client');
  mockCallLLM = llm.callLLM as jest.MockedFunction<typeof callLLM>;
  mockCallLLM.mockReset();
  const store = await import('../src/llm/session-store');
  store.clearAllSessions();
  const { createApp } = await import('../src/app');
  const app = createApp();
  if (previousAdminKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = previousAdminKey;
  return app;
}

/** A schema-valid session id derived from a readable test name. */
function testSessionId(name: string): string {
  return `lpp_${name
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 50)
    .padEnd(12, 'x')}`;
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

describe('detectImmediateCrisis — present danger only', () => {
  const crises = [
    'I am going to kill myself',
    "I'm gonna end my life tonight",
    'I am thinking about suicide.',
    'I want to die',
    "I don't want to live anymore",
    'I am in immediate danger',
    'I have taken too many pills',
    'I just swallowed a bunch of pills',
  ];

  it.each(crises)('treats %j as a live crisis', (message) => {
    expect(detectImmediateCrisis(message)).toBe(true);
  });

  const notCrises = [
    // History disclosures belong to the medical gate, not the crisis response.
    'I have thought about suicide',
    'I have been feeling suicidal',
    'I have a history of suicide attempts',
    'I struggled with self-harm for years',
    // Coverage/contract questions and hypotheticals.
    'If I kill myself, does the policy pay out?',
    'I would kill myself if I had to fill that in again',
    'does the suicide exclusion apply if I kill myself?',
    'does the suicide clause apply if someone kills themselves?',
    // Ordinary copy that happens to contain the trigger words.
    'I want to die my hair red',
    "I don't want to live in a high-rise",
    'I am thinking about suicide prevention training.',
    'I am in immediate danger of missing the deadline',
    '',
  ];

  it.each(notCrises)('leaves %j to the normal gates', (message) => {
    expect(detectImmediateCrisis(message)).toBe(false);
  });
});

describe('POST /api/chat — crisis short-circuit', () => {
  let app: Express;

  beforeEach(async () => {
    app = await freshApp();
  });

  it('answers with the approved emergency resources and never calls the model', async () => {
    const sessionId = testSessionId('crisis');
    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'I am going to kill myself' });

    expect(res.status).toBe(200);
    expect(res.body.assistant_message).toBe(EMERGENCY_RESPONSE);
    expect(res.body.assistant_message).toContain('911');
    expect(res.body.assistant_message).toContain('988');
    expect(res.body.state).toBe('handoff');
    expect(res.body.proposed_action).toBe('request_human_handoff');
    expect(res.body.action_arguments.handoff_reason).toBe('emergency_or_crisis');
    expect(res.body.risk_flags).toContain('emergency_crisis_disclosed');
    expect(mockCallLLM).not.toHaveBeenCalled();
  });

  it('stores a redacted placeholder, never the crisis text', async () => {
    const sessionId = testSessionId('crisis-history');
    await request(app)
      .post('/api/chat')
      .send({ sessionId, message: "I'm in immediate danger right now" });

    const history = await request(app)
      .get(`/api/session/${sessionId}/history`)
      .set('x-admin-key', ADMIN_KEY);
    const stored = JSON.stringify(history.body);
    expect(stored).toContain('REDACTED');
    expect(stored).not.toContain('immediate danger right now');

    const store = await import('../src/llm/session-store');
    expect(store.getSessionState(sessionId)).toBe('handoff');
  });
});

describe('POST /api/chat — tool authorization', () => {
  let app: Express;

  beforeEach(async () => {
    app = await freshApp();
  });

  it('drops a create_lead the model claimed it had consent for', async () => {
    // The model asserts consent for itself; the server has no consent record
    // for this session, so the proposal must not survive the route.
    //
    // The session is placed in the contact flow first: an `education` turn with
    // no retrievable evidence abstains before the model is asked, which would
    // test the RAG gate rather than the tool gate.
    const store = await import('../src/llm/session-store');
    store.setSessionState(testSessionId('tool-create-lead'), 'consent');

    mockCallLLM.mockResolvedValueOnce({
      success: true,
      content: modelReply({
        proposed_action: 'create_lead',
        action_arguments: { idempotency_key: 'model-supplied-key' },
        consent: {
          privacy_notice_version: '1.0.0',
          contact_consent_version: '1.0.0',
          contact_consent_affirmed: true,
          medical_consent_version: null,
          medical_consent_affirmed: false,
          do_not_contact: false,
        },
        risk_flags: [],
      }),
      latencyMs: 5,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({
        sessionId: testSessionId('tool-create-lead'),
        message: 'Please have Richard call me.',
      });

    expect(res.status).toBe(200);
    expect(res.body.proposed_action).toBe('none');
    expect(res.body.action_arguments).toEqual({});
    expect(res.body.risk_flags).toContain('tool_action_blocked');
    expect(res.body.analytics.error_code).toBe('tool_action_blocked');
  });

  /** A valid model handoff reply, with the arguments the model attached. */
  function handoffReply(actionArguments: Record<string, unknown>): string {
    return modelReply({
      assistant_message: 'Richard Parslow can help with that. Would you like a handoff?',
      state: 'handoff',
      proposed_action: 'request_human_handoff',
      action_arguments: actionArguments,
      analytics: {
        event_name: 'ai_handoff_request',
        topic_category: null,
        conversation_stage: 'handoff',
        fallback_type: null,
        handoff_reason: 'individualized_recommendation',
        error_code: null,
      },
    });
  }

  it('does not flag an ordinary answer as a blocked tool action', async () => {
    // `none` is the absence of a tool call: the policy layer must authorize it,
    // or every normal answer acquires a spurious tool_action_blocked flag.
    mockCallLLM.mockResolvedValueOnce({
      success: true,
      content: modelReply(),
      latencyMs: 5,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({
        sessionId: testSessionId('tool-none'),
        message: 'Tell me about term life insurance.',
      });

    expect(res.status).toBe(200);
    expect(res.body.proposed_action).toBe('none');
    expect(res.body.analytics.event_name).toBe('ai_answer_shown');
    expect(res.body.risk_flags).not.toContain('tool_action_blocked');
    expect(res.body.analytics.error_code).not.toBe('tool_action_blocked');
  });

  it('keeps an allowlisted handoff proposal', async () => {
    mockCallLLM.mockResolvedValue({
      success: true,
      content: handoffReply({
        handoff_reason: 'individualized_recommendation',
        summary: 'Visitor asked for a recommendation.',
      }),
      latencyMs: 5,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId: testSessionId('tool-handoff'), message: 'What should I buy?' });

    expect(res.status).toBe(200);
    expect(res.body.proposed_action).toBe('request_human_handoff');
    expect(res.body.action_arguments).toEqual({
      handoff_reason: 'individualized_recommendation',
      summary: 'Visitor asked for a recommendation.',
    });
    expect(res.body.risk_flags).not.toContain('tool_action_blocked');
    // A real model reply was used — not the static fallback.
    expect(res.body.risk_flags).not.toContain('static_fallback_used');
  });

  it('drops the whole proposal when it carries an un-allowlisted argument', async () => {
    mockCallLLM.mockResolvedValue({
      success: true,
      content: handoffReply({
        handoff_reason: 'individualized_recommendation',
        summary: 'Visitor asked for a recommendation.',
        ssn: '111-11-1111',
      }),
      latencyMs: 5,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId: testSessionId('tool-extra-arg'), message: 'What should I buy?' });

    expect(res.status).toBe(200);
    expect(res.body.proposed_action).toBe('none');
    expect(res.body.action_arguments).toEqual({});
    expect(res.body.risk_flags).toContain('tool_action_blocked');
    // The rejected value is never echoed back to the caller.
    expect(JSON.stringify(res.body)).not.toContain('111-11-1111');
    expect(res.body.risk_flags).not.toContain('static_fallback_used');
  });
});
