/**
 * End-to-end verification of the two side effects a chat turn may carry.
 *
 * These tests drive the real routes: /api/consent writes the consent artifact,
 * /api/scheduling/select records the visitor's choice, and /api/chat is handed
 * a model reply that proposes the side effect. The assertions are about what
 * the *server* did — a lead id that came from storage, a booking that exists
 * once, and a refusal where no verified fact supports the proposal.
 */

import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

process.env.LEAD_LOG_PATH = tempLogPath('verified-api-lead');
process.env.DSR_LOG_PATH = tempLogPath('verified-api-dsr');

import request from 'supertest';
import type { Express } from 'express';

import { callLLM } from '../src/llm/llm-client';
import { ACTION_NOT_CONFIRMED_NOTE } from '../src/tools/verified-actions';

jest.mock('../src/llm/llm-client', () => {
  const actual = jest.requireActual('../src/llm/llm-client');
  return { ...actual, callLLM: jest.fn() };
});

let mockCallLLM: jest.MockedFunction<typeof callLLM>;

async function freshApp(): Promise<Express> {
  jest.resetModules();
  const llm = await import('../src/llm/llm-client');
  mockCallLLM = llm.callLLM as jest.MockedFunction<typeof callLLM>;
  mockCallLLM.mockReset();
  const store = await import('../src/llm/session-store');
  store.clearAllSessions();
  const { createApp } = await import('../src/app');
  return createApp();
}

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

/** A model reply that proposes create_lead and claims consent for itself. */
function leadReply(): string {
  return modelReply({
    assistant_message: 'Thanks — I have your details and Richard will follow up.',
    state: 'consent',
    consent: {
      privacy_notice_version: '1.0.0',
      contact_consent_version: '1.0.0',
      contact_consent_affirmed: true,
      medical_consent_version: null,
      medical_consent_affirmed: false,
      do_not_contact: false,
    },
    proposed_action: 'create_lead',
    action_arguments: { idempotency_key: 'model-key', lead_data: { email: 'model@example.com' } },
  });
}

function bookingReply(slotId: string): string {
  return modelReply({
    assistant_message: 'Your appointment is booked.',
    state: 'contact_offer',
    proposed_action: 'book_appointment',
    action_arguments: { slot_id: slotId, idempotency_key: 'model-booking' },
    analytics: {
      event_name: 'ai_appointment_booked',
      topic_category: null,
      conversation_stage: 'contact_offer',
      fallback_type: null,
      handoff_reason: null,
      error_code: null,
    },
  });
}

/** Submits the consent form for a session and returns the stored lead id. */
async function submitConsent(app: Express, sessionId: string): Promise<string> {
  const res = await request(app).post('/api/consent').send({
    sessionId,
    contactConsentAffirmed: true,
    contactChannel: 'email',
    email: 'visitor@example.com',
    firstName: 'Alex',
    consentText: 'I agree to be contacted about my life-insurance inquiry.',
    topicCategory: 'term_life',
    articleId: 'article-1',
  });
  expect(res.status).toBe(200);
  return res.body.leadId as string;
}

afterAll(() => {
  cleanupTempLogs(process.env.LEAD_LOG_PATH, process.env.DSR_LOG_PATH);
  delete process.env.LEAD_LOG_PATH;
  delete process.env.DSR_LOG_PATH;
});

describe('POST /api/chat — create_lead authorization', () => {
  it('acknowledges the consented lead instead of blocking it', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('lead-authorized');
    const leadId = await submitConsent(app, sessionId);

    mockCallLLM.mockResolvedValueOnce({ success: true, content: leadReply(), latencyMs: 5 });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'Please have Richard email me.' });

    expect(res.status).toBe(200);
    expect(res.body.proposed_action).toBe('create_lead');
    expect(res.body.action_arguments).toEqual({ lead_id: leadId });
    expect(res.body.risk_flags).not.toContain('tool_action_blocked');
    // The model's own contact data and key never reach the caller.
    expect(JSON.stringify(res.body)).not.toContain('model@example.com');
    expect(JSON.stringify(res.body)).not.toContain('model-key');

    const { listLeadRecords } = await import('../src/consent/consent-model');
    const forSession = listLeadRecords().filter((record) => record.session_id === sessionId);
    expect(forSession).toHaveLength(1);
  });

  it('still blocks a lead when the session never submitted consent', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('lead-unverified');
    // The conversation is in the contact flow, but no consent record exists for
    // this session — the model's own consent claim must not fill the gap.
    const store = await import('../src/llm/session-store');
    store.setSessionState(sessionId, 'consent');

    mockCallLLM.mockResolvedValueOnce({ success: true, content: leadReply(), latencyMs: 5 });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'Please have Richard email me.' });

    expect(res.status).toBe(200);
    expect(res.body.proposed_action).toBe('none');
    expect(res.body.risk_flags).toContain('tool_action_blocked');
    // The model said it had the details; the correction says it does not.
    expect(res.body.assistant_message).toContain(ACTION_NOT_CONFIRMED_NOTE);

    const { listLeadRecords } = await import('../src/consent/consent-model');
    expect(listLeadRecords().filter((record) => record.session_id === sessionId)).toHaveLength(0);
  });
});

describe('scheduling + booking', () => {
  it('lists server-issued slots and books the selected one exactly once', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('booking-flow');
    await submitConsent(app, sessionId);

    const availability = await request(app).get('/api/scheduling/slots');
    expect(availability.status).toBe(200);
    expect(availability.body.slots.length).toBeGreaterThan(0);
    const slotId = availability.body.slots[0].slot_id as string;

    const selection = await request(app).post('/api/scheduling/select').send({ sessionId, slotId });
    expect(selection.status).toBe(200);
    expect(selection.body.slotId).toBe(slotId);

    mockCallLLM.mockResolvedValue({ success: true, content: bookingReply(slotId), latencyMs: 5 });

    const first = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'Book that time please.' });
    expect(first.status).toBe(200);
    expect(first.body.proposed_action).toBe('book_appointment');
    expect(first.body.action_arguments.slot_id).toBe(slotId);
    const appointmentId = first.body.action_arguments.appointment_id as string;
    expect(appointmentId).toMatch(/^apt_/);
    expect(first.body.risk_flags).not.toContain('tool_action_blocked');

    // A retry of the same turn must not double-book.
    const retry = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'Book that time please.' });
    expect(retry.status).toBe(200);
    expect(retry.body.action_arguments.appointment_id).toBe(appointmentId);
  });

  it('refuses a model-supplied slot the visitor did not select', async () => {
    const app = await freshApp();
    const sessionId = testSessionId('booking-swap');
    await submitConsent(app, sessionId);

    const availability = await request(app).get('/api/scheduling/slots');
    const offered = availability.body.slots.map((slot: { slot_id: string }) => slot.slot_id);
    await request(app).post('/api/scheduling/select').send({ sessionId, slotId: offered[0] });

    mockCallLLM.mockResolvedValueOnce({
      success: true,
      content: bookingReply(offered[1]),
      latencyMs: 5,
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ sessionId, message: 'Book the other time.' });

    expect(res.status).toBe(200);
    expect(res.body.proposed_action).toBe('none');
    expect(res.body.action_arguments).toEqual({});
    expect(res.body.risk_flags).toContain('tool_action_blocked');
    expect(res.body.assistant_message).toContain(ACTION_NOT_CONFIRMED_NOTE);

    const { getAppointmentForSession } = await import('../src/scheduling/appointment-slots');
    expect(getAppointmentForSession(sessionId)).toBeUndefined();
  });

  it('rejects a selection for a slot the server did not issue', async () => {
    const app = await freshApp();
    const res = await request(app)
      .post('/api/scheduling/select')
      .send({ sessionId: testSessionId('bad-slot'), slotId: 'slot_20260231T1800Z' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_slot_id');
  });

  it('rejects a selection for a slot inside the notice window', async () => {
    const app = await freshApp();
    const now = Date.now();
    // Round to the next half hour, which is always inside the 2-hour notice
    // window rather than beyond it.
    const soon = new Date(Math.ceil(now / (30 * 60_000)) * 30 * 60_000);
    const iso = soon.toISOString();
    const slotId = `slot_${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(
      11,
      13,
    )}${iso.slice(14, 16)}Z`;

    const res = await request(app)
      .post('/api/scheduling/select')
      .send({ sessionId: testSessionId('too-soon'), slotId });

    // Either the notice window or staffed hours rejects it; never a 200.
    expect(res.status).toBe(400);
  });
});
