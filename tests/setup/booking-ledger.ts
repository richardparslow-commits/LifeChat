/**
 * Test isolation for the durable booking ledger (SEC-14).
 *
 * `bookSlot` now creates one claim file per slot, and the claim is the
 * authority across processes. Suites run in parallel workers and each chooses
 * the same "next bookable half-hour" from a fixed clock, so a shared default
 * (`data/bookings`) would make one suite's booking conflict with another's and
 * leave claim files in the repository.
 *
 * Each test file gets a unique directory under the OS temp dir. Jest gives each
 * test file a fresh module registry, so `config` reads this value when the file
 * imports it; the random suffix also keeps reused workers apart.
 */

import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';

process.env.BOOKING_LEDGER_PATH = path.join(os.tmpdir(), 'lifechat-test-bookings', randomUUID());
