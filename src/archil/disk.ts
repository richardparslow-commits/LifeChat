/**
 * Archil disk storage boundary for LifeChat — durable files across restarts and
 * serverless/container instances.
 *
 * A serverless invocation or container without a host volume has no local
 * filesystem that outlives it. An Archil disk is durable storage that survives
 * that boundary, read and written either through the S3-style object API
 * (`putObject` / `appendObject` / `getObject` / `deleteObject`) or by running a
 * command in a fresh container (`exec`) or persistent sandbox VM that mounts
 * the disk.
 *
 * This module is the only place the `disk` SDK is imported, so the credential
 * rules are enforced in one spot:
 *
 *   - `ARCHIL_API_KEY` is a server-side variable. API keys start with `key-`.
 *     A disk/mount token (`adt_…`) authenticates a FUSE mount, not the control
 *     plane or S3 API, and gets HTTP 401 — so that mistake is rejected with an
 *     actionable explanation instead of a bare 401.
 *   - Keys are region-scoped (`ARCHIL_REGION`, default `aws-us-east-1`). Using
 *     an `aws-us-east-1` key against a `gcp-us-central1` disk URL also returns
 *     401.
 *   - The one-time mount token `createDisk` returns is never returned or logged.
 *
 * Note on lazy loading: `disk` is loaded lazily via Node's native module loader
 * rather than a top-level import so that Jest suites (which run inside a VM
 * context without `--experimental-vm-modules`) never evaluate `disk/dist/index.cjs`
 * unless Archil SDK calls actually run.
 */

import { createRequire } from 'module';
import type * as ArchilNamespace from 'disk';
import type { Disk, ExecResult } from 'disk';

type ArchilModule = typeof ArchilNamespace;

let loadedSdk: ArchilModule | null = null;

function getArchilSdk(): ArchilModule {
  if (!loadedSdk) {
    // Use createRequire on process.execPath / __filename so Node's native CJS
    // loader (not Jest's VM sandbox) loads `disk` and its `import("undici")` call.
    const nativeRequire = createRequire(__filename);
    loadedSdk = nativeRequire('disk') as ArchilModule;
  }
  return loadedSdk;
}

/** Region used when `ARCHIL_REGION` is unset or blank. */
export const DEFAULT_ARCHIL_REGION = 'aws-us-east-1';

/**
 * Regions in which `exec` (serverless container commands) and sandboxes are
 * available. Object-style reads/writes work in every region.
 */
export const ARCHIL_EXEC_REGIONS = ['aws-us-east-1', 'aws-us-west-2', 'aws-eu-west-1'] as const;

/** Default name for the disk when creating one unconfigured. */
export const DEFAULT_ARCHIL_DISK_NAME = 'lifechat';

/** Where exec mounts a single disk by default. */
export const ARCHIL_MOUNT_PATH = '/mnt/data';

export type ArchilEnv = Record<string, string | undefined>;

/**
 * A configuration mistake, not an API failure. Callers can report the message
 * to a human as-is: it names the variable and the fix.
 */
export class ArchilConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchilConfigError';
  }
}

export interface ArchilConfig {
  apiKey: string;
  region: string;
  /** `dsk-…` from `ARCHIL_DISK_ID`, or null when nothing is configured yet. */
  diskId: string | null;
}

/**
 * True when both an Archil API key (starting with `key-`) and a target disk id
 * (`LIFECHAT_ARCHIL_DISK_ID` or `ARCHIL_DISK_ID`, starting with `dsk-`) are
 * present in the environment, and the process is not running inside an Archil
 * Sandbox VM where the root filesystem (`/dev/mapper/archil-root`) is already
 * backed by an Archil disk and outbound calls to the control plane are blocked.
 *
 * Inside an Archil Sandbox VM (`ARCHIL_CONTAINER_ID` is set), standard local
 * filesystem writes (`fs`) already persist to the sandbox's durable Archil root
 * disk (`ARCHIL_DISK_ID`), unless `LIFECHAT_FORCE_ARCHIL_S3 === 'true'` is
 * explicitly requested.
 */
export function isArchilStorageConfigured(env: ArchilEnv = process.env): boolean {
  if (env.ARCHIL_CONTAINER_ID && env.LIFECHAT_FORCE_ARCHIL_S3 !== 'true') {
    return false;
  }
  const apiKey = (env.LIFECHAT_ARCHIL_API_KEY ?? env.ARCHIL_API_KEY)?.trim() ?? '';
  const diskId = (env.LIFECHAT_ARCHIL_DISK_ID ?? env.ARCHIL_DISK_ID)?.trim() ?? '';
  return apiKey.startsWith('key-') && diskId.startsWith('dsk-');
}

/**
 * Normalize an Archil region string. Inside an Archil Sandbox guest, the
 * runtime injects internal cell identifiers like `prod.us-east-1.green`; the
 * public SDK expects `aws-us-east-1`.
 */
export function normalizeArchilRegion(rawRegion?: string): string {
  const trimmed = rawRegion?.trim() || '';
  if (!trimmed) return DEFAULT_ARCHIL_REGION;
  if (/^prod\.us-east-1\./i.test(trimmed)) return 'aws-us-east-1';
  if (/^prod\.us-west-2\./i.test(trimmed)) return 'aws-us-west-2';
  if (/^prod\.eu-west-1\./i.test(trimmed)) return 'aws-eu-west-1';
  return trimmed;
}

/**
 * Resolve the SDK credentials from the environment.
 *
 * `LIFECHAT_ARCHIL_*` overrides take precedence over `ARCHIL_*` so a process
 * running inside an Archil Sandbox VM can target a dedicated data disk instead
 * of the sandbox's auto-injected root disk.
 */
export function loadArchilConfig(env: ArchilEnv = process.env): ArchilConfig {
  const apiKey = (env.LIFECHAT_ARCHIL_API_KEY ?? env.ARCHIL_API_KEY)?.trim() ?? '';
  const region = normalizeArchilRegion(env.LIFECHAT_ARCHIL_REGION ?? env.ARCHIL_REGION);
  const diskId = (env.LIFECHAT_ARCHIL_DISK_ID ?? env.ARCHIL_DISK_ID)?.trim() || null;
  if (!apiKey) {
    throw new ArchilConfigError(
      'ARCHIL_API_KEY is not set. Create an API key at https://console.archil.com/api-keys ' +
        '(it starts with key-, not adt_) and set it in .env.',
    );
  }
  if (!apiKey.startsWith('key-')) {
    throw new ArchilConfigError(
      'ARCHIL_API_KEY does not look like an Archil API key (expected a value starting with key-). ' +
        'Disk and mount tokens (adt_…) get HTTP 401 from the API; use an API key from ' +
        'https://console.archil.com/api-keys instead.',
    );
  }
  if (diskId !== null && !diskId.startsWith('dsk-')) {
    throw new ArchilConfigError(`ARCHIL_DISK_ID must be a disk id (dsk-…), got "${diskId}".`);
  }
  return { apiKey, region, diskId };
}

/**
 * Point the SDK's module-level client at this environment's key and region.
 */
export function configureArchil(config: ArchilConfig = loadArchilConfig()): void {
  getArchilSdk().configure({ apiKey: config.apiKey, region: config.region });
}

let cachedDiskPromise: { key: string; promise: Promise<Disk> } | null = null;

/**
 * The disk named by `ARCHIL_DISK_ID`, cached per (apiKey, region, diskId) tuple
 * so repeated JSONL appends do not re-fetch disk metadata on every turn.
 */
export async function getArchilDisk(config: ArchilConfig = loadArchilConfig()): Promise<Disk> {
  if (!config.diskId) {
    throw new ArchilConfigError(
      'ARCHIL_DISK_ID is not set, so there is no configured disk to open.',
    );
  }
  const cacheKey = `${config.region}:${config.diskId}:${config.apiKey}`;
  if (cachedDiskPromise && cachedDiskPromise.key === cacheKey) {
    return cachedDiskPromise.promise;
  }
  const archil = getArchilSdk();
  archil.configure({ apiKey: config.apiKey, region: config.region });
  const promise = archil.getDisk(config.diskId).catch((err) => {
    if (cachedDiskPromise?.key === cacheKey) {
      cachedDiskPromise = null;
    }
    throw err;
  });
  cachedDiskPromise = { key: cacheKey, promise };
  return promise;
}

/** Reset the cached disk handle (for tests). */
export function resetArchilDiskCache(): void {
  cachedDiskPromise = null;
}

export interface ResolvedArchilDisk {
  disk: Disk;
  /** True when this call created the disk (no `ARCHIL_DISK_ID` was configured). */
  created: boolean;
}

/**
 * The disk this environment works with: the one named by `ARCHIL_DISK_ID`, or —
 * when no id is configured — an existing disk in the account, or a new one.
 */
export async function resolveArchilDisk(
  config: ArchilConfig = loadArchilConfig(),
  options: { createName?: string } = {},
): Promise<ResolvedArchilDisk> {
  const archil = getArchilSdk();
  archil.configure({ apiKey: config.apiKey, region: config.region });
  if (config.diskId) return { disk: await archil.getDisk(config.diskId), created: false };
  const name = options.createName ?? DEFAULT_ARCHIL_DISK_NAME;
  const all = await archil.listDisks();
  const existing = all.find((candidate) => candidate.name === name) ?? all[0];
  if (existing) return { disk: existing, created: false };
  const { disk } = await archil.createDisk({ name });
  return { disk, created: true };
}

/**
 * Normalize a local file path (e.g. `data/lead-records.jsonl` or
 * `/mnt/archil/lifechat/data/lead-records.jsonl`) into a clean S3 object key on
 * the Archil disk (`lifechat/data/lead-records.jsonl`).
 */
export function toArchilObjectKey(filePath: string, prefix = 'lifechat'): string {
  const cleaned = filePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(\.\/)+/, '');
  const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, '');
  if (!normalizedPrefix || cleaned.startsWith(`${normalizedPrefix}/`)) {
    return cleaned;
  }
  return `${normalizedPrefix}/${cleaned}`;
}

/**
 * Append a single JSONL line to an object on the configured Archil disk using
 * the S3-compatible `?append=true` extension (`disk.appendObject`).
 */
export async function appendArchilJsonlLine(filePath: string, line: string): Promise<boolean> {
  try {
    const disk = await getArchilDisk();
    const key = toArchilObjectKey(filePath);
    await disk.appendObject(key, `${line}\n`, 'application/x-ndjson');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read all non-empty lines from a JSONL object on the configured Archil disk.
 * Returns `[]` when the object does not exist yet (HTTP 404 / `NoSuchKey`).
 */
export async function readArchilJsonlLines(filePath: string): Promise<string[]> {
  try {
    const disk = await getArchilDisk();
    const key = toArchilObjectKey(filePath);
    const bytes = await disk.getObject(key);
    const text = new TextDecoder().decode(bytes);
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Replace a JSONL object on the configured Archil disk (idempotent).
 *
 * Erasure and retention rewrite a log rather than appending to it. Object
 * storage has no rename, so the replacement is a single put (or a delete when
 * nothing remains); a reader sees the old object or the new one, never a
 * half-written mix.
 */
export async function writeArchilJsonlLines(
  filePath: string,
  lines: readonly string[],
): Promise<boolean> {
  try {
    const disk = await getArchilDisk();
    const key = toArchilObjectKey(filePath);
    if (lines.length === 0) {
      await disk.deleteObject(key);
      return true;
    }
    await disk.putObject(key, `${lines.join('\n')}\n`, 'application/x-ndjson');
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a JSONL object from the configured Archil disk (idempotent).
 */
export async function removeArchilLogObject(filePath: string): Promise<void> {
  try {
    const disk = await getArchilDisk();
    const key = toArchilObjectKey(filePath);
    await disk.deleteObject(key);
  } catch {
    // Best-effort cleanup
  }
}

/** Run one command in a fresh container with the disk mounted at `/mnt/data`. */
export async function runArchilCommand(disk: Disk, command: string): Promise<ExecResult> {
  return disk.exec(command);
}

/** Write a file on the disk through the object API; `key` is disk-relative. */
export async function writeArchilFile(disk: Disk, key: string, contents: string): Promise<void> {
  await disk.putObject(key, contents);
}

/** Read a file back through the object API. */
export async function readArchilFile(disk: Disk, key: string): Promise<string> {
  return new TextDecoder().decode(await disk.getObject(key));
}
