/**
 * Server-side appointment slots and bookings (Section 4.8 / Section 10).
 *
 * The model may propose a booking, but a slot is only real if *this module*
 * issued it. Slot ids are derived from the UTC half-hour grid and re-derived
 * on verification, so an id the model invented (or a stale one copied from an
 * earlier turn) fails the same checks a client-forged id does: the wall clock
 * must fall inside staffed hours in Central Time, the start must be far enough
 * out to be actionable and close enough to be on the bookable horizon, and the
 * slot must not already hold an appointment.
 *
 * Idempotency is enforced here rather than trusted from the model: a repeat
 * booking with the same key returns the appointment it already created instead
 * of creating a second one, a key reused for a different slot/session is
 * refused, and a session may hold at most one appointment. Check-and-set is
 * synchronous, so two requests interleaved on the event loop cannot both win
 * the same slot.
 *
 * Durability and cross-instance uniqueness (SEC-14): the in-memory indexes are
 * a cache over one durable claim file per booked slot. `bookSlot` creates the
 * claim with `O_CREAT|O_EXCL` before indexing it, so a second process — not
 * just a second request — loses the race and reports the slot as taken. Claims
 * are reloaded on first use, so a restart keeps every booking and the slot
 * inventory stays accurate. Limits (documented in docs/verified-actions.md):
 * the ledger needs a shared POSIX filesystem; Archil's object API has no
 * conditional create, so booking is refused there rather than acknowledged
 * without a uniqueness guarantee. A long-lived deployment that expects to
 * replace this ledger with the practice-management calendar should book there
 * through a real calendar API instead.
 */

import { v4 as uuidv4 } from 'uuid';

import { SERVICE_LEVEL_AGREEMENT } from '../handoff/human-escalation';
import { BoundedLruCache } from '../persistence/bounded-lru';
import { claimSlot, clearBookingClaims, isSlotClaimed, loadBookingClaims } from './booking-ledger';

/** Display zone for slot times; the practice operates on Central Time. */
export const SCHEDULING_TIME_ZONE = SERVICE_LEVEL_AGREEMENT.BUSINESS_HOURS_TIMEZONE;

/** Length of one appointment, and the step between slot starts. */
export const SLOT_DURATION_MINUTES = 30;

/** How far ahead a visitor may book. */
export const BOOKING_HORIZON_DAYS = 14;

/** Notice required before a slot can be booked, so staff can prepare. */
export const MINIMUM_NOTICE_HOURS = 2;

/** Upper bound on resident appointments (bounded like every other store). */
export const MAX_TRACKED_APPOINTMENTS = 2000;

/** Upper bound on one availability response. */
export const MAX_LISTED_SLOTS = 200;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SLOT_STEP_MS = SLOT_DURATION_MINUTES * MINUTE_MS;

const SLOT_ID_PATTERN = /^slot_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/;

const BUSINESS_DAYS: readonly string[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/** A bookable window, resolved from the same business hours the SLA publishes. */
function businessWindow(): { startMinutes: number; endMinutes: number } {
  const [startHour, startMinute] = SERVICE_LEVEL_AGREEMENT.BUSINESS_HOURS.start
    .split(':')
    .map(Number);
  const [endHour, endMinute] = SERVICE_LEVEL_AGREEMENT.BUSINESS_HOURS.end.split(':').map(Number);
  return {
    startMinutes: startHour * 60 + startMinute,
    endMinutes: endHour * 60 + endMinute,
  };
}

/**
 * Wall-clock weekday and minute-of-day in Central Time.
 *
 * `hour12: false` yields '24' for midnight in some ICU builds, so the hour is
 * reduced modulo 24 rather than trusted as-is.
 */
function centralClock(date: Date): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULING_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return { weekday, minutes: hour * 60 + minute };
}

/**
 * True when a slot starting at `date` fits entirely inside staffed hours on a
 * business day.
 */
function isInsideBusinessHours(date: Date): boolean {
  const { weekday, minutes } = centralClock(date);
  if (!BUSINESS_DAYS.includes(weekday)) return false;
  const { startMinutes, endMinutes } = businessWindow();
  return minutes >= startMinutes && minutes + SLOT_DURATION_MINUTES <= endMinutes;
}

/** Canonical slot id for the UTC half-hour grid: `slot_YYYYMMDDTHHmmZ`. */
export function formatSlotId(date: Date): string {
  const iso = date.toISOString();
  return `slot_${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(
    11,
    13,
  )}${iso.slice(14, 16)}Z`;
}

/**
 * Parses a slot id back to its start instant.
 *
 * The round-trip check rejects calendar overflow ('2026-02-31', '25:00') that
 * `Date.UTC` would silently roll forward into a *different*, valid slot.
 */
export function parseSlotId(slotId: unknown): Date | null {
  if (typeof slotId !== 'string') return null;
  const match = SLOT_ID_PATTERN.exec(slotId);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)),
  );
  return formatSlotId(date) === slotId ? date : null;
}

/** Wire shape of one available slot. */
export interface AppointmentSlot {
  slot_id: string;
  /** ISO 8601 UTC start. */
  starts_at: string;
  /** ISO 8601 UTC end. */
  ends_at: string;
  time_zone: string;
  /** Local Central Time label for display (e.g. `Wed, Oct 21, 9:00 AM`). */
  display: string;
}

/** Wire shape of a confirmed appointment. */
export interface Appointment {
  appointment_id: string;
  slot_id: string;
  session_id: string;
  booked_at: string;
}

const appointmentsBySlot = new BoundedLruCache<string, Appointment>(MAX_TRACKED_APPOINTMENTS);
const appointmentsByKey = new BoundedLruCache<string, Appointment>(MAX_TRACKED_APPOINTMENTS);
const appointmentsBySession = new BoundedLruCache<string, Appointment>(MAX_TRACKED_APPOINTMENTS);

/**
 * True once the durable claims have been folded into the in-memory indexes.
 * Loading lazily keeps module import side-effect free and lets a restart pick
 * up bookings written by a previous process on first use.
 */
let ledgerLoaded = false;

function indexAppointment(appointment: Appointment, idempotencyKey: string): void {
  appointmentsBySlot.set(appointment.slot_id, appointment);
  appointmentsByKey.set(idempotencyKey, appointment);
  appointmentsBySession.set(appointment.session_id, appointment);
}

function ensureLedgerLoaded(): void {
  if (ledgerLoaded) return;
  ledgerLoaded = true;
  for (const claim of loadBookingClaims()) {
    indexAppointment(
      {
        appointment_id: claim.appointment_id,
        slot_id: claim.slot_id,
        session_id: claim.session_id,
        booked_at: claim.booked_at,
      },
      claim.idempotency_key,
    );
  }
}

/** Why a slot id was refused. Stable codes, safe to log and to return. */
export type SlotRejectionCode =
  | 'invalid_slot_id'
  | 'slot_outside_business_hours'
  | 'slot_too_soon'
  | 'slot_out_of_horizon'
  | 'slot_already_booked';

export type SlotVerification =
  { ok: true; slot: AppointmentSlot } | { ok: false; code: SlotRejectionCode };

/** Formats a slot for display in the practice's time zone. */
function displayLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULING_TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function slotFromDate(date: Date): AppointmentSlot {
  return {
    slot_id: formatSlotId(date),
    starts_at: date.toISOString(),
    ends_at: new Date(date.getTime() + SLOT_STEP_MS).toISOString(),
    time_zone: SCHEDULING_TIME_ZONE,
    display: displayLabel(date),
  };
}

/**
 * Re-verifies a slot id against the server's own inventory at commit time.
 *
 * This is the check the model cannot perform and cannot skip: it is applied
 * both when the user selects a slot and again immediately before a booking is
 * written, so a slot that was taken (or that has since fallen inside the
 * notice window) between those two moments is refused.
 */
export function verifySlot(slotId: unknown, now: Date = new Date()): SlotVerification {
  ensureLedgerLoaded();
  const start = parseSlotId(slotId);
  if (start === null) return { ok: false, code: 'invalid_slot_id' };

  const canonicalId = formatSlotId(start);
  if (!isInsideBusinessHours(start)) {
    return { ok: false, code: 'slot_outside_business_hours' };
  }
  if (start.getTime() < now.getTime() + MINIMUM_NOTICE_HOURS * HOUR_MS) {
    return { ok: false, code: 'slot_too_soon' };
  }
  if (start.getTime() > now.getTime() + BOOKING_HORIZON_DAYS * DAY_MS) {
    return { ok: false, code: 'slot_out_of_horizon' };
  }
  // Memory first, then the claim file: an instance whose index has not reloaded
  // since another instance booked the slot still refuses it here.
  if (appointmentsBySlot.get(canonicalId) || isSlotClaimed(canonicalId)) {
    return { ok: false, code: 'slot_already_booked' };
  }
  return { ok: true, slot: slotFromDate(start) };
}

/**
 * Lists bookable slots from now to the booking horizon, excluding ones already
 * taken. Times are generated here, so anything the model says about
 * availability is irrelevant to what the user can actually select.
 */
export function listAvailableSlots(
  now: Date = new Date(),
  maxSlots: number = MAX_LISTED_SLOTS,
): AppointmentSlot[] {
  ensureLedgerLoaded();
  const earliest = now.getTime() + MINIMUM_NOTICE_HOURS * HOUR_MS;
  const latest = now.getTime() + BOOKING_HORIZON_DAYS * DAY_MS;

  // Align to the next half-hour boundary on the UTC grid. Central Time is a
  // whole number of hours from UTC, so UTC :00/:30 boundaries are the local
  // ones too (including across daylight saving).
  let cursor = Math.ceil(earliest / SLOT_STEP_MS) * SLOT_STEP_MS;

  const slots: AppointmentSlot[] = [];
  while (cursor <= latest && slots.length < maxSlots) {
    const start = new Date(cursor);
    if (isInsideBusinessHours(start) && !appointmentsBySlot.get(formatSlotId(start))) {
      slots.push(slotFromDate(start));
    }
    cursor += SLOT_STEP_MS;
  }
  return slots;
}

/** Why a booking attempt was refused (slot codes plus ledger codes). */
export type BookingRejectionCode =
  | SlotRejectionCode
  | 'idempotency_key_required'
  | 'idempotency_conflict'
  | 'appointment_exists'
  /** The ledger cannot make a durable, cross-process claim on this runtime. */
  | 'ledger_unavailable';

export type BookingResult =
  | { ok: true; appointment: Appointment; replayed: boolean }
  | { ok: false; code: BookingRejectionCode };

/**
 * Books a verified slot, exactly once per idempotency key.
 *
 * - The same key for the same session and slot replays the original
 *   appointment (`replayed: true`) instead of creating a second booking.
 * - The same key pointing at a different slot or session is a conflict: the
 *   caller is not allowed to redefine what a key means.
 * - A session that already holds a different appointment is refused rather
 *   than silently double-booking the visitor.
 */
export function bookSlot(input: {
  slotId: unknown;
  sessionId: string;
  idempotencyKey: string;
  now?: Date;
}): BookingResult {
  const { slotId, sessionId, idempotencyKey } = input;
  const now = input.now ?? new Date();
  ensureLedgerLoaded();

  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    return { ok: false, code: 'idempotency_key_required' };
  }
  const start = parseSlotId(slotId);
  if (start === null) return { ok: false, code: 'invalid_slot_id' };
  const canonicalId = formatSlotId(start);

  const replay = appointmentsByKey.get(idempotencyKey);
  if (replay) {
    return replay.session_id === sessionId && replay.slot_id === canonicalId
      ? { ok: true, appointment: replay, replayed: true }
      : { ok: false, code: 'idempotency_conflict' };
  }

  const existing = appointmentsBySession.get(sessionId);
  if (existing) {
    return existing.slot_id === canonicalId
      ? { ok: true, appointment: existing, replayed: true }
      : { ok: false, code: 'appointment_exists' };
  }

  const verification = verifySlot(canonicalId, now);
  if (!verification.ok) return { ok: false, code: verification.code };

  const appointment: Appointment = {
    appointment_id: `apt_${uuidv4()}`,
    slot_id: canonicalId,
    session_id: sessionId,
    booked_at: now.toISOString(),
  };

  // Cross-process check-and-set: the claim file is created exclusively, so a
  // second instance loses even when it verified the slot a moment earlier.
  // Only the winner indexes the appointment; a loser reports the slot taken.
  const claim = claimSlot({
    appointment_id: appointment.appointment_id,
    slot_id: appointment.slot_id,
    session_id: appointment.session_id,
    booked_at: appointment.booked_at,
    idempotency_key: idempotencyKey,
  });
  if (claim === 'taken') return { ok: false, code: 'slot_already_booked' };
  if (claim === 'unavailable') return { ok: false, code: 'ledger_unavailable' };

  indexAppointment(appointment, idempotencyKey);

  return { ok: true, appointment, replayed: false };
}

/** The session's confirmed appointment, if any. */
export function getAppointmentForSession(sessionId: string): Appointment | undefined {
  ensureLedgerLoaded();
  return appointmentsBySession.get(sessionId);
}

/** The appointment held on a slot, if any. */
export function getAppointmentForSlot(slotId: string): Appointment | undefined {
  ensureLedgerLoaded();
  const start = parseSlotId(slotId);
  if (start === null) return undefined;
  return appointmentsBySlot.get(formatSlotId(start));
}

/** Clears every appointment and its durable claim (testing only). */
export function clearAllAppointments(): void {
  appointmentsBySlot.clear();
  appointmentsByKey.clear();
  appointmentsBySession.clear();
  clearBookingClaims();
  ledgerLoaded = true;
}

/**
 * Drops the in-memory index and rebuilds it from the durable claims.
 *
 * This is how a restart (or another instance that loaded before a booking was
 * made) sees bookings it did not itself write. Testing uses it to simulate a
 * second process; production gets the same effect on first use after boot.
 */
export function reloadBookingsFromLedger(): void {
  appointmentsBySlot.clear();
  appointmentsByKey.clear();
  appointmentsBySession.clear();
  ledgerLoaded = false;
  ensureLedgerLoaded();
}
