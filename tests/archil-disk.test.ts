/**
 * Tests for the Archil disk storage boundary (`src/archil/disk.ts`) and its
 * integration with `src/persistence/jsonl-log.ts` and `src/config/app-config.ts`.
 */

import {
  ArchilConfigError,
  DEFAULT_ARCHIL_REGION,
  isArchilStorageConfigured,
  loadArchilConfig,
  toArchilObjectKey,
} from '../src/archil/disk';
import {
  config,
  isDurableStorageConfigured,
  isEphemeralServerlessPath,
} from '../src/config/app-config';

describe('Archil configuration and credential boundary', () => {
  test('rejects missing ARCHIL_API_KEY with an actionable message', () => {
    expect(() => loadArchilConfig({})).toThrow(ArchilConfigError);
    expect(() => loadArchilConfig({})).toThrow(/ARCHIL_API_KEY is not set/);
  });

  test('rejects a disk/mount token (adt_…) used in place of an API key (key-…)', () => {
    expect(() =>
      loadArchilConfig({
        // Synthetic mount token: the shape is what this test rejects.
        ARCHIL_API_KEY: 'adt_a07ecda8bf48c9d669c37901', // gitleaks:allow - synthetic test fixture
      }),
    ).toThrow(/expected a value starting with key-/);
  });

  test('rejects a malformed ARCHIL_DISK_ID', () => {
    expect(() =>
      loadArchilConfig({
        ARCHIL_API_KEY: 'key-test-valid-format',
        ARCHIL_DISK_ID: 'not-a-disk-id',
      }),
    ).toThrow(/ARCHIL_DISK_ID must be a disk id \(dsk-…\)/);
  });

  test('defaults region to aws-us-east-1 and parses valid config', () => {
    const parsed = loadArchilConfig({
      ARCHIL_API_KEY: '  key-test-valid-format  ',
      ARCHIL_DISK_ID: '  dsk-00000000000f241b  ',
    });
    expect(parsed).toEqual({
      apiKey: 'key-test-valid-format',
      region: DEFAULT_ARCHIL_REGION,
      diskId: 'dsk-00000000000f241b',
    });
  });

  test('LIFECHAT_ARCHIL_* overrides sandbox-injected ARCHIL_* and normalizes internal cell regions', () => {
    const parsed = loadArchilConfig({
      ARCHIL_API_KEY: 'key-sandbox-default',
      ARCHIL_REGION: 'prod.us-east-1.green',
      ARCHIL_DISK_ID: 'dsk-00000000000f288c',
      LIFECHAT_ARCHIL_DISK_ID: 'dsk-00000000000f241b',
    });
    expect(parsed).toEqual({
      apiKey: 'key-sandbox-default',
      region: 'aws-us-east-1',
      diskId: 'dsk-00000000000f241b',
    });
  });

  test('isArchilStorageConfigured requires both a key- API key and a dsk- disk id', () => {
    expect(isArchilStorageConfigured({})).toBe(false);
    expect(isArchilStorageConfigured({ ARCHIL_API_KEY: 'key-123' })).toBe(false);
    expect(
      isArchilStorageConfigured({
        ARCHIL_API_KEY: 'adt_123',
        ARCHIL_DISK_ID: 'dsk-00000000000f241b',
      }),
    ).toBe(false);
    expect(
      isArchilStorageConfigured({
        ARCHIL_API_KEY: 'key-123',
        ARCHIL_DISK_ID: 'dsk-00000000000f241b',
      }),
    ).toBe(true);
  });

  test('toArchilObjectKey normalizes relative and absolute paths under the prefix', () => {
    expect(toArchilObjectKey('data/lead-records.jsonl')).toBe('lifechat/data/lead-records.jsonl');
    expect(toArchilObjectKey('./data/dsr-records.jsonl')).toBe('lifechat/data/dsr-records.jsonl');
    expect(toArchilObjectKey('/var/lib/lifechat/dsr.jsonl')).toBe(
      'lifechat/var/lib/lifechat/dsr.jsonl',
    );
    expect(toArchilObjectKey('lifechat/data/abstention-log.jsonl')).toBe(
      'lifechat/data/abstention-log.jsonl',
    );
  });

  test('serverless durability needs evidence, not DURABLE_STORAGE_CONFIGURED', () => {
    const prevServerless = config.serverless;
    const prevKey = process.env.ARCHIL_API_KEY;
    const prevDisk = process.env.ARCHIL_DISK_ID;
    const prevDurable = process.env.DURABLE_STORAGE_CONFIGURED;
    try {
      config.serverless = true;
      process.env.ARCHIL_API_KEY = '';
      process.env.ARCHIL_DISK_ID = '';

      // SEC-11: the flag used to turn the fail-closed guard off on its own.
      // A record directory under `data/` in a serverless bundle is ephemeral
      // (or read-only) no matter what the environment asserts.
      process.env.DURABLE_STORAGE_CONFIGURED = 'true';
      expect(isDurableStorageConfigured()).toBe(false);
      expect(isEphemeralServerlessPath('data/lead-records.jsonl')).toBe(true);

      process.env.ARCHIL_API_KEY = 'key-test-valid-format';
      process.env.ARCHIL_DISK_ID = 'dsk-00000000000f241b';

      expect(isDurableStorageConfigured()).toBe(true);
      expect(isEphemeralServerlessPath('data/lead-records.jsonl')).toBe(false);
    } finally {
      config.serverless = prevServerless;
      if (prevKey === undefined) delete process.env.ARCHIL_API_KEY;
      else process.env.ARCHIL_API_KEY = prevKey;
      if (prevDisk === undefined) delete process.env.ARCHIL_DISK_ID;
      else process.env.ARCHIL_DISK_ID = prevDisk;
      if (prevDurable === undefined) delete process.env.DURABLE_STORAGE_CONFIGURED;
      else process.env.DURABLE_STORAGE_CONFIGURED = prevDurable;
    }
  });
});
