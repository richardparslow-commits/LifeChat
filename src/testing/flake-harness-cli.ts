/**
 * Repeat-until-failure CLI for the intermittently flaky suites.
 *
 *   npm run test:flake                         5 iterations of the known-flaky suites
 *   npm run test:flake -- --iterations 20      keep looking for the rare failure
 *   npm run test:flake -- --suite tests/api-endpoints.test.ts
 *   npm run test:flake -- --workers 50%        reproduce under the same contention
 *   npm run test:flake -- --json               machine-readable report
 *
 * On the first failing iteration it stops, keeps that log, and reruns each
 * failing test alone `--repro-attempts` times (default 3). The report says
 * whether the failure is deterministic (fails alone — an ordinary bug) or
 * load/order dependent (passes alone — the reproduction command is the lead).
 *
 * Exit codes: 0 no failure in any iteration, 1 a failure, 2 bad usage.
 */

import {
  DEFAULT_FLAKY_SUITES,
  DEFAULT_ITERATIONS,
  DEFAULT_REPRO_ATTEMPTS,
  HarnessUsageError,
  formatHarnessReport,
  parseHarnessArgs,
  runFlakeHarness,
  type HarnessReport,
  type JestRunner,
} from './flake-harness';

const USAGE = [
  'Repeat-until-failure harness for flaky jest suites',
  '',
  '  npm run test:flake                                  the default suites, ' +
    `${DEFAULT_ITERATIONS} iterations`,
  `  npm run test:flake -- --iterations 20               more iterations (default ${DEFAULT_ITERATIONS})`,
  '  npm run test:flake -- --suite tests/api-endpoints.test.ts',
  '  npm run test:flake -- --suites a.test.ts,b.test.ts',
  `  npm run test:flake -- --repro-attempts 5            isolation reruns (default ${DEFAULT_REPRO_ATTEMPTS})`,
  '  npm run test:flake -- --workers 50%                 pass a jest worker setting through',
  '  npm run test:flake -- --keep-going                  keep iterating after a failure',
  '  npm run test:flake -- --keep-passes                 keep passing-iteration logs',
  '  npm run test:flake -- --out <dir>                   artifacts directory',
  '  npm run test:flake -- --json                        machine-readable report',
  '  npm run test:flake -- --help',
  '',
  'Default suites (those that have flaked in full-suite runs):',
  ...DEFAULT_FLAKY_SUITES.map((suite) => `  ${suite}`),
  '',
  'On the first failure the run stops, the failing log is kept, and each failing',
  'test is rerun alone. "DETERMINISTIC" means it fails alone; otherwise the',
  'failure depends on load, ordering, or shared process state.',
].join('\n');

/**
 * The entry point, taking argv so tests can drive it without a process.
 * Returns the exit code rather than exiting.
 */
export function runFlakeHarnessCli(
  argv: readonly string[] = process.argv.slice(2),
  deps: { runJest?: JestRunner; now?: () => Date; root?: string } = {},
): number {
  let options: ReturnType<typeof parseHarnessArgs>;
  try {
    options = parseHarnessArgs(argv);
  } catch (error) {
    if (error instanceof HarnessUsageError) {
      console.error(error.message);
      console.error('');
      console.error(USAGE);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let report: HarnessReport;
  try {
    report = runFlakeHarness(options, deps);
  } catch (error) {
    if (error instanceof HarnessUsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHarnessReport(report));
  }
  return report.passed ? 0 : 1;
}

// Direct invocation (e.g. `npm run test:flake`).
if (require.main === module) {
  process.exitCode = runFlakeHarnessCli();
}
