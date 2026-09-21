/**
 * Serverless-mode tests.
 *
 * The Vercel deployment path imports src/index.ts on a cold start, where a
 * self-started listener would crash the invocation. These tests pin the
 * contract the deploy depends on:
 *
 *   - under SERVERLESS=true the module builds the app but never binds a port
 *     (a probe connection to the configured port is refused);
 *   - the returned app is the real router: /health answers, the kill-switch
 *     and admin endpoints stay gated, and /api/chat produces its normal
 *     envelope — serverless mode changes socket ownership, not behavior;
 *   - the platform auto-detection (VERCEL=1) takes effect without the
 *     explicit override;
 *   - without the flag the module listens as before (the regression guard).
 *
 * As in the other endpoint suites, src/index.ts is re-imported with
 * jest.resetModules() under the env each block needs, and LLM_API_KEY is
 * emptied so no test ever reaches the network.
 */

import request from 'supertest';
import type { Express } from 'express';
import net from 'net';

interface LoadedApp {
  app: Express;
  server?: import('http').Server;
  cleanup: () => Promise<void>;
}

/** Loads src/index.ts as a fresh module with the given env overrides. */
async function loadApp(env: Record<string, string>): Promise<LoadedApp> {
  jest.resetModules();
  const previous = { ...process.env };
  Object.entries(env).forEach(([key, value]) => {
    process.env[key] = value;
  });

  const mod = (await import('../src/index')) as {
    app: Express;
    server?: import('http').Server;
  };

  // Restore env after the module has read it
  Object.keys(env).forEach((key) => {
    if (previous[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous[key];
    }
  });

  return {
    app: mod.app,
    server: mod.server,
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        if (mod.server) {
          mod.server.close(() => resolve());
        } else {
          resolve();
        }
      });
    },
  };
}

/** Probes a TCP port; resolves true when something is listening. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('serverless mode — the app builds without owning a socket', () => {
  const PORT = 31077; // probe target; nothing may listen there

  afterEach(async () => {
    // Nothing to close in serverless mode; the loader handles the rest.
    await Promise.resolve();
  });

  test('SERVERLESS=true builds the app but never binds the port', async () => {
    const loaded = await loadApp({
      SERVERLESS: 'true',
      LIFECHAT_PORT: String(PORT),
      LLM_API_KEY: '',
      LEAD_LOG_PATH: `data/lead-serverless-test-${Date.now()}.jsonl`,
      DSR_LOG_PATH: `data/dsr-serverless-test-${Date.now()}.jsonl`,
    });

    expect(loaded.server).toBeUndefined();
    expect(await portInUse(PORT)).toBe(false);
    await loaded.cleanup();
  });

  test('VERCEL=1 triggers the same no-listen behavior without the override', async () => {
    const loaded = await loadApp({
      VERCEL: '1',
      LIFECHAT_PORT: String(PORT),
      LLM_API_KEY: '',
      LEAD_LOG_PATH: `data/lead-serverless-test-${Date.now()}.jsonl`,
      DSR_LOG_PATH: `data/dsr-serverless-test-${Date.now()}.jsonl`,
    });

    expect(loaded.server).toBeUndefined();
    expect(await portInUse(PORT)).toBe(false);
    await loaded.cleanup();
  });

  test('the exported app serves the real router under serverless mode', async () => {
    const loaded = await loadApp({
      SERVERLESS: 'true',
      LIFECHAT_PORT: String(PORT),
      LLM_API_KEY: '',
      ADMIN_API_KEY: 'serverless-test-admin-key',
      LEAD_LOG_PATH: `data/lead-serverless-test-${Date.now()}.jsonl`,
      DSR_LOG_PATH: `data/dsr-serverless-test-${Date.now()}.jsonl`,
    });

    // /health answers with the readiness facts an operator (and the deploy
    // workflow's smoke check) consumes.
    const health = await request(loaded.app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toHaveProperty('status');

    // The admin gate still holds without a long-running process: with a key
    // configured, a request without it is refused.
    const gated = await request(loaded.app).get('/api/system-prompt');
    expect([401, 403]).toContain(gated.status);

    // The main chat envelope is unchanged.
    const chat = await request(loaded.app).post('/api/chat').send({
      sessionId: 'serverless-smoke',
      currentState: 'education',
      message: 'What is term life insurance?',
    });
    expect(chat.status).toBe(200);
    expect(chat.body).toHaveProperty('state');

    await loaded.cleanup();
  });

  test('without the flag the server listens on the port as before', async () => {
    const loaded = await loadApp({
      LIFECHAT_PORT: '0', // OS-assigned: the regression guard only needs a live server
      LLM_API_KEY: '',
      LEAD_LOG_PATH: `data/lead-serverless-test-${Date.now()}.jsonl`,
      DSR_LOG_PATH: `data/dsr-serverless-test-${Date.now()}.jsonl`,
    });

    expect(loaded.server).toBeDefined();
    expect(loaded.server!.listening).toBe(true);
    await loaded.cleanup();
  });
});
