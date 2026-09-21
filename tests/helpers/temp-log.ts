/**
 * Temp log paths for tests.
 *
 * Record logs are append-only JSONL files, and the suites that exercise them
 * need real paths. Pointing those paths at `data/` left a file behind for every
 * run (roughly ninety of them accumulated in the repo) — the directory is
 * gitignored, but a sandbox checkout that runs the suite still ends up with a
 * growing pile of test records next to the real ones, and a test record is
 * indistinguishable from a live one at a glance.
 *
 * Every test record log now goes to a temp directory outside the project.
 * `cleanupTempLogs` is best-effort (the OS temp dir is self-cleaning, and a
 * failure to unlink must never fail a test).
 */

import { existsSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';

/** A unique temp path for a test record log. */
export function tempLogPath(label: string): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), 'lifechat-test-logs', `${label}-${unique}.jsonl`);
}

/** Best-effort removal of temp log files created by a suite. */
export function cleanupTempLogs(...paths: readonly (string | undefined)[]): void {
  for (const logPath of paths) {
    if (!logPath) continue;
    try {
      if (existsSync(logPath)) unlinkSync(logPath);
    } catch {
      // Best effort only — a leftover file under the OS temp dir is harmless.
    }
  }
}
