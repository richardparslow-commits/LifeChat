/**
 * Appointment slots in the widget: the server issues them, the visitor chooses
 * one, and only that id is sent back through /api/scheduling/select.
 *
 * The picker is rendered by the shipped public/widget.js, executed against the
 * shim DOM like the accessibility suite. That matters here because the rule
 * being tested is behavioural: the widget must offer exactly the slot ids the
 * availability response carried (no invented or client-built times), write
 * every label as text, and record the choice with the same session id it used
 * for the conversation.
 */

import { readFileSync } from 'fs';
import path from 'path';

import { runWidget, type FakeElement, type WidgetRun } from './helpers/dom-shim';

const WIDGET_SOURCE = readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');

const DISCLOSURE = { firstMessage: 'I am the Life Policy Pilot AI Educational Assistant.' };

const SCHEDULING_REPLY = {
  assistant_message: 'I can hold a time for you. Here are the next available appointments.',
  state: 'scheduling',
};

const SLOTS = [
  {
    slot_id: 'slot_20261021T1400Z',
    starts_at: '2026-10-21T14:00:00.000Z',
    ends_at: '2026-10-21T14:30:00.000Z',
    time_zone: 'America/Chicago',
    display: 'Wed, Oct 21, 9:00 AM',
  },
  {
    slot_id: 'slot_20261021T1430Z',
    starts_at: '2026-10-21T14:30:00.000Z',
    ends_at: '2026-10-21T15:00:00.000Z',
    time_zone: 'America/Chicago',
    display: 'Wed, Oct 21, 9:30 AM',
  },
];

const SLOTS_PAYLOAD = {
  timeZone: 'America/Chicago',
  slotDurationMinutes: 30,
  slots: SLOTS,
};

/** Open the panel from the launcher, the way a visitor starts a conversation. */
function open(run: WidgetRun): void {
  if (run.widget.styleValue('display') === 'none') run.launcher.dispatch('click');
}

/** Start the widget and settle the opening disclosure request. */
async function start(): Promise<WidgetRun> {
  const run = runWidget(WIDGET_SOURCE);
  await run.fetch.respond(DISCLOSURE);
  return run;
}

/** Open the panel, ask for times, and answer the chat and slots requests. */
async function askForTimes(
  run: WidgetRun,
  payload: unknown = SLOTS_PAYLOAD,
  reply: unknown = SCHEDULING_REPLY,
): Promise<void> {
  open(run);
  run.input.value = 'Can I book an appointment?';
  run.input.dispatch('keydown', { key: 'Enter', shiftKey: false });
  await run.fetch.respond(reply);
  await run.fetch.respond(payload);
}

function byClass(run: WidgetRun, className: string): FakeElement[] {
  return run.log.descendants().filter((node) => node.className.split(/\s+/).includes(className));
}

function slotButtons(run: WidgetRun): FakeElement[] {
  return byClass(run, 'lpp-slot');
}

function picker(run: WidgetRun): FakeElement | null {
  return byClass(run, 'lpp-slots')[0] ?? null;
}

function callsTo(run: WidgetRun, fragment: string) {
  return run.fetch.calls.filter((call) => call.url.includes(fragment));
}

describe('appointment slot picker', () => {
  it('renders the server-issued times as buttons in a labelled group', async () => {
    const run = await start();
    await askForTimes(run);

    expect(callsTo(run, '/api/scheduling/slots')).toHaveLength(1);
    expect(callsTo(run, '/api/scheduling/slots')[0].url).toBe(
      'https://server.example.test/api/scheduling/slots',
    );

    const group = byClass(run, 'lpp-slots-list')[0];
    expect(group).not.toBeNull();
    expect(group.tagName).toBe('DIV');
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-labelledby')).toBe('lpp-slots-title-1');
    expect(group.getAttribute('aria-describedby')).toBe('lpp-slots-hint-1');

    const title = byClass(run, 'lpp-slots-title')[0];
    expect(title.textContent).toBe('Available appointment times');
    expect(title.id).toBe('lpp-slots-title-1');

    const hint = byClass(run, 'lpp-slots-hint')[0];
    expect(hint.id).toBe('lpp-slots-hint-1');
    expect(hint.textContent).toContain("practice's time zone");

    const buttons = slotButtons(run);
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Wed, Oct 21, 9:00 AM',
      'Wed, Oct 21, 9:30 AM',
    ]);
    // One tab stop for the group: the first time is tabbable and the rest are
    // reached with the arrow keys.
    expect(buttons.map((button) => button.getAttribute('tabindex'))).toEqual(['0', '-1']);
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('role')).toBe('radio');
      expect(button.getAttribute('aria-checked')).toBe('false');
      expect(button.parentNode).toBe(group);
      expect(button.getAttribute('data-slot-id')).toMatch(/^slot_\d{8}T\d{4}Z$/);
    }
  });

  it('moves focus with the arrow keys, Home and End without choosing a time', async () => {
    const run = await start();
    await askForTimes(run);

    const [first, second] = slotButtons(run);
    first.focus();

    first.dispatch('keydown', { key: 'ArrowDown' });
    expect(run.document.activeElement).toBe(second);
    expect(second.getAttribute('tabindex')).toBe('0');
    expect(first.getAttribute('tabindex')).toBe('-1');

    // Both directions wrap, so the group can be walked from either end.
    second.dispatch('keydown', { key: 'ArrowRight' });
    expect(run.document.activeElement).toBe(first);
    first.dispatch('keydown', { key: 'ArrowLeft' });
    expect(run.document.activeElement).toBe(second);

    second.dispatch('keydown', { key: 'Home' });
    expect(run.document.activeElement).toBe(first);
    first.dispatch('keydown', { key: 'End' });
    expect(run.document.activeElement).toBe(second);

    // Moving focus is not choosing: nothing is checked and nothing is sent.
    expect(slotButtons(run).map((button) => button.getAttribute('aria-checked'))).toEqual([
      'false',
      'false',
    ]);
    expect(callsTo(run, '/api/scheduling/select')).toHaveLength(0);
  });

  it('commits the focused time with Enter and marks that radio checked', async () => {
    const run = await start();
    await askForTimes(run);

    const buttons = slotButtons(run);
    buttons[0].dispatch('keydown', { key: 'ArrowDown' });
    buttons[1].dispatch('keydown', { key: 'Enter' });

    const selects = callsTo(run, '/api/scheduling/select');
    expect(selects).toHaveLength(1);
    expect(JSON.parse(selects[0].init.body).slotId).toBe('slot_20261021T1430Z');
    // Checked while the save is in flight, and disabled so a second commit
    // cannot race the first.
    expect(buttons[1].getAttribute('aria-checked')).toBe('true');
    expect(buttons[0].getAttribute('aria-checked')).toBe('false');
    expect(buttons[1].disabled).toBe(true);
  });

  it('commits with Space, and clears the checked state when the save fails', async () => {
    const run = await start();
    await askForTimes(run);

    const buttons = slotButtons(run);
    buttons[0].focus();
    buttons[0].dispatch('keydown', { key: ' ' });

    expect(callsTo(run, '/api/scheduling/select')).toHaveLength(1);
    expect(buttons[0].getAttribute('aria-checked')).toBe('true');

    await run.fetch.respond({ error: 'Server error' }, 500);

    // Nothing was recorded, so nothing may stay marked as chosen.
    expect(buttons[0].getAttribute('aria-checked')).toBe('false');
    expect(buttons[0].disabled).toBe(false);
  });

  it('offers only well-formed, distinct slots and treats labels as text', async () => {
    const run = await start();
    await askForTimes(run, {
      slots: [
        null,
        { display: 'No id here' },
        { slot_id: 'slot_not-a-grid-id', display: 'Forged time' },
        { slot_id: 'slot_20261021T1500Z', display: '' },
        { slot_id: 'slot_20261021T1530Z', display: '<img src=x onerror="alert(1)">' },
        { ...SLOTS[0] },
        { ...SLOTS[0] },
      ],
    });

    const buttons = slotButtons(run);
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toBe('<img src=x onerror="alert(1)">');
    expect(buttons[1].textContent).toBe('Wed, Oct 21, 9:00 AM');
    // Written with textContent: no element was created from the label.
    expect(run.log.descendants().some((node) => node.tagName === 'IMG')).toBe(false);
  });

  it('caps the rendered list and says so', async () => {
    const run = await start();
    const many = Array.from({ length: 30 }, (_, index) => ({
      slot_id: `slot_202610${String(21 + Math.floor(index / 12)).padStart(2, '0')}T${String(
        9 + (index % 12),
      ).padStart(2, '0')}00Z`,
      starts_at: '2026-10-21T14:00:00.000Z',
      ends_at: '2026-10-21T14:30:00.000Z',
      time_zone: 'America/Chicago',
      display: `Time ${index + 1}`,
    }));

    await askForTimes(run, { slots: many });

    expect(slotButtons(run)).toHaveLength(24);
    expect(byClass(run, 'lpp-slots-status')[0].textContent).toBe(
      'Showing the next 24 available times.',
    );
  });

  it('says when no times are available', async () => {
    const run = await start();
    await askForTimes(run, { slots: [] });

    expect(slotButtons(run)).toHaveLength(0);
    expect(byClass(run, 'lpp-slots-status')[0].textContent).toBe(
      'No appointment times are currently available.',
    );
  });

  it('records the chosen slot through the select endpoint', async () => {
    const run = await start();
    await askForTimes(run);

    slotButtons(run)[1].dispatch('click');
    expect(slotButtons(run)[1].getAttribute('aria-checked')).toBe('true');
    expect(slotButtons(run)[0].getAttribute('aria-checked')).toBe('false');

    const selects = callsTo(run, '/api/scheduling/select');
    expect(selects).toHaveLength(1);
    expect(selects[0].url).toBe('https://server.example.test/api/scheduling/select');
    expect(selects[0].init.method).toBe('POST');
    expect(selects[0].init.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(selects[0].init.body);
    expect(body.slotId).toBe('slot_20261021T1430Z');
    // The same session the conversation is using, not a fresh one.
    const chatBody = JSON.parse(callsTo(run, '/api/chat')[0].init.body);
    expect(body.sessionId).toBe(chatBody.sessionId);

    await run.fetch.respond({
      sessionId: body.sessionId,
      slotId: body.slotId,
      startsAt: '2026-10-21T14:30:00.000Z',
      timeZone: 'America/Chicago',
      selected: true,
    });

    expect(slotButtons(run)).toHaveLength(0);
    const status = byClass(run, 'lpp-slots-status')[0];
    expect(status.textContent).toBe(
      'Selected Wed, Oct 21, 9:30 AM. Reply in the chat to confirm the appointment.',
    );
    expect(status.getAttribute('tabindex')).toBe('-1');
    expect(run.document.activeElement).toBe(status);
  });

  it('submits once even when a button is clicked again before the reply', async () => {
    const run = await start();
    await askForTimes(run);

    const button = slotButtons(run)[0];
    button.dispatch('click');
    button.dispatch('click');

    expect(callsTo(run, '/api/scheduling/select')).toHaveLength(1);
  });

  it('refreshes the times when the chosen slot was just taken', async () => {
    const run = await start();
    await askForTimes(run);

    slotButtons(run)[0].dispatch('click');
    await run.fetch.respond({ error: 'Slot unavailable' }, 409);

    expect(byClass(run, 'lpp-slots-alert')[0].textContent).toBe(
      'That time was just taken. Showing the updated times.',
    );
    expect(callsTo(run, '/api/scheduling/slots')).toHaveLength(2);

    await run.fetch.respond({ slots: [SLOTS[1]] });
    expect(slotButtons(run)).toHaveLength(1);
    expect(slotButtons(run)[0].textContent).toBe('Wed, Oct 21, 9:30 AM');
    expect(slotButtons(run)[0].disabled).toBeFalsy();
  });

  it('re-enables the times when the selection fails', async () => {
    const run = await start();
    await askForTimes(run);

    slotButtons(run)[0].dispatch('click');
    await run.fetch.fail(new Error('network'));

    expect(byClass(run, 'lpp-slots-alert')[0].textContent).toBe(
      'That time could not be saved. Please try again.',
    );
    expect(slotButtons(run)[0].disabled).toBeFalsy();
    expect(slotButtons(run)[0].getAttribute('aria-checked')).toBe('false');

    slotButtons(run)[0].dispatch('click');
    expect(callsTo(run, '/api/scheduling/select')).toHaveLength(2);
  });

  it('surfaces a rate limit without losing the offered times', async () => {
    const run = await start();
    await askForTimes(run);

    slotButtons(run)[0].dispatch('click');
    await run.fetch.respond({ error: 'Too many requests' }, 429);

    expect(byClass(run, 'lpp-slots-alert')[0].textContent).toBe(
      'Too many requests. Please wait a moment and try again.',
    );
    expect(slotButtons(run)).toHaveLength(2);
    expect(slotButtons(run)[0].disabled).toBeFalsy();
  });

  it('offers a retry when availability cannot be loaded', async () => {
    const run = await start();
    await askForTimes(run, SLOTS_PAYLOAD);
    // A fresh scheduling turn whose availability call fails.
    run.input.value = 'Another time?';
    run.input.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await run.fetch.respond(SCHEDULING_REPLY);
    await run.fetch.fail(new Error('network'));

    const retry = byClass(run, 'lpp-slot-retry')[0];
    expect(retry).toBeDefined();
    expect(byClass(run, 'lpp-slots-alert')[0].textContent).toBe(
      'Could not load available times. Please try again.',
    );

    retry.dispatch('click');
    expect(callsTo(run, '/api/scheduling/slots')).toHaveLength(3);
    await run.fetch.respond({ slots: [SLOTS[0]] });
    expect(slotButtons(run)).toHaveLength(1);
  });

  it('does not offer times outside a scheduling turn', async () => {
    const run = await start();
    open(run);
    run.input.value = 'What does term life cover?';
    run.input.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await run.fetch.respond({
      assistant_message: 'Term life covers a set period.',
      state: 'education',
    });

    expect(picker(run)).toBeNull();
    expect(callsTo(run, '/api/scheduling/slots')).toHaveLength(0);
    expect(run.fetch.pendingCount).toBe(0);
  });

  it('replaces the picker rather than stacking one per scheduling turn', async () => {
    const run = await start();
    await askForTimes(run);
    expect(byClass(run, 'lpp-slots')).toHaveLength(1);

    run.input.value = 'What about Friday?';
    run.input.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await run.fetch.respond(SCHEDULING_REPLY);
    await run.fetch.respond(SLOTS_PAYLOAD);

    expect(byClass(run, 'lpp-slots')).toHaveLength(1);
    expect(byClass(run, 'lpp-slots-list')[0].getAttribute('aria-labelledby')).toBe(
      'lpp-slots-title-2',
    );
  });
});
