/**
 * Operator CLI for the session → lead index (C-07).
 *
 *   npm run records:index-sessions
 *
 * Streams the durable lead log, decrypts each record to read only its session
 * id and lead id, and replaces `LEAD_SESSION_INDEX_PATH` in one atomic write.
 * The index carries no name, email, phone, or medical detail, and no record
 * contents are printed.
 *
 * The server rebuilds the index on its own when the file is missing or older
 * than the lead log, so this command is for the deliberate cases: a pre-deploy
 * backfill after restoring a log, a repair after an index write failure, and a
 * check of how many sessions the log actually binds. Exit codes: 0 written,
 * 1 the write failed, 2 bad usage.
 */

import { rebuildLeadSessionIndex } from './consent-model';

const USAGE = [
  'Session → lead index rebuild',
  '',
  '  npm run records:index-sessions',
  '      Rebuild lead-session-index.jsonl from the lead log. Prints a JSON',
  '      receipt (path, sessions indexed, records scanned, unreadable).',
  '',
  'The index holds only session_id, lead_id and created_at. Records are',
  'decrypted with RECORD_ENCRYPTION_KEY (or its legacy key ring) to read those',
  'three fields. See docs/data-lifecycle-runbook.md.',
].join('\n');

async function runSessionIndexCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length > 0) {
    console.error(`unknown argument: ${argv[0]}`);
    console.error('');
    console.error(USAGE);
    return 2;
  }

  try {
    const result = await rebuildLeadSessionIndex();
    console.log(JSON.stringify({ status: result.written ? 'ok' : 'failed', ...result }, null, 2));
    return result.written ? 0 : 1;
  } catch (error) {
    console.error('Session index rebuild failed:', error instanceof Error ? error.message : error);
    return 1;
  }
}

// Direct invocation (e.g. `npm run records:index-sessions`).
if (require.main === module) {
  void runSessionIndexCli().then((code) => {
    process.exitCode = code;
  });
}

export { runSessionIndexCli };
