/**
 * Guards the app/startup split introduced in src/app.ts + src/index.ts.
 *
 * The point of the split is that constructing the HTTP app has no process-level
 * side effects: no listener, no signal handlers, no startup gates, no exit. If
 * a future change moves any of that back into createApp(), or moves a route
 * back into the entry point, these assertions fail.
 */

import { readFileSync } from 'fs';
import path from 'path';

import { createApp } from '../src/app';

const APP_SOURCE = readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
const INDEX_SOURCE = readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

describe('createApp() is side-effect free', () => {
  it('builds a fresh Express app without registering signal handlers', () => {
    const before = new Set(process.listeners('SIGTERM'));

    const first = createApp();
    const second = createApp();

    // A fresh stack and route table per call, not a module-level singleton.
    expect(first).not.toBe(second);
    expect(typeof first.listen).toBe('function');
    expect(process.listeners('SIGTERM').filter((listener) => !before.has(listener))).toEqual([]);
  });

  it('owns no listener, signal or exit behaviour', () => {
    expect(APP_SOURCE).not.toMatch(/\.listen\(/);
    expect(APP_SOURCE).not.toMatch(/process\.on\(/);
    expect(APP_SOURCE).not.toMatch(/process\.exit\(/);
    expect(APP_SOURCE).not.toMatch(/SIGTERM|SIGINT/);
  });

  it('does not run the startup preflight from the app module', () => {
    // Config predicates may be *used* by a route (the disclosure gate reads
    // whether a licence is configured); what must not live here is the boot
    // report or a refusal to start.
    expect(APP_SOURCE).not.toContain('runStartupPreflight');
    expect(APP_SOURCE).not.toMatch(/FATAL: production startup/);
  });
});

describe('the entry point owns startup, not routes', () => {
  it('defines no HTTP routes', () => {
    expect(INDEX_SOURCE).not.toMatch(/app\.(get|post|put|delete|patch|use)\(/);
  });

  it('builds the app through createApp() and registers the shutdown signals', () => {
    expect(INDEX_SOURCE).toContain('createApp()');
    expect(INDEX_SOURCE).toMatch(/process\.on\('SIGTERM'/);
    expect(INDEX_SOURCE).toMatch(/process\.on\('SIGINT'/);
  });

  it('keeps the boot preflight and production gates at startup', () => {
    expect(INDEX_SOURCE).toContain('runStartupPreflight()');
    expect(INDEX_SOURCE).toContain('isLicenseNumberConfigured()');
    expect(INDEX_SOURCE).toContain('isAdminApiKeyConfigured()');
    expect(INDEX_SOURCE).toContain('isRecordEncryptionKeyConfigured()');
  });
});

describe('importing the entry point twice does not stack shutdown handlers', () => {
  it('replaces its own SIGTERM/SIGINT pair instead of adding another', async () => {
    const baseline = {
      SIGTERM: process.listeners('SIGTERM'),
      SIGINT: process.listeners('SIGINT'),
    };
    const overrides = {
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      SERVERLESS: 'false',
    };
    const previous = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]]),
    );
    const servers: Array<import('http').Server | undefined> = [];

    const load = async () => {
      jest.resetModules();
      const mod = (await import('../src/index')) as {
        server?: import('http').Server;
      };
      servers.push(mod.server);
      return {
        term: process.listeners('SIGTERM').length,
        int: process.listeners('SIGINT').length,
      };
    };

    try {
      // A real listener per import is the point: the entry point owns the
      // socket, so this exercises the exact double-boot path (watch mode, or a
      // test suite that reloads the module to re-read the environment).
      Object.assign(process.env, overrides);

      const first = await load();
      const second = await load();

      expect(second.term).toBe(first.term);
      expect(second.int).toBe(first.int);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      for (const server of servers) {
        await new Promise<void>((resolve) => {
          if (server && server.listening) {
            server.close(() => resolve());
          } else {
            resolve();
          }
        });
      }
      // Leave the process as this test found it: the handlers the second import
      // registered point at a closed server and belong to no other suite.
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        for (const listener of process.listeners(signal)) {
          if (!baseline[signal].includes(listener)) {
            process.removeListener(signal, listener);
          }
        }
      }
    }
  });
});
