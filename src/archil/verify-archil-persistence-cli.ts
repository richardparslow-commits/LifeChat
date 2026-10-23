/**
 * Archil persistence verification CLI for LifeChat.
 *
 *   npm run verify:archil-persistence
 *
 * Verifies both:
 * 1. Two separate `disk.exec` container invocations (write in container 1, read
 *    back in container 2) so survival across container boundaries is proven.
 * 2. The S3-compatible JSONL object append (`appendArchilJsonlLine`) and read
 *    (`readArchilJsonlLines`) used by LifeChat's lead, DSR, and abstention
 *    stores.
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import {
  ARCHIL_EXEC_REGIONS,
  appendArchilJsonlLine,
  loadArchilConfig,
  readArchilJsonlLines,
  removeArchilLogObject,
  resolveArchilDisk,
} from './disk';

const ENV_FILE = path.join(process.cwd(), '.env');

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function rememberDiskId(diskId: string): boolean {
  try {
    const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
    const kept = existing.split('\n').filter((line) => !/^\s*ARCHIL_DISK_ID\s*=/.test(line));
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    const next =
      kept.length === 0
        ? `ARCHIL_DISK_ID=${diskId}\n`
        : `${kept.join('\n')}\nARCHIL_DISK_ID=${diskId}\n`;
    writeFileSync(ENV_FILE, next, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadArchilConfig();
  if (!(ARCHIL_EXEC_REGIONS as readonly string[]).includes(config.region)) {
    fail(
      `exec runs only in ${ARCHIL_EXEC_REGIONS.join(', ')}; ARCHIL_REGION is "${config.region}". ` +
        'Use a key from an exec-capable region (the default is aws-us-east-1).',
    );
  }

  const { disk, created } = await resolveArchilDisk(config);
  process.stdout.write(
    `disk:    ${disk.name} (${disk.id}${created ? ', created' : ''}) in ${config.region}\n`,
  );
  if (config.diskId !== disk.id) {
    process.env.ARCHIL_DISK_ID = disk.id;
    process.stdout.write(
      rememberDiskId(disk.id)
        ? `saved:   ARCHIL_DISK_ID=${disk.id} in .env\n`
        : `add to .env: ARCHIL_DISK_ID=${disk.id}\n`,
    );
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDirectory = `persistence-checks/lifechat-${runId}`;
  const probePath = `${runDirectory}/probe.txt`;
  const line = `lifechat-archil-persistence ${runId} ${randomUUID()}`;

  const write = await disk.exec(
    `mkdir -p '${runDirectory}' && printf '%s\\n' '${line}' > '${probePath}'`,
  );
  if (write.exitCode !== 0) {
    fail(`write exec exited ${write.exitCode}:\n${write.stderr.trim() || '(no stderr)'}`);
  }
  process.stdout.write(`wrote:   ${probePath}\n`);

  const read = await disk.exec(`cat '${probePath}'`);
  if (read.exitCode !== 0) {
    fail(
      `read-back exec exited ${read.exitCode} — the file written by the first exec is gone:\n` +
        `${read.stderr.trim() || '(no stderr)'}`,
    );
  }
  if (!read.stdout.includes(line)) {
    fail(
      'read-back exec did not return what the write exec stored:\n' +
        `  wrote: ${line}\n  read:  ${read.stdout.trim() || '(empty)'}`,
    );
  }
  process.stdout.write(`read:    ${read.stdout.trim()}\n`);

  // Verify S3-compatible JSONL object append/read used by LifeChat record stores
  const jsonlProbePath = `data/probe-${runId}.jsonl`;
  const entry1 = JSON.stringify({ seq: 1, runId });
  const entry2 = JSON.stringify({ seq: 2, runId });
  const ok1 = await appendArchilJsonlLine(jsonlProbePath, entry1);
  const ok2 = await appendArchilJsonlLine(jsonlProbePath, entry2);
  if (!ok1 || !ok2) {
    fail('JSONL object append failed on Archil disk.');
  }
  const lines = await readArchilJsonlLines(jsonlProbePath);
  await removeArchilLogObject(jsonlProbePath);
  if (lines.length !== 2 || lines[0] !== entry1 || lines[1] !== entry2) {
    fail(`JSONL object read-back mismatch: got ${JSON.stringify(lines)}`);
  }

  process.stdout.write(
    '✓ persisted: exec container probe + S3 JSONL append/read verified on Archil disk\n',
  );
}

main().catch((error: { status?: number; message?: string }) => {
  if (error?.status === 401) {
    fail(
      'Archil rejected the credential (HTTP 401). ARCHIL_API_KEY is probably a disk/mount token ' +
        '(adt_…) or a key from a different region: use an API key starting with key- from ' +
        'https://console.archil.com/api-keys in an AWS region.',
    );
  }
  fail(error?.message ?? String(error));
});
