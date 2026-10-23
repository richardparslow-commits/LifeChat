/**
 * Record-log key rotation (SEC-15).
 *
 * Rotating `RECORD_ENCRYPTION_KEY` used to make every prior record unreadable
 * because the envelope carried no key identity. The fix has two halves: the
 * reader now accepts a ring of legacy keys (see `record-encryption.ts`), and
 * this module rewrites the logs under the current key so the old secret can be
 * retired.
 *
 * Each line is decoded with whatever key in the ring authenticates it (or, for
 * a legacy log, read as plaintext) and re-encrypted with the primary key. The
 * rewrite is atomic and durable per file: a temporary file is written and
 * fsynced, renamed, and the directory fsynced, or the whole file is put to
 * Archil object storage. If any line cannot be decoded,
 * that file is left exactly as it was and the run fails — a partial rewrite
 * would silently drop legal records.
 *
 * Run with `npm run records:rekey` (`-- --dry-run` to inspect first).
 */

import { config } from '../config/app-config';
import {
  decryptRecordLine,
  encryptRecordLine,
  isEncryptedRecordLine,
  isLegacyPlaintextRecordLine,
  isRecordEncryptionConfigured,
  isRecordEncryptionKeyStrong,
  recordKeyId,
} from './record-encryption';
import { isArchilStorageConfigured, writeArchilJsonlLines } from '../archil/disk';
import { readJsonlLines, replaceJsonlLines } from '../persistence/jsonl-log';

/** Per-log outcome of a rotation run. */
export interface RekeyLogResult {
  path: string;
  total: number;
  /** Already encrypted under the current key; left byte-for-byte identical. */
  unchanged: number;
  /** Encrypted under a legacy key; decrypted and re-encrypted. */
  rekeyed: number;
  /** Legacy plaintext; encrypted under the current key. */
  encrypted: number;
  /** Lines that could not be authenticated or parsed; the file was not written. */
  undecodable: number;
  written: boolean;
}

export interface RekeyRunResult {
  dryRun: boolean;
  /** Id of the key that new records are written with (not the secret). */
  currentKeyId: string;
  logs: RekeyLogResult[];
}

/** The record logs that carry encrypted content. */
export function recordLogPaths(): string[] {
  return [...new Set([config.leadLogPath, config.dsrLogPath, config.erasureLogPath])];
}

/** Re-encrypts one JSONL record log under the current primary key. */
export async function rekeyRecordLog(
  filePath: string,
  options: { dryRun?: boolean } = {},
): Promise<RekeyLogResult> {
  const currentKid = recordKeyId(config.recordEncryptionKey.trim());
  const lines = await readJsonlLines(filePath);
  const result: RekeyLogResult = {
    path: filePath,
    total: lines.length,
    unchanged: 0,
    rekeyed: 0,
    encrypted: 0,
    undecodable: 0,
    written: false,
  };
  if (lines.length === 0) return result;

  const rewritten: string[] = [];
  for (const line of lines) {
    if (isEncryptedRecordLine(line)) {
      const plain = decryptRecordLine(line);
      if (plain === null) {
        result.undecodable += 1;
        rewritten.push(line);
        continue;
      }
      let kid: string | null = null;
      try {
        const parsed = JSON.parse(line) as { kid?: unknown };
        kid = typeof parsed.kid === 'string' ? parsed.kid : null;
      } catch {
        kid = null;
      }
      if (kid === currentKid) {
        result.unchanged += 1;
        rewritten.push(line);
      } else {
        result.rekeyed += 1;
        rewritten.push(encryptRecordLine(plain));
      }
      continue;
    }

    if (isLegacyPlaintextRecordLine(line)) {
      result.encrypted += 1;
      rewritten.push(encryptRecordLine(line));
      continue;
    }

    // Malformed JSON: not a record we can re-encrypt, and dropping it would
    // lose whatever it was. Fail this file instead.
    result.undecodable += 1;
    rewritten.push(line);
  }

  if (result.undecodable > 0) return result; // leave the file untouched
  if (options.dryRun === true) return result;

  if (isArchilStorageConfigured()) {
    result.written = await writeArchilJsonlLines(filePath, rewritten);
    return result;
  }

  // The shared durable rewrite: temp file written and fsynced, renamed over
  // the log, directory fsynced. A rotation that is only in the page cache can
  // lose the re-encrypted lines and bring the old-key ones back (M-05).
  result.written = await replaceJsonlLines(filePath, rewritten);
  return result;
}

/**
 * Rewrites every encrypted record log under the current key.
 *
 * Throws before reading anything when the primary key is missing or too weak:
 * a migration run must never leave logs encrypted under a key it cannot use.
 */
export async function rekeyAllRecordLogs(
  options: { dryRun?: boolean } = {},
): Promise<RekeyRunResult> {
  if (!isRecordEncryptionConfigured() || !isRecordEncryptionKeyStrong()) {
    throw new Error(
      'RECORD_ENCRYPTION_KEY must be set (at least 32 characters) before rotating record logs.',
    );
  }

  const logs: RekeyLogResult[] = [];
  for (const path of recordLogPaths()) {
    logs.push(await rekeyRecordLog(path, options));
  }

  return {
    dryRun: options.dryRun === true,
    currentKeyId: recordKeyId(config.recordEncryptionKey.trim()),
    logs,
  };
}

/** True when the run completed without leaving any line undecodable or unwritten. */
export function rekeyRunSucceeded(result: RekeyRunResult): boolean {
  return result.logs.every(
    (log) => log.undecodable === 0 && (result.dryRun || log.written || log.total === 0),
  );
}
