/**
 * Repeat-until-failure harness for the intermittently flaky suites.
 *
 * A flaky test is not diagnosed by one passing run. This harness reruns the
 * suites that have produced transport-level failures (dropped sockets, a
 * response from the wrong handler) and, on the first failure, stops, keeps the
 * log, and attempts a *deterministic reproduction* of each failing test in
 * isolation with `-t`.
 *
 * The distinction it reports matters:
 *
 *  - `deterministic: true` — the test failed every time it was rerun alone.
 *    That is an ordinary bug with an ordinary fix.
 *  - `deterministic: false` — the test passed alone but failed under a full
 *    suite run. The failure depends on load, ordering, or shared process
 *    state, and the reproduction command in the report is the starting point.
 *
 * Everything is injected through `runJest` so the orchestration is unit-tested
 * without spawning real test processes.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

/** Suites that have flaked in full-suite runs; the default target set. */
export const DEFAULT_FLAKY_SUITES = [
  'tests/api-endpoints.test.ts',
  'tests/medical-condition-gate.test.ts',
] as const;

export const DEFAULT_ITERATIONS = 5;
export const DEFAULT_REPRO_ATTEMPTS = 3;
export const DEFAULT_ITERATION_TIMEOUT_MS = 10 * 60 * 1000;

/** One failing test extracted from a jest run. */
export interface TestFailure {
  /** Full name as jest printed it, e.g. `describe › test name`. */
  name: string;
  /** File the failure came from, when the log names it. */
  suite: string | null;
  /** First meaningful error line (used to group repeats of the same symptom). */
  signature: string;
}

export interface HarnessOptions {
  suites: string[];
  iterations: number;
  reproAttempts: number;
  timeoutMs: number;
  /** Extra arguments passed to every jest invocation (e.g. --maxWorkers=50%). */
  jestArgs: string[];
  /** Print usage rather than run (CLI concern; the runner ignores it). */
  help: boolean;
  /** Emit the report as JSON instead of a terminal rendering. */
  json: boolean;
  /** Keep iterating after the first failure instead of stopping. */
  keepGoing: boolean;
  /** Keep logs from passing iterations (they are large). */
  keepPasses: boolean;
  /** Directory for run artifacts; a temp directory by default. */
  outDir?: string;
  /** Project root; resolved from this file when not supplied. */
  root?: string;
}

export interface JestInvocation {
  root: string;
  args: string[];
  timeoutMs: number;
}

export interface JestRunResult {
  /** Exit status; null when the process was killed (timeout/signal). */
  status: number | null;
  output: string;
  /** Set when the runner itself could not produce a status. */
  error?: string;
}

export type JestRunner = (invocation: JestInvocation) => JestRunResult;

export interface ReproductionResult {
  test: string;
  suite: string | null;
  pattern: string;
  attempts: number;
  failures: number;
  /** True when every attempt failed — the failure reproduces in isolation. */
  deterministic: boolean;
  command: string;
}

export interface FirstFailure {
  iteration: number;
  command: string;
  failures: TestFailure[];
  logPath: string;
}

export interface HarnessReport {
  suites: string[];
  iterations: number;
  iterationsRun: number;
  iterationsPassed: number;
  passed: boolean;
  firstFailure: FirstFailure | null;
  reproductions: ReproductionResult[];
  logDir: string;
  reportPath: string;
  durationMs: number;
}

export class HarnessUsageError extends Error {}

/** Parses the harness CLI arguments. Throws HarnessUsageError on bad input. */
export function parseHarnessArgs(argv: readonly string[]): HarnessOptions {
  const options: HarnessOptions = {
    suites: [...DEFAULT_FLAKY_SUITES],
    iterations: DEFAULT_ITERATIONS,
    reproAttempts: DEFAULT_REPRO_ATTEMPTS,
    timeoutMs: DEFAULT_ITERATION_TIMEOUT_MS,
    jestArgs: [],
    help: false,
    json: false,
    keepGoing: false,
    keepPasses: false,
  };
  let suitesProvided = false;

  const readNumber = (raw: string | undefined, flag: string, min: number): number => {
    if (raw === undefined) throw new HarnessUsageError(`${flag} needs a value`);
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      throw new HarnessUsageError(`${flag} must be an integer >= ${min}, got ${raw}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const take = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) return undefined;
      i += 1;
      return next;
    };

    switch (flag) {
      case '--iterations':
        options.iterations = readNumber(take(), '--iterations', 1);
        break;
      case '--repro-attempts':
        options.reproAttempts = readNumber(take(), '--repro-attempts', 1);
        break;
      case '--timeout-ms':
        options.timeoutMs = readNumber(take(), '--timeout-ms', 1000);
        break;
      case '--suite':
      case '--suites': {
        const raw = take();
        if (raw === undefined) throw new HarnessUsageError('--suite needs a test file path');
        const files = raw
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        if (files.length === 0) throw new HarnessUsageError('--suite needs a test file path');
        options.suites = suitesProvided ? [...options.suites, ...files] : files;
        suitesProvided = true;
        break;
      }
      case '--workers': {
        const raw = take();
        if (raw === undefined) throw new HarnessUsageError('--workers needs a value');
        options.jestArgs.push(`--maxWorkers=${raw}`);
        break;
      }
      case '--json':
        options.json = true;
        break;
      case '--keep-going':
        options.keepGoing = true;
        break;
      case '--keep-passes':
        options.keepPasses = true;
        break;
      case '--out':
        options.outDir = take();
        if (!options.outDir) throw new HarnessUsageError('--out needs a directory');
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new HarnessUsageError(`unknown argument: ${arg}`);
    }
  }

  return options;
}

/** Escapes a string so it is matched literally by a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts failing tests from jest's stderr/stdout.
 *
 * Jest prints `FAIL path/to/file.test.ts` and then each failure as
 * `● <describe › test>`. Console blocks are also `● Console` and carry no test
 * name, so they are skipped. The suite is attributed from the most recent FAIL
 * marker, which is how the report can rerun only the right file.
 */
export function extractFailures(log: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  let currentSuite: string | null = null;
  const lines = log.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const suiteMatch = /^\s*FAIL\s+(\S+\.test\.tsx?)\b/.exec(line);
    if (suiteMatch) {
      currentSuite = suiteMatch[1];
      continue;
    }

    const marker = /^\s*●\s+(.+?)\s*$/.exec(line);
    if (!marker) continue;
    const name = marker[1];
    if (name === 'Console' || name.startsWith('Console ')) continue;
    if (name.startsWith('Test suite failed to run')) continue;

    // The signature is the first substantive line of the error block: the
    // assertion message, the thrown error, or the transport symptom. Grouping
    // repeats by it is what makes a report readable.
    let signature = '';
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (candidate.startsWith('at ')) continue;
      if (/^\d+\s*\|/.test(candidate)) continue;
      if (candidate.startsWith('>')) continue;
      signature = candidate;
      break;
    }

    const key = `${currentSuite ?? ''}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push({ name, suite: currentSuite, signature });
  }

  return failures;
}

/**
 * The `-t` pattern for a failure: the last `›` segment. Jest matches the
 * pattern against the concatenated full name, so the innermost test name is
 * normally unique and avoids describe-level text that may contain regex
 * metacharacters (including the `›` separator itself).
 */
export function reproductionPattern(testName: string): string {
  const segments = testName.split('›');
  return segments[segments.length - 1].trim();
}

/** Resolves jest's CLI entry point from the project's own dependencies. */
export function resolveJestBin(root: string): string {
  const candidates = [
    path.join(root, 'node_modules', 'jest', 'bin', 'jest.js'),
    path.join(root, 'node_modules', '.bin', 'jest'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new HarnessUsageError(
      `could not find jest under ${root}/node_modules — run the harness from the project checkout`,
    );
  }
  return found;
}

/** The default runner: a real jest process, with its exit status preserved. */
export const spawnJest: JestRunner = (invocation) => {
  const result = spawnSync(
    process.execPath,
    [resolveJestBin(invocation.root), ...invocation.args],
    {
      cwd: invocation.root,
      env: { ...process.env, FORCE_COLOR: '0', CI: 'true' },
      encoding: 'utf8',
      timeout: invocation.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) {
    return { status: null, output, error: result.error.message };
  }
  return { status: result.status, output };
};

function timestampForDir(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Renders the report for a terminal. */
export function formatHarnessReport(report: HarnessReport): string {
  const lines: string[] = [];
  const duration = `${(report.durationMs / 1000).toFixed(1)}s`;

  lines.push(`flake harness — ${report.suites.join(', ')}`);
  lines.push(
    `iterations: ${report.iterationsRun}/${report.iterations} run, ` +
      `${report.iterationsPassed} passed — ${report.passed ? 'NO FAILURE' : 'FAILED'} (${duration})`,
  );

  if (!report.firstFailure) {
    lines.push('');
    lines.push('No failure reproduced. That does not prove the suites are stable;');
    lines.push('raise --iterations to keep looking.');
  } else {
    const first = report.firstFailure;
    lines.push('');
    lines.push(`first failure: iteration ${first.iteration}`);
    lines.push(`  command: ${first.command}`);
    lines.push(`  log:     ${first.logPath}`);
    for (const failure of first.failures) {
      lines.push(`  ✕ ${failure.name}`);
      if (failure.signature) lines.push(`      ${failure.signature}`);
    }

    lines.push('');
    lines.push('reproduction attempts (the failing test alone, repeated):');
    for (const result of report.reproductions) {
      const verdict = result.deterministic
        ? 'DETERMINISTIC — fails alone'
        : 'load/order dependent — passes alone';
      lines.push(
        `  ${result.failures}/${result.attempts} failed — ${verdict}` + ` [${result.test}]`,
      );
      lines.push(`      ${result.command}`);
    }
  }

  lines.push('');
  lines.push(`artifacts: ${report.logDir}`);
  lines.push(`report:    ${report.reportPath}`);
  return lines.join('\n');
}

/**
 * Runs the suites repeatedly and diagnoses the first failure.
 *
 * Stops at the first failing iteration unless `keepGoing` is set: later
 * failures are usually the same symptom, and the first one is the reproduction
 * worth keeping. Each failing test is then rerun alone `reproAttempts` times,
 * which is what separates a deterministic bug from a load-dependent one.
 */
export function runFlakeHarness(
  options: HarnessOptions,
  deps: { runJest?: JestRunner; now?: () => Date; root?: string } = {},
): HarnessReport {
  const root = options.root ?? deps.root ?? path.join(__dirname, '..', '..');
  const now = deps.now ?? (() => new Date());
  const runJest = deps.runJest ?? spawnJest;
  const startedAt = Date.now();

  const missing = options.suites.filter((suite) => !existsSync(path.join(root, suite)));
  if (missing.length > 0) {
    throw new HarnessUsageError(`suite file(s) not found: ${missing.join(', ')}`);
  }

  const logDir =
    options.outDir ?? path.join(os.tmpdir(), `lifechat-flake-${timestampForDir(now())}`);
  mkdirSync(logDir, { recursive: true });

  let iterationsRun = 0;
  let iterationsPassed = 0;
  let firstFailure: FirstFailure | null = null;

  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    iterationsRun = iteration;
    const args = [...options.suites, '--silent', ...options.jestArgs];
    const result = runJest({ root, args, timeoutMs: options.timeoutMs });
    const logPath = path.join(logDir, `iter-${String(iteration).padStart(2, '0')}.log`);
    writeFileSync(logPath, result.output);

    const passed = result.status === 0;
    if (passed) {
      iterationsPassed += 1;
      if (!options.keepPasses) {
        try {
          unlinkSync(logPath);
        } catch {
          // A leftover log is harmless; never fail the harness for cleanup.
        }
      }
      continue;
    }

    firstFailure = {
      iteration,
      command: `npx jest ${args.join(' ')}`,
      failures: extractFailures(result.output),
      logPath,
    };
    break;
  }

  const reproductions: ReproductionResult[] = [];
  if (firstFailure) {
    const attempted = new Set<string>();
    for (const failure of firstFailure.failures) {
      const pattern = reproductionPattern(failure.name);
      const suite = failure.suite;
      const key = `${suite ?? ''}::${pattern}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
      if (suite === null) continue;

      let failuresSeen = 0;
      for (let attempt = 1; attempt <= options.reproAttempts; attempt += 1) {
        const args = [suite, '-t', pattern, '--silent', ...options.jestArgs];
        const result = runJest({ root, args, timeoutMs: options.timeoutMs });
        if (result.status !== 0) failuresSeen += 1;
      }

      reproductions.push({
        test: failure.name,
        suite,
        pattern,
        attempts: options.reproAttempts,
        failures: failuresSeen,
        deterministic: failuresSeen === options.reproAttempts,
        command: `npx jest ${suite} -t "${pattern}"`,
      });
    }
  }

  const passed = firstFailure === null;
  const reportPath = path.join(logDir, 'report.json');
  const report: HarnessReport = {
    suites: options.suites,
    iterations: options.iterations,
    iterationsRun,
    iterationsPassed,
    passed,
    firstFailure,
    reproductions,
    logDir,
    reportPath,
    durationMs: Date.now() - startedAt,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
