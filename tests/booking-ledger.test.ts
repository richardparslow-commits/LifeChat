/**
 * SEC-14 — the appointment ledger is durable and cross-process.
 *
 * The previous ledger lived only in bounded LRUs, so two instances could each
 * verify the same open slot and both confirm it. These tests cover the durable
 * claim file that now arbitrates: it is written once per slot, reloaded after a
 * restart (simulated with `reloadBookingsFromLedger`), and refused when the
 * ledger cannot be durable.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import {
  bookSlot,
  clearAllAppointments,
  getAppointmentForSlot,
  getAppointmentForSession,
  listAvailableSlots,
  reloadBookingsFromLedger,
  verifySlot,
} from '../src/scheduling/appointment-slots';
import { bookingLedgerDirectory, isSlotClaimed } from '../src/scheduling/booking-ledger';
import { config } from '../src/config/app-config';

/** Wednesday 2026-10-21, 10:00 in Chicago (CDT, UTC-5). */
const NOW = new Date('2026-10-21T15:00:00.000Z');

/** 13:00 Central the same day — past the 2-hour notice window. */
const SLOT_A = 'slot_20261021T1800Z';
/** 14:00 Central — a different bookable slot. */
const SLOT_B = 'slot_20261021T1900Z';

function sessionId(name: string): string {
  return `lpp_${name.padEnd(12, 'x').slice(0, 60)}`;
}

function tempPath(label: string): string {
  return path.join(os.tmpdir(), 'lifechat-booking-ledger-test', `${label}-${randomUUID()}`);
}

beforeEach(() => {
  clearAllAppointments();
});

afterAll(() => {
  clearAllAppointments();
});

describe('durable slot claims', () => {
  it('writes one claim file for a confirmed booking', () => {
    const booking = bookSlot({
      slotId: SLOT_A,
      sessionId: sessionId('claim-writer'),
      idempotencyKey: 'booking:claim-writer',
      now: NOW,
    });
    expect(booking.ok).toBe(true);

    const claims = readdirSync(bookingLedgerDirectory());
    expect(claims).toContain(`${SLOT_A}.json`);
    expect(isSlotClaimed(SLOT_A)).toBe(true);
  });

  it('refuses a slot claimed by another process before this process reloaded', () => {
    // A valid claim written by "another instance" after this index was built.
    mkdirSync(bookingLedgerDirectory(), { recursive: true });
    writeFileSync(
      path.join(bookingLedgerDirectory(), `${SLOT_B}.json`),
      JSON.stringify({
        appointment_id: 'apt_other_instance',
        slot_id: SLOT_B,
        session_id: 'lpp_other_instance',
        booked_at: NOW.toISOString(),
        idempotency_key: 'booking:other-instance',
      }),
    );

    // No reload: the claim file itself must make the slot unavailable.
    expect(verifySlot(SLOT_B, NOW)).toEqual({ ok: false, code: 'slot_already_booked' });
    expect(
      bookSlot({
        slotId: SLOT_B,
        sessionId: sessionId('stale-instance'),
        idempotencyKey: 'booking:stale-instance',
        now: NOW,
      }),
    ).toEqual({ ok: false, code: 'slot_already_booked' });
  });

  it('refuses the same slot to a second instance that reloads the ledger', () => {
    const first = bookSlot({
      slotId: SLOT_A,
      sessionId: sessionId('instance-a'),
      idempotencyKey: 'booking:instance-a',
      now: NOW,
    });
    expect(first.ok).toBe(true);

    // A second process starts with an empty index and reads the claim.
    reloadBookingsFromLedger();

    expect(getAppointmentForSlot(SLOT_A)?.session_id).toBe(sessionId('instance-a'));
    expect(verifySlot(SLOT_A, NOW)).toEqual({ ok: false, code: 'slot_already_booked' });
    expect(listAvailableSlots(NOW).map((slot) => slot.slot_id)).not.toContain(SLOT_A);

    const second = bookSlot({
      slotId: SLOT_A,
      sessionId: sessionId('instance-b'),
      idempotencyKey: 'booking:instance-b',
      now: NOW,
    });
    expect(second).toEqual({ ok: false, code: 'slot_already_booked' });
  });

  it('replays the original appointment after a reload', () => {
    const id = sessionId('replay-after-reload');
    const first = bookSlot({
      slotId: SLOT_A,
      sessionId: id,
      idempotencyKey: 'booking:replay-after-reload',
      now: NOW,
    });
    expect(first.ok).toBe(true);

    reloadBookingsFromLedger();

    const replay = bookSlot({
      slotId: SLOT_A,
      sessionId: id,
      idempotencyKey: 'booking:replay-after-reload',
      now: NOW,
    });
    expect(replay.ok).toBe(true);
    expect(replay.ok && replay.replayed).toBe(true);
    expect(replay.ok && replay.appointment.appointment_id).toBe(
      first.ok ? first.appointment.appointment_id : 'unreachable',
    );
    expect(getAppointmentForSession(id)?.slot_id).toBe(SLOT_A);
  });

  it('keeps a different slot bookable across a reload', () => {
    bookSlot({
      slotId: SLOT_A,
      sessionId: sessionId('holds-a'),
      idempotencyKey: 'booking:holds-a',
      now: NOW,
    });
    reloadBookingsFromLedger();

    const other = bookSlot({
      slotId: SLOT_B,
      sessionId: sessionId('wants-b'),
      idempotencyKey: 'booking:wants-b',
      now: NOW,
    });
    expect(other.ok).toBe(true);
    expect(other.ok && other.appointment.slot_id).toBe(SLOT_B);
  });

  it('treats a corrupt claim as occupied rather than double-booking the slot', () => {
    // A truncated write cannot be read as a booking, so it is not indexed —
    // but the file still exists, and ignoring it would risk a second booking.
    mkdirSync(bookingLedgerDirectory(), { recursive: true });
    writeFileSync(path.join(bookingLedgerDirectory(), `${SLOT_A}.json`), '{"appointment_id":');

    reloadBookingsFromLedger();

    expect(getAppointmentForSlot(SLOT_A)).toBeUndefined();
    expect(verifySlot(SLOT_A, NOW)).toEqual({ ok: false, code: 'slot_already_booked' });
  });
});

describe('ledger availability fails closed', () => {
  const originalPath = config.bookingLedgerPath;
  const originalServerless = config.serverless;

  afterEach(() => {
    config.bookingLedgerPath = originalPath;
    config.serverless = originalServerless;
  });

  it('refuses a booking when the ledger directory cannot be created', () => {
    // A regular file where the directory should be makes mkdir fail.
    const blocker = tempPath('blocker');
    mkdirSync(path.dirname(blocker), { recursive: true });
    writeFileSync(blocker, 'not a directory');
    config.bookingLedgerPath = path.join(blocker, 'bookings');

    const booking = bookSlot({
      slotId: SLOT_A,
      sessionId: sessionId('no-ledger'),
      idempotencyKey: 'booking:no-ledger',
      now: NOW,
    });
    expect(booking).toEqual({ ok: false, code: 'ledger_unavailable' });
    expect(existsSync(path.join(blocker, 'bookings'))).toBe(false);
  });

  it('refuses a booking on a serverless runtime pointed at an ephemeral path', () => {
    config.serverless = true;
    config.bookingLedgerPath = path.join(os.tmpdir(), 'lifechat-ephemeral-bookings');

    const booking = bookSlot({
      slotId: SLOT_A,
      sessionId: sessionId('ephemeral'),
      idempotencyKey: 'booking:ephemeral',
      now: NOW,
    });
    expect(booking).toEqual({ ok: false, code: 'ledger_unavailable' });
  });
});
