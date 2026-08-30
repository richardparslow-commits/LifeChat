/**
 * Medical capture gating — default is fail-closed.
 *
 * The medical review flow collects TDPSA-sensitive health data, so it must be
 * gated by default. config computes healthDataCollectionDisabled from
 * `process.env.HEALTH_DATA_COLLECTION_DISABLED !== 'false'` — meaning it is
 * TRUE (medical capture blocked) whenever the flag is unset, explicitly
 * "true", or anything other than the literal "false". Only a deliberate
 * `.env` flip to `false` (post-counsel-approval) enables the flow.
 *
 * These tests lock that default so the re-gated posture can't silently leak
 * into the enabled state. src/config/app-config.ts has no dotenv import, so a
 * direct unit import is deterministic regardless of any .env file.
 */

import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';

/** Loads src/config/app-config.ts fresh with HEALTH_DATA_COLLECTION_DISABLED unset. */
async function loadConfigWithUnsetFlag(): Promise<{ healthDataCollectionDisabled: boolean }> {
  jest.resetModules();
  const prev = process.env.HEALTH_DATA_COLLECTION_DISABLED;
  delete process.env.HEALTH_DATA_COLLECTION_DISABLED;
  try {
    const mod = (await import('../src/config/app-config')) as {
      config: { healthDataCollectionDisabled: boolean };
    };
    return { healthDataCollectionDisabled: mod.config.healthDataCollectionDisabled };
  } finally {
    // Restore for later imports/tests
    if (prev === undefined) {
      delete process.env.HEALTH_DATA_COLLECTION_DISABLED;
    } else {
      process.env.HEALTH_DATA_COLLECTION_DISABLED = prev;
    }
  }
}

interface LoadedApp {
  app: Express;
  cleanup: () => Promise<void>;
}

async function loadApp(flagValue: string): Promise<LoadedApp> {
  jest.resetModules();
  const previous = { ...process.env };
  process.env.HEALTH_DATA_COLLECTION_DISABLED = flagValue;
  process.env.LIFECHAT_PORT = '0';
  process.env.LLM_API_KEY = '';

  const { app, server } = (await import('../src/index')) as {
    app: Express;
    server: Server;
  };

  // Restore after the module has read it
  const restore = (key: string) => {
    if (previous[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous[key];
    }
  };
  restore('HEALTH_DATA_COLLECTION_DISABLED');
  restore('LIFECHAT_PORT');
  restore('LLM_API_KEY');

  return {
    app,
    cleanup: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe('HEALTH_DATA_COLLECTION_DISABLED default (unset) — medical capture fail-closed', () => {
  it('defaults healthDataCollectionDisabled to true when the env var is unset', async () => {
    const cfg = await loadConfigWithUnsetFlag();
    expect(cfg.healthDataCollectionDisabled).toBe(true);
  });
});

describe('HEALTH_DATA_COLLECTION_DISABLED refused medical data when not "false"', () => {
  describe('the config only enables with the literal "false"', () => {
    it('treats an explicit "false" as enabled', async () => {
      jest.resetModules();
      const prev = process.env.HEALTH_DATA_COLLECTION_DISABLED;
      process.env.HEALTH_DATA_COLLECTION_DISABLED = 'false';
      try {
        const mod = (await import('../src/config/app-config')) as {
          config: { healthDataCollectionDisabled: boolean };
        };
        expect(mod.config.healthDataCollectionDisabled).toBe(false);
      } finally {
        if (prev === undefined) {
          delete process.env.HEALTH_DATA_COLLECTION_DISABLED;
        } else {
          process.env.HEALTH_DATA_COLLECTION_DISABLED = prev;
        }
      }
    });

    it('treats an explicit "true" as disabled', async () => {
      jest.resetModules();
      const prev = process.env.HEALTH_DATA_COLLECTION_DISABLED;
      process.env.HEALTH_DATA_COLLECTION_DISABLED = 'true';
      try {
        const mod = (await import('../src/config/app-config')) as {
          config: { healthDataCollectionDisabled: boolean };
        };
        expect(mod.config.healthDataCollectionDisabled).toBe(true);
      } finally {
        if (prev === undefined) {
          delete process.env.HEALTH_DATA_COLLECTION_DISABLED;
        } else {
          process.env.HEALTH_DATA_COLLECTION_DISABLED = prev;
        }
      }
    });
  });

  describe('the real /api/chat endpoint honours the fail-closed default', () => {
    let loaded: LoadedApp;

    beforeAll(async () => {
      // Any non-"false" value (here: empty/blank) must behave as disabled —
      // this exercises the default gate through the real server, independent of
      // any .env file.
      loaded = await loadApp('');
    });

    afterAll(async () => {
      await loaded.cleanup();
    });

    it('reports healthDataCollection as disabled', async () => {
      const res = await request(loaded.app).get('/');
      expect(res.status).toBe(200);
      expect(res.body.healthDataCollection).toBe('disabled');
    });

    it('refuses health data shared in education with a gated licensed-broker handoff', async () => {
      const res = await request(loaded.app).post('/api/chat').send({
        sessionId: 'default-edu-health',
        currentState: 'education',
        message: 'I have diabetes and I take insulin',
      });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('handoff');
      expect(res.body.risk_flags).toContain('sensitive_data_disclosed');
      expect(res.body.proposed_action).toBe('request_human_handoff');
      expect(res.body.assistant_message).toContain(
        "This chat isn't the right place for medical or health information.",
      );
    });

    it('refuses health data in medical_review even when the flag is not explicitly set', async () => {
      // With the flag effectively off, even a request into the consented
      // review state receives no health data — the gate applies.
      const res = await request(loaded.app).post('/api/chat').send({
        sessionId: 'default-medreview-health',
        currentState: 'medical_review',
        message: 'I have diabetes and I take insulin',
      });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('handoff');
      expect(res.body.risk_flags).toContain('sensitive_data_disclosed');
    });

    it('reports F5 medical review as gated_by_flag on /health under the default', async () => {
      const res = await request(loaded.app).get('/health');
      expect(res.status).toBe(200);
      const f5 = res.body.compliance.flows.find((f: { id: string }) => f.id === 'F5');
      expect(f5.runtimeStatus).toBe('gated_by_flag');
      // Enabling/not-setting a flag is never counsel approval
      expect(f5.approvalStatus).toBe('pending_counsel');
    });
  });
});
