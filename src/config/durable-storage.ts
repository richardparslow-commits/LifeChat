/**
 * Durable record storage — verified, not declared (SEC-11).
 *
 * Record logs (lead/consent, DSR, erasure and access audit) are legal
 * artifacts. On a serverless platform the only guaranteed-writable location is
 * an ephemeral scratch directory, so a write there can be acknowledged and
 * then vanish with the invocation. The previous control was a boolean
 * (`DURABLE_STORAGE_CONFIGURED=true`) that switched that guard off; a flag
 * asserts durability but proves nothing, so the one control that turns
 * fail-closed writes into fail-open ones was itself unverified.
 *
 * This module replaces the assertion with evidence:
 *
 *   - Archil object storage configured: records are written outside the
 *     process, so durability does not depend on the local filesystem.
 *   - A long-running process (not serverless): it owns a real filesystem.
 *   - Otherwise the probe writes a random byte string to each record
 *     directory, reads it back, and deletes it. Directories under a known
 *     ephemeral root (`/tmp`, `/var/task`, …) fail before that, because a
 *     successful write there is exactly the false positive the flag created.
 *
 * The probe runs once at boot and the verdict is frozen. A failed probe leaves
 * record writes failing closed (503) rather than accepting records that may be
 * lost; the operator sees the reason in the startup log and on
 * `GET /api/admin/health`.
 */

import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, resolve } from 'path';

/** Where the verdict came from. Stable codes, safe for logs and admin health. */
export type DurableStorageReason =
  'local_process' | 'archil' | 'probe_passed' | 'probe_failed' | 'ephemeral_path' | 'probe_pending';

export interface DurableStorageStatus {
  /** True only when durability was established, never merely assumed. */
  verified: boolean;
  reason: DurableStorageReason;
  /** Absolute record directories that were examined (operator diagnostics). */
  checked: string[];
}

/**
 * Filesystem roots that are scratch space on serverless platforms. The OS
 * temp directory is included by definition: a record written there does not
 * outlive the machine, whichever platform supplies the path.
 */
const EPHEMERAL_ROOTS = [
  ...new Set(['/tmp', '/private/tmp', '/var/task', '/var/tmp', '/dev/shm', '/run', tmpdir()]),
];

let status: DurableStorageStatus = {
  verified: false,
  reason: 'probe_pending',
  checked: [],
};

/** The boot probe's verdict. `probe_pending` until `verifyDurableStorage` runs. */
export function durableStorageStatus(): DurableStorageStatus {
  return status;
}

/** True only after a successful probe (or an Archil/local-process verdict). */
export function isDurableStorageVerified(): boolean {
  return status.verified;
}

/** Test hook: forget the verdict so a probe can run again under new env. */
export function resetDurableStorageStatus(): void {
  status = { verified: false, reason: 'probe_pending', checked: [] };
}

/** True when `dir` is (or is under) a known ephemeral root. */
export function isEphemeralDirectory(dir: string): boolean {
  const resolved = resolve(dir);
  return EPHEMERAL_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`));
}

/**
 * Verifies that the configured record log directories can hold records beyond
 * this process.
 *
 * Synchronous on purpose: it runs in the startup preflight, before the server
 * accepts a request, and a record write must never race the verdict.
 *
 * @param input.serverless     Whether the platform recycles the filesystem.
 * @param input.archilConfigured Whether Archil storage is configured.
 * @param input.logPaths       Record log paths (lead, DSR, audit, access).
 */
export function verifyDurableStorage(input: {
  serverless: boolean;
  archilConfigured: boolean;
  logPaths: readonly string[];
}): DurableStorageStatus {
  const checked: string[] = [];

  // A process that owns its filesystem does not need the probe: there is no
  // cold-start boundary for the disk to fall off.
  if (!input.serverless) {
    status = { verified: true, reason: 'local_process', checked };
    return status;
  }

  if (input.archilConfigured) {
    status = { verified: true, reason: 'archil', checked };
    return status;
  }

  const directories = [
    ...new Set(
      input.logPaths
        .filter((logPath) => logPath.trim().length > 0)
        .map((logPath) => dirname(resolve(logPath))),
    ),
  ];
  checked.push(...directories);

  if (directories.length === 0) {
    status = { verified: false, reason: 'probe_failed', checked };
    return status;
  }

  // A relative path resolves inside the deployment bundle on a serverless
  // host (the read-only bundle directory or the invocation scratchpad). It is
  // never a mounted durable volume, so it is refused even though the same
  // relative path on a developer's laptop would happily accept a write.
  const relativePath = input.logPaths.some(
    (logPath) => logPath.trim().length > 0 && !logPath.trim().startsWith('/'),
  );
  if (relativePath) {
    status = { verified: false, reason: 'ephemeral_path', checked };
    return status;
  }

  // The legacy flag is deliberately not consulted. A path under /tmp fails
  // here no matter what the environment says, which is the SEC-11 fix.
  for (const dir of directories) {
    if (isEphemeralDirectory(dir)) {
      status = { verified: false, reason: 'ephemeral_path', checked };
      return status;
    }
  }

  for (const dir of directories) {
    const probePath = resolve(dir, `.lifechat-storage-probe-${randomUUID()}`);
    const payload = `lifechat-storage-probe:${randomUUID()}`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(probePath, payload, { encoding: 'utf8', mode: 0o600 });
      if (readFileSync(probePath, 'utf8') !== payload) {
        throw new Error('probe content did not round-trip');
      }
    } catch {
      // Leave nothing behind even on a partial probe.
      try {
        unlinkSync(probePath);
      } catch {
        // Nothing was written, or the filesystem refuses deletes too.
      }
      status = { verified: false, reason: 'probe_failed', checked };
      return status;
    }
    try {
      unlinkSync(probePath);
    } catch {
      // A leftover zero-PII probe file is harmless; durability is proven.
    }
  }

  status = { verified: true, reason: 'probe_passed', checked };
  return status;
}
