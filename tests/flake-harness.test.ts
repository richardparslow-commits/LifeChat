/**
 * The flake harness exists to turn "it failed once in a full run" into a
 * reproduction. Its own logic is therefore tested against synthetic jest
 * output and an injected runner: parsing, stopping at the first failure,
 * isolation reruns, and exit codes — without spawning real suites.
 */

import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

import {
  HarnessUsageError,
  escapeRegExp,
  extractFailures,
  parseHarnessArgs,
  reproductionPattern,
  runFlakeHarness,
  type HarnessOptions,
  type JestInvocation,
} from '../src/testing/flake-harness';
import { runFlakeHarnessCli } from '../src/testing/flake-harness-cli';

const ROOT = path.join(__dirname, '..');

function baseOptions(overrides: Partial<HarnessOptions> = {}): HarnessOptions {
  return {
    suites: ['tests/api-endpoints.test.ts'],
    iterations: 3,
    reproAttempts: 2,
    timeoutMs: 60_000,
    jestArgs: [],
    help: false,
    json: false,
    keepGoing: false,
    keepPasses: false,
    root: ROOT,
    ...overrides,
  };
}

/** Two failures in the shape jest prints, including the repeated summary. */
const FAILING_LOG = [
  'FAIL tests/api-endpoints.test.ts',
  '  ● POST /api/chat — contract questions › pays out on a policy wording question',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '    Expected: 200',
  '    Received: 401',
  '',
  '      at Object.<anonymous> (tests/api-endpoints.test.ts:1070:24)',
  '',
  '  ● Console',
  '',
  '    console.log',
  '      noisy output',
  '',
  '  ● POST /api/chat — chapter XI › the liver filters your blood',
  '',
  '    Parse Error: Expected HTTP/, RTSP/ or ICE/',
  '',
  'Summary of all failing tests',
  'FAIL tests/api-endpoints.test.ts',
  '  ● POST /api/chat — contract questions › pays out on a policy wording question',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
].join('\n');

describe('parseHarnessArgs', () => {
  it('defaults to the known-flaky suites and the documented iteration count', () => {
    const options = parseHarnessArgs([]);
    expect(options.suites).toEqual([
      'tests/api-endpoints.test.ts',
      'tests/medical-condition-gate.test.ts',
    ]);
    expect(options.iterations).toBe(5);
    expect(options.reproAttempts).toBe(3);
    expect(options.keepGoing).toBe(false);
  });

  it('accepts overrides in both --flag value and --flag=value form', () => {
    const options = parseHarnessArgs([
      '--iterations',
      '20',
      '--suite=tests/api-endpoints.test.ts,tests/request-contract.test.ts',
      '--repro-attempts=4',
      '--workers',
      '50%',
      '--keep-going',
      '--keep-passes',
      '--json',
      '--out',
      '/tmp/somewhere',
    ]);

    expect(options.iterations).toBe(20);
    expect(options.suites).toEqual([
      'tests/api-endpoints.test.ts',
      'tests/request-contract.test.ts',
    ]);
    expect(options.reproAttempts).toBe(4);
    expect(options.jestArgs).toEqual(['--maxWorkers=50%']);
    expect(options.keepGoing).toBe(true);
    expect(options.keepPasses).toBe(true);
    expect(options.json).toBe(true);
    expect(options.outDir).toBe('/tmp/somewhere');
  });

  it('appends further --suite flags rather than replacing the first', () => {
    const options = parseHarnessArgs([
      '--suite',
      'tests/api-endpoints.test.ts',
      '--suite',
      'tests/medical-condition-gate.test.ts',
    ]);
    expect(options.suites).toEqual([
      'tests/api-endpoints.test.ts',
      'tests/medical-condition-gate.test.ts',
    ]);
  });

  it.each([
    ['iterations', ['--iterations', '0']],
    ['repro attempts', ['--repro-attempts', 'x']],
    ['timeout', ['--timeout-ms', '10']],
    ['suite', ['--suite', ' , ']],
    ['workers', ['--workers']],
    ['out', ['--out']],
    ['unknown flag', ['--wat']],
  ])('rejects a bad %s value', (_label, argv) => {
    expect(() => parseHarnessArgs(argv)).toThrow(HarnessUsageError);
  });

  it('marks --help without running anything', () => {
    expect(parseHarnessArgs(['--help']).help).toBe(true);
  });
});

describe('extractFailures', () => {
  it('attributes failures to their suite and skips console blocks', () => {
    const failures = extractFailures(FAILING_LOG);

    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      name: 'POST /api/chat — contract questions › pays out on a policy wording question',
      suite: 'tests/api-endpoints.test.ts',
      signature: 'expect(received).toBe(expected) // Object.is equality',
    });
    expect(failures[1].signature).toBe('Parse Error: Expected HTTP/, RTSP/ or ICE/');
  });

  it('de-duplicates the summary that follows the run', () => {
    // The same failure appears twice in the log (detail + summary).
    expect(extractFailures(FAILING_LOG).filter((f) => f.name.includes('pays out'))).toHaveLength(1);
  });

  it('returns nothing for a passing log', () => {
    expect(extractFailures('PASS tests/api-endpoints.test.ts\n\nTests: 10 passed')).toEqual([]);
  });
});

describe('reproductionPattern', () => {
  it('uses the innermost test name so the pattern avoids describe text', () => {
    expect(reproductionPattern('describe › nested › the liver filters your blood')).toBe(
      'the liver filters your blood',
    );
    expect(reproductionPattern('a plain test name')).toBe('a plain test name');
  });

  it('escapes regex metacharacters for a literal -t pattern', () => {
    expect(escapeRegExp('costs $5 (approx.) [see note]')).toBe(
      'costs \\$5 \\(approx\\.\\) \\[see note\\]',
    );
  });
});

describe('runFlakeHarness', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(path.join(os.tmpdir(), 'lifechat-flake-test-'));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('reports a clean run without inventing a failure', () => {
    const calls: JestInvocation[] = [];
    const report = runFlakeHarness(baseOptions({ outDir }), {
      runJest: (invocation) => {
        calls.push(invocation);
        return { status: 0, output: 'PASS' };
      },
    });

    expect(report.passed).toBe(true);
    expect(report.iterationsRun).toBe(3);
    expect(report.iterationsPassed).toBe(3);
    expect(report.firstFailure).toBeNull();
    expect(report.reproductions).toEqual([]);
    expect(calls).toHaveLength(3);
    // Every iteration ran the configured suite and preserved the exit status.
    expect(calls[0].args[0]).toBe('tests/api-endpoints.test.ts');
  });

  it('stops at the first failure and reruns each failing test in isolation', () => {
    let iterationRuns = 0;
    const report = runFlakeHarness(baseOptions({ outDir, iterations: 5, reproAttempts: 3 }), {
      runJest: (invocation) => {
        if (invocation.args.includes('-t')) {
          return { status: 0, output: 'PASS' };
        }
        iterationRuns += 1;
        return iterationRuns === 2
          ? { status: 1, output: FAILING_LOG }
          : { status: 0, output: 'PASS' };
      },
    });

    expect(report.passed).toBe(false);
    expect(report.iterationsRun).toBe(2);
    expect(report.iterationsPassed).toBe(1);
    expect(report.firstFailure?.iteration).toBe(2);
    expect(report.firstFailure?.failures).toHaveLength(2);
    // The failing iteration's log is kept and points at the real output.
    expect(readFileSync(report.firstFailure!.logPath, 'utf8')).toContain('Parse Error');

    const liver = report.reproductions.find((r) => r.test.includes('liver'));
    expect(liver).toMatchObject({
      suite: 'tests/api-endpoints.test.ts',
      pattern: 'the liver filters your blood',
      attempts: 3,
      failures: 0,
      // Passed every isolation rerun: load/order dependent, not a plain bug.
      deterministic: false,
    });
    expect(liver?.command).toContain('-t "the liver filters your blood"');

    // The report is written for later inspection.
    const written = JSON.parse(readFileSync(report.reportPath, 'utf8'));
    expect(written.firstFailure.failures).toHaveLength(2);
  });

  it('marks a failure that repeats alone as deterministic', () => {
    const report = runFlakeHarness(baseOptions({ outDir, iterations: 2, reproAttempts: 2 }), {
      runJest: (invocation) =>
        invocation.args.includes('-t')
          ? { status: 1, output: FAILING_LOG }
          : { status: 1, output: FAILING_LOG },
    });

    expect(report.passed).toBe(false);
    expect(report.reproductions).not.toHaveLength(0);
    for (const result of report.reproductions) {
      expect(result.failures).toBe(2);
      expect(result.deterministic).toBe(true);
    }
  });

  it('treats a killed runner (timeout) as a failure', () => {
    const report = runFlakeHarness(baseOptions({ outDir, iterations: 1 }), {
      runJest: () => ({ status: null, output: '', error: 'timed out' }),
    });
    expect(report.passed).toBe(false);
    expect(report.firstFailure?.iteration).toBe(1);
  });

  it('refuses a suite file that does not exist', () => {
    expect(() =>
      runFlakeHarness(baseOptions({ suites: ['tests/not-a-real-suite.test.ts'], outDir })),
    ).toThrow(HarnessUsageError);
  });
});

describe('runFlakeHarnessCli', () => {
  it('prints usage and exits 0 for --help', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(runFlakeHarnessCli(['--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Repeat-until-failure harness'));
    log.mockRestore();
  });

  it('exits 2 for bad usage', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runFlakeHarnessCli(['--nope'])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unknown argument'));
    error.mockRestore();
  });

  it('exits 1 when an iteration fails and 0 when they all pass', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'lifechat-flake-cli-'));

    try {
      const failing = runFlakeHarnessCli(
        ['--suite', 'tests/api-endpoints.test.ts', '--iterations', '1', '--json', '--out', outDir],
        {
          root: ROOT,
          runJest: () => ({ status: 1, output: FAILING_LOG }),
        },
      );
      expect(failing).toBe(1);

      const passing = runFlakeHarnessCli(
        ['--suite', 'tests/api-endpoints.test.ts', '--iterations', '2', '--json', '--out', outDir],
        {
          root: ROOT,
          runJest: () => ({ status: 0, output: 'PASS' }),
        },
      );
      expect(passing).toBe(0);
    } finally {
      log.mockRestore();
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
