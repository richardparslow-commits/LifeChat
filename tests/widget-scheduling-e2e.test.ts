/**
 * Wire-level scheduling flow: the shipped widget, the real Express app, and a
 * stubbed model reply.
 *
 * The unit suite drives public/widget.js against hand-written availability and
 * selection payloads. That proves the DOM contract but not the wire contract:
 * that the ids the widget offers are the ids this server generated, that the
 * selection route accepts the widget's session and stores the choice, and that
 * a time someone else took comes back as the real 409 and a refreshed list.
 *
 * Only the model hop is stubbed (callLLM). Everything the widget reads or
 * writes goes through the real routes and the real scheduling module.
 */

import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

const LEAD_LOG_PATH = tempLogPath('widget-scheduling-e2e-lead');
const DSR_LOG_PATH = tempLogPath('widget-scheduling-e2e-dsr');
process.env.LEAD_LOG_PATH = LEAD_LOG_PATH;
process.env.DSR_LOG_PATH = DSR_LOG_PATH;

import { readFileSync } from 'fs';
import path from 'path';

import request from 'supertest';
import type { Express } from 'express';

import { callLLM } from '../src/llm/llm-client';
import type { ConversationState } from '../src/state-machine/state-machine';
import { runWidget, type FakeElement, type WidgetRun } from './helpers/dom-shim';

jest.mock('../src/llm/llm-client', () => {
  const actual = jest.requireActual('../src/llm/llm-client');
  return { ...actual, callLLM: jest.fn() };
});

jest.setTimeout(20_000);

afterAll(() => {
  cleanupTempLogs(LEAD_LOG_PATH, DSR_LOG_PATH);
});

const WIDGET_SOURCE = readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');

/** A model reply for a scheduling turn: prose only, no time of its own. */
function schedulingReply(): string {
  return JSON.stringify({
    assistant_message:
      'I can hold a time for you. Here are the next available appointments on our calendar.',
    state: 'scheduling',
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
      event_name: 'ai_schedule_open',
      topic_category: null,
      conversation_stage: 'scheduling',
      fallback_type: null,
      handoff_reason: null,
      error_code: null,
    },
  });
}

interface LiveServer {
  app: Express;
  store: typeof import('../src/llm/session-store');
  scheduling: typeof import('../src/scheduling/appointment-slots');
}

let mockCallLLM: jest.MockedFunction<typeof callLLM>;

/**
 * A fresh app, session store and appointment ledger. Each test gets its own
 * module registry so sessions and rate-limit windows start empty.
 */
async function freshServer(): Promise<LiveServer> {
  jest.resetModules();
  const llm = await import('../src/llm/llm-client');
  mockCallLLM = llm.callLLM as jest.MockedFunction<typeof callLLM>;
  mockCallLLM.mockReset();

  const store = await import('../src/llm/session-store');
  store.clearAllSessions();
  const scheduling = await import('../src/scheduling/appointment-slots');
  scheduling.clearAllAppointments();

  const { createApp } = await import('../src/app');
  return { app: createApp(), store, scheduling };
}

/** One request the widget made, with the response the server gave. */
interface BridgeCall {
  method: 'GET' | 'POST';
  path: string;
  body: any;
  status: number;
  /** Parsed JSON response body (0/undefined until the response arrives). */
  payload: any;
}

/**
 * Routes the widget's fetch calls into the real app.
 *
 * The widget is a static script with no transport abstraction, so the harness
 * replaces its `fetch`. Keeping supertest on the far side means the request the
 * widget builds — method, path, JSON body, session id — is exactly what the
 * server parses.
 */
function createBridge(
  app: Express,
  calls: BridgeCall[],
  onRequest?: (call: BridgeCall) => void,
): (url: string, init?: any) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }> {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: BridgeCall = {
      method,
      path: parsed.pathname,
      body,
      status: 0,
      payload: null,
    };
    calls.push(call);
    if (onRequest) onRequest(call);

    const agent = request(app);
    const req =
      method === 'POST'
        ? agent.post(call.path).send(body ?? {})
        : agent.get(call.path + parsed.search);
    if (init.headers) req.set(init.headers);

    const res = await req;
    call.status = res.status;
    call.payload = res.body;
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      json: async () => res.body,
    };
  };
}

function callsTo(calls: BridgeCall[], fragment: string): BridgeCall[] {
  return calls.filter((call) => call.path.includes(fragment));
}

function byClass(run: WidgetRun, className: string): FakeElement[] {
  return run.log.descendants().filter((node) => node.className.split(/\s+/).includes(className));
}

function slotButtons(run: WidgetRun): FakeElement[] {
  return byClass(run, 'lpp-slot');
}

/** Poll until the widget or the server has settled, then fail with context. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function openPanel(run: WidgetRun): void {
  if (run.widget.styleValue('display') === 'none') run.launcher.dispatch('click');
}

function sendMessage(run: WidgetRun, text: string): void {
  openPanel(run);
  run.input.value = text;
  run.input.dispatch('keydown', { key: 'Enter', shiftKey: false });
}

interface Visitor {
  run: WidgetRun;
  calls: BridgeCall[];
  sessionId: string;
  offered: { slot_id: string; display: string }[];
}

/**
 * Starts the widget against the server, asks for times, and waits for the real
 * availability list to render.
 *
 * A real visit reaches `scheduling` after the earlier turns; the harness enters
 * at that point by seeding the session state the moment the widget's chat
 * request names its session — the same server-authoritative state a prior turn
 * would have left behind. Nothing else about the flow is short-circuited.
 */
async function openSchedulingVisitor(server: LiveServer, message: string): Promise<Visitor> {
  const calls: BridgeCall[] = [];
  let seedState: ConversationState | null = 'scheduling';

  const run = runWidget(WIDGET_SOURCE, {
    fetch: createBridge(server.app, calls, (call) => {
      if (call.path === '/api/chat' && seedState) {
        server.store.setSessionState(String(call.body.sessionId), seedState);
        seedState = null;
      }
    }),
  });

  await waitFor(() => run.log.childNodes.length > 0, 'the opening disclosure');
  sendMessage(run, message);
  await waitFor(() => slotButtons(run).length > 0, 'the server-issued slot buttons');

  const chat = callsTo(calls, '/api/chat')[0];
  const availability = callsTo(calls, '/api/scheduling/slots')[0];
  if (!chat || !availability) throw new Error('The widget did not make the expected requests');

  return {
    run,
    calls,
    sessionId: String(chat.body.sessionId),
    offered: availability.payload.slots as { slot_id: string; display: string }[],
  };
}

describe('scheduling wire contract', () => {
  it('renders the live inventory and records the visitor choice through the API', async () => {
    const server = await freshServer();
    mockCallLLM.mockResolvedValue({ success: true, content: schedulingReply(), latencyMs: 5 });

    const visitor = await openSchedulingVisitor(server, 'Can I book an appointment?');
    const { run, calls, sessionId, offered } = visitor;

    const chat = callsTo(calls, '/api/chat')[0];
    expect(chat.status).toBe(200);
    expect(chat.payload.state).toBe('scheduling');
    expect(chat.payload.assistant_message).toContain('hold a time');

    const availability = callsTo(calls, '/api/scheduling/slots')[0];
    expect(availability.status).toBe(200);
    expect(availability.payload.timeZone).toBeTruthy();
    expect(availability.payload.slotDurationMinutes).toBeGreaterThan(0);
    expect(offered.length).toBeGreaterThan(1);
    for (const slot of offered) {
      expect(slot.slot_id).toMatch(/^slot_\d{8}T\d{4}Z$/);
      expect(slot.display.length).toBeGreaterThan(0);
    }

    // The offered buttons are the server's slots, in the server's order, with
    // the server's own display strings — no client-built times.
    const buttons = slotButtons(run);
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.map((button) => button.textContent)).toEqual(
      offered.slice(0, buttons.length).map((slot) => slot.display),
    );
    expect(buttons.map((button) => button.getAttribute('data-slot-id'))).toEqual(
      offered.slice(0, buttons.length).map((slot) => slot.slot_id),
    );

    const group = byClass(run, 'lpp-slots-list')[0];
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-labelledby')).toBe(byClass(run, 'lpp-slots-title')[0].id);
    expect(group.getAttribute('aria-describedby')).toBe(byClass(run, 'lpp-slots-hint')[0].id);
    for (const button of buttons) expect(button.getAttribute('role')).toBe('radio');

    const chosen = buttons[1];
    const chosenId = String(chosen.getAttribute('data-slot-id'));
    chosen.dispatch('click');

    await waitFor(
      () => callsTo(calls, '/api/scheduling/select')[0]?.status !== 0,
      'the selection response',
    );
    const selection = callsTo(calls, '/api/scheduling/select')[0];
    expect(selection.status).toBe(200);
    expect(selection.body).toEqual({ sessionId, slotId: chosenId });
    expect(selection.payload.selected).toBe(true);
    expect(selection.payload.slotId).toBe(chosenId);

    // The selection is the visitor's own session, on the server, and the slot
    // really is bookable by the rule the booking action itself uses.
    expect(server.store.getSelectedSlot(sessionId)).toBe(chosenId);
    expect(server.scheduling.verifySlot(chosenId).ok).toBe(true);

    await waitFor(() => slotButtons(run).length === 0, 'the confirmation to replace the list');
    const status = byClass(run, 'lpp-slots-status')[0];
    expect(status.textContent).toContain(offered[1].display);
    expect(run.document.activeElement).toBe(status);
  });

  it('replaces the held time when the visitor changes it through the widget', async () => {
    const server = await freshServer();
    mockCallLLM.mockResolvedValue({ success: true, content: schedulingReply(), latencyMs: 5 });

    const visitor = await openSchedulingVisitor(server, 'Can I book an appointment?');
    const { run, calls, sessionId, offered } = visitor;

    slotButtons(run)[0].dispatch('click');
    await waitFor(
      () => callsTo(calls, '/api/scheduling/select')[0]?.status !== 0,
      'the first selection response',
    );
    const firstId = String(offered[0].slot_id);
    expect(server.store.getSelectedSlot(sessionId)).toBe(firstId);
    await waitFor(() => slotButtons(run).length === 0, 'the first confirmation');

    // "Change time" asks the server for current availability again and keeps
    // the held time visible, rather than asking the conversation for a turn.
    const change = byClass(run, 'lpp-slot-change')[0];
    expect(change).toBeDefined();
    const availabilityBefore = callsTo(calls, '/api/scheduling/slots').length;
    change.dispatch('click');
    await waitFor(
      () =>
        callsTo(calls, '/api/scheduling/slots').length === availabilityBefore + 1 &&
        slotButtons(run).length > 0,
      'the re-opened availability list',
    );

    const reopened = slotButtons(run);
    expect(reopened[0].getAttribute('aria-checked')).toBe('true');
    expect(run.document.activeElement).toBe(reopened[0]);
    expect(byClass(run, 'lpp-slot-change')).toHaveLength(0);

    const secondId = String(reopened[1].getAttribute('data-slot-id'));
    expect(secondId).not.toBe(firstId);
    reopened[1].dispatch('click');
    await waitFor(
      () => callsTo(calls, '/api/scheduling/select')[1]?.status !== 0,
      'the replacement selection response',
    );
    expect(callsTo(calls, '/api/scheduling/select')[1].status).toBe(200);

    // One held time per session: the server replaced the first choice, so the
    // booking action can only name the latest one.
    expect(server.store.getSelectedSlot(sessionId)).toBe(secondId);
    expect(server.scheduling.verifySlot(secondId).ok).toBe(true);

    await waitFor(() => slotButtons(run).length === 0, 'the second confirmation');
    expect(byClass(run, 'lpp-slots-status')[0].textContent).toContain(offered[1].display);
    expect(byClass(run, 'lpp-slot-change')).toHaveLength(1);
  });

  it('refreshes from the server when another visitor took the time first', async () => {
    const server = await freshServer();
    mockCallLLM.mockResolvedValue({ success: true, content: schedulingReply(), latencyMs: 5 });

    const visitor = await openSchedulingVisitor(server, 'Can I book an appointment?');
    const { run, calls } = visitor;
    const target = String(slotButtons(run)[0].getAttribute('data-slot-id'));

    // Someone else books that exact slot in the same ledger the app uses.
    const booking = server.scheduling.bookSlot({
      slotId: target,
      sessionId: 'lpp_other_visitor',
      idempotencyKey: 'other-visitor-booking',
    });
    expect(booking.ok).toBe(true);

    slotButtons(run)[0].dispatch('click');
    await waitFor(
      () => callsTo(calls, '/api/scheduling/select')[0]?.status !== 0,
      'the refused selection',
    );
    expect(callsTo(calls, '/api/scheduling/select')[0].status).toBe(409);

    // The widget asks the server again rather than guessing a replacement.
    await waitFor(
      () => callsTo(calls, '/api/scheduling/slots').length === 2 && slotButtons(run).length > 0,
      'the refreshed availability list',
    );
    const refreshed = callsTo(calls, '/api/scheduling/slots')[1];
    expect(refreshed.status).toBe(200);
    expect(refreshed.payload.slots.map((slot: { slot_id: string }) => slot.slot_id)).not.toContain(
      target,
    );
    expect(slotButtons(run).map((button) => button.getAttribute('data-slot-id'))).not.toContain(
      target,
    );
    // Nothing was recorded for this visitor: the refusal happened server-side.
    expect(server.store.getSelectedSlot(visitor.sessionId)).toBeNull();
    expect(server.scheduling.getAppointmentForSession('lpp_other_visitor')?.slot_id).toBe(target);
  });

  it("keeps each visitor's choice on their own session without reserving the slot", async () => {
    const server = await freshServer();
    mockCallLLM.mockResolvedValue({ success: true, content: schedulingReply(), latencyMs: 5 });

    const first = await openSchedulingVisitor(server, 'Can I book an appointment?');
    const second = await openSchedulingVisitor(server, 'I would like a different time.');

    const firstId = String(slotButtons(first.run)[0].getAttribute('data-slot-id'));
    const secondId = String(slotButtons(second.run)[1].getAttribute('data-slot-id'));
    expect(firstId).not.toBe(secondId);

    slotButtons(first.run)[0].dispatch('click');
    await waitFor(
      () => callsTo(first.calls, '/api/scheduling/select')[0]?.status === 200,
      "the first visitor's selection",
    );
    // The second visitor commits from the keyboard: Enter on the focused radio.
    const secondButton = slotButtons(second.run)[1];
    secondButton.focus();
    secondButton.dispatch('keydown', { key: 'Enter' });
    await waitFor(
      () => callsTo(second.calls, '/api/scheduling/select')[0]?.status === 200,
      "the second visitor's selection",
    );

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(server.store.getSelectedSlot(first.sessionId)).toBe(firstId);
    expect(server.store.getSelectedSlot(second.sessionId)).toBe(secondId);
    // Choosing a time records a preference; the booking action is what reserves.
    expect(server.scheduling.getAppointmentForSlot(firstId)).toBeUndefined();
    expect(server.scheduling.getAppointmentForSlot(secondId)).toBeUndefined();
    // Selecting a time is a scheduling turn for the next message either way.
    expect(server.store.getSessionState(first.sessionId)).toBe('scheduling');
    expect(server.store.getSessionState(second.sessionId)).toBe('scheduling');
  });
});
