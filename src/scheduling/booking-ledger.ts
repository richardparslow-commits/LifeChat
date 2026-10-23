/**
 * Durable slot claims for the appointment ledger (SEC-14).
 *
 * The appointment ledger used to live only in three bounded LRUs, so two
 * instances could each verify the same open slot and both confirm it. The
 * check-and-set was atomic with respect to the event loop, not to another
 * process.
 *
 * This module is the cross-process half of the fix: one claim file per slot,
 * created with `O_CREAT | O_EXCL` (`flag: 'wx'`). The filesystem is the
 * arbiter, so exactly one process can create a given slot's claim; every other
 * process gets `EEXIST` and reports the slot as taken. Claims are written and
 * fsynced before the in-memory index is updated, and they are reloaded on first
 * use, so a restart (or another replica) sees the bookings that already exist.
 *
 * Limits, stated plainly:
 *   - A POSIX filesystem is required. Archil's S3 object API has no conditional
 *     create, so the object-mode deployment cannot host the ledger; booking is
 *     refused there rather than granted without a uniqueness guarantee.
 *   - On a serverless runtime the ledger directory must be an absolute path
 *     outside the platform's ephemeral roots. Otherwise every claim would die
 *     with the invocation, so `claimSlot` refuses instead of acknowledging.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { resolve } from 'path';

import { config } from '../config/app-config';
import { isEphemeralDirectory } from '../config/durable-storage';

/** Canonical slot id shape; also the claim file's basename. */
const CLAIM_FILENAME = /^(slot_\d{8}T\d{4}Z)\.json$/;

/** One durable booking claim: the appointment plus the key that created it. */
export interface BookingClaim {
  appointment_id: string;
  slot_id: string;
  session_id: string;
  booked_at: string;
  idempotency_key: string;
}

/** Result of trying to claim a slot. */
export type ClaimResult = 'claimed' | 'taken' | 'unavailable';

/** Absolute directory holding one claim file per booked slot. */
export function bookingLedgerDirectory(): string {
  return resolve(config.bookingLedgerPath);
}

/**
 * True when this ledger can make a durable, cross-process claim.
 *
 * A long-running process owns its filesystem. On a serverless runtime only an
 * absolute path outside the known ephemeral roots can survive the invocation;
 * the default relative `data/bookings` (and Archil object mode, which mounts
 * nothing) cannot, so booking must fail closed there.
 */
export function isBookingLedgerWritable(): boolean {
  if (!config.serverless) return true;
  const raw = config.bookingLedgerPath.trim();
  if (!raw.startsWith('/')) return false;
  return !isEphemeralDirectory(bookingLedgerDirectory());
}

function claimPath(slotId: string): string | null {
  if (!/^slot_\d{8}T\d{4}Z$/.test(slotId)) return null;
  return resolve(bookingLedgerDirectory(), `${slotId}.json`);
}

/**
 * Creates the slot's claim file exclusively.
 *
 * @returns `claimed` when this process created the file, `taken` when another
 *          process already did, `unavailable` when the ledger cannot be used
 *          (ephemeral/serverless path, missing permissions, full disk).
 */
export function claimSlot(claim: BookingClaim): ClaimResult {
  if (!isBookingLedgerWritable()) return 'unavailable';
  const path = claimPath(claim.slot_id);
  if (path === null) return 'unavailable';

  try {
    mkdirSync(bookingLedgerDirectory(), { recursive: true });
  } catch {
    return 'unavailable';
  }

  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'taken' : 'unavailable';
  }

  try {
    writeSync(fd, JSON.stringify(claim));
    // Flush the claim before returning: a booking acknowledged to a visitor
    // must not be lost with an unclean shutdown.
    fsyncSync(fd);
  } catch {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // The partial claim is unreadable, but leaving it would block the slot.
    }
    return 'unavailable';
  }
  closeSync(fd);
  return 'claimed';
}

/**
 * True when a claim file already exists for the slot.
 *
 * This is the cross-process freshness check `verifySlot` uses before offering
 * or selecting a slot: another instance's booking is visible through the
 * filesystem even when this process's index has not reloaded yet.
 */
export function isSlotClaimed(slotId: string): boolean {
  const path = claimPath(slotId);
  return path !== null && existsSync(path);
}

/**
 * Reads every valid claim. Malformed files are not indexed (they cannot be
 * interpreted), but `isSlotClaimed` still treats them as occupied: the slot is
 * refused rather than risked on a second booking.
 */
export function loadBookingClaims(): BookingClaim[] {
  const directory = bookingLedgerDirectory();
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return []; // no ledger yet — the normal first-run state
  }

  const claims: BookingClaim[] = [];
  for (const name of names) {
    const match = CLAIM_FILENAME.exec(name);
    if (!match) continue;
    try {
      const parsed = JSON.parse(readFileSync(resolve(directory, name), 'utf8')) as unknown;
      if (isBookingClaim(parsed) && parsed.slot_id === match[1]) claims.push(parsed);
    } catch {
      // A corrupt claim cannot be trusted to hold the slot, and skipping it is
      // the same policy the record loaders use for unreadable lines.
    }
  }
  return claims;
}

function isBookingClaim(value: unknown): value is BookingClaim {
  if (typeof value !== 'object' || value === null) return false;
  const claim = value as Record<string, unknown>;
  return (
    typeof claim.appointment_id === 'string' &&
    typeof claim.slot_id === 'string' &&
    typeof claim.session_id === 'string' &&
    typeof claim.booked_at === 'string' &&
    typeof claim.idempotency_key === 'string'
  );
}

/** Removes one claim (testing only; a real cancellation is a separate feature). */
export function releaseBookingClaim(slotId: string): void {
  const path = claimPath(slotId);
  if (path === null) return;
  try {
    unlinkSync(path);
  } catch {
    // Missing is the desired end state.
  }
}

/** Removes every claim file in the ledger directory (testing only). */
export function clearBookingClaims(): void {
  const directory = bookingLedgerDirectory();
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!CLAIM_FILENAME.test(name)) continue;
    try {
      unlinkSync(resolve(directory, name));
    } catch {
      // Best effort; the caller clears memory regardless.
    }
  }
}
