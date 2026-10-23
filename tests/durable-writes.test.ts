/**
 * Durable record writes (M-05).
 *
 * An acknowledged write is a promise: the consent a visitor was told was
 * recorded, the erasure that removed their data. Those guarantees are syscalls,
 * not file contents, so this suite wraps `fs/promises.open` and records every
 * handle that was `fsync`ed.
 *
 * What is asserted:
 *
 *   - an append fsyncs the file before resolving true, and fsyncs the directory
 *     when the append created the file (a new name is a directory change);
 *   - a rewrite fsyncs the temp file before the rename and the directory after
 *     it, so a crash cannot leave an empty log where an erased one was;
 *   - the platform's refusal to sync a directory is tolerated, while a real
 *     error is not.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises') as typeof import('fs/promises');
  const mockSyncedPaths: string[] = [];

  const recordingOpen = async (target: unknown, ...rest: unknown[]): Promise<any> => {
    const handle = await (actual.open as (...args: unknown[]) => Promise<any>)(target, ...rest);
    const realSync = handle.sync.bind(handle);
    handle.sync = async () => {
      mockSyncedPaths.push(String(target));
      return realSync();
    };
    return handle;
  };

  // The failure tests swap the implementation; a module export cannot be
  // reassigned through the mock registry, so the switch lives in here.
  let currentOpen: (target: unknown, ...rest: unknown[]) => Promise<any> = recordingOpen;
  const open = (target: unknown, ...rest: unknown[]): Promise<any> => currentOpen(target, ...rest);
  const mockSetOpen = (next: typeof recordingOpen | null): void => {
    currentOpen = next ?? recordingOpen;
  };

  return { ...actual, open, __syncedPaths: mockSyncedPaths, __setOpen: mockSetOpen };
});

import * as fsPromises from 'fs/promises';

import { appendJsonlLine, replaceJsonlLines } from '../src/persistence/jsonl-log';

const mockedFs = fsPromises as unknown as {
  __syncedPaths: string[];
  __setOpen: (next: ((target: unknown, ...rest: unknown[]) => Promise<any>) | null) => void;
};
const synced = mockedFs.__syncedPaths;
const setOpen = mockedFs.__setOpen;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lifechat-durable-'));
  synced.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('durable append', () => {
  it('fsyncs the file and the new directory entry before reporting success', async () => {
    const file = join(dir, 'nested', 'log.jsonl');

    await expect(appendJsonlLine(file, '{"n":1}')).resolves.toBe(true);

    expect(synced).toContain(file);
    // The append created the file, so its name is new to the directory too.
    expect(synced).toContain(join(dir, 'nested'));
  });

  it('fsyncs the file but not the directory when the file already exists', async () => {
    const file = join(dir, 'existing.jsonl');
    writeFileSync(file, '');
    synced.length = 0;

    await expect(appendJsonlLine(file, '{"n":2}')).resolves.toBe(true);

    expect(synced).toEqual([file]);
  });
});

describe('durable rewrite', () => {
  it('fsyncs the temp file before the rename and the directory after it', async () => {
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, '{"old":1}\n');

    await expect(replaceJsonlLines(file, ['{"new":1}'])).resolves.toBe(true);

    expect(synced).toContain(`${file}.rewriting`);
    expect(synced).toContain(dir);
    expect(synced.indexOf(`${file}.rewriting`)).toBeLessThan(synced.indexOf(dir));
    expect(readFileSync(file, 'utf8')).toBe('{"new":1}\n');
  });

  it('still replaces the log when the platform cannot sync a directory', async () => {
    // Windows refuses to open a directory this way. That is not a failed
    // write — there is no stronger primitive to ask for — so the rewrite must
    // still report success rather than telling the operator nothing changed.
    const file = join(dir, 'platform.jsonl');
    writeFileSync(file, '{"old":1}\n');
    const actual = jest.requireActual('fs/promises') as typeof import('fs/promises');
    setOpen(async (target: unknown, ...rest: unknown[]) => {
      if (String(target) === dir) {
        const error = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return (actual.open as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    });

    try {
      await expect(replaceJsonlLines(file, ['{"new":1}'])).resolves.toBe(true);
    } finally {
      setOpen(null);
    }
    expect(readFileSync(file, 'utf8')).toBe('{"new":1}\n');
  });

  it('reports failure, leaving the previous log in place, when the temp write fails', async () => {
    const file = join(dir, 'stuck.jsonl');
    writeFileSync(file, '{"old":1}\n');
    const actual = jest.requireActual('fs/promises') as typeof import('fs/promises');
    setOpen(async (target: unknown, ...rest: unknown[]) => {
      if (String(target).endsWith('.rewriting')) {
        const error = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
        error.code = 'ENOSPC';
        throw error;
      }
      return (actual.open as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    });

    try {
      await expect(replaceJsonlLines(file, ['{"new":1}'])).resolves.toBe(false);
    } finally {
      setOpen(null);
    }
    expect(readFileSync(file, 'utf8')).toBe('{"old":1}\n');
  });
});
