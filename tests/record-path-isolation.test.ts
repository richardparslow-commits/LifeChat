/**
 * Record-path isolation guard (M-01).
 *
 * `tests/setup/record-paths.ts` points every suite's record stores at a private
 * temp directory. This guard makes that a tested property rather than a
 * convention: the resolved config must be outside the repository, a real write
 * must leave `data/` exactly as it was, and no test may quietly override a
 * record path back into `data/`.
 *
 * The last check matters because an env assignment in one suite only affects
 * that file: it would look isolated while still appending to a developer's
 * store, which is how the original leak survived review.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { config } from '../src/config/app-config';
import {
  clearAllLeadRecords,
  createLeadRecord,
  saveLeadRecord,
} from '../src/consent/consent-model';
import { clearAllDsrRecords, submitDsr } from '../src/privacy/dsr';

/** True when the path resolves inside the OS temp directory. */
function isUnderTempDir(value: string): boolean {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(value);
  return resolved === tempRoot || resolved.startsWith(`${tempRoot}${path.sep}`);
}

/** Names of the files in the repository's data/ directory. */
function dataDirectory(): string[] {
  const dir = path.resolve(__dirname, '..', 'data');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}

/** Every TypeScript file under tests/. */
function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testSources(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

const RECORD_PATH_VARS = [
  'LEAD_LOG_PATH',
  'LEAD_SESSION_INDEX_PATH',
  'DSR_LOG_PATH',
  'LEAD_ACCESS_LOG_PATH',
  'ERASURE_LOG_PATH',
  'ABSTENTION_LOG_PATH',
  'BOOKING_LEDGER_PATH',
];

describe('test record-path isolation', () => {
  afterAll(async () => {
    await clearAllLeadRecords();
    await clearAllDsrRecords();
  });

  it('resolves every record store outside the repository', () => {
    const resolved = {
      leadLog: config.leadLogPath,
      leadSessionIndex: config.leadSessionIndexPath,
      dsrLog: config.dsrLogPath,
      leadAccessLog: config.leadAccessLogPath,
      erasureLog: config.erasureLogPath,
      abstentionLog: config.abstentionLogPath,
      bookingLedger: config.bookingLedgerPath,
    };
    for (const [name, value] of Object.entries(resolved)) {
      expect({ name, isolated: isUnderTempDir(value) }).toEqual({ name, isolated: true });
    }
  });

  it('writes records under the temp dir and leaves data/ untouched', async () => {
    const before = dataDirectory();

    const lead = createLeadRecord('article-1', '/term-life', 'term_life');
    lead.session_id = 'lpp_isolation0001';
    lead.email = 'isolation@example.com';
    lead.contact_channel = 'email';
    lead.contact_consent_version = config.contactConsentVersion;
    lead.consent_timestamp = new Date().toISOString();
    lead.consent_text_hash = 'sha256:test-copy';
    expect(await saveLeadRecord(lead)).toBe(true);

    const dsr = await submitDsr({ requestType: 'access', contactEmail: 'isolation@example.com' });
    expect(dsr.ok).toBe(true);

    // The writes really happened, just not in the repository.
    expect(existsSync(config.leadLogPath)).toBe(true);
    expect(existsSync(config.leadSessionIndexPath)).toBe(true);
    expect(existsSync(config.dsrLogPath)).toBe(true);
    expect(dataDirectory()).toEqual(before);
  });

  it('has no test that points a record path back into data/', () => {
    // Matches `VAR: 'data/...'` and the indirect form `VAR: path.join('data', ...)`.
    const pattern = new RegExp(
      `\\b(?:${RECORD_PATH_VARS.join('|')})\\s*[:=][^\\n]*?(?:data/|['"\`]data['"\`])`,
    );
    const guard = path.resolve(__filename);
    const offenders: string[] = [];

    for (const file of testSources(__dirname)) {
      if (path.resolve(file) === guard) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          offenders.push(`${path.relative(path.resolve(__dirname, '..'), file)}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
