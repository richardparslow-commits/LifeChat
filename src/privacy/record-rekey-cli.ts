/**
 * Operator CLI for record-encryption key rotation (SEC-15).
 *
 *   npm run records:rekey -- --dry-run
 *   npm run records:rekey
 *
 * Prints a JSON receipt with per-log counts and the current key id (a hash
 * prefix of the secret, never the secret). Exit codes: 0 completed (including
 * a clean dry run), 1 the run failed, 2 bad usage.
 *
 * Rotation procedure:
 *   1. Set the new secret as RECORD_ENCRYPTION_KEY.
 *   2. Put the previous secret(s) in RECORD_ENCRYPTION_KEYS (comma-separated).
 *   3. Deploy, then run this command (dry run first).
 *   4. Remove the old secret from RECORD_ENCRYPTION_KEYS once every log reports
 *      `undecodable: 0` and `written: true` (or the file is empty).
 */

import { rekeyAllRecordLogs, rekeyRunSucceeded } from './record-rekey';

const USAGE = [
  'Record-encryption key rotation',
  '',
  '  npm run records:rekey -- --dry-run',
  '      Report what would be rewritten; change nothing.',
  '',
  '  npm run records:rekey',
  '      Decrypt every record with the configured key ring and re-encrypt it',
  '      under RECORD_ENCRYPTION_KEY. A log with any undecodable line is left',
  '      untouched and the command exits 1.',
  '',
  'Before running, set RECORD_ENCRYPTION_KEY to the new secret and list the',
  'previous secret(s) in RECORD_ENCRYPTION_KEYS. See',
  'docs/data-lifecycle-runbook.md for the full procedure.',
].join('\n');

async function runRecordRekeyCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`unknown argument: ${unknown[0]}`);
    console.error('');
    console.error(USAGE);
    return 2;
  }

  try {
    const result = await rekeyAllRecordLogs({ dryRun: argv.includes('--dry-run') });
    console.log(
      JSON.stringify({ status: rekeyRunSucceeded(result) ? 'ok' : 'failed', ...result }, null, 2),
    );
    return rekeyRunSucceeded(result) ? 0 : 1;
  } catch (error) {
    console.error('Record rotation failed:', error instanceof Error ? error.message : error);
    return 1;
  }
}

// Direct invocation (e.g. `npm run records:rekey`).
if (require.main === module) {
  void runRecordRekeyCli().then((code) => {
    process.exitCode = code;
  });
}

export { runRecordRekeyCli };
