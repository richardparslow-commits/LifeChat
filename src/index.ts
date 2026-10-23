/**
 * LifeChat entry point — startup only.
 *
 * The HTTP app is built by `createApp()` in src/app.ts. This module owns the
 * process-level concerns that must not run when the app is merely constructed:
 * the production readiness gates (which may refuse to start), the boot
 * preflight report, the listener, the periodic cleanup timers, and the SIGTERM
 * / SIGINT handlers. Importing this module is therefore what starts a server —
 * unless SERVERLESS=true, where the platform owns the socket.
 */

import 'dotenv/config';

import type { Server } from 'http';
import { accessSync, constants, existsSync, mkdirSync } from 'fs';
import path from 'path';
import {
  config,
  PRODUCT_DEFINITION,
  isLicenseNumberConfigured,
  isAdminApiKeyConfigured,
  isAdminApiKeyStrong,
  isRecordEncryptionKeyConfigured,
  wildcardAllowedOrigins,
  MIN_ADMIN_API_KEY_LENGTH,
} from './config/app-config';
import { createApp, PUBLIC_DIR } from './app';
import { isDataPathsWritable, setDataPathsWritable } from './runtime-status';
import { isArchilStorageConfigured, loadArchilConfig, toArchilObjectKey } from './archil/disk';
import { verifyDurableStorage } from './config/durable-storage';
import { resolveTrustProxy } from './config/trust-proxy';
import { startSessionCleanup } from './llm/session-store';
import { startRateLimitCleanup } from './security/security-controls';
import { ensureLeadRecordsLoaded, ensureSessionIndexLoaded } from './consent/consent-model';
import { ensureDsrRecordsLoaded } from './privacy/dsr';
import {
  isRecordEncryptionKeyStrong,
  MIN_RECORD_ENCRYPTION_KEY_LENGTH,
} from './privacy/record-encryption';

const app = createApp();

// Hydrate the record caches at boot. The loaders stream the JSONL logs rather
// than blocking startup; writes also await them, so a submission that races
// boot is ordered after hydration instead of against a half-loaded cache.
// The session index is PII-free and small, and hydrating it here means the
// first chat turn does not pay for it (C-07). Loaders resolve rather than
// reject, but a failed read must never crash the process — the per-request
// write path still fails closed.
void Promise.all([
  ensureLeadRecordsLoaded(),
  ensureSessionIndexLoaded(),
  ensureDsrRecordsLoaded(),
]).catch(() => {});

/**
 * Startup preflight — report the environment the process actually resolved,
 * before it accepts traffic.
 *
 * Everything here is a warning, never a fatal: the production gates below are
 * the only conditions that refuse to start. The point is that a sandbox
 * operator can see, in the boot log, whether the static assets were found,
 * where records will be written, whether those directories are writable, and
 * whether an LLM key is configured — instead of inferring it from a failed
 * request later.
 */
function runStartupPreflight(): void {
  // Static assets resolve relative to the compiled file (dist/../public).
  if (!existsSync(PUBLIC_DIR)) {
    console.warn(
      `WARN: static asset directory not found at ${PUBLIC_DIR} — /demo.html and /widget.js will 404. ` +
        'Run the server from a full checkout (public/ beside dist/).',
    );
  }

  // Record logs: report resolved paths, and verify (creating if needed) that
  // each parent directory is writable. Same directories the writers create on
  // demand, so this only makes a failure visible earlier.
  const logPaths = [
    config.leadLogPath,
    config.dsrLogPath,
    config.abstentionLogPath,
    config.erasureLogPath,
    config.leadAccessLogPath,
  ];
  if (isArchilStorageConfigured()) {
    const archilCfg = loadArchilConfig();
    console.log(`  Archil disk: ${archilCfg.diskId} (${archilCfg.region})`);
    for (const logPath of new Set(logPaths)) {
      console.log(`  Records (Archil): ${toArchilObjectKey(logPath)}`);
    }
    setDataPathsWritable(true);
  } else {
    const unwritable: string[] = [];
    if (process.env.ARCHIL_CONTAINER_ID && process.env.ARCHIL_DISK_ID) {
      console.log(
        `  Archil Sandbox root disk: ${process.env.ARCHIL_DISK_ID} (${process.env.ARCHIL_REGION || 'mounted at /'})`,
      );
    }
    for (const logPath of new Set(logPaths)) {
      const dir = path.dirname(path.resolve(logPath));
      try {
        mkdirSync(dir, { recursive: true });
        accessSync(dir, constants.W_OK);
      } catch {
        unwritable.push(dir);
      }
      console.log(
        `  Records: ${logPath}${unwritable.includes(dir) ? '  (DIRECTORY NOT WRITABLE)' : ''}`,
      );
    }
    setDataPathsWritable(unwritable.length === 0);
    if (!isDataPathsWritable()) {
      console.warn(
        `WARN: record directories are not writable (${unwritable.join(', ')}). ` +
          'Lead, DSR, and abstention writes will fail closed until this is fixed.',
      );
    }
  }

  // SEC-11: durability is proven at boot, not declared by an env flag. A
  // serverless process whose record directories are ephemeral keeps failing
  // closed, whatever DURABLE_STORAGE_CONFIGURED says.
  const storage = verifyDurableStorage({
    serverless: config.serverless,
    archilConfigured: isArchilStorageConfigured(),
    logPaths,
  });
  if (storage.verified) {
    console.log(`  Record durability: verified (${storage.reason})`);
  } else {
    const legacyFlag = process.env.DURABLE_STORAGE_CONFIGURED === 'true';
    const suffix = legacyFlag
      ? ' DURABLE_STORAGE_CONFIGURED is ignored: it asserted durability without proving it.'
      : '';
    console.warn(
      `WARN: record durability is NOT verified (${storage.reason}). Consent, DSR and audit writes will fail closed rather than acknowledge a record that may be lost.${suffix} Mount a durable volume or configure Archil.`,
    );
  }

  // M-08: abstention analytics are keyed, so without a key nothing is written
  // (an unkeyed question digest is reversible by dictionary lookup). Report the
  // contradiction at boot rather than as a silent gap in the editorial feed.
  if (config.abstentionLoggingEnabled && !config.abstentionLogKey.trim()) {
    console.warn(
      'WARN: ABSTENTION_LOGGING_ENABLED is on but ABSTENTION_LOG_KEY is not configured, ' +
        'so no abstention is recorded: an unkeyed question hash can be reversed by ' +
        'dictionary lookup. Set the key, or set ABSTENTION_LOGGING_ENABLED=false.',
    );
  }

  console.log(
    `  LLM: ${config.llmApiKey.trim().length > 0 ? 'key configured' : 'NO API KEY — responses fall back to the static safe message'}`,
  );
  console.log(`  LLM endpoint: ${config.llmApiBaseUrl} (${config.llmModel})`);
  console.log(
    `  Cross-origin embed: ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(', ') : 'same-origin only (ALLOWED_ORIGINS unset)'}`,
  );
  // A wildcard is accepted for previews, and it is also a CORS grant to every
  // site on that vendor domain. Name it at boot so an operator who copied a
  // preview value into production sees what it admits before a stranger does.
  const wildcardOrigins = wildcardAllowedOrigins();
  if (wildcardOrigins.length > 0) {
    console.warn(
      `WARN: ALLOWED_ORIGINS contains a subdomain wildcard (${wildcardOrigins.join(', ')}). ` +
        "A wildcard admits every site on that vendor's domain, not only yours: any tenant could " +
        "spend this API's model budget and post consent or DSR records. Use it for the preview " +
        'under test, and list exact origins in production.',
    );
  }
  const trustProxy = resolveTrustProxy({
    raw: config.trustProxy,
    serverless: config.serverless,
    vercel: process.env.VERCEL === '1',
  });
  console.log(
    `  Proxy trust: ${trustProxy.setting === false ? 'none' : JSON.stringify(trustProxy.setting)}` +
      `${trustProxy.source === 'vercel_default' ? ' (Vercel edge default)' : ''}`,
  );

  // SEC-18: with health data collection enabled and no key, /api/consent will
  // refuse every medical profile rather than write it in plaintext. Report the
  // contradiction at boot instead of letting the first visitor find it as 503.
  if (!config.healthDataCollectionDisabled && !isRecordEncryptionKeyConfigured()) {
    console.warn(
      'WARN: health data collection is enabled but RECORD_ENCRYPTION_KEY is not configured. ' +
        '/api/consent will refuse every medical profile with 503 rather than store it in plaintext ' +
        '(SEC-18); set the key to enable the medical flow.',
    );
  }
}

/**
 * Production gate: a verified Texas license number is required before going
 * live (Texas Insurance Code §541.003 / TAC §19.1004). In pilot mode the app
 * may run without it (fail-closed disclosure); outside pilot mode it refuses
 * to start rather than serve a placeholder.
 */
if (!config.pilotMode && !isLicenseNumberConfigured()) {
  console.error(
    'FATAL: production startup requires a verified TEXAS_LICENSE_NUMBER in the environment. ' +
      'Set it before disabling pilot mode; the placeholder is never served to users.',
  );
  process.exit(1);
}

/**
 * Production gate: an admin API key is required before going live so the
 * system prompt, session history, and DSR status endpoints are never exposed
 * without authentication. In pilot mode the app may run without it (dev
 * convenience); outside pilot mode it refuses to start.
 */
if (!config.pilotMode && !isAdminApiKeyConfigured()) {
  console.error(
    'FATAL: production startup requires an ADMIN_API_KEY in the environment. ' +
      'Set it before disabling pilot mode; admin endpoints must not be public.',
  );
  process.exit(1);
}

/**
 * Entropy gate (SEC-10) for the admin key: a configured key below the minimum
 * length is refused outright, in every mode. The key gates the system prompt,
 * session history, lead lookups, session deletion, and the kill switch; a short
 * key is guessable regardless of how the comparison is implemented, and a
 * constant-time compare in front of a 6-character secret protects nothing.
 */
if (isAdminApiKeyConfigured() && !isAdminApiKeyStrong()) {
  console.error(
    `FATAL: ADMIN_API_KEY must be at least ${MIN_ADMIN_API_KEY_LENGTH} characters. ` +
      'Generate one with `openssl rand -base64 48` (or equivalent) and restart; ' +
      'admin authentication is not weakened to accommodate a short secret.',
  );
  process.exit(1);
}

/**
 * Production gate: at-rest record encryption (RECORD_ENCRYPTION_KEY) is
 * required before going live so DSR and lead records — which may contain PII
 * and are legal/consent artifacts — are never written to disk in plaintext.
 * In pilot mode records may fall back to plaintext for dev convenience.
 */
if (!config.pilotMode && !isRecordEncryptionKeyConfigured()) {
  console.error(
    'FATAL: production startup requires a RECORD_ENCRYPTION_KEY in the environment. ' +
      'Set it before disabling pilot mode; DSR/lead records are encrypted at rest ' +
      'with AES-256-GCM and must never be written in plaintext in production.',
  );
  process.exit(1);
}

/**
 * Entropy gate (SEC-10): a configured key below the minimum length is refused
 * outright, in every mode. Continuing would derive a weak AES key for legal
 * records, so the failure must be visible at boot rather than discovered when
 * every write starts failing closed.
 */
if (isRecordEncryptionKeyConfigured() && !isRecordEncryptionKeyStrong()) {
  console.error(
    `FATAL: RECORD_ENCRYPTION_KEY must be at least ${MIN_RECORD_ENCRYPTION_KEY_LENGTH} characters. ` +
      'Generate one with `openssl rand -base64 48` (or equivalent) and restart; ' +
      'record encryption is not weakened to accommodate a short secret.',
  );
  process.exit(1);
}

// Report the resolved environment before serving anything.
runStartupPreflight();

/**
 * Start the server — unless running serverless.
 *
 * On platforms whose runtime starts each invocation itself (Vercel's Node
 * runtime), calling listen() during a cold start crashes the invocation with
 * EADDRINUSE-style errors or a hung boot. SERVERLESS=true builds the same app
 * but leaves the port alone: the platform owns the socket. The in-memory
 * session and rate-limit stores do not outlive a warm instance there, so the
 * periodic cleanup loops are skipped rather than scheduled — there is nothing
 * long-lived for them to sweep.
 */
let server: Server | undefined;
if (config.serverless) {
  console.log('  Serverless mode: listening is owned by the platform (SERVERLESS=true).');
} else {
  server = app.listen(config.port, () => {
    // Start periodic cleanup of expired sessions (30-min TTL)
    startSessionCleanup();
    // Start periodic cleanup of stale rate-limit entries (prevents unbounded
    // memory growth from unique session IDs and clears expired lockouts)
    startRateLimitCleanup();

    console.log(`\n  ${PRODUCT_DEFINITION.name}`);
    console.log(`  Owner: ${PRODUCT_DEFINITION.owner}`);
    console.log(`  Jurisdiction: ${PRODUCT_DEFINITION.initialJurisdiction}`);
    console.log(`  Pilot mode: ${config.pilotMode}`);
    console.log(
      `  Health data collection: ${config.healthDataCollectionDisabled ? 'DISABLED' : 'enabled'}`,
    );
    console.log(
      `  Outbound marketing: ${config.outboundMarketingDisabled ? 'DISABLED' : 'enabled'}`,
    );
    console.log(`\n  Server running at http://localhost:${config.port}`);
    console.log(`  Widget at http://localhost:${config.port}/widget.js`);
    console.log(`  Session history: max 20 turns, 30-min TTL`);
    console.log('');
  });

  /**
   * Bind failures must not become silent hangs.
   *
   * An unhandled `error` event on a Server throws, killing the process mid-
   * request — callers see a dropped socket rather than a diagnosis. A second
   * process on the same port is a real misconfiguration in production and is
   * reported as one; under a test runner it is expected (parallel workers all
   * inherit the same port from .env), and the exported app is what the suite
   * drives, so the process keeps running without a listener.
   */
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (process.env.JEST_WORKER_ID) {
      console.warn(
        `  Test worker: port ${config.port} is already in use (${error.code ?? 'unknown'}); ` +
          'continuing without a listener.',
      );
      return;
    }
    console.error(`FATAL: could not bind port ${config.port}: ${error.message}`);
    process.exit(1);
  });
}

/**
 * Graceful shutdown.
 *
 * Managed sandboxes, container platforms, and process supervisors stop an app
 * with SIGTERM (Ctrl-C sends SIGINT). Without a handler the process dies
 * mid-request and, when the supervisor expects a clean exit, the port can look
 * occupied on restart. This closes the listener — letting in-flight requests
 * finish — then exits, with a bounded wait so a hung keep-alive connection can
 * never wedge a restart.
 */
function shutdown(signal: string): void {
  console.log(`\n  ${signal} received — closing the server (in-flight requests may finish)...`);
  const forceExit = setTimeout(() => {
    console.warn('  Shutdown timed out after 5s — exiting anyway.');
    process.exit(0);
  }, 5000);
  forceExit.unref();
  server?.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

/**
 * The handlers this module registered, kept on the process itself so a second
 * import of the entry point (ts-node --watch, or a test that resets the module
 * registry to re-read the environment) replaces them instead of stacking a new
 * pair on top of the previous, already-closed server's handlers.
 */
type ShutdownHandlers = Record<'SIGTERM' | 'SIGINT', () => void>;
const processWithShutdownHandlers = process as typeof process & {
  __lifechatShutdownHandlers?: ShutdownHandlers;
};

if (!config.serverless) {
  const previousHandlers = processWithShutdownHandlers.__lifechatShutdownHandlers;
  if (previousHandlers) {
    process.removeListener('SIGTERM', previousHandlers.SIGTERM);
    process.removeListener('SIGINT', previousHandlers.SIGINT);
  }

  const handlers: ShutdownHandlers = {
    SIGTERM: () => shutdown('SIGTERM'),
    SIGINT: () => shutdown('SIGINT'),
  };
  process.on('SIGTERM', handlers.SIGTERM);
  process.on('SIGINT', handlers.SIGINT);
  processWithShutdownHandlers.__lifechatShutdownHandlers = handlers;
}

export { server, app };
