/**
 * Non-blocking JSONL log I/O.
 *
 * The record stores used to call appendFileSync/readFileSync, which blocks the
 * event loop for the whole duration of the syscall — a slow or contended disk
 * stalls every chat turn in the process. These helpers use the stream APIs
 * instead: writes go through a WriteStream and resolve when the data has been
 * flushed, reads stream the file line by line so a large log is never copied
 * into one string.
 *
 * Fail-closed semantics are preserved: appendJsonlLine resolves false when the
 * directory cannot be created or the write fails, and the caller only
 * acknowledges a record once the promise resolves true.
 */

import { constants, createReadStream } from 'fs';
import { access, mkdir, open, rename, unlink } from 'fs/promises';
import { dirname } from 'path';
import {
  appendArchilJsonlLine,
  isArchilStorageConfigured,
  readArchilJsonlLines,
  removeArchilLogObject,
  writeArchilJsonlLines,
} from '../archil/disk';

/**
 * Appends one line to a JSONL file (or Archil disk object when configured).
 *
 * Resolves true once the line has been flushed and the file descriptor closed;
 * resolves false on any I/O failure (missing permissions, full disk, invalid
 * path). Never rejects — callers use the boolean to fail closed.
 */
/**
 * Errnos a directory sync can legitimately answer on a platform or filesystem
 * that does not support it. Those are treated as done: there is no stronger
 * primitive to fall back to, and refusing every write on such a host would
 * break the store rather than make it safer. Every other error is a failure.
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  'EPERM',
  'EISDIR',
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EBADF',
  'EACCES',
]);

function errnoCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? '';
}

/**
 * Flushes a directory entry to disk (M-05).
 *
 * `fsync` on a file persists its contents and inode, but a newly created file or
 * a `rename` also changes the parent directory; without flushing that, a power
 * loss can leave the content on disk with no name pointing at it — or, after a
 * rewrite, bring the previous version back. Resolves true when the directory is
 * synced or the host cannot sync one at all.
 */
export async function syncDirectory(directory: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(directory, 'r');
  } catch (error) {
    return DIRECTORY_SYNC_UNSUPPORTED.has(errnoCode(error));
  }
  try {
    await handle.sync();
    return true;
  } catch (error) {
    return DIRECTORY_SYNC_UNSUPPORTED.has(errnoCode(error));
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Appends one line to a JSONL file (or Archil disk object when configured).
 *
 * Resolves true once the line is on disk — written, fsynced, and (when the file
 * did not exist yet) with its new directory entry flushed — and false on any
 * failure. Never rejects; callers use the boolean to fail closed.
 *
 * The fsync is what makes an acknowledgement a promise (M-05): the old write
 * resolved once the bytes reached the OS, so a power loss could lose a consent
 * the visitor had just been told was recorded. Note what this does and does not
 * buy: a process crash loses nothing, and a sudden power loss loses at most the
 * append that had not returned yet — provided the device honours the flush. On
 * macOS `fsync` does not request `F_FULLFSYNC`, so a hardware write cache can
 * still drop the last write; the runbook records that as the RPO.
 */
export async function appendJsonlLine(filePath: string, line: string): Promise<boolean> {
  if (isArchilStorageConfigured()) {
    return appendArchilJsonlLine(filePath, line);
  }
  const directory = dirname(filePath);
  try {
    if (directory && directory !== '.') {
      await mkdir(directory, { recursive: true });
    }
  } catch {
    return false;
  }

  // Whether the append also creates the file decides whether the parent
  // directory needs flushing; an existing file's entry is already durable.
  let existed = true;
  try {
    await access(filePath, constants.F_OK);
  } catch {
    existed = false;
  }

  let handle;
  try {
    handle = await open(filePath, 'a');
  } catch {
    return false;
  }

  let written = false;
  try {
    await handle.appendFile(`${line}\n`, 'utf8');
    await handle.sync();
    written = true;
  } catch {
    written = false;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!written) return false;

  return existed || syncDirectory(directory);
}

/**
 * Reads a JSONL file as an array of non-empty lines.
 *
 * Streams the file rather than reading it whole. Returns an empty array when
 * the file is missing or unreadable — the loaders treat that as "no records
 * yet", which is the same behaviour the synchronous loaders had.
 */
export function readJsonlLines(filePath: string): Promise<string[]> {
  if (isArchilStorageConfigured()) {
    return readArchilJsonlLines(filePath);
  }
  return new Promise<string[]>((resolve) => {
    const lines: string[] = [];
    let buffered = '';
    let settled = false;

    const settle = (value: string[]): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });

    stream.on('data', (chunk: string | Buffer) => {
      buffered += String(chunk);
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim().length > 0) lines.push(line);
        newline = buffered.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (buffered.trim().length > 0) lines.push(buffered);
      settle(lines);
    });
    stream.on('error', () => settle([]));
  });
}

/**
 * Streams a JSONL file line by line without collecting it.
 *
 * Boot hydration and whole-log rebuilds only need to visit each line once;
 * `readJsonlLines` would hold every line in memory first, which doubles the
 * peak footprint of a large log for no benefit. Resolves true when the whole
 * file was read and false when a read error cut it short, so a caller that
 * publishes derived data (an index, an export) can refuse a truncated result
 * instead of presenting it as complete. `onLine` must handle its own parsing
 * failures — a throw propagates out of the stream handler.
 */
export function forEachJsonlLine(
  filePath: string,
  onLine: (line: string) => void,
): Promise<boolean> {
  if (isArchilStorageConfigured()) {
    return readArchilJsonlLines(filePath).then((lines) => {
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) onLine(trimmed);
      }
      return true;
    });
  }

  return new Promise<boolean>((resolve) => {
    let buffered = '';
    let settled = false;

    const settle = (complete: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(complete);
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length > 0) onLine(trimmed);
    };

    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });

    stream.on('data', (chunk: string | Buffer) => {
      buffered += String(chunk);
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        handleLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (buffered.trim().length > 0) handleLine(buffered);
      settle(true);
    });
    // A missing file is the same "no records yet" case the array loader treats
    // as an empty list; any other error is a short read.
    stream.on('error', (error) => settle((error as NodeJS.ErrnoException).code === 'ENOENT'));
  });
}

/**
 * Replaces a JSONL file's contents in one write.
 *
 * Used for derived indexes and for erasure/retention rewrites, which replace a
 * log rather than append to it. Local writes go to a sibling temp file, are
 * fsynced, and are renamed over the target — then the directory is fsynced — so
 * a crash mid-write cannot leave a half-written log, and a crash after the
 * rename cannot resurrect the erased version. A rename that cannot replace the
 * target (Windows) falls back to unlink-then-rename. Resolves false on any I/O
 * failure, leaving the previous file in place.
 */
export async function replaceJsonlLines(
  filePath: string,
  lines: readonly string[],
): Promise<boolean> {
  if (isArchilStorageConfigured()) {
    return writeArchilJsonlLines(filePath, lines);
  }

  const directory = dirname(filePath);
  try {
    if (directory && directory !== '.') {
      await mkdir(directory, { recursive: true });
    }
  } catch {
    return false;
  }

  const payload = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  const temporary = `${filePath}.rewriting`;
  try {
    // Open, write, fsync, close: the payload must be on the device before the
    // rename makes it the live file, or a crash can leave an empty log where
    // an erased one used to be.
    const handle = await open(temporary, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      await rename(temporary, filePath);
    } catch (error) {
      // Windows cannot always rename over an existing file.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      await unlink(filePath).catch(() => undefined);
      await rename(temporary, filePath);
    }
  } catch {
    await unlink(temporary).catch(() => undefined);
    return false;
  }

  // The rename itself is a directory change. Failing here does not undo a
  // rewrite that already happened, so it is reported, not treated as a failed
  // write (a caller that heard "unchanged" would stop looking for the risk).
  if (!(await syncDirectory(directory))) {
    console.warn(`WARN: ${filePath} was rewritten but its directory could not be synced`);
  }
  return true;
}

/**
 * Streams a JSONL file and returns the first value for which `parse` returns
 * something other than null/undefined.
 *
 * This is the cache-miss path for the record stores: unlike readJsonlLines it
 * never collects the file, and it stops reading as soon as a match is found,
 * so looking up one evicted record costs at most one pass over the log. A
 * line that throws while being parsed (malformed JSON, undecryptable envelope)
 * is skipped exactly as the bulk loaders skip it. Resolves undefined when the
 * file is missing, unreadable, or holds no match.
 */
export async function findJsonlRecord<T>(
  filePath: string,
  parse: (line: string) => T | null | undefined,
): Promise<T | undefined> {
  if (isArchilStorageConfigured()) {
    const lines = await readArchilJsonlLines(filePath);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const found = parse(trimmed);
        if (found !== null && found !== undefined) return found;
      } catch {
        continue;
      }
    }
    return undefined;
  }
  return new Promise<T | undefined>((resolve) => {
    let buffered = '';
    let settled = false;

    const settle = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(value);
    };

    /** Feeds one complete line to the parser; true when it matched. */
    const handleLine = (line: string): boolean => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      let found: T | null | undefined;
      try {
        found = parse(trimmed);
      } catch {
        return false;
      }
      if (found === null || found === undefined) return false;
      settle(found);
      return true;
    };

    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });

    stream.on('data', (chunk: string | Buffer) => {
      if (settled) return;
      buffered += String(chunk);
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (handleLine(line)) return;
        newline = buffered.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (!settled && buffered.trim().length > 0) handleLine(buffered);
      settle(undefined);
    });
    stream.on('error', () => settle(undefined));
  });
}

/**
 * Streams a JSONL file and returns the LAST value for which `parse` returns
 * something other than null/undefined.
 *
 * Append-only logs express an update as a later line for the same id (the
 * bulk loaders are last-wins). A cache-miss lookup must use the same rule, or
 * a record that was verified after it was created would read back as its
 * original, unverified version. Memory stays bounded: only the latest match
 * is retained, never the file.
 */
export async function findLastJsonlRecord<T>(
  filePath: string,
  parse: (line: string) => T | null | undefined,
): Promise<T | undefined> {
  if (isArchilStorageConfigured()) {
    const lines = await readArchilJsonlLines(filePath);
    let latest: T | undefined;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const found = parse(trimmed);
        if (found !== null && found !== undefined) latest = found;
      } catch {
        continue;
      }
    }
    return latest;
  }

  return new Promise<T | undefined>((resolve) => {
    let buffered = '';
    let latest: T | undefined;
    let settled = false;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve(latest);
    };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const found = parse(trimmed);
        if (found !== null && found !== undefined) latest = found;
      } catch {
        // skip malformed lines exactly as the bulk loaders do
      }
    };

    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });

    stream.on('data', (chunk: string | Buffer) => {
      if (settled) return;
      buffered += String(chunk);
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        handleLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    stream.on('end', () => {
      if (buffered.trim().length > 0) handleLine(buffered);
      settle();
    });
    stream.on('error', settle);
  });
}

/** Removes a log file if it exists; missing files are not an error. */
export async function removeLogFile(filePath: string): Promise<void> {
  if (isArchilStorageConfigured()) {
    await removeArchilLogObject(filePath);
  }
  try {
    await unlink(filePath);
  } catch {
    // Best-effort cleanup — a missing or locked file must not throw.
  }
}
