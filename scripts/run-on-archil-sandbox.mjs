#!/usr/bin/env node
/**
 * Build LifeChat and run it inside an Archil Sandbox.
 *
 *   npm run deploy:archil-sandbox                 # build, deploy, restart, verify
 *   npm run deploy:archil-sandbox -- --skip-build # reuse the existing dist/
 *
 * Why this exists: the "how do I get it running on Archil?" steps are easy to
 * get wrong one at a time — the sandbox needs a compiled app (no ts-node under
 * a supervisor), a private env file rather than secrets in the sandbox's
 * metadata, an npm install inside the guest, a process that outlives the exec
 * session, and an exposed port. Doing them by hand once is fine; doing them
 * twice is how a demo breaks. This script is the runbook, executable.
 *
 * Persistence: the sandbox root filesystem is `/dev/mapper/archil-root`, an
 * Archil disk, so `/app/data/*.jsonl` survives stop/start. Mounting the shared
 * data disk (`ARCHIL_DISK_ID`) as an extra volume is intentionally NOT done
 * here: an exclusive read-write mount of that disk failed at boot, and a
 * conditional mount failed too, so the run uses the sandbox's own durable root
 * disk instead. The S3 deployment still writes to `ARCHIL_DISK_ID`.
 *
 * Secrets: `.env` is copied into a temp file (mode 0600), uploaded with the
 * files API, and installed at `/root/lifechat.env` (mode 0600) inside the
 * guest. Nothing is printed, and no secret is put in the sandbox's env
 * metadata where it would be visible in the console.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import * as archil from 'disk';

const SANDBOX_NAME = process.env.LIFECHAT_SANDBOX_NAME || 'lifechat-run';
const BASE_IMAGE = process.env.LIFECHAT_SANDBOX_IMAGE || 'node:22-bookworm-slim';
const APP_PORT = Number(process.env.LIFECHAT_SANDBOX_PORT || 3000);
const APP_DIR = '/app';
const ENV_PATH_IN_GUEST = '/root/lifechat.env';

const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');

dotenv.config({ quiet: true });

function fail(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

function step(message) {
  process.stdout.write(`\n== ${message}\n`);
}

function requireArchilConfig() {
  const apiKey = process.env.ARCHIL_API_KEY?.trim();
  const region = process.env.ARCHIL_REGION?.trim() || 'aws-us-east-1';
  if (!apiKey?.startsWith('key-')) {
    fail(
      'ARCHIL_API_KEY is missing or is not an Archil API key (expected key-…). ' +
        'Create one at https://console.archil.com/api-keys.',
    );
  }
  archil.configure({ apiKey, region });
  return { region };
}

/**
 * The guest's env: everything the app needs from `.env`, minus the values this
 * script owns. Record paths are absolute inside the guest so the logs land on
 * the durable root disk whether the app is started by hand or by this script.
 */
function guestEnvFile() {
  const lines = readFileSync(path.join(process.cwd(), '.env'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter(
      (line) => !/^(LEAD_LOG_PATH|DSR_LOG_PATH|ABSTENTION_LOG_PATH|LIFECHAT_PORT|PORT)=/.test(line),
    );
  lines.push(
    `LIFECHAT_PORT=${APP_PORT}`,
    `LEAD_LOG_PATH=${APP_DIR}/data/lead-records.jsonl`,
    `DSR_LOG_PATH=${APP_DIR}/data/dsr-records.jsonl`,
    `ABSTENTION_LOG_PATH=${APP_DIR}/data/abstention-log.jsonl`,
  );
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'lifechat-sandbox-')), 'lifechat.env');
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

function buildBundle() {
  if (!skipBuild) {
    step('Building (tsc)');
    execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  }
  step('Packing dist/ + public/ + package files');
  const bundle = path.join(
    mkdtempSync(path.join(tmpdir(), 'lifechat-bundle-')),
    'lifechat-app.tgz',
  );
  execFileSync(
    'tar',
    ['--exclude=*.map', '-czf', bundle, 'dist', 'public', 'package.json', 'package-lock.json'],
    { stdio: 'inherit' },
  );
  return bundle;
}

async function findSandbox() {
  const listed = await archil.listSandboxes();
  const all = Array.isArray(listed) ? listed : (listed.sandboxes ?? listed.items ?? []);
  return all.find((candidate) => candidate.name === SANDBOX_NAME) ?? null;
}

async function main() {
  requireArchilConfig();
  const bundlePath = buildBundle();
  const envPath = guestEnvFile();

  step(`Preparing sandbox "${SANDBOX_NAME}"`);
  let sandbox = await findSandbox();
  if (sandbox && sandbox.status === 'failed') {
    // A failed sandbox cannot be started; its root disk holds nothing worth
    // keeping because it never booted. Leave it for the console to show.
    process.stdout.write(
      `   previous sandbox is failed (${sandbox.exitReason ?? 'no reason'}); creating a new one\n`,
    );
    sandbox = null;
  }
  if (!sandbox) {
    sandbox = await archil.createSandbox({
      name: SANDBOX_NAME,
      baseImage: BASE_IMAGE,
      vcpuCount: 2,
      memSizeMiB: 2048,
      ports: [APP_PORT],
    });
    if (sandbox.status !== 'running') {
      fail(`Sandbox failed to start: ${sandbox.exitReason ?? 'no reason reported'}`);
    }
    process.stdout.write(`   created ${sandbox.id}\n`);
  } else {
    // Stop/start is what makes a redeploy deterministic: a process left over
    // from a previous run would keep holding the port, and killing it by
    // pattern is exactly the kind of cleanup that goes wrong quietly.
    if (sandbox.status === 'running') await sandbox.stop();
    await sandbox.start();
    process.stdout.write(`   reused ${sandbox.id} (${sandbox.status})\n`);
  }

  step('Uploading bundle and env file');
  await sandbox.files.uploadFile(readFileSync(bundlePath), '/root/lifechat-app.tgz');
  await sandbox.files.uploadFile(readFileSync(envPath), ENV_PATH_IN_GUEST, { mode: 0o600 });

  step('Unpacking and installing production dependencies');
  const install = await sandbox.exec(
    `set -e; mkdir -p ${APP_DIR}/data; tar -xzf /root/lifechat-app.tgz -C ${APP_DIR} ` +
      `2>/dev/null; cd ${APP_DIR} && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3`,
  );
  if (install.exitCode !== 0) {
    process.stderr.write(`${install.stdout}\n${install.stderr}\n`);
    fail('npm ci failed inside the sandbox');
  }

  step('Starting the server (detached)');
  const server = await sandbox.run(`node --env-file=${ENV_PATH_IN_GUEST} dist/index.js`, {
    cwd: APP_DIR,
  });
  process.stdout.write(`   process ${server.id}\n`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await server.disconnect();

  step('Exposing the port');
  const hostname = await sandbox.exposePort(APP_PORT);
  const baseUrl = `https://${hostname}`;
  process.stdout.write(`   ${baseUrl}\n`);

  step('Waiting for /health');
  const deadline = Date.now() + 60_000;
  let health = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      // Routing can take a few seconds to propagate; keep polling until the
      // deadline rather than treating the first refusal as a failed deploy.
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (!health) {
    const log = await sandbox.exec('tail -40 /root/lifechat.log 2>/dev/null; ls -l /app/data');
    process.stderr.write(`${log.stdout}\n`);
    fail(`/health did not answer at ${baseUrl} within 60s`);
  }

  // /health is liveness only (M-02). Readiness — LLM configuration, writable
  // record paths, the storage verdict — needs the admin key from the env the
  // sandbox was started with; it is reported, never enforced, like the probe.
  let readiness = null;
  const adminKey = process.env.ADMIN_API_KEY?.trim();
  if (adminKey) {
    try {
      const response = await fetch(`${baseUrl}/api/admin/health`, {
        headers: { 'x-admin-key': adminKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) readiness = await response.json();
    } catch {
      // A readiness read that fails must not fail the deploy report.
    }
  }

  const demo = await fetch(`${baseUrl}/demo.html`, { signal: AbortSignal.timeout(10_000) });
  const widget = await fetch(`${baseUrl}/widget.js`, { signal: AbortSignal.timeout(10_000) });
  const records = await sandbox.exec('wc -l /app/data/*.jsonl 2>/dev/null || true');

  // The model path is reported, never enforced: a rejected key is a demo
  // problem, not a failed deploy — the app, the widget and the record store
  // all work, and failing here would hide that.
  const probe = await sandbox.exec(
    `cd ${APP_DIR} && node --env-file=${ENV_PATH_IN_GUEST} dist/llm/llm-probe-cli.js`,
  );
  const probeDetail = probe.stdout
    .split('\n')
    .filter((line) => /FAILED|OK —/.test(line))
    .join(' ')
    .replace(/^\s*(FAILED|OK) — /, '')
    .trim();

  // Sandbox egress is a managed allowlist on this plan: package registries and
  // the major model providers answer, but an unlisted gateway host is reset at
  // the TLS handshake. That is a network symptom, not a bad key, and it is the
  // single easiest thing to misdiagnose here.
  const egressHint =
    probe.exitCode !== 0 && /network_error/.test(probeDetail)
      ? `  Note:         ${new URL(process.env.LLM_API_BASE_URL || 'https://api.openai.com/v1').host} is not reachable from the sandbox.\n` +
        "                Archil's managed egress allows api.openai.com, api.anthropic.com,\n" +
        '                openrouter.ai, api.groq.com and generativelanguage.googleapis.com;\n' +
        '                a custom policy needs a paid plan.'
      : null;

  process.stdout.write(
    [
      '',
      'LifeChat is running on Archil.',
      `  URL:          ${baseUrl}`,
      `  Demo:         ${baseUrl}/demo.html  (HTTP ${demo.status})`,
      `  Widget:       ${baseUrl}/widget.js  (HTTP ${widget.status})`,
      `  Status:       ${health.status}${readiness ? `, dataPathsWritable=${readiness.dataPathsWritable}` : ''}`,
      `  LLM:          configured=${readiness?.llm?.configured ?? 'unknown'}, model=${readiness?.llm?.model ?? '?'}`,
      `  Model probe:  ${probe.exitCode === 0 ? 'OK' : 'FAILED'}${probeDetail ? ` — ${probeDetail}` : ''}`,
      ...(egressHint ? [egressHint] : []),
      `  Sandbox:      ${sandbox.id} (${sandbox.status}), root disk /dev/mapper/archil-root`,
      `  Records:      ${records.stdout.trim().split('\n').filter(Boolean).join(' | ') || '(none yet)'}`,
      '',
    ].join('\n'),
  );
}

main().catch((error) => fail(error?.stack ?? String(error)));
