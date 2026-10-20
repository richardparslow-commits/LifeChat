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

  it('fails before the build without the project pin, and deploys to that same project', () => {
    const guardStep = WORKFLOW.indexOf('Require the project pin');
    const checkoutStep = WORKFLOW.indexOf('Checkout repository');

    expect(guardStep).toBeGreaterThan(-1);
    // Failing here, before `npm ci` and the build, avoids a long red run whose
    // only problem is a missing secret pair.
    expect(checkoutStep).toBeGreaterThan(guardStep);

    const guardBlock = WORKFLOW.slice(guardStep, checkoutStep);
    expect(guardBlock).toContain('VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}');
    expect(guardBlock).toContain('VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}');
    expect(guardBlock).toContain('exit 1');

    // The deploy addresses the same project the secrets were written to, so a
    // value can never land in one project while the function runs in another.
    const deployBlock = WORKFLOW.slice(
      WORKFLOW.indexOf('Deploy to Vercel (production)'),
      WORKFLOW.indexOf('Smoke check the deployment'),
    );
    expect(deployBlock).toContain('--scope "$VERCEL_ORG_ID"');
    expect(deployBlock).toContain('--project "$VERCEL_PROJECT_ID"');
  });
});
