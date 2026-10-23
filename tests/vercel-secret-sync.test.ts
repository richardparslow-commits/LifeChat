/**
 * Deploy-time Vercel secret sync.
 *
 * The pre-deploy gate validates the repository copy of ADMIN_API_KEY and
 * RECORD_ENCRYPTION_KEY. The deployed function must run with those exact
 * values, and Vercel's environment is a separate, write-only store, so the
 * workflow pushes the checked copy into the project before deploying.
 *
 * The script runs in CI against the real Vercel CLI, which a unit test cannot
 * call. The stub here replaces `npx` on PATH and records argv and stdin, so the
 * contract that matters is still exercised: both secrets go to the production
 * environment as overwritten Vercel Secrets, the value travels over stdin, not
 * argv, and an empty value stops the run before Vercel is touched.
 */

import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { GATED_SECRET_NAMES } from '../src/config/secret-gate';

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'sync-vercel-secrets.sh');
const WORKFLOW = readFileSync(
  path.join(PROJECT_ROOT, '.github', 'workflows', 'deploy.yml'),
  'utf8',
);

const STRONG_ADMIN = 'Kx7Qm2Vt9Rb4Nc8Ws3Yd6Lf1Hg5Jp0Za';
const STRONG_ENCRYPTION = 'Zm4Tq9Wc2Xn7Kb5Vr8Ys3Ld6Jh1Gf0Pa';

/** Records each invocation's argv and stdin, one file per call. */
const STUB_NPX = `#!/usr/bin/env bash
dir="$(cd "$(dirname "$0")" && pwd)"
count=0
if [ -f "$dir/count" ]; then count="$(cat "$dir/count")"; fi
count=$((count + 1))
printf '%s' "$count" > "$dir/count"
printf '%s\\n' "$*" >> "$dir/calls"
cat > "$dir/value-$count"
`;

interface StubRun {
  status: number;
  stdout: string;
  stderr: string;
  /** One argv line per `npx` invocation, in order. */
  calls: string[];
  /** The stdin value each invocation received, in order. */
  values: string[];
}

const SYNCED_ENV = [
  'VERCEL_TOKEN',
  'VERCEL_ORG_ID',
  'VERCEL_PROJECT_ID',
  'ADMIN_API_KEY',
  'RECORD_ENCRYPTION_KEY',
];

function runScript(env: Record<string, string | undefined>): StubRun {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vercel-secret-sync-'));
  writeFileSync(path.join(dir, 'npx'), STUB_NPX);
  chmodSync(path.join(dir, 'npx'), 0o755);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
  };
  // A developer's own deployment variables must not influence a test.
  for (const name of SYNCED_ENV) delete childEnv[name];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[name] = value;
  }

  const result = spawnSync('bash', [SCRIPT], {
    cwd: PROJECT_ROOT,
    env: childEnv,
    encoding: 'utf8',
  });

  const callsPath = path.join(dir, 'calls');
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const values = calls.map((_, index) => {
    const valuePath = path.join(dir, `value-${index + 1}`);
    return existsSync(valuePath) ? readFileSync(valuePath, 'utf8') : '';
  });

  rmSync(dir, { recursive: true, force: true });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls,
    values,
  };
}

/** Every value the deploy pipeline needs once VERCEL_KEY enables it. */
const DEPLOY_CONFIG_NAMES = [
  'VERCEL_KEY',
  'VERCEL_ORG_ID',
  'VERCEL_PROJECT_ID',
  'ADMIN_API_KEY',
  'RECORD_ENCRYPTION_KEY',
  'LLM_API_KEY',
  'TEXAS_LICENSE_NUMBER',
] as const;

/**
 * Extracts a step's `run: |` body from deploy.yml.
 *
 * js-yaml is only a transitive override in this project, so the workflow is
 * read line by line, the way the pinning guards do. The body keeps its shell
 * text exactly, which is what lets the test execute the real step instead of
 * asserting on a copy of it.
 */
function stepRunBlock(stepName: string): string {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start === -1) throw new Error(`step not found in deploy.yml: ${stepName}`);

  const runIndex = lines.findIndex((line, index) => index > start && /^\s+run: \|$/.test(line));
  if (runIndex === -1) throw new Error(`step has no run block: ${stepName}`);

  const indent = /^\s*/.exec(lines[runIndex])?.[0].length ?? 0;
  const body: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== '' && /^\s*/.exec(line)?.[0].length === 0) break;
    if (line.trim() !== '' && (/^\s*/.exec(line)?.[0].length ?? 0) <= indent) break;
    body.push(line.slice(Math.min(indent + 2, line.length)));
  }
  return body.join('\n');
}

interface StepRun {
  status: number;
  stdout: string;
  stderr: string;
  /** Contents written to $GITHUB_OUTPUT. */
  output: string;
}

/**
 * Returns one step's YAML, from its `- name:` line to the next step at the same
 * indentation. Reading the file line by line keeps this independent of the
 * YAML library under `overrides`.
 */
function workflowStep(stepName: string): string {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  if (start === -1) throw new Error(`step not found in deploy.yml: ${stepName}`);

  const indent = /^\s*/.exec(lines[start])?.[0].length ?? 0;
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^\s*- name: /.test(line) && (/^\s*/.exec(line)?.[0].length ?? 0) === indent,
  );
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

/** Stands in for the Vercel CLI and prints a deployment URL like the real one. */
const STUB_DEPLOY_NPX = `#!/usr/bin/env bash
dir="$(cd "$(dirname "$0")" && pwd)"
printf '%s\\n' "$*" >> "$dir/calls"
echo "https://lifechat-fixture.vercel.app"
`;

interface DeployStepRun {
  status: number;
  /** One argv line per `npx` invocation. */
  calls: string[];
  /** Contents written to $GITHUB_ENV. */
  env: string;
  /** The teed deploy log the step later greps for the URL. */
  log: string;
}

/** Runs the workflow's deploy step exactly as the runner would. */
function runDeployStep(): DeployStepRun {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deploy-step-'));
  writeFileSync(path.join(dir, 'npx'), STUB_DEPLOY_NPX);
  chmodSync(path.join(dir, 'npx'), 0o755);
  const envPath = path.join(dir, 'github-env');
  writeFileSync(envPath, '');

  const result = spawnSync(
    'bash',
    ['-eo', 'pipefail', '-c', stepRunBlock('Deploy to Vercel (production)')],
    {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        GITHUB_ENV: envPath,
        VERCEL_TOKEN: 'vercel-token-for-test',
        VERCEL_ORG_ID: 'team_abc123',
        VERCEL_PROJECT_ID: 'prj_def456',
      },
      encoding: 'utf8',
    },
  );

  const callsPath = path.join(dir, 'calls');
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const env = readFileSync(envPath, 'utf8');
  const logPath = path.join(dir, 'deploy.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';

  rmSync(dir, { recursive: true, force: true });
  return { status: result.status ?? -1, calls, env, log };
}

/** Runs the workflow's configuration step exactly as the runner would. */
function runDeployConfigStep(env: Record<string, string | undefined>): StepRun {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deploy-config-'));
  const outputPath = path.join(dir, 'github-output');
  writeFileSync(outputPath, '');

  const childEnv: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: outputPath };
  for (const name of DEPLOY_CONFIG_NAMES) delete childEnv[name];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[name] = value;
  }

  const result = spawnSync('bash', ['-c', stepRunBlock('Check deploy configuration')], {
    cwd: PROJECT_ROOT,
    env: childEnv,
    encoding: 'utf8',
  });

  const output = readFileSync(outputPath, 'utf8');
  rmSync(dir, { recursive: true, force: true });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output,
  };
}

describe('Vercel secret sync', () => {
  it('pushes both validated secrets to production, as overwritable Vercel Secrets', () => {
    const run = runScript({
      VERCEL_TOKEN: 'vercel-token-for-test',
      VERCEL_ORG_ID: 'team_abc123',
      VERCEL_PROJECT_ID: 'prj_def456',
      ADMIN_API_KEY: STRONG_ADMIN,
      RECORD_ENCRYPTION_KEY: STRONG_ENCRYPTION,
    });

    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(2);

    expect(run.calls[0]).toMatch(/^--no-install vercel env add ADMIN_API_KEY /);
    expect(run.calls[0]).toContain('--environment production');
    expect(run.calls[0]).toContain('--sensitive');
    expect(run.calls[0]).toContain('--force');
    expect(run.calls[0]).toContain('--scope team_abc123');
    expect(run.calls[0]).toContain('--project prj_def456');
    expect(run.calls[0]).toContain('--token vercel-token-for-test');

    expect(run.calls[1]).toMatch(/^--no-install vercel env add RECORD_ENCRYPTION_KEY /);

    // The checked value is the value Vercel receives, byte for byte.
    expect(run.values).toEqual([STRONG_ADMIN, STRONG_ENCRYPTION]);

    // Length only: the run's output must not become a copy of the secrets.
    expect(run.stdout).toContain(
      `Synced ADMIN_API_KEY to Vercel production (${STRONG_ADMIN.length} chars).`,
    );
    expect(run.stdout).toContain(
      `Synced RECORD_ENCRYPTION_KEY to Vercel production (${STRONG_ENCRYPTION.length} chars).`,
    );
    for (const output of [run.stdout, run.stderr, ...run.calls]) {
      expect(output).not.toContain(STRONG_ADMIN);
      expect(output).not.toContain(STRONG_ENCRYPTION);
    }
  });

  it('passes the value over stdin rather than argv', () => {
    const tricky = 'A1 b2$c3"d4 e5';
    const run = runScript({
      VERCEL_TOKEN: 'token',
      VERCEL_ORG_ID: 'team_abc123',
      VERCEL_PROJECT_ID: 'prj_def456',
      ADMIN_API_KEY: tricky,
      RECORD_ENCRYPTION_KEY: STRONG_ENCRYPTION,
    });

    expect(run.status).toBe(0);
    expect(run.values[0]).toBe(tricky);
    expect(run.calls[0]).not.toContain(tricky);
  });

  it('stops before calling Vercel when a validated value is empty', () => {
    const run = runScript({
      VERCEL_TOKEN: 'token',
      VERCEL_ORG_ID: 'team_abc123',
      VERCEL_PROJECT_ID: 'prj_def456',
      ADMIN_API_KEY: '',
      RECORD_ENCRYPTION_KEY: STRONG_ENCRYPTION,
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('ADMIN_API_KEY is empty');
    expect(run.calls).toHaveLength(0);
  });

  it('refuses to run without a Vercel token', () => {
    const run = runScript({
      ADMIN_API_KEY: STRONG_ADMIN,
      RECORD_ENCRYPTION_KEY: STRONG_ENCRYPTION,
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('VERCEL_TOKEN is not set');
    expect(run.calls).toHaveLength(0);
  });

  it('refuses to guess the project when the identifiers are missing', () => {
    // Writing the value to some other project would deploy unchecked secrets,
    // so an unpinned checkout fails closed rather than letting the CLI link.
    for (const env of [{ VERCEL_ORG_ID: 'team_abc123' }, { VERCEL_PROJECT_ID: 'prj_def456' }, {}]) {
      const run = runScript({
        VERCEL_TOKEN: 'token',
        ADMIN_API_KEY: STRONG_ADMIN,
        RECORD_ENCRYPTION_KEY: STRONG_ENCRYPTION,
        ...env,
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toContain('VERCEL_ORG_ID and VERCEL_PROJECT_ID must both be set');
      expect(run.calls).toHaveLength(0);
    }
  });
});

describe('deploy workflow wiring', () => {
  it('syncs the same two secrets after the gate and before the deploy', () => {
    const gateStep = WORKFLOW.indexOf('Pre-deploy posture gate');
    const installStep = WORKFLOW.indexOf('Install pinned Vercel CLI');
    const syncStep = WORKFLOW.indexOf('Sync validated secrets to Vercel (production)');
    const deployStep = WORKFLOW.indexOf('Deploy to Vercel (production)');

    expect(gateStep).toBeGreaterThan(-1);
    // The script calls `npx --no-install vercel`, so the pinned CLI must already exist.
    expect(installStep).toBeGreaterThan(gateStep);
    expect(syncStep).toBeGreaterThan(installStep);
    expect(deployStep).toBeGreaterThan(syncStep);

    const syncBlock = WORKFLOW.slice(syncStep, deployStep);
    expect(syncBlock).toContain('bash scripts/sync-vercel-secrets.sh');
    expect(syncBlock).toContain('VERCEL_TOKEN: ${{ secrets.VERCEL_KEY }}');
    expect(syncBlock).toContain('VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}');
    expect(syncBlock).toContain('VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}');
    expect(syncBlock).toContain('ADMIN_API_KEY: ${{ secrets.ADMIN_API_KEY }}');
    expect(syncBlock).toContain('RECORD_ENCRYPTION_KEY: ${{ secrets.RECORD_ENCRYPTION_KEY }}');
    // The sync is deliberately limited to the two values the runtime cannot start without.
    expect(syncBlock).not.toContain('LLM_API_KEY');
    expect(syncBlock).not.toContain('TEXAS_LICENSE_NUMBER');
  });

  it('checks configuration before checkout, and every later step depends on it', () => {
    const configStep = WORKFLOW.indexOf('Check deploy configuration');
    const checkoutStep = WORKFLOW.indexOf('Checkout repository');

    expect(configStep).toBeGreaterThan(-1);
    // Before install and build: a missing value is cheap to report now and
    // expensive to discover after a full build.
    expect(checkoutStep).toBeGreaterThan(configStep);
    expect(WORKFLOW.slice(configStep, checkoutStep)).toContain('id: config');

    // No stale reference to the old token-only step, or the job would read an
    // output that is never set and silently skip everything.
    expect(WORKFLOW).not.toContain('steps.token.outputs.available');
    expect(WORKFLOW).toContain("if: steps.config.outputs.available == 'true'");

    // The deploy addresses the same project the secrets were stored in, so a
    // value can never land in one project while the function runs in another.
    const deployBlock = WORKFLOW.slice(
      WORKFLOW.indexOf('Deploy to Vercel (production)'),
      WORKFLOW.indexOf('Smoke check the deployment'),
    );
    expect(deployBlock).toContain('--scope "$VERCEL_ORG_ID"');
    expect(deployBlock).toContain('--project "$VERCEL_PROJECT_ID"');
  });

  it('uploads source for a remote build rather than asking for output nobody produced', () => {
    // `--prebuilt` uploads only the `.vercel/output` directory written by
    // `vercel build`. This job never runs that command, so the flag would make
    // every deploy fail before upload. The deployment is built by Vercel from
    // vercel.json instead, and the local build above is only a parity gate.
    const deployStart = WORKFLOW.indexOf('Deploy to Vercel (production)');
    const deployBlock = WORKFLOW.slice(deployStart, WORKFLOW.indexOf('Smoke check the deployment'));

    expect(deployBlock).not.toMatch(/--prebuilt\b/);
    expect(WORKFLOW).not.toMatch(/npx --no-install vercel build/);

    // Keep the local parity gate: it runs the same build Vercel will run, so a
    // broken build fails here rather than as a failed remote deployment.
    const buildStep = WORKFLOW.indexOf('name: Build');
    expect(buildStep).toBeGreaterThan(-1);
    expect(deployStart).toBeGreaterThan(buildStep);
  });

  it('runs the deploy step with no prebuilt flag and captures the deployment URL', () => {
    const run = runDeployStep();

    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toMatch(/^--no-install vercel deploy --prod --yes /);
    expect(run.calls[0]).not.toContain('--prebuilt');

    // The step still addresses the project the secrets were synced to.
    expect(run.calls[0]).toContain('--scope team_abc123');
    expect(run.calls[0]).toContain('--project prj_def456');
    expect(run.calls[0]).toContain('--token vercel-token-for-test');

    // A successful run records the URL for the smoke check that follows.
    expect(run.log).toContain('https://lifechat-fixture.vercel.app');
    expect(run.env).toContain('DEPLOY_URL=https://lifechat-fixture.vercel.app');
  });

  it('gives the posture gate step every value the gate validates', () => {
    const gateBlock = workflowStep('Pre-deploy posture gate (secrets + license)');

    expect(gateBlock).toContain('run: npm run secrets:gate');

    // Each value is mapped explicitly. A gate run that silently lost one of
    // these would report a missing value and fail the main-branch deploy; that
    // failure belongs in a pull request, which is what this pin buys.
    expect(gateBlock).toContain('ADMIN_API_KEY: ${{ secrets.ADMIN_API_KEY }}');
    expect(gateBlock).toContain('RECORD_ENCRYPTION_KEY: ${{ secrets.RECORD_ENCRYPTION_KEY }}');
    expect(gateBlock).toContain('LLM_API_KEY: ${{ secrets.LLM_API_KEY }}');
    // The license is a public identifier: a repository variable is preferred,
    // and an existing repository secret keeps working.
    expect(gateBlock).toContain(
      'TEXAS_LICENSE_NUMBER: ${{ vars.TEXAS_LICENSE_NUMBER || secrets.TEXAS_LICENSE_NUMBER }}',
    );

    // Driving the list from the gate itself means a newly gated value cannot be
    // added to the gate without this step being updated in the same change.
    for (const name of GATED_SECRET_NAMES) {
      expect(gateBlock).toMatch(new RegExp(`^\\s+${name}: \\$\\{\\{`, 'm'));
    }
  });

  it('treats an absent VERCEL_KEY as "pipeline disabled" and skips green', () => {
    // The enable switch doubles as the opt-out: forks and pre-secret states
    // must stay green rather than failing for configuration they never had.
    const run = runDeployConfigStep({});

    expect(run.status).toBe(0);
    expect(run.output).toContain('available=false');
    expect(run.stdout).toContain('deploy pipeline is disabled');
    expect(run.stdout).not.toContain('::error::');
  });

  it('passes when the pipeline is enabled and every required value is present', () => {
    const run = runDeployConfigStep({
      VERCEL_KEY: 'token',
      VERCEL_ORG_ID: 'team_abc123',
      VERCEL_PROJECT_ID: 'prj_def456',
      ADMIN_API_KEY: STRONG_ADMIN,
      RECORD_ENCRYPTION_KEY: STRONG_ENCRYPTION,
      LLM_API_KEY: 'sk-proj-fixture-0000000000000000',
      TEXAS_LICENSE_NUMBER: 'TX-1234567',
    });

    expect(run.status).toBe(0);
    expect(run.output).toContain('available=true');
    expect(run.stdout).toContain('Deploy configuration complete');
    expect(run.stdout).not.toContain('::error::');
  });

  it('fails loudly and names every missing value when the pipeline is enabled', () => {
    const run = runDeployConfigStep({ VERCEL_KEY: 'token', VERCEL_ORG_ID: 'team_abc123' });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain('::error::The deploy pipeline is enabled');
    // Everything absent is named in one run, so nobody fixes one secret, reruns
    // ten minutes of CI, and discovers the next gap.
    for (const name of [
      'VERCEL_PROJECT_ID',
      'ADMIN_API_KEY',
      'RECORD_ENCRYPTION_KEY',
      'LLM_API_KEY',
      'TEXAS_LICENSE_NUMBER',
    ]) {
      expect(run.stdout).toContain(name);
    }
    // The values that are present must not be reported as missing.
    const missingLine = /required configuration is missing: ([^\n]+)/.exec(run.stdout)?.[1] ?? '';
    expect(missingLine).not.toContain('VERCEL_ORG_ID');
    expect(missingLine).not.toContain('VERCEL_KEY');
  });
});
