/**
 * Operator CLI for the record lifecycle.
 *
 *   npm run data:lifecycle -- erase --request-id <dsr-id>
 *   npm run data:lifecycle -- retention --dry-run
 *   npm run data:lifecycle -- retention --days 2555
 *   npm run data:lifecycle -- --help
 *
 * `erase` requires a *verified deletion* DSR; the address is read from that
 * record, so the command cannot be pointed at an arbitrary address. Both
 * commands print a JSON receipt (request id and counts only — never PII), which
 * is the artifact to attach to the DSR file.
 *
 * The npm script loads `.env` via `node -r dotenv/config` before this module so
 * a local operator gets the same paths and key as the app. In a deployed
 * environment the platform's variables are used and no `.env` is required.
 *
 * Exit codes: 0 completed (including a dry run), 1 the operation failed,
 * 2 bad usage.
 */

import { eraseSubject, sweepExpiredRecords, ErasureIncompleteError } from './erasure';

const USAGE = [
  'Record lifecycle operator CLI',
  '',
  '  npm run data:lifecycle -- erase --request-id <dsr-id>',
  '      Fulfil a verified deletion request: erase matching lead records,',
  '      tombstone the DSR, write a PII-free audit entry.',
  '',
  '  npm run data:lifecycle -- retention [--dry-run] [--days N]',
  '      Remove records older than DATA_RETENTION_DAYS (default 7 years).',
  '      A dry run reports the counts without changing anything.',
  '',
  '  npm run data:lifecycle -- --help',
  '',
  'The command never accepts an email address: erasure derives the subject from',
  "the verified DSR, so it cannot be used to erase somebody else's records.",
].join('\n');

interface ParsedArgs {
  command: 'erase' | 'retention' | 'help';
  requestId?: string;
  dryRun?: boolean;
  days?: number;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help' };
  }
  if (command !== 'erase' && command !== 'retention') {
    throw new Error(`unknown command: ${command}`);
  }

  const parsed: ParsedArgs = { command };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] =
      arg.startsWith('--') && arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg, undefined];

    if (flag === '--request-id' && command === 'erase') {
      parsed.requestId = inline ?? argv[(i += 1)];
      if (!parsed.requestId) throw new Error('--request-id requires a value');
    } else if (flag === '--dry-run' && command === 'retention') {
      parsed.dryRun = true;
    } else if (flag === '--days' && command === 'retention') {
      const raw = inline ?? argv[(i += 1)];
      const value = Number.parseInt(raw ?? '', 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--days requires a positive integer');
      }
      parsed.days = value;
    } else {
      throw new Error(`unknown argument for ${command}: ${arg}`);
    }
  }

  if (command === 'erase' && !parsed.requestId) {
    throw new Error('erase requires --request-id');
  }

  return parsed;
}

/** Entry point; returns the exit code so tests (and scripts) can drive it. */
export async function runLifecycleCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(USAGE);
    return 2;
  }

  if (parsed.command === 'help') {
    console.log(USAGE);
    return 0;
  }

  try {
    if (parsed.command === 'erase') {
      const receipt = await eraseSubject({ requestId: parsed.requestId as string });
      console.log(JSON.stringify({ status: 'fulfilled', ...receipt }, null, 2));
      return 0;
    }

    const receipt = await sweepExpiredRecords({
      dryRun: parsed.dryRun === true,
      retentionDays: parsed.days,
    });
    console.log(JSON.stringify(receipt, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof ErasureIncompleteError) {
      // The message is operator-safe by construction (failure class + file).
      console.error(`Lifecycle operation failed (${error.code}): ${error.message}`);
    } else {
      console.error('Lifecycle operation failed:', error);
    }
    return 1;
  }
}

// Direct invocation (e.g. `npm run data:lifecycle`).
if (require.main === module) {
  void runLifecycleCli().then((code) => {
    process.exitCode = code;
  });
}
