/**
 * Tests for the persistence primitives behind the record stores.
 *
 * Two properties matter and are asserted here rather than assumed:
 * - BoundedLruCache evicts the least-recently-used entry and refreshes on read,
 *   so a client-supplied key cannot grow a store without limit.
 * - The JSONL helpers are non-blocking streams that create directories, resolve
 *   false instead of throwing on an unwritable path (the stores depend on that
 *   boolean to fail closed), and read a missing file as "no records yet".
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { BoundedLruCache } from '../src/persistence/bounded-lru';
import {
  appendJsonlLine,
  findJsonlRecord,
  readJsonlLines,
  removeLogFile,
} from '../src/persistence/jsonl-log';

describe('BoundedLruCache', () => {
  it('evicts the least-recently-used entry once it is over capacity', () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('refreshes recency on read, so a hot entry survives insertion', () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.get('a')).toBe(1); // 'a' is now most recently used
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('updating an existing key does not evict anything', () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBe(2);
  });

  it('lists values oldest-first and deletes/clears explicitly', () => {
    const cache = new BoundedLruCache<string, string>(3);
    cache.set('a', 'first');
    cache.set('b', 'second');

    expect(cache.values()).toEqual(['first', 'second']);
    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('refuses a nonsense capacity instead of silently misbehaving', () => {
    expect(() => new BoundedLruCache<string, number>(0)).toThrow(RangeError);
    expect(() => new BoundedLruCache<string, number>(1.5)).toThrow(RangeError);
  });
});

describe('jsonl-log', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lifechat-jsonl-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends lines in order and creates missing parent directories', async () => {
    const file = join(dir, 'nested', 'deeper', 'log.jsonl');

    expect(await appendJsonlLine(file, '{"n":1}')).toBe(true);
    expect(await appendJsonlLine(file, '{"n":2}')).toBe(true);

    expect(readFileSync(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n');
    expect(await readJsonlLines(file)).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('resolves false rather than throwing when the path cannot be written', async () => {
    // /dev/null cannot be a parent directory — the same failure mode as a
    // read-only or full volume, and the stores rely on the boolean.
    await expect(appendJsonlLine('/dev/null/records.jsonl', '{}')).resolves.toBe(false);
  });

  it('resolves false when the log path itself is a directory', async () => {
    // The open, not the mkdir, is what fails here, and its error arrives on the
    // end() callback. A callback that ignored that argument reported success
    // for a write that never happened, so every store could acknowledge a
    // record the disk never held.
    const asDirectory = join(dir, 'log.jsonl');
    mkdirSync(asDirectory);

    await expect(appendJsonlLine(asDirectory, '{}')).resolves.toBe(false);
  });

  it('reads a missing file as no records, not an error', async () => {
    await expect(readJsonlLines(join(dir, 'missing.jsonl'))).resolves.toEqual([]);
  });

  it('skips blank lines and tolerates an unterminated final line', async () => {
    const file = join(dir, 'blank.jsonl');
    writeFileSync(file, 'one\n\ntwo\nthree');

    expect(await readJsonlLines(file)).toEqual(['one', 'two', 'three']);
  });

  it('finds the first matching record without collecting the file', async () => {
    const file = join(dir, 'find.jsonl');
    writeFileSync(file, '{"id":"a","n":1}\n{"id":"b","n":2}\n{"id":"a","n":3}\n');

    const found = await findJsonlRecord<{ id: string; n: number }>(file, (line) => {
      const parsed = JSON.parse(line) as { id?: string; n?: number };
      return parsed.id === 'a' ? (parsed as { id: string; n: number }) : null;
    });

    expect(found).toEqual({ id: 'a', n: 1 });
  });

  it('matches an unterminated final line and skips malformed lines', async () => {
    const file = join(dir, 'find-tail.jsonl');
    writeFileSync(file, 'not json\n{"id":"match"}');

    const found = await findJsonlRecord<{ id: string }>(file, (line) => {
      const parsed = JSON.parse(line) as { id?: string };
      return parsed.id === 'match' ? (parsed as { id: string }) : null;
    });

    expect(found).toEqual({ id: 'match' });
  });

  it('resolves undefined for a miss and for a missing file', async () => {
    const file = join(dir, 'find-miss.jsonl');
    writeFileSync(file, '{"id":"a"}\n');
    const parse = (line: string) => {
      const parsed = JSON.parse(line) as { id?: string };
      return parsed.id === 'zzz' ? parsed : null;
    };

    await expect(findJsonlRecord(file, parse)).resolves.toBeUndefined();
    await expect(findJsonlRecord(join(dir, 'missing.jsonl'), parse)).resolves.toBeUndefined();
  });

  it('removes a log file and tolerates a missing one', async () => {
    const file = join(dir, 'gone.jsonl');
    writeFileSync(file, 'x\n');

    await expect(removeLogFile(file)).resolves.toBeUndefined();
    await expect(readJsonlLines(file)).resolves.toEqual([]);
    await expect(removeLogFile(file)).resolves.toBeUndefined();
  });
});

describe('record encryption key entropy (SEC-10)', () => {
  const previousKey = process.env.RECORD_ENCRYPTION_KEY;

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.RECORD_ENCRYPTION_KEY;
    } else {
      process.env.RECORD_ENCRYPTION_KEY = previousKey;
    }
    jest.resetModules();
  });

  it('refuses to derive a key from a secret under 32 characters', async () => {
    process.env.RECORD_ENCRYPTION_KEY = 'a-short-passphrase';
    jest.resetModules();
    const mod = await import('../src/privacy/record-encryption');

    expect(mod.isRecordEncryptionConfigured()).toBe(true);
    expect(mod.isRecordEncryptionKeyStrong()).toBe(false);
    expect(() => mod.encryptRecordLine('{"a":1}')).toThrow(/at least 32/);
  });

  it('encrypts and decrypts with a 32-character secret', async () => {
    process.env.RECORD_ENCRYPTION_KEY = 'k'.repeat(32);
    jest.resetModules();
    const mod = await import('../src/privacy/record-encryption');

    const line = mod.encryptRecordLine('{"a":1}');
    expect(line).toContain('aes-256-gcm');
    expect(mod.decryptRecordLine(line)).toBe('{"a":1}');
  });
});
