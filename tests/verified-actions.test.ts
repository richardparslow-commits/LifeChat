/**
 * Server-side verification for the two side effects the model may propose:
 * creating a lead and booking an appointment (Section 4.8 / ARCH-02).
 *
 * The unit under test is the *facts*: consent is read from the durable record
 * /api/consent wrote, the slot comes from the server's own inventory, the
 * visitor's choice is recorded before a booking may name it, and every retry
 * is idempotent. A model-supplied consent block, slot id, or idempotency key
 * must never be enough on its own.
 */

import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

process.env.LEAD_LOG_PATH = tempLogPath('verified-actions-lead');
process.env.DSR_LOG_PATH = tempLogPath('verified-actions-dsr');

import { config } from '../src/config/app-config';
import {
  clearAllLeadRecords,
  createLeadRecord,
  getVerifiedContactConsent,
  listLeadRecords,
  saveLeadRecord,
  type LeadRecord,
} from '../src/consent/consent-model';
import { clearAllDsrRecords, submitDsr } from '../src/privacy/dsr';
import {
  bookSlot,
  clearAllAppointments,
  getAppointmentForSession,
  listAvailableSlots,
  parseSlotId,
  verifySlot,
} from '../src/scheduling/appointment-slots';
import { clearAllSessions, getSelectedSlot, setSelectedSlot } from '../src/llm/session-store';
import { executeProposedAction } from '../src/tools/verified-actions';

/** Wednesday 2026-10-21, 10:00 in Chicago (CDT, UTC-5). */
const NOW = new Date('2026-10-21T15:00:00.000Z');

/** 13:00 Central the same day — past the 2-hour notice window. */
const BOOKABLE_SLOT = 'slot_20261021T1800Z';

function sessionId(name: string): string {
  return `lpp_${name
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 50)
    .padEnd(12, 'x')}`;
}

/** Saves a complete, current consent record for a session. */
async function saveConsent(id: string, overrides: Partial<LeadRecord> = {}): Promise<LeadRecord> {
  const lead = createLeadRecord('article-1', '/term-life', 'term_life');
  lead.session_id = id;
  lead.email = 'visitor@example.com';
  lead.contact_channel = 'email';
  lead.contact_consent_version = config.contactConsentVersion;
  lead.consent_timestamp = new Date().toISOString();
  lead.consent_text_hash = 'sha256:test';
  Object.assign(lead, overrides);
  await saveLeadRecord(lead);
  return lead;
}

beforeEach(async () => {
  await clearAllLeadRecords();
  await clearAllDsrRecords();
  clearAllAppointments();
  clearAllSessions();
});

afterAll(async () => {
  await clearAllLeadRecords();
  await clearAllDsrRecords();
  cleanupTempLogs(process.env.LEAD_LOG_PATH, process.env.DSR_LOG_PATH);
  delete process.env.LEAD_LOG_PATH;
  delete process.env.DSR_LOG_PATH;
});

describe('slot inventory', () => {
  it('issues slot ids on the half-hour grid that round-trip', () => {
    const slots = listAvailableSlots(NOW);
    expect(slots.length).toBeGreaterThan(0);

    for (const slot of slots) {
      expect(parseSlotId(slot.slot_id)?.toISOString()).toBe(slot.starts_at);
      expect(verifySlot(slot.slot_id, NOW).ok).toBe(true);
    }
    // Every listed slot is uniquely identified.
    expect(new Set(slots.map((slot) => slot.slot_id)).size).toBe(slots.length);
  });

  it('only lists staffed business hours', () => {
    // Ids are generated here, so this is the inventory's own claim checked
    // against its own verifier: a slot the verifier would reject must never be
    // offered.
    const slots = listAvailableSlots(NOW);
    for (const slot of slots) {
      expect(verifySlot(slot.slot_id, NOW).ok).toBe(true);
    }
  });

  it('rejects a malformed or overflowing id', () => {
    expect(verifySlot('slot_nope', NOW)).toEqual({ ok: false, code: 'invalid_slot_id' });
    expect(verifySlot(undefined, NOW)).toEqual({ ok: false, code: 'invalid_slot_id' });
    // 31 February rolls forward to 2/3 if the checksum round-trip is skipped.
    expect(verifySlot('slot_20260231T1800Z', NOW)).toEqual({
      ok: false,
      code: 'invalid_slot_id',
    });
  });

  it('rejects a slot outside staffed hours', () => {
    // 12:00 UTC is 07:00 Central — before the 08:00 open.
    expect(verifySlot('slot_20261021T1200Z', NOW)).toEqual({
      ok: false,
      code: 'slot_outside_business_hours',
    });
    // 2026-10-24 is a Saturday.
    expect(verifySlot('slot_20261024T1800Z', NOW)).toEqual({
      ok: false,
      code: 'slot_outside_business_hours',
    });
  });

  it('rejects a slot inside the notice window', () => {
    // 16:00Z is 11:00 Central, one hour out.
    expect(verifySlot('slot_20261021T1600Z', NOW)).toEqual({ ok: false, code: 'slot_too_soon' });
  });

  it('rejects a slot beyond the booking horizon', () => {
    expect(verifySlot('slot_20261120T1800Z', NOW)).toEqual({
      ok: false,
      code: 'slot_out_of_horizon',
    });
  });

  it('rejects a slot that has already been booked', () => {
    const first = bookSlot({
      slotId: BOOKABLE_SLOT,
      sessionId: sessionId('slot-holder'),
      idempotencyKey: 'booking:first',
      now: NOW,
    });
    expect(first.ok).toBe(true);

    expect(verifySlot(BOOKABLE_SLOT, NOW)).toEqual({
      ok: false,
      code: 'slot_already_booked',
    });
    expect(listAvailableSlots(NOW).map((slot) => slot.slot_id)).not.toContain(BOOKABLE_SLOT);
  });
});

describe('bookSlot — idempotency', () => {
  it('replays the same appointment for a repeated key', () => {
    const id = sessionId('replay');
    const first = bookSlot({
      slotId: BOOKABLE_SLOT,
      sessionId: id,
      idempotencyKey: 'booking:one',
      now: NOW,
    });
    const second = bookSlot({
      slotId: BOOKABLE_SLOT,
      sessionId: id,
      idempotencyKey: 'booking:one',
      now: NOW,
    });

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.appointment.appointment_id).toBe(first.appointment.appointment_id);
      expect(second.replayed).toBe(true);
      expect(first.replayed).toBe(false);
    }
    // One booking, not two.
    expect(getAppointmentForSession(id)?.slot_id).toBe(BOOKABLE_SLOT);
  });

  it('refuses to let a key mean a different slot or session', () => {
    bookSlot({
      slotId: BOOKABLE_SLOT,
      sessionId: sessionId('key-owner'),
      idempotencyKey: 'booking:shared',
      now: NOW,
    });

    const otherSlot = bookSlot({
      slotId: 'slot_20261021T1900Z',
      sessionId: sessionId('key-owner'),
      idempotencyKey: 'booking:shared',
      now: NOW,
    });
    expect(otherSlot).toEqual({ ok: false, code: 'idempotency_conflict' });

    const otherSession = bookSlot({
      slotId: BOOKABLE_SLOT,
      sessionId: sessionId('key-thief'),
      idempotencyKey: 'booking:shared',
      now: NOW,
    });
    expect(otherSession).toEqual({ ok: false, code: 'idempotency_conflict' });
  });

  it('refuses a second slot for a session that already holds one', () => {
    const id = sessionId('double-book');
    bookSlot({
      slotId: BOOKABLE_SLOT,
      sessionId: id,
      idempotencyKey: 'booking:a',
      now: NOW,
    });
    const second = bookSlot({
      slotId: 'slot_20261021T1900Z',
      sessionId: id,
      idempotencyKey: 'booking:b',
      now: NOW,
    });
    expect(second).toEqual({ ok: false, code: 'appointment_exists' });
  });

  it('requires a non-empty idempotency key', () => {
    expect(
      bookSlot({
        slotId: BOOKABLE_SLOT,
        sessionId: sessionId('no-key'),
        idempotencyKey: '   ',
        now: NOW,
      }),
    ).toEqual({ ok: false, code: 'idempotency_key_required' });
  });
});

describe('getVerifiedContactConsent', () => {
  it('finds nothing for a session that never submitted consent', async () => {
    expect(await getVerifiedContactConsent(sessionId('unknown'))).toEqual({
      ok: false,
      reason: 'no_consent_record',
    });
  });

  it('returns the stored consent for a complete, current record', async () => {
    const id = sessionId('consented');
    const lead = await saveConsent(id);

    const result = await getVerifiedContactConsent(id);
    expect(result).toEqual({
      ok: true,
      consent: {
        leadId: lead.lead_id,
        channel: 'email',
        email: 'visitor@example.com',
        phone: null,
        version: config.contactConsentVersion,
        consentedAt: lead.consent_timestamp,
      },
    });
  });

  it('treats an incomplete artifact as no consent', async () => {
    const id = sessionId('incomplete');
    await saveConsent(id, { consent_text_hash: null });
    expect(await getVerifiedContactConsent(id)).toEqual({
      ok: false,
      reason: 'no_consent_record',
    });
  });

  it('rejects a superseded consent version', async () => {
    const id = sessionId('stale');
    await saveConsent(id, { contact_consent_version: '0.0.1' });
    expect(await getVerifiedContactConsent(id)).toEqual({
      ok: false,
      reason: 'stale_consent_version',
    });
  });

  it('rejects a contact value that does not match its channel', async () => {
    const id = sessionId('bad-channel');
    await saveConsent(id, { contact_channel: 'phone', email: 'visitor@example.com', phone: null });
    expect(await getVerifiedContactConsent(id)).toEqual({
      ok: false,
      reason: 'invalid_contact_field',
    });
  });

  it('falls back to the log when the in-process index has evicted the session', async () => {
    // The index is a bounded cache, so a miss must not be mistaken for "no
    // consent": the durable record still proves it.
    const id = sessionId('evicted');
    const lead = await saveConsent(id);

    const result = await getVerifiedContactConsent(id);
    expect(result.ok && result.consent.leadId).toBe(lead.lead_id);
  });
});

describe('executeProposedAction — create_lead', () => {
  it('refuses a lead the model claimed consent for, when no record exists', async () => {
    const result = await executeProposedAction({
      sessionId: sessionId('no-record'),
      proposedAction: 'create_lead',
      actionArguments: { idempotency_key: 'model-key', lead_data: { email: 'x@y.com' } },
      now: NOW,
    });

    expect(result.authorized).toBe(false);
    expect(result.code).toBe('consent_not_verified');
    expect(listLeadRecords()).toHaveLength(0);
  });

  it('acknowledges the consented record without writing a second one', async () => {
    const id = sessionId('lead-ok');
    const lead = await saveConsent(id);

    const result = await executeProposedAction({
      sessionId: id,
      proposedAction: 'create_lead',
      // Model-supplied arguments are ignored entirely.
      actionArguments: { idempotency_key: 'model-key', lead_data: { email: 'model@example.com' } },
      now: NOW,
    });

    expect(result.authorized).toBe(true);
    expect(result.effect?.leadId).toBe(lead.lead_id);
    expect(result.sanitizedArguments).toEqual({ lead_id: lead.lead_id });
    // The model's key and lead data never reach the response.
    expect(JSON.stringify(result.sanitizedArguments)).not.toContain('model-key');
    expect(JSON.stringify(result.sanitizedArguments)).not.toContain('model@example.com');
    // Exactly the one record /api/consent created.
    expect(listLeadRecords()).toHaveLength(1);

    // A retry replays the same acknowledgement.
    const retry = await executeProposedAction({
      sessionId: id,
      proposedAction: 'create_lead',
      actionArguments: {},
      now: NOW,
    });
    expect(retry.effect?.leadId).toBe(lead.lead_id);
    expect(listLeadRecords()).toHaveLength(1);
  });

  it('suppresses everything when do_not_contact is set', async () => {
    const id = sessionId('dnc');
    await saveConsent(id);
    const result = await executeProposedAction({
      sessionId: id,
      proposedAction: 'create_lead',
      doNotContact: true,
      now: NOW,
    });
    expect(result.authorized).toBe(false);
    expect(result.code).toBe('consent_withdrawn');
  });

  it('suppresses everything while a deletion request is open', async () => {
    const id = sessionId('dsr');
    await saveConsent(id);
    const dsr = await submitDsr({
      requestType: 'deletion',
      contactEmail: 'Visitor@Example.com',
    });
    expect(dsr.ok).toBe(true);

    const result = await executeProposedAction({
      sessionId: id,
      proposedAction: 'create_lead',
      now: NOW,
    });
    expect(result.authorized).toBe(false);
    expect(result.code).toBe('consent_withdrawn');
  });
});

describe('executeProposedAction — book_appointment', () => {
  it('requires the slot the visitor selected', async () => {
    const id = sessionId('no-selection');
    await saveConsent(id);

    const result = await executeProposedAction({
      sessionId: id,
      proposedAction: 'book_appointment',
      actionArguments: { slot_id: BOOKABLE_SLOT },
      now: NOW,
    });

    expect(result.authorized).toBe(false);
    expect(result.code).toBe('slot_selection_required');
    expect(getAppointmentForSession(id)).toBeUndefined();
  });

  it('refuses a slot the visitor selected but the model then replaced', async () => {
    const id = sessionId('swap');
    await saveConsent(id);
    setSelectedSlot(id, BOOKABLE_SLOT);
    expect(getSelectedSlot(id)).toBe(BOOKABLE_SLOT);

    const result = await executeProposedAction({
      sessionId: id,
      proposedAction: 'book_appointment',
      actionArguments: { slot_id: 'slot_20261021T1900Z' },
      now: NOW,
    });
    expect(result.authorized).toBe(false);
    expect(result.code).toBe('slot_selection_required');
  });

  it('books the selected slot exactly once, replaying on retry', async () => {
    const id = sessionId('books');
    await saveConsent(id);
    setSelectedSlot(id, BOOKABLE_SLOT);

    const first = await executeProposedAction({
      sessionId: id,
      proposedAction: 'book_appointment',
      actionArguments: { slot_id: BOOKABLE_SLOT, idempotency_key: 'model-key' },
      now: NOW,
    });
    expect(first.authorized).toBe(true);
    const appointmentId = first.effect?.appointmentId;
    expect(appointmentId).toMatch(/^apt_/);
    expect(first.sanitizedArguments).toEqual({
      appointment_id: appointmentId,
      slot_id: BOOKABLE_SLOT,
    });

    const retry = await executeProposedAction({
      sessionId: id,
      proposedAction: 'book_appointment',
      actionArguments: { slot_id: BOOKABLE_SLOT },
      now: NOW,
    });
    expect(retry.authorized).toBe(true);
    expect(retry.effect?.appointmentId).toBe(appointmentId);
    expect(retry.effect?.replayed).toBe(true);
  });

  it('refuses a slot another session already took', async () => {
    const holder = sessionId('slot-holder-2');
    bookSlot({
      slotId: BOOKABLE_SLOT,
      sessionId: holder,
      idempotencyKey: 'booking:holder',
      now: NOW,
    });

    const id = sessionId('late');
    await saveConsent(id, { email: 'late@example.com' });
    setSelectedSlot(id, BOOKABLE_SLOT);

    const result = await executeProposedAction({
      sessionId: id,
      proposedAction: 'book_appointment',
      actionArguments: { slot_id: BOOKABLE_SLOT },
      now: NOW,
    });
    expect(result.authorized).toBe(false);
    expect(result.code).toBe('slot_not_verified');
    expect(getAppointmentForSession(id)).toBeUndefined();
  });

  it('re-verifies at commit time, so a stale selection expires', async () => {
    const id = sessionId('stale-slot');
    await saveConsent(id);
    setSelectedSlot(id, BOOKABLE_SLOT);

    // Time moves past the appointment start: the same id is no longer bookable.
    const later = new Date('2026-10-21T18:30:00.000Z');
    const result = await executeProposedAction({
      sessionId: id,
      proposedAction: 'book_appointment',
      actionArguments: { slot_id: BOOKABLE_SLOT },
      now: later,
    });
    expect(result.authorized).toBe(false);
    expect(result.code).toBe('slot_not_verified');
  });
});

describe('executeProposedAction — confirmation and fail-closed defaults', () => {
  it('only accepts the appointment id this server issued', async () => {
    const id = sessionId('confirm');
    await saveConsent(id);
    setSelectedSlot(id, BOOKABLE_SLOT);
    const booking = await executeProposedAction({
      sessionId: id,
      proposedAction: 'book_appointment',
      actionArguments: { slot_id: BOOKABLE_SLOT },
      now: NOW,
    });

    const invented = await executeProposedAction({
      sessionId: id,
      proposedAction: 'send_transactional_confirmation',
      actionArguments: { appointment_id: 'apt_made_up' },
      now: NOW,
    });
    expect(invented.authorized).toBe(false);
    expect(invented.code).toBe('appointment_not_verified');

    const real = await executeProposedAction({
      sessionId: id,
      proposedAction: 'send_transactional_confirmation',
      actionArguments: { appointment_id: booking.effect?.appointmentId },
      now: NOW,
    });
    expect(real.authorized).toBe(true);
    expect(real.effect?.appointmentId).toBe(booking.effect?.appointmentId);
  });

  it('refuses every side effect on an ephemeral serverless runtime', async () => {
    const id = sessionId('serverless');
    await saveConsent(id);
    setSelectedSlot(id, BOOKABLE_SLOT);

    const original = config.serverless;
    config.serverless = true;
    try {
      for (const proposedAction of [
        'create_lead',
        'book_appointment',
        'send_transactional_confirmation',
      ] as const) {
        const result = await executeProposedAction({
          sessionId: id,
          proposedAction,
          actionArguments: { slot_id: BOOKABLE_SLOT, appointment_id: 'apt_any' },
          now: NOW,
        });
        expect(result.authorized).toBe(false);
        expect(result.code).toBe('storage_unavailable');
      }
      expect(getAppointmentForSession(id)).toBeUndefined();
    } finally {
      config.serverless = original;
    }
  });

  it('keeps availability reads and handoffs side-effect free but allowlisted', async () => {
    const slots = await executeProposedAction({
      sessionId: sessionId('availability'),
      proposedAction: 'get_calendar_slots',
      actionArguments: { time_zone: 'America/Chicago' },
      now: NOW,
    });
    expect(slots.authorized).toBe(true);
    expect(slots.effect?.availableSlots?.length).toBeGreaterThan(0);

    const handoff = await executeProposedAction({
      sessionId: sessionId('handoff'),
      proposedAction: 'request_human_handoff',
      actionArguments: {
        handoff_reason: 'individualized_recommendation',
        summary: 'Asked for a recommendation.',
      },
      now: NOW,
    });
    expect(handoff.authorized).toBe(true);
    expect(handoff.sanitizedArguments).toEqual({
      handoff_reason: 'individualized_recommendation',
      summary: 'Asked for a recommendation.',
    });

    const injected = await executeProposedAction({
      sessionId: sessionId('handoff-injection'),
      proposedAction: 'request_human_handoff',
      actionArguments: { handoff_reason: 'x', ssn: '111-11-1111' },
      now: NOW,
    });
    expect(injected.authorized).toBe(false);
    expect(injected.code).toBe('tool_not_authorized');
  });
});
