/**
 * CLI for the condition-coverage sweep.
 *
 *   npm run conditions:sweep                        every committed candidate corpus
 *   npm run conditions:sweep -- <path> [<path>...]  one or more candidate lists
 *   npm run conditions:sweep -- --all               list every row, not only the problems
 *   npm run conditions:sweep -- --json              machine-readable output
 *   npm run conditions:sweep -- --report-only       never fail the exit code
 *
 * Exits 1 when any candidate is silent (neither mapped nor gated), mapped
 * without the gate watching for it, or carrying a deferral that is no longer
 * silent (a stale ledger entry). A gated-but-uncoded row is policy, not a
 * failure — it is listed so the next reviewer can see the decision — and a
 * declared deferral is a recorded decision, not a failure, so it does not
 * affect the exit code while it is still silent.
 */

import {
  COMMITTED_CANDIDATE_LIST_PATHS,
  formatConditionCoverageSweep,
  sweepConditionCandidateList,
  type ConditionCoverageSweep,
} from './condition-coverage-sweep';

const USAGE = [
  'Condition coverage sweep — measure a candidate phrase list against the vocabulary and the gate',
  '',
  '  npm run conditions:sweep                        sweep every committed corpus',
  '  npm run conditions:sweep -- <path> [<path>...]  sweep one or more candidate lists',
  '  npm run conditions:sweep -- --all               list every row',
  '  npm run conditions:sweep -- --json              machine-readable output',
  '  npm run conditions:sweep -- --report-only       always exit 0',
  '',
  'Candidate list format: one phrase per line, `#` comments and blank lines ignored,',
  'or a JSON array of strings or deferred objects ({ "phrase", "deferred_reason" }).',
  '',
  '  ? <phrase> :: <reason>   declare a deliberate deferral — measured every run,',
  '                           reported as `deferred`, never counted as a silent gap,',
  '                           and a declaration whose row is no longer silent fails.',
  '',
  'Committed corpora and the deferral ledger:',
  ...COMMITTED_CANDIDATE_LIST_PATHS.map((listPath) => `  ${listPath}`),
].join('\n');

interface SweepOptions {
  paths: string[];
  json: boolean;
  all: boolean;
  reportOnly: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): SweepOptions {
  const options: SweepOptions = {
    paths: [],
    json: false,
    all: false,
    reportOnly: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--report-only') options.reportOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    else options.paths.push(arg);
  }
  return options;
}

/** The entry point, taking argv so tests can drive it without a process. */
export function runConditionCoverageSweepCli(
  argv: readonly string[] = process.argv.slice(2),
): number {
  let options: SweepOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(USAGE);
    return 1;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const paths = options.paths.length > 0 ? options.paths : COMMITTED_CANDIDATE_LIST_PATHS;
  const sweeps: ConditionCoverageSweep[] = [];
  for (const listPath of paths) {
    try {
      sweeps.push(sweepConditionCandidateList(listPath));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (options.json) {
    console.log(JSON.stringify(sweeps, null, 2));
  } else {
    console.log(
      sweeps.map((sweep) => formatConditionCoverageSweep(sweep, { all: options.all })).join('\n\n'),
    );
  }

  const blocking = sweeps.reduce((count, sweep) => count + sweep.blocking.length, 0);
  if (options.reportOnly) return 0;
  return blocking === 0 ? 0 : 1;
}

// Direct-invocation entry (e.g. `npm run conditions:sweep`).
if (require.main === module) {
  process.exitCode = runConditionCoverageSweepCli();
}
