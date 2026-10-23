/**
 * C-08 — the shipped widget can take a lead and a privacy request.
 *
 * Before this change the compliance features were API-only: the chat refused a
 * direct identifier, said a "secure process" existed, and stopped there. These
 * tests drive the real `public/widget.js` against the real Express app and
 * assert what the server ends up holding: a lead bound to the widget's session,
 * with the hash of the canonical consent copy, and a TDPSA request the operator
 * can read back.
 *
 * Only the model hop is stubbed. The consent copy, the consent artifact, the
 * lead export, the DSR record and the admin read all go through the routes.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';

import request from 'supertest';
import type { Express } from 'express';

import { RECOMMENDED_EMAIL_CONSENT_COPY } from '../src/consent/consent-copy';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';
import { runWidget, type FakeElement, type WidgetRun } from './helpers/dom-shim';

const LEAD_LOG_PATH = tempLogPath('widget-contact-lead');
const DSR_LOG_PATH = tempLogPath('widget-contact-dsr');
const ACCESS_LOG_PATH = tempLogPath('widget-contact-access');
process.env.LEAD_LOG_PATH = LEAD_LOG_PATH;
process.env.DSR_LOG_PATH = DSR_LOG_PATH;
process.env.LEAD_ACCESS_LOG_PATH = ACCESS_LOG_PATH;

jest.mock('../src/llm/llm-client', () => {
  const actual = jest.requireActual('../src/llm/llm-client');
  return { ...actual, callLLM: jest.fn() };
});

jest.setTimeout(20_000);

const ADMIN_KEY = 'widget-contact-admin-0123456789abcdef';
const WIDGET_SOURCE = readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');

type CallLLM = typeof import('../src/llm/llm-client').callLLM;
let mockCallLLM: jest.MockedFunction<CallLLM>;

interface BridgeCall {
  method: 'GET' | 'POST';
  path: string;
  body: any;
  status: number;
  payload: any;
}

/** A fresh app and module registry for one visitor. */
async function freshServer(): Promise<Express> {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  jest.resetModules();
  const llm = await import('../src/llm/llm-client');
  mockCallLLM = llm.callLLM as jest.MockedFunction<CallLLM>;
  mockCallLLM.mockReset();
  mockCallLLM.mockResolvedValue({ success: false, content: null, error: 'offline', latencyMs: 1 });
  const store = await import('../src/llm/session-store');
  store.clearAllSessions();
  const { createApp } = await import('../src/app');
  return createApp();
}

/** Routes the widget's fetch calls into the real app, recording them. */
function createBridge(
  app: Express,
  calls: BridgeCall[],
  onRequest?: (call: BridgeCall) => void,
): (url: string, init?: any) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }> {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const method = String(init.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: BridgeCall = { method, path: parsed.pathname, body, status: 0, payload: null };
    calls.push(call);
    if (onRequest) onRequest(call);

    const agent = request(app);
    const req = method === 'POST' ? agent.post(call.path).send(body ?? {}) : agent.get(call.path);
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

function callsTo(calls: BridgeCall[], path: string): BridgeCall[] {
  // Exact paths: `/api/consent` must not also match `/api/consent-text`.
  return calls.filter((call) => call.path === path);
}

function byClass(run: WidgetRun, className: string): FakeElement[] {
  return run.widget.descendants().filter((node) => node.className.split(/\s+/).includes(className));
}

function byId(run: WidgetRun, id: string): FakeElement {
  const found = run.shadowRoot.getElementById(id);
  if (!found) throw new Error(`The widget did not render #${id}`);
  return found;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Visitor {
  run: WidgetRun;
  calls: BridgeCall[];
  sessionId: string;
}

/** Starts the widget, waits for the disclosure, and sends one chat turn. */
async function startVisitor(app: Express, message: string): Promise<Visitor> {
  const calls: BridgeCall[] = [];
  const run = runWidget(WIDGET_SOURCE, { fetch: createBridge(app, calls) });
  await waitFor(() => run.log.childNodes.length > 0, 'the opening disclosure');

  if (run.widget.styleValue('display') === 'none') run.launcher.dispatch('click');
  run.input.value = message;
  run.input.dispatch('keydown', { key: 'Enter', shiftKey: false });
  await waitFor(() => callsTo(calls, '/api/chat')[0]?.status !== 0, 'the chat reply');

  const chat = callsTo(calls, '/api/chat')[0];
  return { run, calls, sessionId: String(chat.body.sessionId) };
}

/** Opens the contact panel and waits for the canonical consent copy. */
async function openContactForm(visitor: Visitor): Promise<void> {
  byId(visitor.run, 'lpp-contact-toggle').dispatch('click');
  await waitFor(
    () =>
      byClass(visitor.run, 'lpp-contact-copy')[0].textContent !==
      'Loading the approved consent text…',
    'the canonical consent copy',
  );
}

afterAll(() => {
  cleanupTempLogs(LEAD_LOG_PATH, DSR_LOG_PATH, ACCESS_LOG_PATH);
});

describe('C-08 — chat refusal leads to a consented lead in the widget', () => {
  it('takes the lead through /api/consent and the broker export sees it', async () => {
    const app = await freshServer();
    // The refusal path is deterministic: a direct identifier is blocked before
    // the model, and the visitor is handed off.
    const visitor = await startVisitor(app, 'My email is jane.doe@example.com');
    const chat = callsTo(visitor.calls, '/api/chat')[0];
    expect(chat.payload.state).toBe('handoff');
    expect(chat.payload.risk_flags).toContain('sensitive_data_disclosed');
    expect(chat.payload.action_arguments.handoff_reason).toBe('pii_disclosed');

    await openContactForm(visitor);
    const { run, calls, sessionId } = visitor;

    // The form shows the server's own copy, so what the visitor checks is what
    // the record will prove.
    const copy = byClass(run, 'lpp-contact-copy')[0];
    expect(copy.textContent).toBe(RECOMMENDED_EMAIL_CONSENT_COPY);

    const email = byId(run, 'lpp-contact-email');
    const consent = byId(run, 'lpp-contact-consent');
    email.value = 'visitor@example.com';
    consent.checked = true;
    byId(run, 'lpp-contact-form').dispatch('submit');

    await waitFor(() => callsTo(calls, '/api/consent')[0]?.status !== 0, 'the consent submission');
    const submission = callsTo(calls, '/api/consent')[0];
    expect(submission.status).toBe(200);
    expect(submission.body).toMatchObject({
      sessionId,
      contactChannel: 'email',
      email: 'visitor@example.com',
      contactConsentAffirmed: true,
      consentText: RECOMMENDED_EMAIL_CONSENT_COPY,
    });

    // The success message is the server's, and focus moved to it.
    const status = byId(run, 'lpp-contact-status');
    expect(status.textContent).toBe(submission.payload.message);
    expect(run.document.activeElement).toBe(status);
    // One submission only: a second click must not create a second lead.
    byId(run, 'lpp-contact-form').dispatch('submit');
    expect(callsTo(calls, '/api/consent')).toHaveLength(1);

    // The broker's read path returns the lead, bound to this session, with the
    // digest of the canonical copy rather than whatever the browser sent.
    const exportResponse = await request(app).get('/api/admin/leads').set('x-admin-key', ADMIN_KEY);
    expect(exportResponse.status).toBe(200);
    const lead = exportResponse.body.leads.find(
      (record: { session_id: string }) => record.session_id === sessionId,
    );
    expect(lead).toBeDefined();
    expect(lead.email).toBe('visitor@example.com');
    expect(lead.contact_channel).toBe('email');
    expect(lead.contact_consent_version).toBeTruthy();
    expect(lead.consent_text_hash).toBe(
      createHash('sha256').update(RECOMMENDED_EMAIL_CONSENT_COPY, 'utf8').digest('hex'),
    );
  });

  it('refuses to submit until the consent statement is checked', async () => {
    const app = await freshServer();
    const visitor = await startVisitor(app, 'What is term life insurance?');
    await openContactForm(visitor);

    const { run, calls } = visitor;
    byId(run, 'lpp-contact-email').value = 'visitor@example.com';
    byId(run, 'lpp-contact-form').dispatch('submit');

    const alert = byId(run, 'lpp-contact-alert');
    expect(alert.textContent).toMatch(/check the consent statement/i);
    expect(callsTo(calls, '/api/consent')).toHaveLength(0);
  });

  it('stays disabled when the approved copy cannot be loaded', async () => {
    const app = await freshServer();
    const calls: BridgeCall[] = [];
    const run = runWidget(WIDGET_SOURCE, {
      fetch: async (url, init = {}) => {
        if (String(url).includes('/api/consent-text')) {
          return { status: 503, ok: false, json: async () => ({ error: 'unavailable' }) };
        }
        return createBridge(app, calls)(url, init);
      },
    });
    await waitFor(() => run.log.childNodes.length > 0, 'the opening disclosure');
    byId(run, 'lpp-contact-toggle').dispatch('click');
    await waitFor(
      () => byId(run, 'lpp-contact-alert').textContent.length > 0,
      'the copy failure message',
    );

    expect(byId(run, 'lpp-contact-submit').disabled).toBe(true);
    expect(byId(run, 'lpp-contact-alert').textContent).toMatch(/could not be loaded/i);
    expect(callsTo(calls, '/api/consent')).toHaveLength(0);
  });
});

describe('C-08 — the widget ships a working TDPSA request route', () => {
  it('submits a deletion request through /api/dsr and the operator can read it', async () => {
    const app = await freshServer();
    const calls: BridgeCall[] = [];
    const run = runWidget(WIDGET_SOURCE, { fetch: createBridge(app, calls) });
    await waitFor(() => run.log.childNodes.length > 0, 'the opening disclosure');

    byId(run, 'lpp-dsr-toggle').dispatch('click');
    expect(byId(run, 'lpp-dsr-panel').getAttribute('aria-labelledby')).toBe('lpp-dsr-title');
    expect(run.document.activeElement).toBe(byId(run, 'lpp-dsr-email'));

    byId(run, 'lpp-dsr-email').value = 'visitor@example.com';
    byId(run, 'lpp-dsr-type').value = 'deletion';
    byId(run, 'lpp-dsr-detail').value = 'Please delete what you hold about me.';
    byId(run, 'lpp-dsr-form').dispatch('submit');

    await waitFor(() => callsTo(calls, '/api/dsr')[0]?.status !== 0, 'the DSR response');
    const submission = callsTo(calls, '/api/dsr')[0];
    expect(submission.status).toBe(200);
    expect(submission.body).toMatchObject({
      requestType: 'deletion',
      contactEmail: 'visitor@example.com',
      detail: 'Please delete what you hold about me.',
    });

    const status = byId(run, 'lpp-dsr-status');
    expect(status.textContent).toContain(submission.payload.requestId);
    expect(status.textContent).toContain(String(submission.payload.responseWithinDays));
    expect(run.document.activeElement).toBe(status);

    // The request is in the operator's own read path, with its type intact.
    const record = await request(app)
      .get(`/api/dsr/${submission.payload.requestId}`)
      .set('x-admin-key', ADMIN_KEY);
    expect(record.status).toBe(200);
    expect(record.body.requestType).toBe('deletion');
    expect(record.body.requestId).toBe(submission.payload.requestId);
  });
});
