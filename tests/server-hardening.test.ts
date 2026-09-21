/**
 * Server hardening / sandbox-readiness tests.
 *
 * These cover the operational surface a managed sandbox or a container platform
 * exercises the moment it boots this app, none of which the feature suites
 * touch:
 *
 *   - it binds the port the platform injects (PORT, not only LIFECHAT_PORT);
 *   - unknown API routes and malformed JSON answer in JSON, not an HTML page,
 *     and no response advertises the framework or leaks a stack trace;
 *   - baseline response headers are present, and API responses are uncacheable;
 *   - cross-origin access is deny-by-default, opt-in per origin, and preflight
 *     is answered without running route logic;
 *   - the two unauthenticated write endpoints are rate-bounded per client;
 *   - the kill switch has a runtime control (admin-only) instead of requiring a
 *     redeploy, and /health reports the facts an operator needs.
 *
 * As in the other endpoint suites, src/index.ts is re-imported with
 * jest.resetModules() under the env each block needs, and LLM_API_KEY is
 * emptied so no test ever reaches the network.
 */

import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';

interface LoadedApp {
  app: Express;
  server: Server;
  cleanup: () => Promise<void>;
}

/** Loads src/index.ts as a fresh module with the given env overrides. */
async function loadApp(env: Record<string, string>): Promise<LoadedApp> {
  jest.resetModules();
  const previous = { ...process.env };
  Object.entries(env).forEach(([key, value]) => {
    process.env[key] = value;
  });

  const { app, server } = (await import('../src/index')) as {
    app: Express;
    server: Server;
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
    app,
    server,
    cleanup: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('server hardening — sandbox boot surface', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      // Port 0 asks the OS for a free port. LIFECHAT_PORT is set explicitly
      // because the repo's .env file defines it and would otherwise win.
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      LEAD_LOG_PATH: `data/lead-hardening-test-${Date.now()}.jsonl`,
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('does not advertise the framework', async () => {
    const res = await request(loaded.app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets baseline response headers on every response', async () => {
    const health = await request(loaded.app).get('/health');
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');

    const widget = await request(loaded.app).get('/widget.js');
    expect(widget.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never lets an API response be cached by a proxy or CDN', async () => {
    // Several API responses carry consent or medical artifacts, so they must
    // not be cached. (Static assets and /health are deliberately not no-store.)
    for (const path of ['/api/disclosure', '/api/consent-text', '/api/availability']) {
      const res = await request(loaded.app).get(path);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('binds the port a hosting platform injects (PORT), with LIFECHAT_PORT winning', async () => {
    jest.resetModules();
    const previousLifchatPort = process.env.LIFECHAT_PORT;
    const previousPort = process.env.PORT;
    try {
      // Defined-but-empty, so dotenv will not repopulate LIFECHAT_PORT from
      // .env while the module reads its configuration.
      process.env.LIFECHAT_PORT = '';
      process.env.PORT = '4123';
      const injected = (await import('../src/config/app-config')) as {
        config: { port: number };
      };
      expect(injected.config.port).toBe(4123);

      jest.resetModules();
      process.env.LIFECHAT_PORT = '4321';
      const explicit = (await import('../src/config/app-config')) as {
        config: { port: number };
      };
      expect(explicit.config.port).toBe(4321);
    } finally {
      if (previousLifchatPort === undefined) delete process.env.LIFECHAT_PORT;
      else process.env.LIFECHAT_PORT = previousLifchatPort;
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
  });

  it('answers an unknown API route with JSON, not an HTML page', async () => {
    const res = await request(loaded.app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.error).toBe('Not found');
    expect(res.body.path).toBe('/api/does-not-exist');
  });

  it('answers malformed JSON with a small JSON 400 and no stack trace', async () => {
    const res = await request(loaded.app)
      .post('/api/chat')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({ error: 'Invalid JSON body' });
    expect(JSON.stringify(res.body)).not.toMatch(/at |SyntaxError|\/Users\//);
  });

  it('reports the readiness facts an operator needs on /health', async () => {
    const res = await request(loaded.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(res.body.llm.configured).toBe(false); // LLM_API_KEY emptied above
    expect(res.body.llm.baseUrl).toBeTruthy();
    expect(res.body.dataPathsWritable).toBe(true);
    // Booleans only — the health payload never carries a key or a filesystem path.
    expect(JSON.stringify(res.body.llm)).not.toMatch(/api[-_]?key"/i);
    expect(JSON.stringify(res.body)).not.toContain('.jsonl');
  });
});

describe('server hardening — cross-origin embed (deny by default)', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      ALLOWED_ORIGINS: 'https://lifepolicypilot.blog/',
      LEAD_LOG_PATH: `data/lead-hardening-cors-${Date.now()}.jsonl`,
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('allows an allowlisted origin (trailing slash and case normalized)', async () => {
    const res = await request(loaded.app)
      .get('/api/disclosure')
      .set('Origin', 'https://LifePolicyPilot.blog');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://LifePolicyPilot.blog');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('gives an origin that is not allowlisted no CORS grant', async () => {
    const res = await request(loaded.app)
      .get('/api/disclosure')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['vary']).toContain('Origin');
  });

  it('answers preflight for an allowed origin without running route logic', async () => {
    const res = await request(loaded.app)
      .options('/api/chat')
      .set('Origin', 'https://lifepolicypilot.blog')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://lifepolicypilot.blog');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('answers preflight for a disallowed origin with a 204 and no grant', async () => {
    const res = await request(loaded.app)
      .options('/api/chat')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses cross-origin by default when ALLOWED_ORIGINS is unset', async () => {
    const strict = await loadApp({ LIFECHAT_PORT: '0', LLM_API_KEY: '', ALLOWED_ORIGINS: '' });
    try {
      const res = await request(strict.app)
        .get('/api/disclosure')
        .set('Origin', 'https://lifepolicypilot.blog');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await strict.cleanup();
    }
  });
});

describe('server hardening — write endpoints are bounded per client', () => {
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      LEAD_LOG_PATH: `data/lead-hardening-limit-${Date.now()}.jsonl`,
      DSR_LOG_PATH: `data/dsr-hardening-limit-${Date.now()}.jsonl`,
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
  });

  it('rate-limits /api/dsr after the per-window budget is exhausted', async () => {
    const { WRITE_RATE_LIMIT_CONFIG } = (await import('../src/security/security-controls')) as {
      WRITE_RATE_LIMIT_CONFIG: { MAX_REQUESTS_PER_WINDOW: number };
    };

    // Validation failures still consume budget: the limit bounds work per
    // client, not successful submissions.
    const send = () =>
      request(loaded.app)
        .post('/api/dsr')
        .send({ requestType: 'access', contactEmail: 'not-an-email' });

    for (let i = 0; i < WRITE_RATE_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW; i++) {
      const res = await send();
      expect(res.status).toBe(400);
    }

    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('Too many requests');
    expect(limited.body.reason).toBe('rate_limit_exceeded');
  });
});

describe('server hardening — the kill switch has a runtime control', () => {
  const ADMIN_KEY = 'hardening-admin-key';
  let loaded: LoadedApp;

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      ADMIN_API_KEY: ADMIN_KEY,
      LEAD_LOG_PATH: `data/lead-hardening-kill-${Date.now()}.jsonl`,
    });
  });

  afterAll(async () => {
    // Never leave the switch tripped for other suites sharing this module state.
    await request(loaded.app).delete('/api/admin/kill-switch').set('x-admin-key', ADMIN_KEY);
    await loaded.cleanup();
  });

  it('requires the admin key to activate', async () => {
    const res = await request(loaded.app)
      .post('/api/admin/kill-switch')
      .send({ reason: 'unauthorized try' });
    expect(res.status).toBe(401);
  });

  it('requires the admin key to clear', async () => {
    const res = await request(loaded.app).delete('/api/admin/kill-switch');
    expect(res.status).toBe(401);
  });

  it('activates, makes chat return the static safe fallback, and clears', async () => {
    const on = await request(loaded.app)
      .post('/api/admin/kill-switch')
      .set('x-admin-key', ADMIN_KEY)
      .send({ reason: 'sandbox drill' });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ killSwitch: true, changed: true });

    const health = await request(loaded.app).get('/health');
    expect(health.body.killSwitch).toBe(true);

    const availability = await request(loaded.app).get('/api/availability');
    expect(availability.body.staffed).toBe(false);

    const chat = await request(loaded.app).post('/api/chat').send({
      sessionId: 'kill-switch-drill',
      currentState: 'education',
      message: 'What is term life insurance?',
    });
    expect(chat.status).toBe(200);
    expect(chat.body.state).toBe('standby');

    // Idempotent: activating twice reports no change rather than re-logging.
    const again = await request(loaded.app)
      .post('/api/admin/kill-switch')
      .set('x-admin-key', ADMIN_KEY)
      .send({ reason: 'again' });
    expect(again.body).toMatchObject({ killSwitch: true, changed: false });

    const off = await request(loaded.app)
      .delete('/api/admin/kill-switch')
      .set('x-admin-key', ADMIN_KEY);
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ killSwitch: false, changed: true });

    const cleared = await request(loaded.app).get('/health');
    expect(cleared.body.killSwitch).toBe(false);
  });
});
