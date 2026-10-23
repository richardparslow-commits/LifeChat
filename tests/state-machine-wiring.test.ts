/**
 * C-06 — the conversation state machine is wired to the route.
 *
 * Before the fix the route passed constant `false` for every model-derived
 * transition input, so `clarify`, `qualification_offer`, and the ordinary
 * `contact_offer` path were unreachable, `LOOP_CONTROLS` was never consulted,
 * and the state was persisted before the response (a failed turn could move the
 * conversation). These tests drive the real route with a stubbed model hop and
 * assert on the state the server persists, not on the model's own `state`.
 */

import request from 'supertest';
import type { Express } from 'express';

import { AssistantResponseSchema, EMPTY_TURN_INTENT } from '../src/schema/response-schema';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';
import { testSessionId } from './helpers/test-session';

const leadLog = tempLogPath('c06-lead');
const dsrLog = tempLogPath('c06-dsr');
process.env.LEAD_LOG_PATH = leadLog;
process.env.DSR_LOG_PATH = dsrLog;

jest.mock('../src/llm/llm-client', () => {
  const actual = jest.requireActual('../src/llm/llm-client');
  return { ...actual, callLLM: jest.fn() };
});

type CallLLM = typeof import('../src/llm/llm-client').callLLM;
let mockCallLLM: jest.MockedFunction<CallLLM>;

const ADMIN_KEY = 'c06-admin-secret-0123456789abcdef';
/** A message the approved corpus can answer, so the turn reaches the model. */
const ANSWERABLE = 'What is term life insurance?';

async function freshApp(): Promise<Express> {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  process.env.LLM_API_KEY = 'test-key';
  jest.resetModules();
  const llm = await import('../src/llm/llm-client');
  mockCallLLM = llm.callLLM as jest.MockedFunction<CallLLM>;
  mockCallLLM.mockReset();
  const { createApp } = await import('../src/app');
  return createApp();
}

function mockReply(intent: Partial<typeof EMPTY_TURN_INTENT> = {}): void {
  mockCallLLM.mockResolvedValue({
    success: true,
    content: JSON.stringify({
      assistant_message: 'Term life insurance covers a set period.',
      state: 'education',
      intent: { ...EMPTY_TURN_INTENT, ...intent },
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
    }),
    latencyMs: 1,
  });
}

/** Loads the same session-store instance the app rules over. */
async function store(): Promise<typeof import('../src/llm/session-store')> {
  return import('../src/llm/session-store');
}

afterAll(() => {
  cleanupTempLogs(leadLog, dsrLog);
});

describe('C-06 — model intent drives the transition', () => {
  it('advances education → qualification_offer on value delivered + interest', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('c06-interest');
    mockReply({ value_delivered: true, interest_in_contact: true });

    const res = await request(app).post('/api/chat').send({ sessionId, message: ANSWERABLE });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('qualification_offer');
    expect((await store()).getSessionState(sessionId)).toBe('qualification_offer');
  });

  it('stays in education when value is delivered without interest', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('c06-no-interest');
    mockReply({ value_delivered: true });

    const res = await request(app).post('/api/chat').send({ sessionId, message: ANSWERABLE });

    expect(res.body.state).toBe('education');
  });

  it('advances qualification_offer → qualification when the visitor agrees', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('c06-agrees');
    await (await store()).setSessionState(sessionId, 'qualification_offer');
    mockReply({ agrees_to_qualification: true });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'Sure, ask me the questions.' });

    expect(res.body.state).toBe('qualification');
    // Entering qualification asks question one.
    expect((await store()).getLoopControlState(sessionId).qualificationQuestionsAsked).toBe(1);
  });

  it('leaves a declined qualification offer in standby', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('c06-declines');
    await (await store()).setSessionState(sessionId, 'qualification_offer');
    mockReply({ declines_or_ends: true });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'No thanks, I would rather not.' });

    expect(res.body.state).toBe('standby');
    expect((await store()).getLoopControlState(sessionId).offerDeclined).toBe(true);
  });
});

describe('C-06 — loop controls are enforced', () => {
  it('refuses a fourth qualification question and wraps up into the offer', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('c06-fourth-question');
    const sessions = await store();
    sessions.setSessionState(sessionId, 'qualification');
    // Three questions already asked: the maximum in Section 4.4.
    sessions.recordQualificationQuestion(sessionId);
    sessions.recordQualificationQuestion(sessionId);
    sessions.recordQualificationQuestion(sessionId);
    mockReply();

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'I have no current coverage.' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('contact_offer');
    expect(res.body.state).not.toBe('qualification');
    expect(sessions.getLoopControlState(sessionId).qualificationQuestionsAsked).toBe(3);
  });

  it('hands off after two failed clarifications instead of asking a third time', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('c06-clarify-cap');
    const sessions = await store();

    mockReply({ needs_clarification: true });
    const first = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'How much is the thing?' });
    expect(first.body.state).toBe('clarify');

    const second = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'The thing, you know.' });
    expect(second.body.state).toBe('clarify');

    const third = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'Still not sure what you mean.' });
    expect(third.body.state).toBe('handoff');
    expect(sessions.getLoopControlState(sessionId).clarificationFailures).toBe(2);
  });

  it('suppresses an automatic qualification offer after a decline', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('c06-no-reoffer');
    const sessions = await store();
    sessions.recordOfferDeclined(sessionId);
    mockReply({ value_delivered: true, interest_in_contact: true });

    const res = await request(app).post('/api/chat').send({ sessionId, message: ANSWERABLE });

    expect(res.body.state).toBe('education');
  });

  it('lets an explicit request reopen contact after a decline', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('c06-reopen');
    const sessions = await store();
    sessions.recordOfferDeclined(sessionId);
    mockReply({ requests_contact: true });

    const res = await request(app)
      .post('/api/chat')
      .send({
        sessionId,
        message: `${ANSWERABLE} Actually, please have someone call me.`,
      });

    expect(res.body.state).toBe('contact_offer');
  });
});

describe('C-06 — the model state is never persisted', () => {
  it('persists the server-derived state and returns it', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('c06-model-state');
    const sessions = await store();
    mockCallLLM.mockResolvedValue({
      success: true,
      content: JSON.stringify({
        assistant_message: 'Term life insurance covers a set period.',
        // The model claims the conversation is already in consent.
        state: 'consent',
        intent: { ...EMPTY_TURN_INTENT },
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
          conversation_stage: 'consent',
          fallback_type: null,
          handoff_reason: null,
          error_code: null,
        },
      }),
      latencyMs: 1,
    });

    const res = await request(app).post('/api/chat').send({ sessionId, message: ANSWERABLE });

    expect(res.body.state).toBe('education');
    expect(sessions.getSessionState(sessionId)).toBe('education');
  });
});

describe('C-06 — intent schema', () => {
  it('defaults every intent flag to false when the model omits the block', () => {
    // A model that predates the field (or a stub) cannot assert a transition.
    const parsed = AssistantResponseSchema.parse(
      JSON.parse(
        JSON.stringify({
          assistant_message: 'Term life insurance covers a set period.',
          state: 'education',
          citations: [],
          lead_data: {},
          consent: {},
          proposed_action: 'none',
          action_arguments: {},
          visual_card: null,
          risk_flags: [],
          analytics: {},
        }),
      ),
    );
    expect(parsed.intent).toEqual(EMPTY_TURN_INTENT);
  });
});
