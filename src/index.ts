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

import express, { Request, Response } from 'express';
import path from 'path';
import { config, PRODUCT_DEFINITION, isLicenseNumberConfigured } from './config/app-config';
import {
  SYSTEM_PROMPT,
  getFirstMessageDisclosure,
  APPOINTMENT_DISCLAIMER,
  BEFORE_CHAT_BANNER,
  ABSTENTION_SENTENCE,
} from './prompts/system-prompt';
import { STATIC_SAFE_FALLBACK, type AssistantResponse } from './schema/response-schema';
import { generateResponse } from './llm/orchestrator';
import { retrieveFromCorpus } from './rag/retrieval';
import {
  getHistory,
  addUserMessage,
  addAssistantMessage,
  startSessionCleanup,
  getActiveSessionCount,
  clearSession,
  getDimeInputs,
  setDimeInputs,
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
  isKillSwitchActive,
} from './security/security-controls';
import { getStaffAvailabilityMessage } from './handoff/human-escalation';
import { getComplianceOverview } from './compliance/classification-matrix';
import {
  generateStaticFallback,
  FALLBACK_MESSAGES,
  LATENCY_CONFIG,
} from './resilience/fallback-behavior';
// generateResponse orchestrator handles LLM + RAG + schema validation
import { sanitizeUrl, generateDataLayerSnippet, type AnalyticsEvent } from './analytics/analytics';

const app = express();
app.use(express.json());

// Serve the widget static files
app.use(express.static(path.join(__dirname, '..', 'public')));

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
    killSwitch: isKillSwitchActive(),
    compliance: getComplianceOverview(),
  });
});

/**
 * GET /api/system-prompt — Returns the hardened system prompt
 * (For admin/internal use only; should be protected in production)
 */
app.get('/api/system-prompt', (_req: Request, res: Response) => {
  res.json({ systemPrompt: SYSTEM_PROMPT });
});

/**
 * GET /api/disclosure — Returns the first-message disclosure and banner
 *
 * The Texas license number is served ONLY when a real number is configured
 * (Texas Insurance Code §541.003 / TAC §19.1004). While unconfigured it is
 * null — never the placeholder — and the disclosure text omits the license
 * line (fail closed).
 */
app.get('/api/disclosure', (_req: Request, res: Response) => {
  res.json({
    firstMessage: getFirstMessageDisclosure(),
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
}

app.post('/api/chat', async (req: Request, res: Response) => {
  const { sessionId, message, currentState, sourceUrl, topicCategory } =
    req.body as ChatRequestBody;

  // Phase 2 gate: the consented medical fact-finding flow is inert unless
  // HEALTH_DATA_COLLECTION_DISABLED=false is set in .env (after counsel
  // approval). When disabled, the medical context flags are forced off and
  // health data shared in chat is blocked, exactly as in Phase 1.
  const medicalCaptureEnabled = !config.healthDataCollectionDisabled;

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
      const response: AssistantResponse = {
        assistant_message: `This chat isn't the right place for medical or health information. Please don't share diagnoses, medications, or health details here. If you need individualized guidance, Richard Parslow, a licensed Texas broker, can help through a secure process. ${ABSTENTION_SENTENCE}`,
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
          handoff_reason: 'health_data_disclosed',
          summary: 'User disclosed health information in public chat',
        },
        risk_flags: ['sensitive_data_disclosed'],
        analytics: {
          event_name: 'ai_handoff_request',
          topic_category: topicCategory || null,
          conversation_stage: currentState,
          fallback_type: null,
          handoff_reason: 'health_data_disclosed',
          error_code: null,
        },
      };
      addAssistantMessage(sessionId, response.assistant_message);
      return res.json(response);
    }
  }

  // 5. Sanitize the source URL (never send raw window.location.href)
  //    sanitizeUrl is called here to ensure query params are stripped
  if (sourceUrl) {
    sanitizeUrl(sourceUrl);
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
  const { response, latencyMs } = await generateResponse({
    userMessage: message,
    currentState: nextState,
    conversationHistory,
    topicCategory,
    dimeContext: inDimeFlow ? buildDimeProgressContext(getDimeInputs(sessionId)) : undefined,
  });

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

  // Create lead record
  const lead = createLeadRecord(
    req.body.articleId || 'unknown',
    sanitizeUrl(req.body.sourceUrl || ''),
    req.body.topicCategory || 'general',
  );

  lead.first_name = firstName || null;
  lead.email = email || null;
  lead.phone = phone || null;
  lead.contact_channel = contactChannel;
  lead.contact_consent_version = config.contactConsentVersion;
  lead.consent_timestamp = new Date().toISOString();

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
  const result = submitDsr({
    requestType: req.body.requestType,
    contactEmail: req.body.contactEmail,
    detail: req.body.detail ?? null,
  });

  if (!result.ok) {
    return res.status(400).json({ error: 'Invalid data subject request', reason: result.reason });
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
  clearSession(req.params.sessionId);
  res.json({ sessionId: req.params.sessionId, status: 'cleared' });
});

/**
 * GET /api/sessions — Returns active session count (admin/monitoring)
 */
app.get('/api/sessions', (_req: Request, res: Response) => {
  res.json({ activeSessions: getActiveSessionCount() });
});

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
 * Start the server
 */
const server = app.listen(config.port, () => {
  // Start periodic cleanup of expired sessions (30-min TTL)
  startSessionCleanup();

  console.log(`\n  ${PRODUCT_DEFINITION.name}`);
  console.log(`  Owner: ${PRODUCT_DEFINITION.owner}`);
  console.log(`  Jurisdiction: ${PRODUCT_DEFINITION.initialJurisdiction}`);
  console.log(`  Pilot mode: ${config.pilotMode}`);
  console.log(
    `  Health data collection: ${config.healthDataCollectionDisabled ? 'DISABLED' : 'enabled'}`,
  );
  console.log(`  Outbound marketing: ${config.outboundMarketingDisabled ? 'DISABLED' : 'enabled'}`);
  console.log(`\n  Server running at http://localhost:${config.port}`);
  console.log(`  Widget at http://localhost:${config.port}/widget.js`);
  console.log(`  Session history: max 20 turns, 30-min TTL`);
  console.log('');
});

export { server, app };
