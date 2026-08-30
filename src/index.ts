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

import express, { Request, Response } from 'express';
import path from 'path';
import { config, PRODUCT_DEFINITION } from './config/app-config';
import { SYSTEM_PROMPT, FIRST_MESSAGE_DISCLOSURE, BEFORE_CHAT_BANNER, ABSTENTION_SENTENCE } from './prompts/system-prompt';
import { STATIC_SAFE_FALLBACK, type AssistantResponse } from './schema/response-schema';
import { generateResponse } from './llm/orchestrator';
import { retrieveFromCorpus } from './rag/retrieval';
import { getNextState, type ConversationState } from './state-machine/state-machine';
import { createLeadRecord, validateEmail, validatePhone, JUST_IN_TIME_NOTICE, RECOMMENDED_PHONE_CONSENT_COPY } from './consent/consent-model';
import { authorizeToolAction } from './tools/tool-controls';
import { detectPromptInjection, detectSensitiveData, checkRateLimit, isKillSwitchActive } from './security/security-controls';
import { getStaffAvailabilityMessage, createHandoffSummary, EMERGENCY_RESPONSE } from './handoff/human-escalation';
import { generateStaticFallback, FALLBACK_MESSAGES, LATENCY_CONFIG } from './resilience/fallback-behavior';
// generateResponse orchestrator handles LLM + RAG + schema validation
import { sanitizeUrl, generateDataLayerSnippet, type AnalyticsEvent } from './analytics/analytics';
import { isDocumentValid, type CorpusDocument } from './rag/rag-architecture';

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
    healthDataCollection: 'disabled',
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
 * GET /health — Simple health check
 */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', killSwitch: isKillSwitchActive() });
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
 */
app.get('/api/disclosure', (_req: Request, res: Response) => {
  res.json({
    firstMessage: FIRST_MESSAGE_DISCLOSURE,
    banner: BEFORE_CHAT_BANNER,
    businessName: config.businessName,
    licensedBrokerName: config.licensedBrokerName,
    texasLicenseNumber: config.texasLicenseNumber,
    privacyNoticeUrl: config.privacyNoticeUrl,
    contactUrl: config.contactUrl,
  });
});

/**
 * GET /api/consent-text — Returns the consent copy for counsel review
 */
app.get('/api/consent-text', (_req: Request, res: Response) => {
  res.json({
    phoneConsentCopy: RECOMMENDED_PHONE_CONSENT_COPY,
    justInTimeNotice: JUST_IN_TIME_NOTICE,
    privacyNoticeVersion: config.privacyNoticeVersion,
    contactConsentVersion: config.contactConsentVersion,
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
}

app.post('/api/chat', async (req: Request, res: Response) => {
  const { sessionId, message, currentState, sourceUrl, articleId, topicCategory } = req.body as ChatRequestBody;

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
      assistant_message: 'I\'ve received a lot of messages in a short time. Please try again in a moment.',
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
    const response: AssistantResponse = {
      assistant_message: 'I can help with general life-insurance education questions. What would you like to learn about?',
      state: 'education',
      citations: [],
      lead_data: {
        first_name: null, email: null, phone: null, goal_category: null,
        timeline_category: null, current_coverage_category: null,
        contact_channel: null, time_zone: null, preferred_contact_window: null,
      },
      consent: {
        privacy_notice_version: config.privacyNoticeVersion,
        contact_consent_version: null,
        contact_consent_affirmed: false,
        do_not_contact: false,
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
    return res.json(response);
  }

  // 4. Security: detect sensitive data
  const sensitiveDataCategory = detectSensitiveData(message);
  if (sensitiveDataCategory === 'health_data') {
    const response: AssistantResponse = {
      assistant_message: `This chat isn't the right place for medical or health information. Please don't share diagnoses, medications, or health details here. If you need individualized guidance, Richard Parslow, a licensed Texas broker, can help through a secure process. ${ABSTENTION_SENTENCE}`,
      state: 'handoff',
      citations: [],
      lead_data: {
        first_name: null, email: null, phone: null, goal_category: null,
        timeline_category: null, current_coverage_category: null,
        contact_channel: null, time_zone: null, preferred_contact_window: null,
      },
      consent: {
        privacy_notice_version: config.privacyNoticeVersion,
        contact_consent_version: null,
        contact_consent_affirmed: false,
        do_not_contact: false,
      },
      proposed_action: 'request_human_handoff',
      action_arguments: { handoff_reason: 'health_data_disclosed', summary: 'User disclosed health information in public chat' },
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
    return res.json(response);
  }

  // 5. Sanitize the source URL (never send raw window.location.href)
  const sanitizedPath = sourceUrl ? sanitizeUrl(sourceUrl) : '/';

  // 6. Determine next state via the state machine
  //    (The orchestrator will use the LLM response to refine the final state)
  const nextState = getNextState({
    currentState,
    userMessage: message,
    hasValueBeenDelivered: false, // Determined by LLM response quality
    userShowsInterest: false,
    queryIsAmbiguous: false,
    userAgreesToQualification: false,
    userRequestsFollowup: false,
    contactChannelChosen: false,
    consentAffirmative: false,
    requiredFieldsValid: false,
    userAsksToBook: false,
    bookingApiConfirms: false,
    riskOrEscalationTrigger: sensitiveDataCategory === 'pii',
    userDeclinesOrFlowEnds: false,
  }) ?? currentState;

  // 7. Run the LLM + RAG orchestrator (Sections 4.6, 4.8, 4.9, 4.11, 15)
  //    This replaces the placeholder and calls the actual model with:
  //    - the hardened system prompt
  //    - retrieved RAG context (approved sources only)
  //    - the user message (sanitized, marked as untrusted)
  //    The orchestrator validates the response against the Zod schema,
  //    enforces cross-field consent rules, and falls back safely on failure.
  const { response, latencyMs, ragPassages } = await generateResponse({
    userMessage: message,
    currentState: nextState,
    topicCategory,
  });

  // 8. Log latency and retrieval info (non-PII)
  if (latencyMs > LATENCY_CONFIG.P95_ANSWER_TARGET_MS) {
    console.warn(`Response latency ${latencyMs}ms exceeds P95 target ${LATENCY_CONFIG.P95_ANSWER_TARGET_MS}ms`);
  }

  return res.json(response);
});

/**
 * POST /api/consent — Submit consent for lead capture
 * (Phase 2 — consented lead capture)
 */
app.post('/api/consent', (req: Request, res: Response) => {
  const { sessionId, contactConsentAffirmed, contactChannel, email, phone, firstName } = req.body;

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
    req.body.topicCategory || 'general'
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
      contentPreview: p.content.slice(0, 200) + '...',
    })),
  });
});

/**
 * Start the server
 */
const server = app.listen(config.port, () => {
  console.log(`\n  ${PRODUCT_DEFINITION.name}`);
  console.log(`  Owner: ${PRODUCT_DEFINITION.owner}`);
  console.log(`  Jurisdiction: ${PRODUCT_DEFINITION.initialJurisdiction}`);
  console.log(`  Pilot mode: ${config.pilotMode}`);
  console.log(`  Health data collection: ${config.healthDataCollectionDisabled ? 'DISABLED' : 'enabled'}`);
  console.log(`  Outbound marketing: ${config.outboundMarketingDisabled ? 'DISABLED' : 'enabled'}`);
  console.log(`\n  Server running at http://localhost:${config.port}`);
  console.log(`  Widget at http://localhost:${config.port}/widget.js`);
  console.log('');
});

export { server, app };
