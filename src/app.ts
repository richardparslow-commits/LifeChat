/**
 * HTTP application construction for LifeChat.
 *
 * Everything a request can touch lives here: middleware, routes, and the
 * helpers they close over. Nothing in this module listens on a port, registers
 * process signal handlers, runs startup gates, or exits the process — that is
 * the entry point's job (src/index.ts). The split exists so the app can be
 * built without side effects: tests and future runtimes can import
 * `createApp()` and hand the result to a listener they own.
 */

import { createHash, timingSafeEqual } from 'crypto';
import compression from 'compression';
import express, { type Express, Request, Response } from 'express';
import path from 'path';
import {
  CONTENT_SECURITY_POLICY,
  HSTS_HEADER,
  staticCacheControl,
} from './security/security-headers';
import {
  config,
  PRODUCT_DEFINITION,
  isLicenseNumberConfigured,
  isAdminApiKeyConfigured,
  isRecordEncryptionKeyConfigured,
  isAllowedOrigin,
  isRecordStorageSafe,
} from './config/app-config';
import { isArchilStorageConfigured } from './archil/disk';
import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME, PROVIDER_BRAND } from './config/branding';
import { durableStorageStatus } from './config/durable-storage';
import { resolveTrustProxy } from './config/trust-proxy';
import {
  SYSTEM_PROMPT,
  getFirstMessageDisclosure,
  getContextualOpeningMessage,
  APPOINTMENT_DISCLAIMER,
  BEFORE_CHAT_BANNER,
  ABSTENTION_SENTENCE,
} from './prompts/system-prompt';
import {
  STATIC_SAFE_FALLBACK,
  MedicalProfileSchema,
  EMPTY_TURN_INTENT,
  type MedicalProfilePayload,
  type AssistantResponse,
} from './schema/response-schema';
import type { TopicCategory } from './schema/topic-category';
import {
  conditionSexFromGender,
  mapConsentedMedicalConditions,
  type ConditionMappingResult,
} from './medical/condition-crosswalk';
import { generateResponse } from './llm/orchestrator';
import { retrieveFromCorpus } from './rag/retrieval';
import { validateCard } from './cards/card-validation';
import {
  getHistory,
  addUserMessage,
  addAssistantMessage,
  getActiveSessionCount,
  clearSession,
  getDimeInputs,
  setDimeInputs,
  getPageContext,
  setPageContext,
  getSourceUrl,
  setSourceUrl,
  getSessionState,
  setSessionState,
  getMedicalConsentAffirmative,
  setMedicalConsentAffirmative,
  getSelectedSlot,
  setSelectedSlot,
  getLoopControlState,
  recordClarificationAttempt,
  resetClarificationAttempts,
  recordQualificationQuestion,
  recordOfferDeclined,
} from './llm/session-store';
import {
  ChatRequestSchema,
  ConsentRequestSchema,
  SlotSelectionSchema,
  contactFieldIsValid,
  validationError,
} from './schema/request-schema';
import {
  getNextState,
  resolveTurnState,
  type ConversationState,
} from './state-machine/state-machine';
import {
  buildDimeProgressContext,
  computeDimeEstimate,
  buildDimeResultMessage,
  countDimeInputs,
  dimeInputsComplete,
  mergeDimeInputs,
  nextDimeStep,
} from './estimator/dime-estimator';
import {
  createLeadRecord,
  saveLeadRecord,
  getJustInTimeNotice,
  getVerifiedContactConsent,
  RECOMMENDED_PHONE_CONSENT_COPY,
  RECOMMENDED_EMAIL_CONSENT_COPY,
} from './consent/consent-model';
import { canonicalContactConsentCopy, isApprovedContactConsentCopy } from './consent/consent-copy';
import { submitDsr, getDsrRecord, verifyDsrRecord, DSR_RESPONSE_SLA_DAYS } from './privacy/dsr';
import { isRecordEncryptionConfigured } from './privacy/record-encryption';
import {
  eraseSubject,
  sweepExpiredRecords,
  ErasureIncompleteError,
  type ErasureErrorCode,
} from './privacy/erasure';
import { exportLeads, LeadExportError, LEAD_EXPORT_HTTP_STATUS } from './privacy/lead-export';
import { recordAdminRead, type AdminReadRoute } from './privacy/admin-access-audit';
import {
  detectPromptInjection,
  detectSensitiveData,
  containsPersonalIdentifier,
  checkRateLimit,
  checkWriteRateLimit,
  checkChatClientLimit,
  incrementChatTokens,
  isKillSwitchActive,
  activateKillSwitch,
  deactivateKillSwitch,
} from './security/security-controls';
import {
  getStaffAvailabilityMessage,
  detectImmediateCrisis,
  EMERGENCY_RESPONSE,
} from './handoff/human-escalation';
import { executeProposedAction, ACTION_NOT_CONFIRMED_NOTE } from './tools/verified-actions';
import {
  SCHEDULING_TIME_ZONE,
  SLOT_DURATION_MINUTES,
  listAvailableSlots,
  verifySlot,
} from './scheduling/appointment-slots';
import { getComplianceOverview } from './compliance/classification-matrix';
import { injectContext } from './contextual/context-injection';
import { detectContextualInjection, validatePageContext } from './contextual/page-context';
import {
  generateStaticFallback,
  FALLBACK_MESSAGES,
  LATENCY_CONFIG,
} from './resilience/fallback-behavior';
// generateResponse orchestrator handles LLM + RAG + schema validation
import { sanitizeUrl, generateDataLayerSnippet, type AnalyticsEvent } from './analytics/analytics';

import { isDataPathsWritable } from './runtime-status';
import { logServerError, safeRequestPath } from './observability/safe-log';

/** Static assets the app serves (widget, demo page, trust-block CSS). */
/**
 * The checkout's public/ directory, when this module runs under Node.
 *
 * A Workers bundle has no `__dirname` and no checkout on disk: the platform's
 * asset binding serves those three files before the request reaches Express
 * (worker/sites-entry.mjs). The check keeps that runtime from throwing at
 * module evaluation while leaving the long-running server's path unchanged.
 */
const MODULE_DIR = typeof __dirname === 'string' ? __dirname : '';
export const PUBLIC_DIR = path.join(MODULE_DIR, '..', 'public');

/**
 * Builds the Express application.
 *
 * Every call returns a fresh app with its own middleware stack and route
 * table; module-level stores are shared, exactly as they are in a running
 * server.
 */
export function createApp(): Express {
  const app = express();

  // Do not advertise the framework on every response.
  app.disable('x-powered-by');

  // Proxy trust decides whether req.ip is a real client key (SEC-10). The
  // resolver supplies a Vercel edge default of one hop, refuses wildcard trust,
  // and leaves every other unset deployment trusting nothing. A numeric value
  // is a hop count; express keywords (loopback, linklocal, uniquelocal) are
  // passed as keywords — *not* as a one-entry subnet list, which Express would
  // reject as an invalid address and effectively ignore — and comma-separated
  // subnets pass through as a list.
  const trustProxy = resolveTrustProxy({
    raw: config.trustProxy,
    serverless: config.serverless,
    vercel: process.env.VERCEL === '1',
  });
  if (trustProxy.warning) {
    console.warn(trustProxy.warning);
  }
  if (trustProxy.setting !== false) {
    try {
      app.set('trust proxy', trustProxy.setting);
    } catch {
      // Express compiles the value on assignment and throws on an entry it
      // cannot parse. Fail closed and loudly: an invalid TRUST_PROXY must not
      // leave the process trusting headers (or 500 on every request).
      console.warn(
        `WARN: TRUST_PROXY="${config.trustProxy}" is not a valid hop count, keyword, ` +
          'IP, or subnet — ignoring it, so no proxy is trusted.',
      );
      app.set('trust proxy', false);
    }
  } else {
    app.set('trust proxy', false);
  }

  // Compress responses (SEC-16). Vercel's edge already negotiates gzip/brotli
  // for static assets, but Docker, Azure and `npm start` serve `public/`
  // through Express and were sending the 68 KB widget uncompressed. The
  // default 1 KB threshold leaves small JSON bodies alone, and the middleware
  // skips ranges, HEAD bodies and pre-compressed types itself.
  app.use(compression());

  app.use(express.json());

  /**
   * Baseline response headers.
   *
   * These harden the cases that are strictly ours: stop MIME sniffing, refuse
   * framing (the widget is a script, not an iframe, and the demo never embeds),
   * do not leak the referring URL, require HTTPS on later visits, constrain the
   * demo document, and keep API responses out of caches (several carry consent or
   * medical artifacts). The CSP travels with *our* responses only — a browser
   * enforces the host page's policy, not this one — so it does not restrict the
   * documented cross-origin widget embed, whose script response ignores a CSP.
   * The policy itself, and its Vercel copy, live in security-headers.ts.
   */
  app.use((_req: Request, res: Response, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', HSTS_HEADER);
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    next();
  });

  app.use('/api', (_req: Request, res: Response, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /**
   * CORS for the widget's cross-origin embed.
   *
   * The widget is served from this app but intended to run inside the blog page
   * (see `data-server-url` in public/widget.js), which is a different origin. The
   * allowlist is opt-in via ALLOWED_ORIGINS and empty by default, so the shipped
   * posture is same-origin only (the bundled demo page) and nothing else can call
   * the API from a browser until the embed origin is named explicitly.
   *
   * A disallowed origin gets no Access-Control-* headers (the browser blocks the
   * response) rather than a 403: same-origin and non-browser callers send no
   * Origin header at all, and a hard failure would make a misconfigured embed
   * look like an outage instead of a policy decision.
   */
  app.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin.length > 0) {
      // Vary regardless of the outcome so caches never serve one origin's
      // CORS decision to another.
      res.setHeader('Vary', 'Origin');
      if (isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
        res.setHeader('Access-Control-Max-Age', '600');
      }
    }
    if (req.method === 'OPTIONS') {
      // Preflight: answer without running any route logic. Allowed origins get
      // the headers above; others get an empty 204 the browser will reject.
      res.status(204).end();
      return;
    }
    next();
  });

  // Serve the widget static files. Under Workers the platform's ASSETS binding
  // answers these paths first, and there is no filesystem to serve from.
  // HTML revalidates; the unversioned JS/CSS get a bounded one-hour cache
  // rather than `immutable`, which their fixed filenames cannot justify.
  if (typeof __dirname === 'string') {
    app.use(
      express.static(PUBLIC_DIR, {
        etag: true,
        lastModified: true,
        setHeaders(res, filePath) {
          res.setHeader('Cache-Control', staticCacheControl(filePath));
        },
      }),
    );
  }

  /**
   * Admin auth middleware — protects internal/debug endpoints that expose the
   * system prompt, session history, session counts, or DSR status. When an
   * ADMIN_API_KEY is configured, requests must carry an x-admin-key header
   * matching it. When no key is configured the endpoints answer 503 in every
   * mode, including an explicit pilot: a missing variable is never an open
   * door (C-01). Pilot mode changes record encryption and storage posture; it
   * does not authenticate an admin caller.
   */
  /**
   * Constant-time comparison with no length oracle (SEC-09).
   *
   * A naive `===` on a secret leaks information through timing: an attacker can
   * measure how many leading characters matched. Both inputs are hashed to a
   * fixed 32 bytes first, so timingSafeEqual always compares equal-length
   * buffers and the time depends only on the algorithm — never on the length of
   * the supplied secret or on how many characters matched. That also removes the
   * throwing length-mismatch case, which would otherwise have to be handled
   * separately and could itself become an oracle.
   */
  function constantTimeEqual(a: string, b: string): boolean {
    const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
    return timingSafeEqual(digest(a), digest(b));
  }

  function requireAdminAuth(req: Request, res: Response): boolean {
    if (!isAdminApiKeyConfigured()) {
      // Fail closed in every mode. The boot gate refuses to *start* a
      // production process without a key, but an admin route must also never
      // be reachable merely because a variable is missing from an
      // already-running process (a restarted deployment with a dropped
      // secret, a stray `createApp()` caller, an imported handler under test).
      res.status(503).json({
        error: 'Admin authentication is not configured',
        message: 'Set ADMIN_API_KEY and restart.',
      });
      return false;
    }
    const provided = req.headers['x-admin-key'];
    if (typeof provided === 'string' && constantTimeEqual(provided, config.adminApiKey)) {
      return true;
    }
    res.status(401).json({
      error: 'Admin authentication required',
      message: 'Provide a valid x-admin-key header.',
    });
    return false;
  }

  /**
   * Records an admin read before its payload leaves the process (M-04).
   *
   * The entry is written first and the data second: if the write fails the
   * caller gets a 503 and no payload, because an unlogged disclosure is treated
   * like an unauthorised one. The lead export keeps its own richer entry (page
   * size, returned ids, suppression count) in the lead-access log.
   */
  async function auditAdminRead(
    res: Response,
    route: AdminReadRoute,
    recordId: string | null = null,
    status = 200,
  ): Promise<boolean> {
    if (await recordAdminRead({ route, recordId, status })) return true;
    res.status(503).json({
      error: 'Audit unavailable',
      message: 'The admin read could not be recorded in the access audit log, so it was refused.',
    });
    return false;
  }

  /**
   * Maps a lifecycle failure to a stable HTTP response.
   *
   * Known `ErasureIncompleteError` messages are safe to return: they name the
   * failure class and the log file, never record content. Unexpected errors are
   * logged server-side and reduced to a generic message, because an exception
   * from a filesystem call may carry paths an operator does not want echoed to
   * an admin client.
   */
  function sendLifecycleError(res: Response, error: unknown, action: string): Response {
    if (!(error instanceof ErasureIncompleteError)) {
      // Facts only: an unexpected error's message can carry a record path or a
      // fragment of the data that failed to parse (M-06).
      logServerError(`[lifecycle] ${action} failed`, error);
      return res.status(500).json({
        error: `${action} failed`,
        message: 'An unexpected error occurred. No records were changed.',
      });
    }

    const statuses: Record<ErasureErrorCode, number> = {
      request_not_found: 404,
      not_a_deletion: 400,
      not_verified: 409,
      already_fulfilled: 409,
      storage_unavailable: 503,
      undecodable_record: 500,
      malformed_record: 500,
      write_failed: 500,
    };

    return res.status(statuses[error.code]).json({
      error: `${action} incomplete`,
      code: error.code,
      message: error.message,
    });
  }

  /**
   * Builds the deterministic refusal+handoff response for sensitive data that
   * is blocked before it ever reaches the LLM (health and financial-account
   * data). The user's raw message is replaced by a redacted placeholder in
   * session history (Section 8: no PII in routine logs) and the reply routes to
   * the licensed-broker handoff with the sensitive_data_disclosed risk flag.
   *
   * @param assistantMessage - the refusal copy for this category
   * @param handoffReason - the machine-readable reason (e.g. health_data_disclosed)
   * @param summary - the PII-minimized handoff summary
   * @param topicCategory - optional topic category for the analytics event
   * @param riskFlags - the risk flags to set; the default records a health-data
   *   disclosure. A health TOPIC question uses its own flag, because nothing
   *   about the visitor's own health was disclosed and the compliance record has
   *   to say so accurately.
   */
  function buildSensitiveDataRefusalResponse(
    assistantMessage: string,
    handoffReason: string,
    summary: string,
    topicCategory: TopicCategory | null | undefined,
    originatingStage: string,
    riskFlags: string[] = ['sensitive_data_disclosed'],
  ): AssistantResponse {
    return {
      assistant_message: assistantMessage,
      state: 'handoff',
      intent: { ...EMPTY_TURN_INTENT },
      citations: [],
      lead_data: {
        first_name: null,
        email: null,
        phone: null,
        goal_category: null,
        timeline_category: null,
        current_coverage_category: null,
        policy_type_seeking: null,
        coverage_amount_seeking: null,
        contact_channel: null,
        time_zone: null,
        preferred_contact_window: null,
        medical_profile: null,
      },
      consent: {
        privacy_notice_version: config.privacyNoticeVersion,
        contact_consent_version: null,
        contact_consent_affirmed: false,
        medical_consent_version: null,
        medical_consent_affirmed: false,
        do_not_contact: false,
      },
      dime_estimator: {
        active: false,
        step: null,
        has_mortgage_or_debt: null,
        income_replacement_years: null,
        future_expenses: null,
        complete: false,
        range_min: null,
        range_max: null,
        range_label: null,
      },
      proposed_action: 'request_human_handoff',
      action_arguments: {
        handoff_reason: handoffReason,
        summary,
      },
      visual_card: null,
      risk_flags: riskFlags,
      analytics: {
        event_name: 'ai_handoff_request',
        topic_category: topicCategory ?? null,
        conversation_stage: originatingStage,
        fallback_type: null,
        handoff_reason: handoffReason,
        error_code: null,
      },
    };
  }

  /**
   * GET / — Health check and product info
   */
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      product: PRODUCT_DEFINITION.name,
      owner: PRODUCT_DEFINITION.owner,
      jurisdiction: PRODUCT_DEFINITION.initialJurisdiction,
      status: config.pilotMode ? 'pilot' : 'production',
      healthDataCollection: config.healthDataCollectionDisabled ? 'disabled' : 'enabled',
      outboundMarketing: config.outboundMarketingDisabled ? 'disabled' : 'enabled',
      endpoints: {
        chat: 'POST /api/chat',
        systemPrompt: 'GET /api/system-prompt',
        disclosure: 'GET /api/disclosure',
        consent: 'GET /api/consent-text',
        availability: 'GET /api/availability',
        health: 'GET /health',
      },
    });
  });

  /**
   * GET /health — Liveness only.
   *
   * Public and unauthenticated, so it answers three facts a load balancer or a
   * status page needs and nothing else (M-02). The readiness posture — model
   * and provider endpoint, record-storage verdict, proxy derivation, which
   * secrets are configured, the compliance matrix — is reconnaissance an
   * attacker would use to target the admin surface, so it moved to the
   * admin-gated route below.
   */
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      killSwitch: isKillSwitchActive(),
    });
  });

  /**
   * GET /api/admin/health — Readiness facts for an operator.
   *
   * Admin-gated (x-admin-key; mandatory in production). Booleans and
   * non-secret identifiers only — never a key value, never a filesystem path.
   */
  app.get('/api/admin/health', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;
    const payload = {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      killSwitch: isKillSwitchActive(),
      llm: {
        configured: config.llmApiKey.trim().length > 0,
        model: config.llmModel,
        baseUrl: config.llmApiBaseUrl,
      },
      dataPathsWritable: isDataPathsWritable() || isArchilStorageConfigured(),
      archilStorageConfigured:
        isArchilStorageConfigured() ||
        Boolean(process.env.ARCHIL_CONTAINER_ID && process.env.ARCHIL_DISK_ID),
      // Durability is a probe verdict, not a configured boolean (SEC-11).
      // `durable` is what the write guards consult; `reason` says why.
      recordStorage: {
        durable: isRecordStorageSafe(),
        verified: durableStorageStatus().verified,
        reason: durableStorageStatus().reason,
      },
      // What req.ip is derived from: a misconfigured proxy collapses every
      // client into one budget, and this is how an operator sees it (SEC-10).
      trustProxy: {
        setting: trustProxy.setting === false ? 'none' : trustProxy.setting,
        source: trustProxy.source,
      },
      recordEncryptionConfigured: isRecordEncryptionKeyConfigured(),
      adminApiKeyConfigured: isAdminApiKeyConfigured(),
      licenseNumberConfigured: isLicenseNumberConfigured(),
      compliance: getComplianceOverview(),
    };
    if (!(await auditAdminRead(res, 'GET /api/admin/health'))) return;
    res.json(payload);
  });

  /**
   * POST /api/admin/kill-switch — stop the assistant immediately.
   *
   * Admin-only (x-admin-key whenever ADMIN_API_KEY is configured, mandatory in
   * production). The kill switch previously had no runtime control: an operator
   * had to redeploy to stop the bot. Activation makes /api/chat return the
   * static safe fallback and reports staffed:false on /api/availability; the
   * model is never called while it is active.
   *
   * The optional reason is logged server-side (truncated) for the audit trail.
   * It is never echoed back or persisted to a record log.
   */
  app.post('/api/admin/kill-switch', (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;
    const alreadyActive = isKillSwitchActive();
    const rawReason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    const reason = rawReason.replace(/[\r\n]+/g, ' ').slice(0, 200);
    if (!alreadyActive) {
      activateKillSwitch();
      console.warn(`[kill-switch] ACTIVATED${reason ? ` — reason: ${reason}` : ''}`);
    }
    res.json({
      killSwitch: true,
      changed: !alreadyActive,
      message: alreadyActive ? 'Kill switch was already active' : 'Kill switch activated',
    });
  });

  /**
   * DELETE /api/admin/kill-switch — clear the kill switch and resume normal
   * responses. Admin-only, same enforcement as activation.
   */
  app.delete('/api/admin/kill-switch', (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;
    const wasActive = isKillSwitchActive();
    if (wasActive) {
      deactivateKillSwitch();
      console.warn('[kill-switch] CLEARED');
    }
    res.json({
      killSwitch: false,
      changed: wasActive,
      message: wasActive ? 'Kill switch cleared' : 'Kill switch was not active',
    });
  });

  /**
   * POST /api/admin/retention/sweep — Remove records past the retention period.
   *
   * Operator-triggered (a cron/CI job or a runbook step), never automatic in a
   * request path. `{ dryRun: true }` returns the counts without modifying
   * anything; `retentionDays` overrides the configured period for one run.
   */
  app.post('/api/admin/retention/sweep', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;

    const dryRun = req.body?.dryRun === true;
    const retentionDays =
      typeof req.body?.retentionDays === 'number' ? req.body.retentionDays : undefined;

    try {
      const receipt = await sweepExpiredRecords({ dryRun, retentionDays });
      return res.json(receipt);
    } catch (error) {
      return sendLifecycleError(res, error, 'Retention sweep');
    }
  });

  /**
   * GET /api/admin/leads — Paginated lead export (SEC-08).
   *
   * Admin-only. This is the read path that makes the handoff real: without it
   * the broker could retrieve a lead only with filesystem access and the
   * record-encryption key. `limit` is capped at 100 and `cursor` is the
   * `nextCursor` returned by the previous page.
   *
   * The log is the record set, so the export is not narrowed by the bounded
   * serving cache. A line that cannot be decoded fails the whole export rather
   * than returning a subset that looks complete, and each page is written to
   * the PII-free access audit log before it is returned — if that write fails,
   * the export is refused.
   */
  app.get('/api/admin/leads', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;

    try {
      const receipt = await exportLeads({ limit: req.query.limit, cursor: req.query.cursor });
      return res.json(receipt);
    } catch (error) {
      if (error instanceof LeadExportError) {
        return res.status(LEAD_EXPORT_HTTP_STATUS[error.code]).json({
          error: error.code.startsWith('invalid_') ? 'Invalid export query' : 'Lead export failed',
          code: error.code,
          message: error.message,
        });
      }
      // Deliberately narrow: an unexpected error's message may carry a path,
      // and this response is admin-only but still leaves the process.
      logServerError('Lead export failed', error);
      return res.status(500).json({ error: 'Lead export failed', code: 'export_failed' });
    }
  });

  /**
   * GET /api/system-prompt — Returns the hardened system prompt
   * (For admin/internal use only; should be protected in production)
   */
  app.get('/api/system-prompt', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;
    if (!(await auditAdminRead(res, 'GET /api/system-prompt'))) return;
    res.json({ systemPrompt: SYSTEM_PROMPT });
  });

  /**
   * GET /api/disclosure — Returns the first-message disclosure and banner
   *
   * The Texas license number is served ONLY when a real number is configured
   * (Texas Insurance Code §541.003 / TAC §19.1004). While unconfigured it is
   * null — never the placeholder — and the disclosure text omits the license
   * line (fail closed).
   *
   * Contextual Content Bridge: may accept optional `url`, `title`, `category`,
   * and `article_id` query params describing the page the user is reading. When
   * the bridge is enabled and the context is valid + maps to an article, the
   * returned firstMessage is enriched with the article-topic prompt (Section
   * 16.3) and the matched article is reported. A prompt-injection attempt in
   * the page title/category returns contextualInjection=true and is ignored.
   */
  app.get('/api/disclosure', (_req: Request, res: Response) => {
    const baseDisclosure = getFirstMessageDisclosure();
    let firstMessage = baseDisclosure;
    let contextualInjection = false;
    let articleId: string | null = null;

    if (config.contextualBridgeEnabled) {
      const url = typeof _req.query.url === 'string' ? _req.query.url : undefined;
      const title = typeof _req.query.title === 'string' ? _req.query.title : undefined;
      const category = typeof _req.query.category === 'string' ? _req.query.category : undefined;
      const article_id =
        typeof _req.query.article_id === 'string' ? _req.query.article_id : undefined;

      const raw = {
        ...(url !== undefined ? { url, title } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(article_id !== undefined ? { article_id } : {}),
      };

      // Prompt-injection guarded: detect a crafted title/category before any
      // content can reach the model. validatePageContext also rejects these, but
      // we capture the flag explicitly to report contextualInjection.
      const injectionAttempt =
        detectContextualInjection(title ?? '') || detectContextualInjection(category ?? '');

      const injection = injectContext(raw);
      contextualInjection = injectionAttempt;
      if (!injectionAttempt && injection.contextualPrompt !== null) {
        firstMessage = getContextualOpeningMessage(baseDisclosure, injection.contextualPrompt);
        articleId = injection.articleMapping?.articleId ?? null;
      }
    }

    res.json({
      firstMessage,
      contextualInjection,
      articleId,
      banner: BEFORE_CHAT_BANNER,
      // The brand hierarchy is server-owned so the widget renders the same
      // names the API and the privacy notice use.
      productName: PRODUCT_NAME,
      providerBrand: PROVIDER_BRAND,
      productDisplayName: PRODUCT_DISPLAY_NAME,
      businessName: config.businessName,
      licensedBrokerName: config.licensedBrokerName,
      texasLicenseNumber: isLicenseNumberConfigured() ? config.texasLicenseNumber : null,
      appointmentDisclaimer: APPOINTMENT_DISCLAIMER,
      appointedCarriers: config.appointedCarriers,
      privacyNoticeUrl: config.privacyNoticeUrl,
      privacyNoticeVersion: config.privacyNoticeVersion,
      dsrEmail: config.dsrEmail,
      contactUrl: config.contactUrl,
    });
  });

  /**
   * GET /api/consent-text — Returns the consent copy for counsel review
   */
  app.get('/api/consent-text', (_req: Request, res: Response) => {
    res.json({
      emailConsentCopy: RECOMMENDED_EMAIL_CONSENT_COPY,
      phoneConsentCopy: RECOMMENDED_PHONE_CONSENT_COPY,
      justInTimeNotice: getJustInTimeNotice(),
      privacyNoticeUrl: config.privacyNoticeUrl,
      privacyNoticeVersion: config.privacyNoticeVersion,
      contactConsentVersion: config.contactConsentVersion,
      dsrEmail: config.dsrEmail,
      note: 'The 1.1.0 consent copy is approved for use by the principal owner and licensed Texas broker (Richard Parslow, 2026-10-23).',
    });
  });

  /**
   * GET /api/availability — Returns staff availability status
   */
  app.get('/api/availability', (_req: Request, res: Response) => {
    res.json({
      staffed: !isKillSwitchActive(),
      message: getStaffAvailabilityMessage(),
    });
  });

  /**
   * POST /api/chat — Main chat endpoint
   *
   * Receives a user message, processes it through the security checks,
   * state machine, and returns a validated response.
   *
   * In Phase 1 (pilot), this endpoint processes messages and returns
   * educational responses or handoff offers. Lead capture and scheduling
   * are structured but may be gated behind phase flags.
   */
  app.post('/api/chat', async (req: Request, res: Response) => {
    // Runtime validation first (SEC-04). Unknown keys are stripped, so a
    // client-supplied currentState or medicalConsentAffirmative never reaches
    // the handler; failures answer with field names only, never the values.
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(validationError(parsed.error));
    }
    const { sessionId, message, sourceUrl, topicCategory } = parsed.data;

    // Server-authoritative state and medical consent (SEC-02). Both come from
    // the session store, never from the request body: a caller cannot inject
    // state='medical_review' or affirm consent by editing the payload.
    const currentState = getSessionState(sessionId);
    const medicalConsentAffirmed = getMedicalConsentAffirmative(sessionId);

    // Phase 2 gate: the consented medical fact-finding flow is inert unless
    // HEALTH_DATA_COLLECTION_DISABLED=false is set in .env (after counsel
    // approval). When disabled, the medical context flags are forced off and
    // health data shared in chat is blocked, exactly as in Phase 1.
    const medicalCaptureEnabled = !config.healthDataCollectionDisabled;

    // Contextual Content Bridge: persist validated page context on the first
    // message of a session (Section 3.2 — page context is sent once). Subsequent
    // messages reuse the stored context so the article stays prioritized for the
    // whole conversation. When the bridge is disabled, nothing is stored.
    if (config.contextualBridgeEnabled && !getPageContext(sessionId)) {
      const pageContext = parsed.data.page_context;
      if (pageContext !== undefined && pageContext !== null) {
        const validated = validatePageContext(pageContext);
        setPageContext(sessionId, validated);
      } else {
        setPageContext(sessionId, null);
      }
    }

    // 1. Check kill switch
    if (isKillSwitchActive()) {
      return res.json({
        ...STATIC_SAFE_FALLBACK,
        assistant_message: generateStaticFallback('kill_switch_active'),
      } as AssistantResponse);
    }

    // 2. Rate limiting. Two budgets, because they answer different questions:
    //    the session budget is fairness for one conversation, while the client
    //    budget (req.ip + a process-wide ceiling) is the only one a caller
    //    cannot escape by minting a fresh session id for every request.
    const clientKey = req.ip || 'unknown';
    const clientLimit = checkChatClientLimit(clientKey);
    const rateLimitResult = clientLimit.allowed
      ? checkRateLimit(sessionId)
      : { allowed: false, reason: clientLimit.reason };
    if (!rateLimitResult.allowed) {
      const response: AssistantResponse = {
        ...STATIC_SAFE_FALLBACK,
        assistant_message:
          "I've received a lot of messages in a short time. Please try again in a moment.",
        analytics: {
          ...STATIC_SAFE_FALLBACK.analytics,
          event_name: 'ai_error',
          error_code: rateLimitResult.reason || 'rate_limited',
        },
      };
      return res.status(429).json(response);
    }

    // 3. Security: detect prompt injection
    const injectionDetected = detectPromptInjection(message);
    if (injectionDetected) {
      // Record the (sanitized) user message and the assistant's response in history
      addUserMessage(sessionId, '[USER MESSAGE REDACTED — prompt injection attempt]', true);
      const response: AssistantResponse = {
        assistant_message:
          'I can help with general life-insurance education questions. What would you like to learn about?',
        state: 'education',
        intent: { ...EMPTY_TURN_INTENT },
        citations: [],
        lead_data: {
          first_name: null,
          email: null,
          phone: null,
          goal_category: null,
          timeline_category: null,
          current_coverage_category: null,
          policy_type_seeking: null,
          coverage_amount_seeking: null,
          contact_channel: null,
          time_zone: null,
          preferred_contact_window: null,
          medical_profile: null,
        },
        consent: {
          privacy_notice_version: config.privacyNoticeVersion,
          contact_consent_version: null,
          contact_consent_affirmed: false,
          medical_consent_version: null,
          medical_consent_affirmed: false,
          do_not_contact: false,
        },
        dime_estimator: {
          active: false,
          step: null,
          has_mortgage_or_debt: null,
          income_replacement_years: null,
          future_expenses: null,
          complete: false,
          range_min: null,
          range_max: null,
          range_label: null,
        },
        proposed_action: 'none',
        action_arguments: {},
        visual_card: null,
        risk_flags: ['prompt_injection_suspected'],
        analytics: {
          event_name: 'ai_error',
          topic_category: topicCategory || null,
          conversation_stage: currentState,
          fallback_type: null,
          handoff_reason: 'prompt_injection_suspected',
          error_code: 'prompt_injection_detected',
        },
      };
      addAssistantMessage(sessionId, response.assistant_message);
      return res.json(response);
    }

    // 4. Safety: a live crisis stops everything (Section 5 / ARCH-03). This runs
    //    before the medical gate on purpose: a present-tense crisis statement is
    //    an emergency, not a health-history disclosure, and the approved
    //    resources are the only useful answer. The raw message is neither sent
    //    to the model nor kept in history — it is exactly the kind of text the
    //    PII policy exists to keep out of logs.
    if (detectImmediateCrisis(message)) {
      setSessionState(sessionId, 'handoff');
      addUserMessage(sessionId, '[USER MESSAGE REDACTED — contained a crisis disclosure]', true);
      const response = buildSensitiveDataRefusalResponse(
        EMERGENCY_RESPONSE,
        'emergency_or_crisis',
        'Visitor reported immediate danger or a crisis; no emergency detail recorded',
        topicCategory,
        currentState,
        ['emergency_crisis_disclosed'],
      );
      addAssistantMessage(sessionId, response.assistant_message);
      return res.json(response);
    }

    // 5. Security: detect sensitive data
    const sensitiveDataCategory = detectSensitiveData(message);
    if (sensitiveDataCategory === 'health_data') {
      // Only the consented medical_review state may receive health details.
      // Everywhere else (and whenever the medical feature flag is off),
      // health data is blocked and routed to a licensed-broker handoff.
      if (!medicalCaptureEnabled || currentState !== 'medical_review' || !medicalConsentAffirmed) {
        setSessionState(sessionId, 'handoff');
        // Record a redacted user message and the assistant's handoff response
        addUserMessage(sessionId, '[USER MESSAGE REDACTED — contained health data]', true);
        const response = buildSensitiveDataRefusalResponse(
          `This chat isn't the right place for medical or health information. Please don't share diagnoses, medications, or health details here. If you need individualized guidance, Richard Parslow, a licensed Texas broker, can help through a secure process. ${ABSTENTION_SENTENCE}`,
          'health_data_disclosed',
          'User disclosed health information in public chat',
          topicCategory,
          currentState,
        );
        addAssistantMessage(sessionId, response.assistant_message);
        return res.json(response);
      }
    }

    // A health TOPIC question — an impersonal question about a condition ("Is TB
    // curable?", "What does TIA stand for?", "How is cancer treated?") — is
    // blocked and handed off like a disclosure, because the answer is clinical or
    // underwriting guidance, but it is NOT recorded or described as one. Nothing
    // about the visitor's health was disclosed, so telling them "don't share
    // diagnoses here" would be inaccurate, and flagging a health-data event would
    // overstate what the record contains. Message omitted from history for the
    // same reason as a disclosure: a later turn must not put a condition in front
    // of the model. Consented medical_review remains the only surface that
    // accepts either.
    if (sensitiveDataCategory === 'health_topic_question') {
      if (!medicalCaptureEnabled || currentState !== 'medical_review' || !medicalConsentAffirmed) {
        setSessionState(sessionId, 'handoff');
        addUserMessage(
          sessionId,
          '[USER MESSAGE OMITTED — health topic, no health data recorded]',
          true,
        );
        const response = buildSensitiveDataRefusalResponse(
          `That's a health topic, and I can't give medical or underwriting guidance on a condition in this chat. I can share approved general information about how life insurance works, and for case-specific answers Richard Parslow, a licensed Texas broker, can help through a secure process. ${ABSTENTION_SENTENCE}`,
          'health_topic_question',
          'Visitor asked about a health condition; no health data disclosed',
          topicCategory,
          currentState,
          ['health_topic_question'],
        );
        addAssistantMessage(sessionId, response.assistant_message);
        return res.json(response);
      }
    }

    // Financial-account data (bank routing/account numbers) is never needed for
    // general life-insurance education, so it is blocked the same way as health
    // data: redacted from history, deterministic licensed-broker handoff, no LLM
    // call, no storage of the number.
    if (sensitiveDataCategory === 'financial_account_data') {
      setSessionState(sessionId, 'handoff');
      addUserMessage(sessionId, '[USER MESSAGE REDACTED — contained financial-account data]', true);
      const response = buildSensitiveDataRefusalResponse(
        `This chat isn't the right place for financial-account or banking details. Please don't share account or routing numbers here. If you need to provide financial information, Richard Parslow, a licensed Texas broker, can help through a secure process. ${ABSTENTION_SENTENCE}`,
        'financial_account_data_disclosed',
        'User disclosed financial-account information in public chat',
        topicCategory,
        currentState,
      );
      addAssistantMessage(sessionId, response.assistant_message);
      return res.json(response);
    }

    // Direct personal identifiers (email, SSN, phone, card number) are never
    // needed in this chat: contact details are collected by /api/consent over a
    // consented, encrypted, durable path. A flagged message is blocked before
    // the orchestrator runs — it is neither sent to the model nor retained in
    // session history — and the visitor is handed off to the licensed broker.
    //
    // This check is independent of the category above on purpose. That
    // classifier returns one category, and health data outranks PII, so a
    // message naming a condition *and* an email is classified health_data,
    // which the consented medical_review flow is otherwise allowed to pass to
    // the model. Direct identifiers must never reach the model in any stage.
    if (containsPersonalIdentifier(message)) {
      setSessionState(sessionId, 'handoff');
      addUserMessage(sessionId, '[USER MESSAGE REDACTED — contained personal data]', true);
      const response = buildSensitiveDataRefusalResponse(
        `This chat isn't the right place for personal or financial identifiers like email addresses, phone numbers, SSNs, or card numbers. Please don't share them here. Richard Parslow, a licensed Texas broker, can collect contact details through a secure process. ${ABSTENTION_SENTENCE}`,
        'pii_disclosed',
        'User shared a direct personal identifier in public chat',
        topicCategory,
        currentState,
      );
      addAssistantMessage(sessionId, response.assistant_message);
      return res.json(response);
    }

    // 5. Sanitize the source URL (never send raw window.location.href with
    //    query-string PII). Store the sanitized canonical path on the session
    //    so it is available for lead records and handoff without re-parsing.
    if (sourceUrl) {
      const sanitizedPath = sanitizeUrl(sourceUrl);
      if (!getSourceUrl(sessionId)) {
        setSourceUrl(sessionId, sanitizedPath);
      }
    }

    // 6. Capture PRIOR conversation history for this session BEFORE recording
    //    the current message. buildMessages() also appends the current message
    //    as its own user turn, so recording-then-reading here would send the
    //    current turn TWICE to the LLM context.
    const conversationHistory = getHistory(sessionId);

    // 7. Record the current user message in session history (for FUTURE turns).
    //    Every PII-, financial- and (unconsented) health-flagged message has
    //    already returned above with a redacted placeholder, so what reaches
    //    this point cannot carry a direct identifier (Section 8).
    addUserMessage(sessionId, message);

    // 8. Resolve the state this turn is answered in (C-06).
    //
    //    The application owns the conversation state, and it is derived from
    //    two different sources at two different times:
    //
    //      - Before the model runs, only application-verified facts exist: a
    //        consent record /api/consent wrote for this session (channel
    //        chosen, consent affirmed), a slot the visitor recorded, and the
    //        medical/DIME request flags. `resolveTurnState` advances the flow
    //        on those alone; it never guesses the visitor's intent.
    //      - After the response is validated, the model's declared `intent`
    //        block decides the transition, subject to LOOP_CONTROLS. That
    //        decision is persisted in step 10d, after the response and any
    //        side effect have been handled — never before, so a failed turn
    //        cannot move the conversation.
    const loopControl = getLoopControlState(sessionId);
    const verifiedContactConsent = await getVerifiedContactConsent(sessionId);
    const contactConsentVerified = verifiedContactConsent.ok;
    const slotSelected = getSelectedSlot(sessionId) !== null;
    const sessionDimeInputs = getDimeInputs(sessionId);
    const turnState = resolveTurnState({
      currentState,
      userMessage: message,
      // Model-declared intent is unknown until the response is validated.
      hasValueBeenDelivered: false,
      userShowsInterest: false,
      queryIsAmbiguous: false,
      userAgreesToQualification: false,
      // Phase 2 medical capture — request-body flags honored only when the
      // feature flag is enabled; otherwise forced off (flow stays inert).
      userAgreesToMedicalReview: medicalCaptureEnabled
        ? (parsed.data.userAgreesToMedicalReview ?? false)
        : false,
      // Medical consent is server-authoritative: recorded by the consented
      // /api/consent flow for this session, never sent in the chat body.
      medicalConsentAffirmative: medicalCaptureEnabled ? medicalConsentAffirmed : false,
      medicalReviewComplete: medicalCaptureEnabled
        ? (parsed.data.medicalReviewComplete ?? false)
        : false,
      // DIME educational sub-flow — explicit request from the widget/future UI,
      // or automatic completion once all three inputs are collected.
      userRequestsDimeEstimator: parsed.data.userRequestsDimeEstimator ?? false,
      dimeComplete: dimeInputsComplete(sessionDimeInputs),
      userRequestsFollowup: false,
      contactChannelChosen: contactConsentVerified,
      consentAffirmative: contactConsentVerified,
      requiredFieldsValid: contactConsentVerified,
      userAsksToBook: slotSelected,
      bookingApiConfirms: false,
      // Sensitive-data categories are blocked and handed off above, before
      // the state machine runs, so nothing here needs a risk escalation.
      riskOrEscalationTrigger: false,
      userDeclinesOrFlowEnds: false,
      loopControl,
    });

    // 9. Run the LLM + RAG orchestrator (Sections 4.6, 4.8, 4.9, 4.11, 15)
    //    Passes conversation history so the model has context for follow-up
    //    questions. The orchestrator validates the response against the Zod
    //    schema, enforces cross-field consent rules, and falls back safely.
    //    While the DIME estimator is active, pass its progress as authoritative
    //    application context (Section 9.2).
    const inDimeFlow = turnState === 'dime_estimator' || currentState === 'dime_estimator';

    // Contextual Content Bridge (Section 16): inject the stored page context so
    // the current article is prioritized in RAG retrieval and the model receives
    // the allowlisted article facts as a user-role data block (SEC-12). When the
    // bridge is disabled or no valid context was stored, this is inert.
    const storedPageContext = getPageContext(sessionId);
    let contextualArticleId: string | null = null;
    let contextualArticleTopic: string | null = null;
    let contextualData: string | null = null;
    if (config.contextualBridgeEnabled && storedPageContext) {
      const contextual = injectContext(storedPageContext);
      contextualArticleId = contextual.articleMapping?.articleId ?? null;
      contextualArticleTopic = contextual.articleMapping?.topic ?? null;
      contextualData = contextual.contextualData;
    }

    const { response, latencyMs, tokenUsage } = await generateResponse({
      userMessage: message,
      currentState: turnState,
      conversationHistory,
      topicCategory,
      dimeContext: inDimeFlow ? buildDimeProgressContext(getDimeInputs(sessionId)) : undefined,
      contextualArticleId,
      contextualData,
      contextualArticleTopic,
    });

    // Feed real LLM token usage into the session's per-window budget so the
    // token cap actually enforces (previously tokenCount was never incremented
    // and the budget could never trip). Null on abstention/fallback paths that
    // made no successful LLM call.
    if (tokenUsage) {
      incrementChatTokens(sessionId, clientKey, tokenUsage.inputTokens + tokenUsage.outputTokens);
    }

    // 10. DIME estimator — merge collected inputs into the session, derive
    //     step/completion deterministically, and on completion override the
    //     message with the application-computed educational range. The model
    //     never produces dollar figures (Section 9.2).
    let finalResponse = response;
    // Application-owned transitions for this turn (DIME completion). Model
    // intent cannot override them, and the persisted state is derived from
    // this value below.
    let appState: ConversationState = turnState;
    if (response.dime_estimator.active) {
      const priorInputs = getDimeInputs(sessionId);
      const isDimeEntry = countDimeInputs(priorInputs) === 0;
      const merged = mergeDimeInputs(priorInputs, response.dime_estimator);
      setDimeInputs(sessionId, merged);

      if (dimeInputsComplete(merged)) {
        const estimate = computeDimeEstimate(merged);
        // The application owns this transition (the estimator completed).
        appState = 'contact_offer';
        finalResponse = {
          ...response,
          assistant_message: buildDimeResultMessage(estimate),
          state: 'contact_offer',
          dime_estimator: {
            active: true,
            step: null,
            ...merged,
            complete: true,
            // Carry the app-computed educational range as structured data so the
            // handoff can receive it; the model never produces these figures.
            range_min: estimate.min,
            range_max: estimate.max,
            range_label: estimate.rangeLabel,
          },
          analytics: {
            ...response.analytics,
            event_name: 'ai_dime_complete',
            conversation_stage: 'contact_offer',
          },
        };
      } else {
        finalResponse = {
          ...response,
          dime_estimator: {
            active: true,
            step: nextDimeStep(merged),
            ...merged,
            complete: false,
            range_min: null,
            range_max: null,
            range_label: null,
          },
          analytics: isDimeEntry
            ? { ...response.analytics, event_name: 'ai_dime_offer' }
            : response.analytics,
        };
      }
    }

    // 10b. Visual Rich Cards (Section 17) — resolve the model's card_id
    //     reference against the pre-approved library. The model never supplies
    //     card content; on any failure (unknown id, injection attempt, disallowed
    //     state, or cards disabled) no card is shown and the text stands alone.
    if (config.visualCardsEnabled) {
      const cardResult = validateCard(finalResponse.visual_card, turnState);
      const riskFlags = finalResponse.risk_flags ?? [];
      if (!cardResult.isValid && finalResponse.visual_card != null) {
        finalResponse = {
          ...finalResponse,
          visual_card: null,
          risk_flags: [...new Set([...riskFlags, 'card_validation_failed'])],
          analytics: {
            ...finalResponse.analytics,
            error_code: 'card_validation_failed',
          },
        };
      } else {
        finalResponse = {
          ...finalResponse,
          // The wire payload carries the resolved full card; the static schema
          // type only describes the model's reference, so the richer object is
          // cast at the API boundary.
          visual_card: cardResult.card as AssistantResponse['visual_card'],
        };
      }
    }

    // 10c. Tool authorization and execution (Section 4.8 / ARCH-02). The model
    //      may propose a side effect; only the application may authorize one.
    //      Everything the decision rests on is server-derived: the consent
    //      record /api/consent wrote for this session, the slot the visitor
    //      selected, and the appointment this process actually booked. The
    //      model's own `consent` block and `slot_id` are not evidence, and a
    //      proposal that fails any check is dropped, flagged, and — because the
    //      model's prose may already claim success — corrected in the message.
    const actionResult = await executeProposedAction({
      sessionId,
      proposedAction: finalResponse.proposed_action,
      actionArguments: finalResponse.action_arguments ?? {},
      doNotContact: finalResponse.consent.do_not_contact,
    });
    if (actionResult.authorized) {
      // Server-derived arguments only: anything else the model attached (lead
      // data, a handoff summary it invented, an idempotency key) is gone.
      finalResponse = {
        ...finalResponse,
        action_arguments: actionResult.sanitizedArguments,
      };
      if (actionResult.effect?.appointmentId) {
        // The booking is real, so the conversation moves to its confirmation
        // state; the app owns that transition, not the model's prose.
        setSessionState(sessionId, 'confirmation');
      }
    } else {
      const hadSideEffect =
        finalResponse.proposed_action === 'create_lead' ||
        finalResponse.proposed_action === 'book_appointment' ||
        finalResponse.proposed_action === 'send_transactional_confirmation';
      const message = finalResponse.assistant_message;
      finalResponse = {
        ...finalResponse,
        assistant_message:
          hadSideEffect && !message.includes(ACTION_NOT_CONFIRMED_NOTE)
            ? `${message} ${ACTION_NOT_CONFIRMED_NOTE}`.trim()
            : message,
        proposed_action: 'none',
        action_arguments: {},
        risk_flags: [...new Set([...(finalResponse.risk_flags ?? []), 'tool_action_blocked'])],
        analytics: {
          ...finalResponse.analytics,
          error_code: 'tool_action_blocked',
        },
      };
    }

    // 10d. Persist the server-derived state (C-06).
    //
    //      The transition comes from the validated `intent` block when the
    //      application has not already decided the turn, and it is subject to
    //      the loop controls read before the turn. The model's own `state`
    //      field is never used: it is a claim about itself, and persisting it
    //      is what left the UI and the server disagreeing.
    const intent = finalResponse.intent;
    const intentAssertsTransition =
      intent.value_delivered ||
      intent.needs_clarification ||
      intent.interest_in_contact ||
      intent.requests_contact ||
      intent.agrees_to_qualification ||
      intent.declines_or_ends;
    let decidedState: ConversationState = appState;
    if (appState === turnState && turnState === currentState && intentAssertsTransition) {
      decidedState =
        getNextState({
          currentState,
          userMessage: message,
          hasValueBeenDelivered: intent.value_delivered,
          userShowsInterest: intent.interest_in_contact,
          queryIsAmbiguous: intent.needs_clarification,
          userAgreesToQualification: intent.agrees_to_qualification,
          userAgreesToMedicalReview: medicalCaptureEnabled
            ? (parsed.data.userAgreesToMedicalReview ?? false)
            : false,
          medicalConsentAffirmative: medicalCaptureEnabled ? medicalConsentAffirmed : false,
          medicalReviewComplete: medicalCaptureEnabled
            ? (parsed.data.medicalReviewComplete ?? false)
            : false,
          userRequestsDimeEstimator: parsed.data.userRequestsDimeEstimator ?? false,
          dimeComplete: dimeInputsComplete(getDimeInputs(sessionId)),
          // An explicit request reopens contact even after a decline; soft
          // interest does not (it only feeds the qualification offer).
          userRequestsFollowup: contactConsentVerified || intent.requests_contact,
          contactChannelChosen: contactConsentVerified,
          consentAffirmative: contactConsentVerified,
          requiredFieldsValid: contactConsentVerified,
          userAsksToBook: slotSelected,
          bookingApiConfirms: false,
          riskOrEscalationTrigger: false,
          userDeclinesOrFlowEnds: intent.declines_or_ends,
          loopControl,
        }) ?? currentState;
    }

    // A verified side effect is the strongest fact about where the flow is:
    // a created lead reached lead_submit, a confirmed booking reached
    // confirmation. Both are server effects, not model claims.
    if (actionResult.effect?.leadId) {
      decidedState = 'lead_submit';
    }
    if (actionResult.effect?.appointmentId) {
      decidedState = 'confirmation';
    }

    // Loop-control bookkeeping. A turn that ends in `clarify` asked one
    // clarifying question; leaving `clarify` resolves the streak. A turn that
    // ends in `qualification` asked one qualification question (the cap is
    // enforced by getNextState above). A decline suppresses automatic offers.
    if (decidedState === 'clarify') {
      recordClarificationAttempt(sessionId);
    } else if (currentState === 'clarify' && decidedState !== 'handoff') {
      // The ambiguity resolved (or the visitor moved on). Escalating to a
      // handoff is the cap doing its job, so the streak is kept for the audit.
      resetClarificationAttempts(sessionId);
    }
    if (decidedState === 'qualification') {
      recordQualificationQuestion(sessionId);
    }
    const declinableStates: ConversationState[] = [
      'qualification_offer',
      'qualification',
      'medical_offer',
      'contact_offer',
    ];
    if (intent.declines_or_ends && declinableStates.includes(turnState)) {
      recordOfferDeclined(sessionId);
    }

    setSessionState(sessionId, decidedState);

    // 10e. Server-authoritative envelope (C-02). The model's `lead_data`,
    //      `consent`, and `state` are claims about itself. Every field a
    //      client or downstream consumer reads is replaced with the server's
    //      own facts: the verified consent record, the session state the route
    //      persisted, and the configured versions. A model that asserts
    //      contact or medical consent, invents an email, attaches a medical
    //      profile, or picks a state cannot change what the API returns.
    const verified = verifiedContactConsent.ok ? verifiedContactConsent.consent : null;
    finalResponse = {
      ...finalResponse,
      state: getSessionState(sessionId),
      lead_data: {
        first_name: null,
        email: verified?.email ?? null,
        phone: verified?.phone ?? null,
        goal_category: null,
        timeline_category: null,
        current_coverage_category: null,
        policy_type_seeking: null,
        coverage_amount_seeking: null,
        contact_channel: verified?.channel ?? null,
        time_zone: null,
        preferred_contact_window: null,
        // Never echo a medical profile back to the client.
        medical_profile: null,
      },
      consent: {
        privacy_notice_version: config.privacyNoticeVersion,
        contact_consent_version: verified?.version ?? null,
        contact_consent_affirmed: verified !== null,
        medical_consent_version: medicalConsentAffirmed ? config.medicalConsentVersion : null,
        medical_consent_affirmed: medicalConsentAffirmed,
        // The model may suppress contact; it may never grant it.
        do_not_contact: finalResponse.consent.do_not_contact === true,
      },
    };

    // 11. Record the assistant response in session history
    //     Only the assistant_message text is stored — never lead_data,
    //     consent fields, or risk_flags (Section 8: PII protection).
    addAssistantMessage(sessionId, finalResponse.assistant_message);

    // 12. Log latency (non-PII)
    if (latencyMs > LATENCY_CONFIG.P95_ANSWER_TARGET_MS) {
      console.warn(
        `Response latency ${latencyMs}ms exceeds P95 target ${LATENCY_CONFIG.P95_ANSWER_TARGET_MS}ms`,
      );
    }

    return res.json(finalResponse);
  });

  /**
   * POST /api/consent — Submit consent for lead capture
   * (Phase 2 — consented lead capture)
   */
  app.post('/api/consent', async (req: Request, res: Response) => {
    // Fail closed on a serverless runtime (SEC-01/SEC-11) unless the boot
    // probe proved the record directories survive the process: /tmp is
    // ephemeral, and a consent record is the legal proof of consent. A flag is
    // not evidence.
    if (!isRecordStorageSafe()) {
      return res.status(503).json({
        error: 'Storage unavailable',
        message:
          'Consent records cannot be stored on this runtime. Please contact Richard Parslow through the secure channel instead.',
      });
    }

    // Bounded per client: this endpoint is unauthenticated by design and each
    // accepted request appends a record to disk.
    const writeLimit = checkWriteRateLimit(req.ip || 'unknown');
    if (!writeLimit.allowed) {
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Please wait a moment before submitting again.',
        reason: writeLimit.reason,
      });
    }

    // Runtime validation (SEC-04/06) before any field is read; unknown keys are
    // stripped and rejected values are never echoed.
    const parsed = ConsentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(validationError(parsed.error));
    }
    const {
      contactConsentAffirmed,
      contactChannel,
      email,
      phone,
      firstName,
      sessionId,
      sourceUrl,
      articleId,
      topicCategory,
      consentText,
    } = parsed.data;

    if (!contactConsentAffirmed) {
      return res.status(400).json({
        error: 'Affirmative consent required',
        message: FALLBACK_MESSAGES.CONTACT_REFUSAL,
      });
    }

    // Validate the selected channel's field server-side.
    if (!contactFieldIsValid(parsed.data)) {
      return res.status(400).json({
        error: contactChannel === 'email' ? 'Invalid email format' : 'Invalid phone format',
      });
    }

    // The artefact must prove the approved disclosure, not merely that some
    // text arrived. Compare against the server-owned copy for this channel and
    // persist the canonical text's hash below.
    if (!isApprovedContactConsentCopy(consentText, contactChannel)) {
      return res.status(400).json({
        error: 'Consent copy mismatch',
        message:
          'Consent was not recorded because the submitted disclosure does not match the approved copy. Please reload the page and try again.',
      });
    }

    // Phase 2 — consented medical profile (optional). The medical facts the user
    // provided inside the chat's consented medical_review flow are submitted
    // here, alongside the consent control they affirmed. Every rule that governs
    // medical data is applied before anything is created, and every failure
    // returns WITHOUT saving a lead, so an unconsented profile can never reach
    // storage:
    //   1. the flow must be enabled (HEALTH_DATA_COLLECTION_DISABLED=false);
    //   2. consent must be affirmative AND versioned (an unversioned or missing
    //      version is not consent);
    //   3. the profile must match the approved field set exactly.
    // The stated conditions are then canonicalized through the ICD-10-CM
    // crosswalk so the broker can match and query the profile. The user's own
    // wording is preserved verbatim; unmatched conditions are left un-mapped
    // rather than guessed onto a code.
    const medicalCapturable = !config.healthDataCollectionDisabled;
    const medicalProfileInput: unknown = parsed.data.medicalProfile ?? null;
    const medicalConsentAffirmed = parsed.data.medicalConsentAffirmed === true;
    const medicalConsentVersion = parsed.data.medicalConsentVersion ?? null;
    const medicalPayloadPresent = medicalProfileInput !== null || medicalConsentAffirmed;

    // Consented medical data, resolved and crosswalked — persisted with the lead
    // record below. Null when the request carried no medical payload.
    let consentedMedical: {
      profile: MedicalProfilePayload;
      mapping: ConditionMappingResult;
      consentVersion: string;
    } | null = null;

    if (medicalPayloadPresent) {
      if (!medicalCapturable) {
        return res.status(400).json({
          error: 'Medical capture is disabled',
          message:
            'Medical information cannot be collected right now. Please contact Richard Parslow, a licensed Texas broker, to share it through a secure process.',
        });
      }

      // SEC-18: a consented medical profile is TDPSA sensitive data and is
      // never written in plaintext — not even in pilot mode. Refusing here,
      // before canonicalization and before a lead record exists, means an
      // operator who enables the flow without a RECORD_ENCRYPTION_KEY gets a
      // visible refusal rather than health data on disk in clear.
      if (!isRecordEncryptionConfigured()) {
        return res.status(503).json({
          error: 'Secure storage unavailable',
          message:
            'Medical information cannot be stored securely right now. Please contact Richard Parslow, a licensed Texas broker, to share it through a secure process.',
        });
      }

      const parsedMedical = MedicalProfileSchema.safeParse(medicalProfileInput);
      if (!parsedMedical.success) {
        return res.status(400).json({ error: 'Invalid medical profile' });
      }

      const mapping = mapConsentedMedicalConditions({
        medicalConditions: parsedMedical.data.medical_conditions,
        consent: {
          medical_consent_affirmed: medicalConsentAffirmed,
          medical_consent_version: medicalConsentVersion,
        },
        healthDataCollectionDisabled: config.healthDataCollectionDisabled,
        // Sex comes from the profile the person filled in — "other",
        // "prefer_not_to_say" and an absent answer are all unknown, which defers
        // the codebook's split rows rather than inferring one.
        sex: conditionSexFromGender(parsedMedical.data.gender),
      });
      if (mapping === null || medicalConsentVersion !== config.medicalConsentVersion) {
        return res.status(400).json({
          error: 'Affirmative current medical consent required',
          message:
            'Optional medical information was not stored because medical consent was not affirmed with the current consent version.',
        });
      }

      consentedMedical = {
        profile: parsedMedical.data,
        mapping,
        // The server's current version, not the caller's label for it.
        consentVersion: config.medicalConsentVersion,
      };
    }

    // Prefer the sanitized canonical path already stored on the session by
    // /api/chat (context bridge, Section 3.2): it is validated and has query
    // params stripped. Fall back to re-sanitizing the request body when the
    // consent form submits without a session id, or before any message in the
    // session carried a sourceUrl. The stored path is never re-sanitized —
    // sanitizeUrl expects a full URL and would degrade a bare pathname to
    // '/unknown'.
    const storedSourcePath = sessionId ? getSourceUrl(sessionId) : null;
    const sourcePath = storedSourcePath ?? sanitizeUrl(sourceUrl || '');

    // Create lead record
    const lead = createLeadRecord(articleId || 'unknown', sourcePath, topicCategory || 'general');

    lead.first_name = firstName || null;
    lead.email = email || null;
    lead.phone = phone || null;
    lead.contact_channel = contactChannel ?? null;
    // The session binding is what lets /api/chat verify this consent later: a
    // record created by this route, carrying this session id, is proof the
    // visitor submitted the form. Nothing else in the chat path can assert it.
    lead.session_id = sessionId ?? null;
    lead.contact_consent_version = config.contactConsentVersion;
    lead.consent_timestamp = new Date().toISOString();
    // The approved copy the visitor affirmed, committed to a SHA-256 digest.
    // Hashing the canonical text (not the submitted string) is what makes the
    // record a proof of which disclosure was shown. The copy itself is never
    // persisted with the record.
    lead.consent_text_hash = createHash('sha256')
      .update(canonicalContactConsentCopy(contactChannel), 'utf8')
      .digest('hex');

    // Phase 2 medical profile — stored only on the consented path resolved above.
    // Canonical refs are additive (the stated conditions stay verbatim) and are
    // TDPSA sensitive health data: operational record only, never analytics.
    if (consentedMedical !== null) {
      lead.medical_profile = {
        ...consentedMedical.profile,
        canonical_conditions: consentedMedical.mapping.canonical,
      };
      lead.medical_consent_version = consentedMedical.consentVersion;
      lead.medical_consent_timestamp = new Date().toISOString();
    }

    // Persist the lead record (with its consent artifact) so the broker can
    // retrieve it and the record survives for the TDPSA retention window.
    // Fail closed: never acknowledge consent if the durable write failed —
    // the lead is the consent proof, so a lost write must not be confirmed.
    if (!(await saveLeadRecord(lead))) {
      return res.status(500).json({
        error: 'Lead storage failed',
        message: 'We could not securely store your information right now. Please try again later.',
      });
    }

    // Bind the server-side medical consent to the chat session so
    // /api/chat can authorize medical_review without trusting the body (SEC-02).
    if (consentedMedical !== null && sessionId) {
      setMedicalConsentAffirmative(sessionId, true);
    }

    // The visitor just submitted the consent form, which is exactly what the
    // state machine's `consent` state represents. Recording it here keeps the
    // contact flow reachable: otherwise the session never leaves `education`,
    // and a follow-up turn is answered from the knowledge base instead of
    // being allowed to reach the (verified) lead path.
    if (sessionId) {
      setSessionState(sessionId, 'consent');
    }

    return res.json({
      leadId: lead.lead_id,
      status: 'created',
      message: 'Your information has been received. Richard Parslow will follow up with you.',
    });
  });

  /**
   * POST /api/dsr — Submit a data subject request (TDPSA consumer rights)
   *
   * Accepts access, deletion, correction, and portability requests. Creates a
   * validated record and returns an acknowledgment with the TDPSA response
   * window. No PII is placed in analytics; the record is stored in the
   * operational system (in-memory for the pilot).
   */
  app.post('/api/dsr', async (req: Request, res: Response) => {
    // Fail closed on a serverless runtime (SEC-01/SEC-11) unless durability was
    // verified at boot: a TDPSA request carries a response deadline, so it must
    // never be accepted into ephemeral storage.
    if (!isRecordStorageSafe()) {
      return res.status(503).json({
        error: 'Storage unavailable',
        message: `Data subject requests cannot be stored on this runtime. Please email ${config.dsrEmail} directly.`,
      });
    }

    // Bounded per client, same reasoning as /api/consent: unauthenticated, and
    // each accepted request appends a durable record.
    const writeLimit = checkWriteRateLimit(req.ip || 'unknown');
    if (!writeLimit.allowed) {
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Please wait a moment before submitting again.',
        reason: writeLimit.reason,
      });
    }

    const result = await submitDsr({
      requestType: req.body.requestType,
      contactEmail: req.body.contactEmail,
      detail: req.body.detail ?? null,
    });

    if (!result.ok) {
      // Validation failures are client errors (400). A failure to durably
      // store the request is a transient server-side condition (503): the
      // consumer must be able to retry rather than treat it as permanent.
      const storageFailure = result.reason.startsWith('We could not securely store');
      return res.status(storageFailure ? 503 : 400).json({
        error: storageFailure ? 'Storage unavailable' : 'Invalid data subject request',
        reason: result.reason,
      });
    }

    // A detail that could not be stored encrypted is reported rather than
    // silently dropped: the consumer should know to send it by email (M-09),
    // and the operator sees `detail_withheld` on the record.
    const detailWithheld = result.record.detail_withheld === true;
    const withheldNote = detailWithheld
      ? `Your free-text detail was not stored because this deployment does not encrypt records; please email ${config.dsrEmail} if you need to include it. `
      : '';
    return res.json({
      requestId: result.record.request_id,
      status: result.record.status,
      requestType: result.record.request_type,
      responseWithinDays: DSR_RESPONSE_SLA_DAYS,
      detailWithheld,
      message: `We received your ${result.record.request_type} request. We will respond to ${result.record.contact_email} within ${DSR_RESPONSE_SLA_DAYS} days. ${withheldNote}You can also email ${config.dsrEmail} directly.`,
    });
  });

  /**
   * POST /api/dsr/:requestId/verify — Confirm the requester controls the
   * address, which is what lets a deletion request suppress contact.
   *
   * Operator-only: the public intake cannot prove control of an address, so
   * self-verification would let anyone disable a real lead's contact path.
   */
  app.post('/api/dsr/:requestId/verify', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;

    const existing = await getDsrRecord(req.params.requestId);
    if (!existing) {
      return res.status(404).json({ error: 'DSR request not found' });
    }

    const record = await verifyDsrRecord(req.params.requestId);
    if (!record) {
      // The record exists but the verification could not be durably written;
      // acknowledging it would let the suppression revert on restart.
      return res.status(503).json({
        error: 'Storage unavailable',
        message: 'The verification could not be stored. Please retry.',
      });
    }

    return res.json({
      requestId: record.request_id,
      status: record.status,
      verified: record.verified,
      verifiedAt: record.verified_at,
    });
  });

  /**
   * POST /api/dsr/:requestId/erase — Fulfil a verified deletion request.
   *
   * The address is derived from the stored DSR, never from the body, so one
   * verified request cannot be used to erase somebody else's records. The
   * operation is fail-closed: if any line cannot be decoded the logs are left
   * untouched and the operator sees a 500 with a safe explanation.
   */
  app.post('/api/dsr/:requestId/erase', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;

    try {
      const receipt = await eraseSubject({ requestId: req.params.requestId });
      return res.json({ status: 'fulfilled', ...receipt });
    } catch (error) {
      return sendLifecycleError(res, error, 'Erasure');
    }
  });

  /**
   * GET /api/dsr/:requestId — DSR request status (admin/debug)
   */
  app.get('/api/dsr/:requestId', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;
    // Cache-first, but a cache miss reloads the record from the JSONL log, so
    // an operator lookup is never narrowed by in-memory cache pressure.
    const record = await getDsrRecord(req.params.requestId);
    if (!record) {
      return res.status(404).json({ error: 'DSR request not found' });
    }
    if (!(await auditAdminRead(res, 'GET /api/dsr/:requestId', record.request_id))) return;
    return res.json({
      requestId: record.request_id,
      status: record.status,
      verified: record.verified === true,
      verifiedAt: record.verified_at,
      fulfilledAt: record.fulfilled_at,
      requestType: record.request_type,
      createdAt: record.created_at,
    });
  });

  /**
   * GET /api/analytics/example — Returns example GTM dataLayer snippets
   */
  app.get('/api/analytics/example', (_req: Request, res: Response) => {
    res.json({
      event: 'ai_fallback_shown' as AnalyticsEvent,
      dataLayerSnippet: generateDataLayerSnippet('ai_fallback_shown', {
        fallback_type: 'contact_declined',
        conversation_stage: 'contact_offer',
        article_id: 'policy-laddering-001',
      }),
      note: 'Push this to window.dataLayer at the verified application state transition, not when the model merely writes fallback words.',
    });
  });

  /**
   * GET /api/rag/search — Test RAG retrieval without calling the LLM
   * Useful for verifying the corpus and retrieval quality.
   * Query param: ?q=your+search+query
   */
  app.get('/api/rag/search', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;
    const query = (req.query.q as string) || '';
    if (!query.trim()) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const result = retrieveFromCorpus(query);
    // The question itself is never recorded: it can carry anything the caller
    // typed, including an address or a health detail.
    if (!(await auditAdminRead(res, 'GET /api/rag/search'))) return;
    res.json({
      query,
      hasSufficientEvidence: result.hasSufficientEvidence,
      passageCount: result.passages.length,
      passages: result.passages.map((p) => ({
        title: p.title,
        url: p.url,
        jurisdiction: p.jurisdiction,
        priority: p.priority,
        score: p.score,
        contentPreview: `${p.content.slice(0, 200)}...`,
      })),
    });
  });

  /**
   * GET /api/session/:sessionId/history — Returns conversation history (admin/debug)
   */
  app.get('/api/session/:sessionId/history', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;
    const history = getHistory(req.params.sessionId);
    if (!(await auditAdminRead(res, 'GET /api/session/:sessionId/history', req.params.sessionId))) {
      return;
    }
    res.json({
      sessionId: req.params.sessionId,
      turnCount: history.length,
      messages: history,
    });
  });

  /**
   * DELETE /api/session/:sessionId — Clears a session's conversation history
   * Used for privacy withdrawal (Section 8: consent withdrawal / deletion route).
   */
  app.delete('/api/session/:sessionId', (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;
    clearSession(req.params.sessionId);
    // Conversation state only. This deliberately does not withdraw consent:
    // the lead record is the legal consent artifact, and erasing it needs the
    // durable, auditable path — a deletion DSR, which the action layer checks
    // on every authorization (src/tools/verified-actions.ts).
    res.json({ sessionId: req.params.sessionId, status: 'cleared' });
  });

  /**
   * GET /api/scheduling/slots — Bookable appointment slots.
   *
   * Times are generated server-side from staffed hours, the notice window, and
   * the booking horizon, and already-booked slots are excluded. The visitor
   * selects one through POST /api/scheduling/select; the model never supplies
   * a slot the server did not issue.
   */
  app.get('/api/scheduling/slots', (req: Request, res: Response) => {
    const limit = checkRateLimit(req.ip || 'unknown');
    if (!limit.allowed) {
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Please wait a moment before checking availability again.',
        reason: limit.reason,
      });
    }

    const slots = listAvailableSlots();
    return res.json({
      timeZone: SCHEDULING_TIME_ZONE,
      slotDurationMinutes: SLOT_DURATION_MINUTES,
      slots,
    });
  });

  /**
   * POST /api/scheduling/select — Records the visitor's chosen slot.
   *
   * Verification happens here and again at booking, so a slot that was taken
   * in between is refused rather than double-booked. This endpoint books
   * nothing: it is the server-side record of a user choice that
   * `book_appointment` must then name.
   */
  app.post('/api/scheduling/select', (req: Request, res: Response) => {
    const limit = checkWriteRateLimit(req.ip || 'unknown');
    if (!limit.allowed) {
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Please wait a moment before selecting a time.',
        reason: limit.reason,
      });
    }

    const parsed = SlotSelectionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(validationError(parsed.error));
    }

    const verification = verifySlot(parsed.data.slotId);
    if (!verification.ok) {
      const taken = verification.code === 'slot_already_booked';
      return res.status(taken ? 409 : 400).json({
        error: taken ? 'Slot unavailable' : 'Slot not bookable',
        code: verification.code,
        message: taken
          ? 'That time has just been taken. Please choose another.'
          : 'That time cannot be booked. Please choose one of the available times.',
      });
    }

    setSelectedSlot(parsed.data.sessionId, verification.slot.slot_id);
    // A chosen time is a scheduling turn: the next message is about booking,
    // not a knowledge-base question, so the state machine must reflect it.
    setSessionState(parsed.data.sessionId, 'scheduling');
    return res.json({
      sessionId: parsed.data.sessionId,
      slotId: verification.slot.slot_id,
      startsAt: verification.slot.starts_at,
      timeZone: verification.slot.time_zone,
      selected: true,
    });
  });

  /**
   * GET /api/sessions — Returns active session count (admin/monitoring)
   */
  app.get('/api/sessions', async (req: Request, res: Response) => {
    if (!requireAdminAuth(req, res)) return;
    const activeSessions = getActiveSessionCount();
    if (!(await auditAdminRead(res, 'GET /api/sessions'))) return;
    res.json({ activeSessions });
  });

  /**
   * JSON 404 for unknown routes.
   *
   * Express's default 404 is an HTML page ("Cannot GET /api/nope"), which the
   * widget and any API client cannot parse — a sandbox probe or a mistyped path
   * showed up as an opaque HTML body. API paths always answer in JSON; other
   * paths get a plain-text line (no HTML, nothing to misrender).
   */
  app.use((req: Request, res: Response) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Not found', path: req.path });
      return;
    }
    res.status(404).type('text/plain').send('Not found');
  });

  /**
   * Terminal error handler — the last middleware in the stack.
   *
   * Three things this fixes over Express's default handler: malformed JSON in a
   * request body is answered with a small JSON 400 instead of an HTML page (the
   * default error page embeds the parser message and, outside production, a stack
   * trace with absolute paths); every other failure is answered 500 with a stable
   * JSON shape and no internal detail; and the failure is logged server-side as
   * facts rather than shipped — or copied — anywhere.
   *
   * The error itself is never logged (M-06): a body-parser failure quotes a
   * fragment of the rejected body in its message, so `console.error(err)` put
   * whatever the visitor typed into the platform's log store. Name, code,
   * status, type, method and the route shape are enough to diagnose it.
   */
  app.use((err: unknown, req: Request, res: Response, next: (error?: unknown) => void) => {
    // Headers already sent: hand back to Express, which will destroy the socket.
    if (res.headersSent) {
      next(err);
      return;
    }

    const anyErr = err as {
      status?: unknown;
      statusCode?: unknown;
      type?: unknown;
      message?: unknown;
    };
    const candidate =
      typeof anyErr?.status === 'number'
        ? anyErr.status
        : typeof anyErr?.statusCode === 'number'
          ? anyErr.statusCode
          : undefined;
    const isBodyParseError = anyErr?.type === 'entity.parse.failed';
    const status = isBodyParseError
      ? 400
      : candidate && candidate >= 400 && candidate < 600
        ? candidate
        : 500;

    if (status >= 500) {
      logServerError('[http] unhandled request error', err, {
        method: req.method,
        path: safeRequestPath(req.path),
        status,
      });
    }

    res.status(status).json({
      error: isBodyParseError
        ? 'Invalid JSON body'
        : status === 413
          ? 'Payload too large'
          : status >= 500
            ? 'Internal server error'
            : 'Request could not be processed',
    });
  });

  return app;
}
