/**
 * Key entropy (SEC-10): a configured secret below the minimum length is a
 * misconfiguration, not a weaker mode. These tests cover the predicate and the
 * boot gate that refuses to start with a short ADMIN_API_KEY.
 *
 * The admin key is the only credential in front of the system prompt, session
 * history, lead lookups, session deletion, and the kill switch. Constant-time
 * comparison (SEC-09) cannot compensate for a guessable secret, so the floor is
 * enforced at startup in every mode — pilot included — exactly as it is for
 * RECORD_ENCRYPTION_KEY.
 */

import { spawnSync } from 'child_process';
import path from 'path';

import { MIN_ADMIN_API_KEY_LENGTH } from '../src/config/app-config';

/** Loads a fresh config module with the given ADMIN_API_KEY in the environment. */
async function configWithAdminKey(value: string) {
  const previous = process.env.ADMIN_API_KEY;
  process.env.ADMIN_API_KEY = value;
  jest.resetModules();
  const mod = await import('../src/config/app-config');
  // Restore immediately: other suites import the same module in this worker.
  jest.resetModules();
  if (previous === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = previous;
  return mod;
}

describe('MIN_ADMIN_API_KEY_LENGTH', () => {
  it('is 32 characters', () => {
    expect(MIN_ADMIN_API_KEY_LENGTH).toBe(32);
  });
});

describe('isAdminApiKeyStrong', () => {
  it('accepts an unset key (pilot mode runs without admin auth)', async () => {
    const mod = await configWithAdminKey('');
    expect(mod.isAdminApiKeyConfigured()).toBe(false);
    expect(mod.isAdminApiKeyStrong()).toBe(false);
  });

  it('rejects a configured key below the floor', async () => {
    const mod = await configWithAdminKey('a'.repeat(MIN_ADMIN_API_KEY_LENGTH - 1));
    expect(mod.isAdminApiKeyConfigured()).toBe(true);
    expect(mod.isAdminApiKeyStrong()).toBe(false);
  });

  it('accepts a key exactly at the floor and above it', async () => {
    const atFloor = await configWithAdminKey('a'.repeat(MIN_ADMIN_API_KEY_LENGTH));
    expect(atFloor.isAdminApiKeyStrong()).toBe(true);

    const above = await configWithAdminKey('b'.repeat(64));
    expect(above.isAdminApiKeyStrong()).toBe(true);
  });

  it('ignores surrounding whitespace rather than counting it as entropy', async () => {
    const padded = await configWithAdminKey(`   ${'c'.repeat(10)}   `);
    expect(padded.isAdminApiKeyStrong()).toBe(false);
  });
});

describe('startup gate', () => {
  const projectRoot = path.join(__dirname, '..');

  /** Runs the real entry point with a given environment. */
  function boot(env: Record<string, string>) {
    return spawnSync(process.execPath, ['-r', 'ts-node/register', 'src/index.ts'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        // Keep the run off the network and away from the repo's record logs.
        SERVERLESS: 'true',
        // Boot behaviour is what is under test, not type-checking: skipping
        // ts-node's checker keeps two spawned boots from competing with the
        // rest of the suite for CPU.
        TS_NODE_TRANSPILE_ONLY: 'true',
        LIFECHAT_PORT: '0',
        LLM_API_KEY: '',
        ADMIN_API_KEY: '',
        RECORD_ENCRYPTION_KEY: 'test-record-encryption-key-0123456789abcdef',
        LEAD_LOG_PATH: `/tmp/lifechat-key-entropy-${Date.now()}.jsonl`,
        DSR_LOG_PATH: `/tmp/lifechat-key-entropy-dsr-${Date.now()}.jsonl`,
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  it('refuses to start with a short ADMIN_API_KEY', () => {
    const result = boot({ ADMIN_API_KEY: 'short-key' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`ADMIN_API_KEY must be at least ${MIN_ADMIN_API_KEY_LENGTH}`);
  }, 90_000);

  it('starts with a key at the floor', () => {
    const result = boot({ ADMIN_API_KEY: 'a'.repeat(MIN_ADMIN_API_KEY_LENGTH) });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('ADMIN_API_KEY must be at least');
  }, 90_000);
});
