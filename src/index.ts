/**
 * Life Policy Pilot AI Educational Assistant — Main Entry Point
 *
 * This server implements the compliance-first architecture described in the
 * "Deep-Research Review and Rewritten Specification" document.
 *
 * Phases (Section 6):
 *   Phase 0 — compliance design (counsel classification)
 *   Phase 1 — educational pilot (RAG over approved sources only)
 *   Phase 2 — consented lead capture
 *   Phase 3 — scheduling
 *   Phase 4 — controlled optimization
 *
 * This implementation is structured for Phase 1 (educational pilot) with
 * the architecture in place for later phases.
 */

// Load .env before any module reads process.env (must be the first import)
import 'dotenv/config';

import { timingSafeEqual } from 'crypto';
import type { Server } from 'http';
import { accessSync, constants, existsSync, mkdirSync } from 'fs';
import express, { Request, Response } from 'express';
import path from 'path';
import {
  config,
  PRODUCT_DEFINITION,
  isLicenseNumberConfigured,
  isAdminApiKeyConfigured,
  isRecordEncryptionKeyConfigured,
  isAllowedOrigin,
} from './config/app-config';
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
  type MedicalProfilePayload,
  type AssistantResponse,
} from './schema/response-schema';
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
  startSessionCleanup,
  getActiveSessionCount,
  clearSession,
  getDimeInputs,
  setDimeInputs,
  getPageContext,
  setPageContext,
  getSourceUrl,
  setSourceUrl,
} from './llm/session-store';
import { getNextState, type ConversationState } from './state-machine/state-machine';
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
  validateEmail,
  validatePhone,
  getJustInTimeNotice,
  RECOMMENDED_PHONE_CONSENT_COPY,
} from './consent/consent-model';
import { submitDsr, getDsrRecord, DSR_RESPONSE_SLA_DAYS } from './privacy/dsr';
import {
  detectPromptInjection,
  detectSensitiveData,
  checkRateLimit,
  checkWriteRateLimit,
  incrementTokenCount,
  isKillSwitchActive,
  activateKillSwitch,
  deactivateKillSwitch,
  startRateLimitCleanup,
} from './security/security-controls';
import { getStaffAvailabilityMessage } from './handoff/human-escalation';
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

const app = express();

/**
 * Set by the startup preflight (see the bottom of this module) and reported on
 * /health. False means a record log's directory could not be created or written
 * to — the app still starts (fail-closed writes already surface per request),
 * but an operator should see it immediately rather than on first submission.
 */
let dataPathsWritable = true;

// Do not advertise the framework on every response.
app.disable('x-powered-by');

app.use(express.json());

/**
 * Baseline response headers.
 *
 * Deliberately a small, dependency-free set rather than a full CSP: the server
 * returns JSON plus two static assets, and the widget is designed to be
 * embedded in third-party pages, so a restrictive frame/CSP policy here would
 * break the documented embed pattern for no gain. These three headers harden
 * the cases that are strictly ours — stop MIME sniffing, do not leak the
 * referring URL, and never let a CDN or proxy cache API responses (several
 * carry consent or medical artifacts).
 */
app.use((_req: Request, res: Response, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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

// Serve the widget static files
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

/**
 * Admin auth middleware — protects internal/debug endpoints that expose the
 * system prompt, session history, session counts, or DSR status. When an
 * ADMIN_API_KEY is configured, requests must carry an x-admin-key header
 * matching it. When no key is configured (pilot/dev), the endpoints remain
 * accessible so local development is not blocked.
 *
 * In production mode (PILOT_MODE=false) startup fails fast unless a key is
 * set, so this middleware is always enforced in production.
 */
/**
 * Constant-time string comparison for the admin key.
 *
 * A naive `===` on a secret leaks information through timing: an attacker can
 * measure how many leading characters matched. timingSafeEqual runs in time
 * proportional to the buffer length regardless of match position; on a length
 * mismatch we still burn a comparable comparison before rejecting so the
 * length of the configured key is not observable either.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function requireAdminAuth(req: Request, res: Response): boolean {
  if (!isAdminApiKeyConfigured()) {
    return true; // No key configured — allow (pilot/dev mode)
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
  topicCategory: string | null | undefined,
  originatingStage: string,
  riskFlags: string[] = ['sensitive_data_disclosed'],
): AssistantResponse {
  return {
    assistant_message: assistantMessage,
    state: 'handoff',
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
 * GET /health — Simple health check, plus the compliance matrix overview
 * with per-flow approval status (Phase 0: counsel classification).
 */
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    killSwitch: isKillSwitchActive(),
    // Readiness facts an operator or sandbox can check without reading logs.
    // Booleans and non-secret identifiers only — never the key, never a path.
    llm: {
      configured: config.llmApiKey.trim().length > 0,
      model: config.llmModel,
      baseUrl: config.llmApiBaseUrl,
    },
    dataPathsWritable,
    recordEncryptionConfigured: isRecordEncryptionKeyConfigured(),
    adminApiKeyConfigured: isAdminApiKeyConfigured(),
    licenseNumberConfigured: isLicenseNumberConfigured(),
    compliance: getComplianceOverview(),
  });
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
 * GET /api/system-prompt — Returns the hardened system prompt
 * (For admin/internal use only; should be protected in production)
 */
app.get('/api/system-prompt', (req: Request, res: Response) => {
  if (!requireAdminAuth(req, res)) return;
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
    phoneConsentCopy: RECOMMENDED_PHONE_CONSENT_COPY,
    justInTimeNotice: getJustInTimeNotice(),
    privacyNoticeUrl: config.privacyNoticeUrl,
    privacyNoticeVersion: config.privacyNoticeVersion,
    contactConsentVersion: config.contactConsentVersion,
    dsrEmail: config.dsrEmail,
    note: 'All consent text must be reviewed and approved by Texas insurance counsel before use.',
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
interface ChatRequestBody {
  sessionId: string;
  message: string;
  currentState: ConversationState;
  sourceUrl?: string;
  articleId?: string;
  topicCategory?: string;
  /** Phase 2 medical capture — only honored when the feature flag is enabled */
  userAgreesToMedicalReview?: boolean;
  medicalConsentAffirmative?: boolean;
  medicalReviewComplete?: boolean;
  /** DIME educational sub-flow — user asked to estimate coverage needs */
  userRequestsDimeEstimator?: boolean;
  /**
   * Contextual Content Bridge — page being viewed. Optional, sent with the
   * first message of a session. Treated as untrusted data and stored per
   * session so the current article stays prioritized (Section 3.2).
   */
  page_context?: unknown;
}

app.post('/api/chat', async (req: Request, res: Response) => {
  const { sessionId, message, currentState, sourceUrl, topicCategory } =
    req.body as ChatRequestBody;

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
    const pageContext = req.body.page_context;
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

  // 2. Rate limiting
  const rateLimitResult = checkRateLimit(sessionId);
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

  // 4. Security: detect sensitive data
  const sensitiveDataCategory = detectSensitiveData(message);
  if (sensitiveDataCategory === 'health_data') {
    // Only the consented medical_review state may receive health details.
    // Everywhere else (and whenever the medical feature flag is off),
    // health data is blocked and routed to a licensed-broker handoff.
    if (!medicalCaptureEnabled || currentState !== 'medical_review') {
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
    if (!medicalCaptureEnabled || currentState !== 'medical_review') {
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
  //    If the message contains PII, store a redacted placeholder instead
  //    (Section 8: do not store contact/health data in routine logs).
  const messageIsSensitive = sensitiveDataCategory === 'pii';
  addUserMessage(sessionId, message, messageIsSensitive);

  // 8. Determine next state via the state machine
  //    (The orchestrator will use the LLM response to refine the final state)
  const sessionDimeInputs = getDimeInputs(sessionId);
  const nextState =
    getNextState({
      currentState,
      userMessage: message,
      hasValueBeenDelivered: false, // Determined by LLM response quality
      userShowsInterest: false,
      queryIsAmbiguous: false,
      userAgreesToQualification: false,
      // Phase 2 medical capture — request-body flags honored only when the
      // feature flag is enabled; otherwise forced off (flow stays inert).
      userAgreesToMedicalReview: medicalCaptureEnabled
        ? (req.body.userAgreesToMedicalReview ?? false)
        : false,
      medicalConsentAffirmative: medicalCaptureEnabled
        ? (req.body.medicalConsentAffirmative ?? false)
        : false,
      medicalReviewComplete: medicalCaptureEnabled
        ? (req.body.medicalReviewComplete ?? false)
        : false,
      // DIME educational sub-flow — explicit request from the widget/future UI,
      // or automatic completion once all three inputs are collected.
      userRequestsDimeEstimator: req.body.userRequestsDimeEstimator ?? false,
      dimeComplete: dimeInputsComplete(sessionDimeInputs),
      userRequestsFollowup: false,
      contactChannelChosen: false,
      consentAffirmative: false,
      requiredFieldsValid: false,
      userAsksToBook: false,
      bookingApiConfirms: false,
      riskOrEscalationTrigger: sensitiveDataCategory === 'pii',
      userDeclinesOrFlowEnds: false,
    }) ?? currentState;

  // 9. Run the LLM + RAG orchestrator (Sections 4.6, 4.8, 4.9, 4.11, 15)
  //    Passes conversation history so the model has context for follow-up
  //    questions. The orchestrator validates the response against the Zod
  //    schema, enforces cross-field consent rules, and falls back safely.
  //    While the DIME estimator is active, pass its progress as authoritative
  //    application context (Section 9.2).
  const inDimeFlow = nextState === 'dime_estimator' || currentState === 'dime_estimator';

  // Contextual Content Bridge (Section 16): inject the stored page context so
  // the current article is prioritized in RAG retrieval and the model receives
  // the no-personal-inference instruction. When the bridge is disabled or no
  // valid context was stored, this is inert.
  const storedPageContext = getPageContext(sessionId);
  let contextualArticleId: string | null = null;
  let contextualArticleTopic: string | null = null;
  let contextualInstruction: string | null = null;
  if (config.contextualBridgeEnabled && storedPageContext) {
    const contextual = injectContext(storedPageContext);
    contextualArticleId = contextual.articleMapping?.articleId ?? null;
    contextualArticleTopic = contextual.articleMapping?.topic ?? null;
    contextualInstruction = contextual.contextualInstruction;
  }

  const { response, latencyMs, tokenUsage } = await generateResponse({
    userMessage: message,
    currentState: nextState,
    conversationHistory,
    topicCategory,
    dimeContext: inDimeFlow ? buildDimeProgressContext(getDimeInputs(sessionId)) : undefined,
    contextualArticleId,
    contextualInstruction,
    contextualArticleTopic,
  });

  // Feed real LLM token usage into the session's per-window budget so the
  // token cap actually enforces (previously tokenCount was never incremented
  // and the budget could never trip). Null on abstention/fallback paths that
  // made no successful LLM call.
  if (tokenUsage) {
    incrementTokenCount(sessionId, tokenUsage.inputTokens + tokenUsage.outputTokens);
  }

  // 10. DIME estimator — merge collected inputs into the session, derive
  //     step/completion deterministically, and on completion override the
  //     message with the application-computed educational range. The model
  //     never produces dollar figures (Section 9.2).
  let finalResponse = response;
  if (response.dime_estimator.active) {
    const priorInputs = getDimeInputs(sessionId);
    const isDimeEntry = countDimeInputs(priorInputs) === 0;
    const merged = mergeDimeInputs(priorInputs, response.dime_estimator);
    setDimeInputs(sessionId, merged);

    if (dimeInputsComplete(merged)) {
      const estimate = computeDimeEstimate(merged);
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
    const cardResult = validateCard(finalResponse.visual_card, nextState);
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
app.post('/api/consent', (req: Request, res: Response) => {
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

  const { contactConsentAffirmed, contactChannel, email, phone, firstName } = req.body;

  if (!contactConsentAffirmed) {
    return res.status(400).json({
      error: 'Affirmative consent required',
      message: FALLBACK_MESSAGES.CONTACT_REFUSAL,
    });
  }

  // Validate fields server-side
  if (contactChannel === 'email' && email) {
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
  }
  if (contactChannel === 'phone' && phone) {
    if (!validatePhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone format' });
    }
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
  const medicalProfileInput: unknown = req.body.medicalProfile ?? null;
  const medicalConsentAffirmed = req.body.medicalConsentAffirmed === true;
  const rawMedicalConsentVersion = req.body.medicalConsentVersion;
  const medicalConsentVersion =
    typeof rawMedicalConsentVersion === 'string' ? rawMedicalConsentVersion : null;
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
    if (mapping === null || medicalConsentVersion === null) {
      return res.status(400).json({
        error: 'Affirmative current medical consent required',
        message:
          'Optional medical information was not stored because medical consent was not affirmed with a current consent version.',
      });
    }

    consentedMedical = {
      profile: parsedMedical.data,
      mapping,
      consentVersion: medicalConsentVersion,
    };
  }

  // Prefer the sanitized canonical path already stored on the session by
  // /api/chat (context bridge, Section 3.2): it is validated and has query
  // params stripped. Fall back to re-sanitizing the request body when the
  // consent form submits without a session id, or before any message in the
  // session carried a sourceUrl. The stored path is never re-sanitized —
  // sanitizeUrl expects a full URL and would degrade a bare pathname to
  // '/unknown'.
  const sessionId = typeof req.body.sessionId === 'string' ? req.body.sessionId : '';
  const storedSourcePath = sessionId ? getSourceUrl(sessionId) : null;
  const sourcePath = storedSourcePath ?? sanitizeUrl(req.body.sourceUrl || '');

  // Create lead record
  const lead = createLeadRecord(
    req.body.articleId || 'unknown',
    sourcePath,
    req.body.topicCategory || 'general',
  );

  lead.first_name = firstName || null;
  lead.email = email || null;
  lead.phone = phone || null;
  lead.contact_channel = contactChannel;
  lead.contact_consent_version = config.contactConsentVersion;
  lead.consent_timestamp = new Date().toISOString();

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
  if (!saveLeadRecord(lead)) {
    return res.status(500).json({
      error: 'Lead storage failed',
      message: 'We could not securely store your information right now. Please try again later.',
    });
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
app.post('/api/dsr', (req: Request, res: Response) => {
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

  const result = submitDsr({
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

  return res.json({
    requestId: result.record.request_id,
    status: result.record.status,
    requestType: result.record.request_type,
    responseWithinDays: DSR_RESPONSE_SLA_DAYS,
    message: `We received your ${result.record.request_type} request. We will respond to ${result.record.contact_email} within ${DSR_RESPONSE_SLA_DAYS} days. You can also email ${config.dsrEmail} directly.`,
  });
});

/**
 * GET /api/dsr/:requestId — DSR request status (admin/debug)
 */
app.get('/api/dsr/:requestId', (req: Request, res: Response) => {
  if (!requireAdminAuth(req, res)) return;
  const record = getDsrRecord(req.params.requestId);
  if (!record) {
    return res.status(404).json({ error: 'DSR request not found' });
  }
  return res.json({
    requestId: record.request_id,
    status: record.status,
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
app.get('/api/rag/search', (req: Request, res: Response) => {
  if (!requireAdminAuth(req, res)) return;
  const query = (req.query.q as string) || '';
  if (!query.trim()) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const result = retrieveFromCorpus(query);
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
app.get('/api/session/:sessionId/history', (req: Request, res: Response) => {
  if (!requireAdminAuth(req, res)) return;
  const history = getHistory(req.params.sessionId);
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
  res.json({ sessionId: req.params.sessionId, status: 'cleared' });
});

/**
 * GET /api/sessions — Returns active session count (admin/monitoring)
 */
app.get('/api/sessions', (req: Request, res: Response) => {
  if (!requireAdminAuth(req, res)) return;
  res.json({ activeSessions: getActiveSessionCount() });
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
 * JSON shape and no internal detail; and the full error is logged server-side,
 * where an operator can see it, instead of being shipped to the caller.
 */
app.use((err: unknown, _req: Request, res: Response, next: (error?: unknown) => void) => {
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
    console.error('Unhandled request error:', err);
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
  const logPaths = [config.leadLogPath, config.dsrLogPath, config.abstentionLogPath];
  const unwritable: string[] = [];
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
  dataPathsWritable = unwritable.length === 0;
  if (!dataPathsWritable) {
    console.warn(
      `WARN: record directories are not writable (${unwritable.join(', ')}). ` +
        'Lead, DSR, and abstention writes will fail closed until this is fixed.',
    );
  }

  console.log(
    `  LLM: ${config.llmApiKey.trim().length > 0 ? 'key configured' : 'NO API KEY — responses fall back to the static safe message'}`,
  );
  console.log(`  LLM endpoint: ${config.llmApiBaseUrl} (${config.llmModel})`);
  console.log(
    `  Cross-origin embed: ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(', ') : 'same-origin only (ALLOWED_ORIGINS unset)'}`,
  );
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

if (!config.serverless) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { server, app };
