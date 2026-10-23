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
 *     redeploy, /health answers liveness only, and the readiness facts an
 *     operator needs are behind the admin gate.
 *
 * As in the other endpoint suites, src/index.ts is re-imported with
 * jest.resetModules() under the env each block needs, and LLM_API_KEY is
 * emptied so no test ever reaches the network.
 */

import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';

import { testSessionId } from './helpers/test-session';
import { cleanupTempLogs, tempLogPath } from './helpers/temp-log';

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
  const leadLog = tempLogPath('hardening-sandbox');

  beforeAll(async () => {
    loaded = await loadApp({
      // Port 0 asks the OS for a free port. LIFECHAT_PORT is set explicitly
      // because the repo's .env file defines it and would otherwise win.
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
    cleanupTempLogs(leadLog);
  });

  it('does not advertise the framework', async () => {
    const res = await request(loaded.app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets baseline response headers on every response', async () => {
    const health = await request(loaded.app).get('/health');
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(health.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(health.headers['x-frame-options']).toBe('DENY');

    const widget = await request(loaded.app).get('/widget.js');
    expect(widget.headers['x-content-type-options']).toBe('nosniff');
    expect(widget.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('sends a document CSP that keeps scripts strict and allows the widget stylesheet', async () => {
    const res = await request(loaded.app).get('/demo.html');
    const csp = String(res.headers['content-security-policy']);

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Scripts must never gain inline/eval escapes; XSS is what this directive
    // is for. Styles keep the inline allowance because widget.js builds its
    // accessibility stylesheet at runtime (see security-headers.ts).
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-eval/);
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  it('caches unversioned static assets for an hour and revalidates HTML', async () => {
    // The names are fixed, so `immutable` would strand every embed on an old
    // widget after a deploy; the bounded window still stops the per-navigation
    // revalidation the audit measured.
    const widget = await request(loaded.app).get('/widget.js');
    expect(widget.headers['cache-control']).toBe('public, max-age=3600, must-revalidate');

    const css = await request(loaded.app).get('/elementor-trust-block.css');
    expect(css.headers['cache-control']).toBe('public, max-age=3600, must-revalidate');

    const demo = await request(loaded.app).get('/demo.html');
    expect(demo.headers['cache-control']).toBe('no-cache');
  });

  it('compresses a large static asset when the client accepts gzip', async () => {
    const compressed = await request(loaded.app).get('/widget.js').set('Accept-Encoding', 'gzip');

    expect(compressed.headers['content-encoding']).toBe('gzip');
    expect(String(compressed.headers['vary'])).toContain('Accept-Encoding');
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

  it('answers /health with liveness only, never the readiness posture', async () => {
    const res = await request(loaded.app).get('/health');
    expect(res.status).toBe(200);
    // Exactly these three facts: model, provider endpoint, storage verdict,
    // proxy derivation, secret-configuration booleans and the compliance
    // matrix are reconnaissance and live behind the admin gate (M-02).
    expect(res.body).toEqual({
      status: 'ok',
      uptimeSeconds: expect.any(Number),
      killSwitch: false,
    });
  });

  it('fails the readiness route closed when no admin key is configured', async () => {
    const res = await request(loaded.app).get('/api/admin/health');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Admin authentication is not configured');
    expect(res.body.llm).toBeUndefined();
  });
});

describe('server hardening — cross-origin embed (deny by default)', () => {
  let loaded: LoadedApp;
  const leadLog = tempLogPath('hardening-cors');

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      ALLOWED_ORIGINS: 'https://lifepolicypilot.blog/',
      LEAD_LOG_PATH: leadLog,
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
    cleanupTempLogs(leadLog);
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
  const leadLog = tempLogPath('hardening-limit-lead');
  const dsrLog = tempLogPath('hardening-limit-dsr');

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      LEAD_LOG_PATH: leadLog,
      DSR_LOG_PATH: dsrLog,
    });
  });

  afterAll(async () => {
    await loaded.cleanup();
    cleanupTempLogs(leadLog, dsrLog);
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
  // 32+ characters: the boot entropy gate refuses a shorter key (SEC-10).
  const ADMIN_KEY = 'hardening-admin-key-0123456789abcdef';
  let loaded: LoadedApp;
  const leadLog = tempLogPath('hardening-kill');

  beforeAll(async () => {
    loaded = await loadApp({
      LIFECHAT_PORT: '0',
      LLM_API_KEY: '',
      ADMIN_API_KEY: ADMIN_KEY,
      LEAD_LOG_PATH: leadLog,
    });
  });

  afterAll(async () => {
    // Never leave the switch tripped for other suites sharing this module state.
    await request(loaded.app).delete('/api/admin/kill-switch').set('x-admin-key', ADMIN_KEY);
    await loaded.cleanup();
    cleanupTempLogs(leadLog);
  });

  it('serves the readiness facts on the admin health route', async () => {
    const denied = await request(loaded.app).get('/api/admin/health');
    expect(denied.status).toBe(401);

    const res = await request(loaded.app).get('/api/admin/health').set('x-admin-key', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptimeSeconds).toBe('number');
    expect(res.body.llm.configured).toBe(false); // LLM_API_KEY emptied above
    expect(res.body.llm.baseUrl).toBeTruthy();
    expect(res.body.dataPathsWritable).toBe(true);
    expect(res.body.recordStorage).toHaveProperty('durable');
    // Booleans and non-secret identifiers only — never a key or a record path.
    expect(JSON.stringify(res.body.llm)).not.toMatch(/api[-_]?key"/i);
    expect(JSON.stringify(res.body)).not.toContain('.jsonl');
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

    const chat = await request(loaded.app)
      .post('/api/chat')
      .send({
        sessionId: testSessionId('kill-switch-drill'),
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
