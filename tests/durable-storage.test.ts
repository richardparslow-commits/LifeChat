/**
 * Durable record storage (SEC-11).
 *
 * The finding: `DURABLE_STORAGE_CONFIGURED=true` switched the ephemeral-path
 * guard off on a serverless runtime, so consent and DSR writes could be
 * acknowledged into `/tmp` and then lost. These tests pin the replacement —
 * a boot probe that proves the record directory survives the process — and the
 * route-level consequence: the old flag no longer buys a 200.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import request from 'supertest';
import type { Express } from 'express';

import type * as DurableStorage from '../src/config/durable-storage';

const repoRoot = process.cwd();

/** A writable directory that is not under a known ephemeral root. */
function nonEphemeralDir(): string {
  const dir = path.join(repoRoot, `.tmp-durable-probe-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function storageModule(): Promise<typeof DurableStorage> {
  return import('../src/config/durable-storage');
}

describe('durable storage probe', () => {
  it('treats a long-running process as durable without touching the disk', async () => {
    const storage = await storageModule();
    storage.resetDurableStorageStatus();

    const missing = path.join(repoRoot, `.tmp-never-created-${randomUUID()}`, 'lead.jsonl');
    const status = storage.verifyDurableStorage({
      serverless: false,
      archilConfigured: false,
      logPaths: [missing],
    });

    expect(status).toMatchObject({ verified: true, reason: 'local_process' });
    expect(existsSync(path.dirname(missing))).toBe(false);
  });

  it('treats Archil as durable without a filesystem at all', async () => {
    const storage = await storageModule();
    storage.resetDurableStorageStatus();

    const status = storage.verifyDurableStorage({
      serverless: true,
      archilConfigured: true,
      logPaths: ['/tmp/never-touched/lead.jsonl'],
    });

    expect(status).toMatchObject({ verified: true, reason: 'archil' });
  });

  it('refuses a scratch path even when it is writable', async () => {
    const storage = await storageModule();
    storage.resetDurableStorageStatus();

    const dir = path.join('/tmp', `lifechat-sec11-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const status = storage.verifyDurableStorage({
        serverless: true,
        archilConfigured: false,
        logPaths: [path.join(dir, 'lead.jsonl'), path.join(dir, 'dsr.jsonl')],
      });

      expect(status).toMatchObject({ verified: false, reason: 'ephemeral_path' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies a real mount by writing, reading back, and cleaning up', async () => {
    const storage = await storageModule();
    storage.resetDurableStorageStatus();

    const dir = nonEphemeralDir();
    try {
      const status = storage.verifyDurableStorage({
        serverless: true,
        archilConfigured: false,
        logPaths: [path.join(dir, 'lead.jsonl')],
      });

      expect(status).toMatchObject({ verified: true, reason: 'probe_passed' });
      expect(status.checked).toEqual([dir]);
      // The probe leaves nothing behind.
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the record path cannot be created or written', async () => {
    const storage = await storageModule();
    storage.resetDurableStorageStatus();

    const dir = nonEphemeralDir();
    const blockedParent = path.join(dir, 'not-a-directory');
    writeFileSync(blockedParent, 'x');
    try {
      const status = storage.verifyDurableStorage({
        serverless: true,
        archilConfigured: false,
        logPaths: [path.join(blockedParent, 'lead.jsonl')],
      });

      expect(status).toMatchObject({ verified: false, reason: 'probe_failed' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DURABLE_STORAGE_CONFIGURED no longer unlocks serverless writes', () => {
  const scratch = path.join('/tmp', `lifechat-sec11-${randomUUID()}`);
  const leadLog = path.join(scratch, 'lead.jsonl');
  const dsrLog = path.join(scratch, 'dsr.jsonl');
  const ADMIN_KEY = 'durable-test-admin-key-0123456789abcdef';

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  async function loadServerlessApp(): Promise<Express> {
    const previous: Record<string, string | undefined> = {};
    const env: Record<string, string> = {
      SERVERLESS: 'true',
      DURABLE_STORAGE_CONFIGURED: 'true',
      PILOT_MODE: 'true',
      ADMIN_API_KEY: ADMIN_KEY,
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
    };
    for (const [key, value] of Object.entries(env)) {
      previous[key] = process.env[key];
      process.env[key] = value;
    }

    jest.resetModules();
    try {
      // Simulate the boot preflight in this registry, then build the app so it
      // consults the probe verdict.
      const storage = (await import('../src/config/durable-storage')) as typeof DurableStorage;
      storage.verifyDurableStorage({
        serverless: true,
        archilConfigured: false,
        logPaths: [leadLog, dsrLog],
      });
      const { createApp } = await import('../src/app');
      return createApp();
    } finally {
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }

  it('still refuses a DSR when the only claim of durability is the flag', async () => {
    const app = await loadServerlessApp();

    const res = await request(app).post('/api/dsr').send({
      requestType: 'access',
      contactEmail: 'subject@example.com',
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Storage unavailable');
    expect(existsSync(scratch)).toBe(false);
  });

  it('reports the probe verdict on the admin health route', async () => {
    const app = await loadServerlessApp();

    const res = await request(app).get('/api/admin/health').set('x-admin-key', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.recordStorage).toMatchObject({
      durable: false,
      verified: false,
      reason: 'ephemeral_path',
    });
  });
});
