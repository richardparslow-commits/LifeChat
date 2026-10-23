/**
 * Container build: the pre-deploy posture gate runs inside `docker build`.
 *
 * The Vercel path runs `npm run secrets:gate` as a workflow step, which a
 * container deployment could skip entirely. The Dockerfile therefore runs the
 * same gate as a build stage, fed by BuildKit secrets rather than build args or
 * ENV (both of which would leave the values in the image).
 *
 * A unit test cannot run a Docker daemon here, so it does the next best thing:
 * it asserts the wiring, and it executes the gate's actual RUN script against
 * real secret files — passing strong values, then a placeholder, then a missing
 * mount — so the command the build runs is exercised, not a copy of it.
 */

import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';

const PROJECT_ROOT = path.join(__dirname, '..');
const DOCKERFILE = readFileSync(path.join(PROJECT_ROOT, 'Dockerfile'), 'utf8');
const DOCKERIGNORE = readFileSync(path.join(PROJECT_ROOT, '.dockerignore'), 'utf8');
const BUILD_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'build-docker-image.sh');

const SECRET_IDS = [
  'admin_api_key',
  'record_encryption_key',
  'llm_api_key',
  'texas_license_number',
] as const;

const GATED_ENV = ['ADMIN_API_KEY', 'RECORD_ENCRYPTION_KEY', 'LLM_API_KEY', 'TEXAS_LICENSE_NUMBER'];

/**
 * Synthetic values that satisfy the gate's length/shape contract. Each is a
 * fixed literal because the gate must accept a realistic value, not a generated
 * one; an inline scanner exemption marks them as test fixtures so the history
 * scan does not report them once this file is committed.
 */
const STRONG: Record<(typeof SECRET_IDS)[number], string> = {
  admin_api_key: 'Kx7Qm2Vt9Rb4Nc8Ws3Yd6Lf1Hg5Jp0Za', // gitleaks:allow - synthetic test fixture
  record_encryption_key: 'Zm4Tq9Wc2Xn7Kb5Vr8Ys3Ld6Jh1Gf0Pa', // gitleaks:allow - synthetic test fixture
  llm_api_key: 'sk-proj-8fK2mQ7vT4xR9cL6nW3bY5dH1jS0aP2e', // gitleaks:allow - synthetic test fixture
  texas_license_number: '2048671',
};

/**
 * The shell command the gate RUN executes, with its secret mounts stripped.
 *
 * Dockerfile line continuations are collapsed, not turned into newlines: the
 * four `NAME="$(cat ...)"` assignments and `npm run secrets:gate` are one
 * command, and splitting them would silently drop the environment.
 */
function gateRunScript(): string {
  const lines = DOCKERFILE.split('\n');
  // The command, not the explanatory comment at the top of the file.
  const gateLine = lines.findIndex((line) => /npm run secrets:gate\s*$/.test(line));
  if (gateLine === -1) throw new Error('the Dockerfile never runs `npm run secrets:gate`');

  let start = gateLine;
  while (start >= 0 && !lines[start].startsWith('RUN ')) start -= 1;
  if (start < 0) throw new Error('the gate command is not part of a RUN instruction');

  let end = start;
  while (end < lines.length && lines[end].trimEnd().endsWith('\\')) end += 1;

  return lines
    .slice(start, end + 1)
    .join('\n')
    .replace(/--mount=type=secret,id=[a-z_]+/g, '')
    .replace(/\\\n\s*/g, ' ')
    .replace(/^RUN\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface GateRun {
  status: number;
  stdout: string;
  stderr: string;
}

function writeSecrets(values: Partial<Record<(typeof SECRET_IDS)[number], string>>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docker-posture-gate-'));
  for (const [id, value] of Object.entries(values)) {
    if (value !== undefined) writeFileSync(path.join(dir, id), value);
  }
  return dir;
}

/** Runs the Dockerfile's gate command with the secret files in `dir`. */
function runGate(dir: string): GateRun {
  const env: NodeJS.ProcessEnv = { ...process.env, SECRETS_DIR: dir };
  // The gate must be satisfied by the mounted files, never by ambient state.
  for (const name of [...GATED_ENV, 'SECRETS_DIR']) delete env[name];
  env.SECRETS_DIR = dir;

  const result = spawnSync('sh', ['-c', gateRunScript()], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Records the argv of each `docker` invocation the build script makes. */
const STUB_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$(cd "$(dirname "$0")" && pwd)/calls"
`;

/** Same, but reports that the buildx plugin is unavailable. */
const STUB_DOCKER_NO_BUILDX = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$(cd "$(dirname "$0")" && pwd)/calls"
if [ "$1" = "buildx" ] && [ "$2" = "version" ]; then exit 1; fi
`;

interface BuildScriptRun {
  status: number;
  stdout: string;
  stderr: string;
  calls: string[];
}

function runBuildScript(
  env: Record<string, string | undefined>,
  stub: string = STUB_DOCKER,
): BuildScriptRun {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docker-build-script-'));
  writeFileSync(path.join(dir, 'docker'), stub);
  chmodSync(path.join(dir, 'docker'), 0o755);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH ?? ''}`,
  };
  for (const name of [...GATED_ENV, 'IMAGE_TAG']) delete childEnv[name];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[name] = value;
  }

  const result = spawnSync('bash', [BUILD_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: childEnv,
    encoding: 'utf8',
  });

  const callsPath = path.join(dir, 'calls');
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean)
    : [];

  rmSync(dir, { recursive: true, force: true });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls,
  };
}

describe('Dockerfile posture gate', () => {
  it('runs every gated value through the pre-deploy gate during the image build', () => {
    const runScript = gateRunScript();

    for (const id of SECRET_IDS) {
      expect(DOCKERFILE).toContain(`--mount=type=secret,id=${id}`);
      expect(runScript).toContain(`$SECRETS_DIR/${id}`);
      expect(runScript).toContain(`$(cat "$SECRETS_DIR/${id}")`);
    }
    expect(runScript).toContain('npm run secrets:gate');

    // Before the compile: a rejected value stops the build instead of wasting
    // it, and the image is never produced.
    expect(DOCKERFILE.search(/npm run secrets:gate\s*$/)).toBeLessThan(
      DOCKERFILE.indexOf('npm run build'),
    );

    // The gate stage is in the final image's ancestry, so it cannot be skipped
    // by building the runtime target.
    expect(DOCKERFILE).toContain('FROM posture-gate AS build');
    expect(DOCKERFILE).toContain('FROM node:22-bookworm-slim AS runtime');
    expect(DOCKERFILE).toMatch(/COPY --from=build .*\/app\/dist \.\/dist/);
    expect(DOCKERFILE).toContain('CMD ["node", "dist/index.js"]');
  });

  it('never carries a gated value in an ARG or ENV instruction', () => {
    // Build args are recorded in the image history and ENV is readable from
    // the image, so either would publish the secrets the gate is checking.
    for (const name of GATED_ENV) {
      expect(DOCKERFILE).not.toMatch(new RegExp(`^\\s*ARG\\s+${name}\\b`, 'm'));
      expect(DOCKERFILE).not.toMatch(new RegExp(`^\\s*ENV\\s+${name}\\b`, 'm'));
    }
    expect(DOCKERFILE).not.toMatch(/--build-arg/);
  });

  it('passes strong values through the real gate command', () => {
    const dir = writeSecrets(STRONG);
    try {
      const run = runGate(dir);
      expect(run.stderr).toBe('');
      expect(run.stdout).toContain('OK: 4 value(s) meet the deployment contract.');
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the build on a placeholder model key, without echoing the value', () => {
    const placeholder = 'sk-test-placeholder-000000000000000';
    const dir = writeSecrets({ ...STRONG, llm_api_key: placeholder });
    try {
      const run = runGate(dir);
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('LLM_API_KEY');
      expect(run.stdout).toContain('FAILED: LLM_API_KEY');
      for (const output of [run.stdout, run.stderr]) {
        expect(output).not.toContain(placeholder);
        expect(output).not.toContain(STRONG.admin_api_key);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the build when a required secret mount is absent', () => {
    const partial: Partial<Record<(typeof SECRET_IDS)[number], string>> = { ...STRONG };
    delete partial.admin_api_key;
    const dir = writeSecrets(partial);
    try {
      const run = runGate(dir);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("build secret 'admin_api_key' is required");
      // Nothing should have reached the gate itself.
      expect(run.stdout).not.toContain('pre-deploy gate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('container build context', () => {
  it('keeps secrets and local state out of the build context', () => {
    const ignored = DOCKERIGNORE.split('\n').map((line) => line.trim());
    expect(ignored).toContain('.env');
    expect(ignored).toContain('.env.*');
    expect(ignored).toContain('node_modules');
    expect(ignored).toContain('data');
    expect(ignored).toContain('tests');
  });
});

describe('build-docker-image.sh', () => {
  it('is executable', () => {
    expect(statSync(BUILD_SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('hands all four values to BuildKit as secrets and reruns the gate stage', () => {
    const run = runBuildScript({
      ADMIN_API_KEY: STRONG.admin_api_key,
      RECORD_ENCRYPTION_KEY: STRONG.record_encryption_key,
      LLM_API_KEY: STRONG.llm_api_key,
      TEXAS_LICENSE_NUMBER: STRONG.texas_license_number,
      IMAGE_TAG: 'lifechat:test',
    });

    expect(run.status).toBe(0);
    // The plugin probe, then the build itself.
    expect(run.calls).toHaveLength(2);
    expect(run.calls[0]).toMatch(/^buildx version/);

    const call = run.calls[1];
    expect(call).toMatch(/^buildx build /);
    expect(call).toContain('--tag lifechat:test');
    expect(call).toContain('--load');
    expect(call).toContain('--no-cache-filter posture-gate');
    expect(call).toContain('--secret id=admin_api_key,env=ADMIN_API_KEY'); // gitleaks:allow - argument name, not a value
    expect(call).toContain('--secret id=record_encryption_key,env=RECORD_ENCRYPTION_KEY'); // gitleaks:allow - argument name, not a value
    expect(call).toContain('--secret id=llm_api_key,env=LLM_API_KEY'); // gitleaks:allow - argument name, not a value
    expect(call).toContain('--secret id=texas_license_number,env=TEXAS_LICENSE_NUMBER'); // gitleaks:allow - argument name, not a value
    expect(call).not.toContain('--build-arg');

    // The value itself never reaches argv, where a process listing would show it.
    for (const value of Object.values(STRONG)) expect(call).not.toContain(value);
    for (const output of [run.stdout, run.stderr]) {
      for (const value of Object.values(STRONG)) expect(output).not.toContain(value);
    }
  });

  it('refuses to build without buildx, rather than drop the cache exclusion', () => {
    const run = runBuildScript(
      {
        ADMIN_API_KEY: STRONG.admin_api_key,
        RECORD_ENCRYPTION_KEY: STRONG.record_encryption_key,
        LLM_API_KEY: STRONG.llm_api_key,
        TEXAS_LICENSE_NUMBER: STRONG.texas_license_number,
      },
      STUB_DOCKER_NO_BUILDX,
    );

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('docker buildx is required');
    expect(run.calls.some((call) => call.startsWith('buildx build'))).toBe(false);
  });

  it('refuses to start the build when a value is missing', () => {
    const run = runBuildScript({ ADMIN_API_KEY: STRONG.admin_api_key });

    expect(run.status).toBe(1);
    expect(run.calls).toHaveLength(0);
    expect(run.stderr).toContain('RECORD_ENCRYPTION_KEY');
    expect(run.stderr).toContain('LLM_API_KEY');
    expect(run.stderr).toContain('TEXAS_LICENSE_NUMBER');
    // The one value that is present must not be reported as missing.
    const missingLine = /missing ([A-Z_ ]+) -/.exec(run.stderr)?.[1] ?? '';
    expect(missingLine).not.toContain('ADMIN_API_KEY');
  });
});
