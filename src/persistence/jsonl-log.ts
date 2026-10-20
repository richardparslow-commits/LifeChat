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

import { createReadStream, createWriteStream } from 'fs';
import { mkdir, unlink } from 'fs/promises';
import { dirname } from 'path';

/**
 * Appends one line to a JSONL file.
 *
 * Resolves true once the line has been flushed and the file descriptor closed;
 * resolves false on any I/O failure (missing permissions, full disk, invalid
 * path). Never rejects — callers use the boolean to fail closed.
 */
export async function appendJsonlLine(filePath: string, line: string): Promise<boolean> {
  const directory = dirname(filePath);
  try {
    if (directory && directory !== '.') {
      await mkdir(directory, { recursive: true });
    }
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    stream.on('error', () => {
      stream.destroy();
      settle(false);
    });
    // The end() callback fires after every byte has been flushed to the OS.
    stream.end(`${line}\n`, () => settle(true));
  });
}

/**
 * Reads a JSONL file as an array of non-empty lines.
 *
 * Streams the file rather than reading it whole. Returns an empty array when
 * the file is missing or unreadable — the loaders treat that as "no records
 * yet", which is the same behaviour the synchronous loaders had.
 */
export function readJsonlLines(filePath: string): Promise<string[]> {
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
export function findJsonlRecord<T>(
  filePath: string,
  parse: (line: string) => T | null | undefined,
): Promise<T | undefined> {
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

/** Removes a log file if it exists; missing files are not an error. */
export async function removeLogFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Best-effort cleanup — a missing or locked file must not throw.
  }
}
