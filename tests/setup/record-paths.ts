/**
 * Test isolation for the durable record stores (M-01).
 *
 * Suites that do not override a record path used the shipped defaults under
 * `data/`, so every run appended synthetic leads, DSRs and abstentions to the
 * same files a developer's local server and a real deployment read. That mixed
 * two kinds of record that are indistinguishable once written, grew the store
 * on every run, and made consent lookups scan test noise (C-07).
 *
 * Each test file gets a unique directory under the OS temp dir, set before any
 * test module imports `config`. Files that need their own path (or that assert
 * on one) still call `tempLogPath`; this is the floor, so a suite that says
 * nothing cannot fall back to the repository.
 *
 * The booking ledger has the same treatment in `booking-ledger.ts`; it is not
 * set here so its existing per-file directory is not overwritten.
 */

import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';

const dir = path.join(os.tmpdir(), 'lifechat-test-records', randomUUID());

process.env.LEAD_LOG_PATH = path.join(dir, 'leads.jsonl');
// Derived from the lead path by default, but set explicitly so a future change
// to the derivation cannot silently point the index back into the repo.
process.env.LEAD_SESSION_INDEX_PATH = path.join(dir, 'lead-session-index.jsonl');
process.env.DSR_LOG_PATH = path.join(dir, 'dsr.jsonl');
process.env.LEAD_ACCESS_LOG_PATH = path.join(dir, 'lead-access.jsonl');
process.env.ADMIN_ACCESS_LOG_PATH = path.join(dir, 'admin-access.jsonl');
process.env.ERASURE_LOG_PATH = path.join(dir, 'erasure.jsonl');
process.env.ABSTENTION_LOG_PATH = path.join(dir, 'abstention.jsonl');
// The abstention hash is keyed (M-08). A fixed test secret keeps digests stable
// across runs and keeps every suite's analytics writes enabled; the suites that
// assert on the key set their own via `config.abstentionLogKey`.
process.env.ABSTENTION_LOG_KEY = 'test-abstention-log-key-not-a-secret';
