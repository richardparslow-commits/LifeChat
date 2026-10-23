/**
 * SEC-15 — record-encryption key rotation and plaintext refusal.
 *
 * The envelope now carries a key id derived from the secret; the reader accepts
 * a ring of previous secrets; production refuses lines that are not an
 * authenticated envelope. These tests rotate a key across real module loads,
 * read a pre-`kid` (v1) envelope, and exercise the migration CLI's rewrite.
 */

import { createCipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

type EncryptionModule = typeof import('../src/privacy/record-encryption');
type RekeyModule = typeof import('../src/privacy/record-rekey');

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

/** Applies env, then loads a fresh module registry so `config` re-reads it. */
async function loadEncryption(env: Record<string, string | undefined>): Promise<EncryptionModule> {
  jest.resetModules();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return import('../src/privacy/record-encryption');
}

async function loadRekey(env: Record<string, string | undefined>): Promise<RekeyModule> {
  await loadEncryption(env);
  return import('../src/privacy/record-rekey');
}

/** A pre-`kid` envelope, exactly as the old writer produced it. */
function v1Envelope(secret: string, payload: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function tempLog(label: string): string {
  const dir = path.join(os.tmpdir(), 'lifechat-rekey-test', randomUUID());
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${label}.jsonl`);
}

afterEach(() => {
  delete process.env.RECORD_ENCRYPTION_KEY;
  delete process.env.RECORD_ENCRYPTION_KEYS;
  delete process.env.PILOT_MODE;
  jest.resetModules();
});

describe('key ids and envelope version', () => {
  it('writes a v2 envelope whose kid is derived from the secret', async () => {
    const mod = await loadEncryption({ RECORD_ENCRYPTION_KEY: KEY_A });

    const line = mod.encryptRecordLine('{"a":1}');
    const envelope = JSON.parse(line) as { v: number; kid: string };

    expect(envelope.v).toBe(2);
    expect(envelope.kid).toBe(mod.recordKeyId(KEY_A));
    expect(mod.isEncryptedRecordLine(line)).toBe(true);
    expect(mod.decryptRecordLine(line)).toBe('{"a":1}');
  });
});

describe('rotation', () => {
  it('reads a line written by the previous key while the old key is in the ring', async () => {
    const before = await loadEncryption({ RECORD_ENCRYPTION_KEY: KEY_A });
    const line = before.encryptRecordLine('{"lead":"old"}');
    const oldKid = before.recordKeyId(KEY_A);

    const after = await loadEncryption({
      RECORD_ENCRYPTION_KEY: KEY_B,
      RECORD_ENCRYPTION_KEYS: KEY_A,
    });

    expect(after.recordKeyId(KEY_B)).not.toBe(oldKid);
    expect(after.decryptRecordLine(line)).toBe('{"lead":"old"}');
  });

  it('reads a pre-kid v1 line by trying the ring', async () => {
    const legacy = v1Envelope(KEY_A, '{"lead":"v1"}');

    const rotated = await loadEncryption({
      RECORD_ENCRYPTION_KEY: KEY_B,
      RECORD_ENCRYPTION_KEYS: KEY_A,
    });

    expect(rotated.decryptRecordLine(legacy)).toBe('{"lead":"v1"}');
  });

  it('cannot read a line whose key is not in the ring', async () => {
    const before = await loadEncryption({ RECORD_ENCRYPTION_KEY: KEY_A });
    const line = before.encryptRecordLine('{"lead":"lost"}');

    const after = await loadEncryption({ RECORD_ENCRYPTION_KEY: KEY_B });

    expect(after.decryptRecordLine(line)).toBeNull();
  });

  it('rejects a tampered envelope', async () => {
    const mod = await loadEncryption({ RECORD_ENCRYPTION_KEY: KEY_A });
    const envelope = JSON.parse(mod.encryptRecordLine('{"a":1}')) as Record<string, string>;
    const bytes = Buffer.from(envelope.data, 'base64');
    bytes[0] ^= 0xff;
    envelope.data = bytes.toString('base64');

    expect(mod.decryptRecordLine(JSON.stringify(envelope))).toBeNull();
  });
});

describe('legacy plaintext records', () => {
  it('are readable in pilot mode', async () => {
    const mod = await loadEncryption({ PILOT_MODE: 'true' });

    expect(mod.isLegacyPlaintextRecordAllowed()).toBe(true);
    expect(mod.decryptRecordLine('{"lead":"plain"}')).toBe('{"lead":"plain"}');
  });

  it('are refused in production', async () => {
    const mod = await loadEncryption({ PILOT_MODE: 'false' });

    expect(mod.isLegacyPlaintextRecordAllowed()).toBe(false);
    expect(mod.decryptRecordLine('{"lead":"plain"}')).toBeNull();
    // An injected line cannot masquerade as a record, and the writer refuses
    // to create one.
    expect(() => mod.encryptRecordLine('{"a":1}')).toThrow(/RECORD_ENCRYPTION_KEY is required/);
  });
});

describe('record rekey migration', () => {
  async function seed(file: string): Promise<void> {
    const before = await loadEncryption({ RECORD_ENCRYPTION_KEY: KEY_A });
    const lines = [
      before.encryptRecordLine('{"lead":"v2-old"}'),
      v1Envelope(KEY_A, '{"lead":"v1-old"}'),
      '{"lead":"plain"}',
    ];
    writeFileSync(file, `${lines.join('\n')}\n`);
  }

  it('rewrites old and plaintext lines under the current key', async () => {
    const file = tempLog('leads');
    await seed(file);

    const rekey = await loadRekey({
      RECORD_ENCRYPTION_KEY: KEY_B,
      RECORD_ENCRYPTION_KEYS: KEY_A,
    });
    const result = await rekey.rekeyRecordLog(file);

    expect(result).toMatchObject({
      total: 3,
      unchanged: 0,
      rekeyed: 2,
      encrypted: 1,
      undecodable: 0,
      written: true,
    });

    // The old secret is gone from the configuration: only the new key reads it.
    const after = await loadEncryption({ RECORD_ENCRYPTION_KEY: KEY_B });
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(after.decryptRecordLine(line) ?? 'null'))).toEqual([
      { lead: 'v2-old' },
      { lead: 'v1-old' },
      { lead: 'plain' },
    ]);
    expect(lines.every((line) => after.isEncryptedRecordLine(line))).toBe(true);
  });

  it('is idempotent under the current key', async () => {
    const file = tempLog('idempotent');
    await seed(file);
    const rekey = await loadRekey({
      RECORD_ENCRYPTION_KEY: KEY_B,
      RECORD_ENCRYPTION_KEYS: KEY_A,
    });
    await rekey.rekeyRecordLog(file);

    const second = await rekey.rekeyRecordLog(file);
    expect(second).toMatchObject({ unchanged: 3, rekeyed: 0, encrypted: 0, written: true });
  });

  it('leaves the file untouched when any line cannot be decoded', async () => {
    const file = tempLog('corrupt');
    await seed(file);
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, `${original}{"truncated":\n`);

    const rekey = await loadRekey({
      RECORD_ENCRYPTION_KEY: KEY_B,
      RECORD_ENCRYPTION_KEYS: KEY_A,
    });
    const result = await rekey.rekeyRecordLog(file);

    expect(result).toMatchObject({ undecodable: 1, written: false });
    expect(readFileSync(file, 'utf8')).toBe(`${original}{"truncated":\n`);
  });

  it('supports a dry run that changes nothing', async () => {
    const file = tempLog('dry-run');
    await seed(file);
    const original = readFileSync(file, 'utf8');

    const rekey = await loadRekey({
      RECORD_ENCRYPTION_KEY: KEY_B,
      RECORD_ENCRYPTION_KEYS: KEY_A,
    });
    const result = await rekey.rekeyRecordLog(file, { dryRun: true });

    expect(result).toMatchObject({ rekeyed: 2, encrypted: 1, written: false });
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('refuses to run without a strong primary key', async () => {
    const rekey = await loadRekey({ RECORD_ENCRYPTION_KEY: 'too-short' });

    await expect(rekey.rekeyAllRecordLogs({ dryRun: true })).rejects.toThrow(
      /at least 32 characters/,
    );
  });
});
