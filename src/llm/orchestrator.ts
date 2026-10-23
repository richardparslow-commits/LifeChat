/**
 * LLM Orchestrator (Sections 4.6, 4.8, 4.9, 4.11, 4.14, 15)
 *
 * Orchestrates the full pipeline:
 *   1. Retrieve approved RAG context (Section 4.6)
 *   2. Build messages with trust-zone separation (Section 4.9)
 *   3. Call the LLM with timeout + retry + circuit breaker (Section 4.11)
 *   4. Extract JSON from the response (Section 15)
 *   5. Parse and validate against the Zod schema (Section 15)
 *   6. Validate cross-field schema rules (Section 15)
 *   7. Retry once with feedback when validation fails, then fall back (Section 4.11)
 *   8. Return the validated response or a safe fallback (Section 4.11)
 *
 * The orchestrator never trusts the LLM output blindly — it validates
 * every field, enforces consent rules, and falls back to a static safe
 * response if anything fails.
 */

import { config } from '../config/app-config';
import { normalizeTopicCategory } from '../schema/topic-category';
import { SYSTEM_PROMPT, ABSTENTION_SENTENCE } from '../prompts/system-prompt';
import { logAbstention } from '../analytics/abstention-log';
import { callLLM, extractJSON, type LLMMessage } from './llm-client';
import { fingerprint, safeCode } from '../observability/safe-log';
import {
  retrieveFromCorpus,
  formatRetrievedContext,
  passagesToCitations,
  type RetrievedPassage,
} from '../rag/retrieval';
import {
  AssistantResponseSchema,
  validateSchemaRules,
  STATIC_SAFE_FALLBACK,
  EMPTY_TURN_INTENT,
  type AssistantResponse,
  type Citation,
} from '../schema/response-schema';
import {
  sanitizeRetrievedContent,
  detectProhibitedPromotionalOffer,
} from '../security/security-controls';
import { FALLBACK_MESSAGES } from '../resilience/fallback-behavior';
import { isKillSwitchActive } from '../security/security-controls';
import {
  detectPersonaGuardrailViolation,
  isReOfferAfterDecline,
} from '../compliance/persona-guardrails';
import { detectClaimViolation } from '../compliance/claim-guard';
import type { ConversationState } from '../state-machine/state-machine';

export interface OrchestratorInput {
  userMessage: string;
  currentState: ConversationState;
  conversationHistory?: LLMMessage[];
  topicCategory?: string;
  /**
   * Application-computed DIME estimator progress (Section 9.2), passed as
   * authoritative application context so the model never re-asks a collected
   * question or invents dollar figures.
   */
  dimeContext?: string;
  /**
   * Contextual Content Bridge (Section 16): the validated article id of the
   * page the user is reading, used to prioritize it in RAG retrieval.
   */
  contextualArticleId?: string | null;
  /**
   * Section 16 contextual article metadata from the allowlisted article map.
   * Untrusted by provenance, so `buildMessages` delivers it as a delimited
   * user-role data block — never as system text (SEC-12).
   */
  contextualData?: string | null;
  /**
   * Section 16 contextual article topic label (educational), used only for the
   * anonymized abstention log's audience category. Never user-supplied text.
   */
  contextualArticleTopic?: string | null;
}

export interface OrchestratorResult {
  response: AssistantResponse;
  ragPassages: RetrievedPassage[];
  latencyMs: number;
  /**
   * Real LLM token usage across all attempts (initial call + validation
   * retry), when the API reports it. Null when no LLM call succeeded — e.g.
   * kill switch, abstention, or fallback paths. The caller feeds this into
   * the per-window token budget (incrementTokenCount).
   */
  tokenUsage: { inputTokens: number; outputTokens: number } | null;
}

/**
 * Runs the full LLM + RAG pipeline and returns a validated response.
 *
 * If the LLM is unavailable, the kill switch is active, or validation fails,
 * returns a safe fallback response that never contains fabricated information.
 */
export async function generateResponse(input: OrchestratorInput): Promise<OrchestratorResult> {
  const startTime = Date.now();

  // 1. Check kill switch
  if (isKillSwitchActive()) {
    return {
      response: {
        ...STATIC_SAFE_FALLBACK,
        assistant_message: FALLBACK_MESSAGES.TIMEOUT,
      },
      ragPassages: [],
      latencyMs: Date.now() - startTime,
      tokenUsage: null,
    };
  }

  // 2. Retrieve RAG context (Section 4.6), prioritizing the article the user
  //    is reading when contextual information is present (Section 3.6).
  const retrievalResult = retrieveFromCorpus(input.userMessage, 3, {
    contextualArticleId: input.contextualArticleId ?? null,
  });
  const ragContext = formatRetrievedContext(retrievalResult.passages);

  // 3. If no sufficient evidence, return abstention immediately (Section 4.6)
  //    "If support is absent, conflicting, expired, or below threshold,
  //    say so and abstain."
  //    The gate applies only to answer states (education/disclosure). In flow
  //    states (qualification, medical_offer/medical_review, contact_offer,
  //    consent, scheduling, ...) the assistant is conducting the conversation —
  //    collecting facts or asking questions — not answering a research
  //    question, so the RAG gate must not block those turns. The model stays
  //    grounded by the system prompt script and the response schema.
  const isAnswerState = input.currentState === 'education' || input.currentState === 'disclosure';
  if (!retrievalResult.hasSufficientEvidence && isAnswerState) {
    // Content-strategy feed: record an anonymized abstention (hash + category,
    // never the raw question or any PII) so the editorial calendar can close
    // the knowledge gap the approved corpus cannot yet answer. The append is a
    // non-blocking stream write and is deliberately not awaited: analytics must
    // never add latency to (or break) the turn that triggered it.
    void logAbstention({
      userMessage: input.userMessage,
      topicCategory: input.topicCategory,
      contextualArticleTopic: input.contextualArticleTopic,
      articleId: input.contextualArticleId ?? null,
    });
    return {
      response: buildAbstentionResponse(input, retrievalResult.passages),
      ragPassages: retrievalResult.passages,
      latencyMs: Date.now() - startTime,
      tokenUsage: null,
    };
  }

  // 4. Call the LLM (Section 4.6, 4.9, 4.11)
  const llmOptions = {
    systemPrompt: SYSTEM_PROMPT,
    ragContext,
    userMessage: sanitizeRetrievedContent(input.userMessage),
    conversationHistory: input.conversationHistory,
    currentState: input.currentState,
    temperature: 0.3,
    maxTokens: 800,
    applicationContext: input.dimeContext,
    contextualData: input.contextualData,
  };
  const llmResult = await callLLM(llmOptions);

  // Real token usage accumulates across the initial call and the validation
  // retry (both consume budget) so the per-window token cap can enforce.
  let tokenUsage = llmResult.usage ?? null;

  // 5. If LLM call failed, return a fallback response (Section 4.11)
  if (!llmResult.success || !llmResult.content) {
    // A code, not a message: `error` is one of the client's own labels, and the
    // provider's body never becomes part of it (M-06). The value is checked
    // against that vocabulary rather than trusted, so a client that starts
    // returning text cannot put it in the log either.
    console.error('LLM call failed', JSON.stringify({ code: safeCode(llmResult.error) }));
    return {
      response: buildFallbackResponse(input, 'llm_call_failed', llmResult.error),
      ragPassages: retrievalResult.passages,
      latencyMs: Date.now() - startTime,
      tokenUsage,
    };
  }

  // 6. Extract, parse, and validate the response (Section 15).
  //    If the first attempt is invalid, retry ONCE with the validation
  //    errors fed back to the model, then fall back only if the retry is
  //    also invalid (Section 4.11 resilience).
  // Records blocked-output violations (persona guardrails and claim-guard
  // rules) caught by the validator so they persist onto the final response's
  // risk_flags even when a retry rewrites the message.
  const blockedViolationLog = new Set<string>();
  const attemptValidation = (
    raw: string,
  ): { ok: true; validated: AssistantResponse } | { ok: false; kind: string; detail: string } => {
    const jsonStr = extractJSON(raw);
    if (!jsonStr) {
      return {
        ok: false,
        kind: 'json_extraction_failed',
        detail:
          'No JSON object could be extracted. Return exactly one valid JSON object and no surrounding prose.',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return {
        ok: false,
        kind: 'json_parse_failed',
        detail: 'The returned JSON could not be parsed.',
      };
    }

    const schemaResult = AssistantResponseSchema.safeParse(parsed);
    if (!schemaResult.success) {
      const issues = schemaResult.error.issues
        .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');
      return {
        ok: false,
        kind: 'schema_validation_failed',
        detail: `The returned JSON is missing or has invalid fields:\n${issues}`,
      };
    }

    const ruleErrors = validateSchemaRules(schemaResult.data);
    if (ruleErrors.length > 0) {
      return {
        ok: false,
        kind: 'schema_rule_violation',
        detail: `Cross-field rules were violated:\n${ruleErrors.map((e) => `- ${e}`).join('\n')}`,
      };
    }

    // Marketing-review gate: while FREE_OFFER_MARKETING_APPROVED is false, an
    // assistant message claiming a free quote/consultation/estimate or
    // no-obligation review is rejected so the retry loop rewrites it.
    if (
      !config.freeOfferMarketingApproved &&
      detectProhibitedPromotionalOffer(schemaResult.data.assistant_message)
    ) {
      return {
        ok: false,
        kind: 'marketing_review_pending',
        detail:
          'The response contains prohibited promotional phrasing (for example "free quote", "free consultation", or "no obligation"), which has not passed marketing review and is not approved. Rewrite the message without any free-offer or no-obligation claim; you may offer a conversation with the licensed broker without characterizing it as free.',
      };
    }

    // Persona guardrail gate (Section 4.14 + docs/ai-chatbot-persona-configuration.md):
    // textual persona violations (presumptive purchase framing, pressure language, or
    // fabricated anecdotes) are rejected so the retry loop rewrites them. The violation
    // persists onto the final response's risk_flags so a blocked attempt is auditably
    // flagged even after a successful retry.
    const personaViolation = detectPersonaGuardrailViolation(schemaResult.data.assistant_message);
    if (personaViolation) {
      blockedViolationLog.add(personaViolation);
      return {
        ok: false,
        kind: 'persona_guardrail_violation',
        detail: `The response violates persona guardrail "${personaViolation}": it uses presumptive purchase framing, pressure language, or fabricated content. Rewrite the message in neutral, educational, non-presumptive language without pressure or invented anecdotes.`,
      };
    }

    // Claim-level output guard (SEC-13): schema, promo and persona checks do
    // not read the factual content of the message, so an unapproved price,
    // guarantee, ranking or personal identifier would otherwise reach the
    // visitor. A violation is fed back for the one retry and recorded on the
    // final response's risk_flags for audit.
    const claimViolation = detectClaimViolation(schemaResult.data.assistant_message);
    if (claimViolation) {
      blockedViolationLog.add(claimViolation.id);
      console.error(
        'LLM response blocked by claim guard',
        JSON.stringify({ rule: claimViolation.rule }),
      );
      return {
        ok: false,
        kind: 'claim_guard_violation',
        detail: claimViolation.retryInstruction,
      };
    }

    // Re-offer guardrail (stateful, across turns): if the user declined a step earlier
    // in the conversation and the candidate assistant message would offer it again,
    // reject it so the retry loop rewrites it. conversationHistory is snapshotted before
    // the current user turn is recorded, so fold the current userMessage in explicitly.
    const priorUserMessages = [
      ...(input.conversationHistory ?? []).filter((m) => m.role === 'user').map((m) => m.content),
      ...(input.userMessage ? [input.userMessage] : []),
    ];
    if (isReOfferAfterDecline(priorUserMessages, schemaResult.data.assistant_message)) {
      blockedViolationLog.add('decline_no_reoffer');
      return {
        ok: false,
        kind: 'persona_guardrail_violation',
        detail:
          'The response re-offers a step the user has already declined (guardrail "decline_no_reoffer"). Once a user declines qualification, contact capture, or booking, do not offer it again in the session. Acknowledge the decline once, stay in education, and do not repeat the offer.',
      };
    }

    return { ok: true, validated: schemaResult.data };
  };

  const firstAttempt = attemptValidation(llmResult.content);
  let validated: AssistantResponse | null = null;
  let failureKind: string | null = firstAttempt.ok ? null : firstAttempt.kind;

  if (firstAttempt.ok) {
    validated = firstAttempt.validated;
  } else {
    // The validator's detail is built from the model's output. Its fingerprint
    // correlates retries without copying that text into the log (M-06).
    console.error(
      'LLM response invalid, retrying once',
      JSON.stringify({ kind: firstAttempt.kind, detail: fingerprint(firstAttempt.detail) }),
    );
    const retryResult = await callLLM({
      ...llmOptions,
      validationFeedback: `Your previous response was rejected by the application validator.\n${firstAttempt.detail}\nReturn ONE complete JSON object matching the schema in the system prompt, with every required top-level key: assistant_message, state, intent, citations, lead_data, consent, proposed_action, action_arguments, risk_flags, analytics.`,
    });
    if (retryResult.usage) {
      tokenUsage = {
        inputTokens: (tokenUsage?.inputTokens ?? 0) + retryResult.usage.inputTokens,
        outputTokens: (tokenUsage?.outputTokens ?? 0) + retryResult.usage.outputTokens,
      };
    }
    if (retryResult.success && retryResult.content) {
      const secondAttempt = attemptValidation(retryResult.content);
      if (secondAttempt.ok) {
        validated = secondAttempt.validated;
      } else {
        console.error(
          'LLM retry also invalid',
          JSON.stringify({ kind: secondAttempt.kind, detail: fingerprint(secondAttempt.detail) }),
        );
        failureKind = secondAttempt.kind;
      }
    } else {
      console.error('LLM retry call failed', JSON.stringify({ code: safeCode(retryResult.error) }));
      failureKind = 'llm_call_failed';
    }
  }

  if (!validated) {
    return {
      response: buildFallbackResponse(input, failureKind ?? 'schema_validation_failed', null),
      ragPassages: retrievalResult.passages,
      latencyMs: Date.now() - startTime,
      tokenUsage,
    };
  }

  // 9. Override citations with retrieved RAG passages
  //    The model may not always include exact citations, so we inject
  //    the retrieved sources to ensure grounding (Section 4.6).
  const citations: Citation[] = passagesToCitations(retrievalResult.passages).slice(0, 3); // Max 3 citations per Section 4.6

  // 10. Ensure privacy notice version is set from config
  validated.consent.privacy_notice_version = config.privacyNoticeVersion;

  // 10b. Persist any output violation that was caught and rewritten so a blocked
  //      attempt is auditable on the final response, not just on the rejected one.
  for (const v of blockedViolationLog) {
    if (!validated.risk_flags.includes(v)) {
      validated.risk_flags = [...validated.risk_flags, v];
    }
  }

  // 11. Build final response
  const finalResponse: AssistantResponse = {
    ...validated,
    citations,
    analytics: {
      ...validated.analytics,
      topic_category:
        normalizeTopicCategory(validated.analytics.topic_category) ??
        normalizeTopicCategory(input.topicCategory),
      conversation_stage: validated.state,
    },
  };

  return {
    response: finalResponse,
    ragPassages: retrievalResult.passages,
    latencyMs: Date.now() - startTime,
    tokenUsage,
  };
}

/**
 * Builds an abstention response when evidence is insufficient (Section 4.6).
 * Uses the required abstention sentence from the system prompt.
 */
function buildAbstentionResponse(
  input: OrchestratorInput,
  passages: RetrievedPassage[],
): AssistantResponse {
  return {
    assistant_message: ABSTENTION_SENTENCE,
    state: input.currentState === 'disclosure' ? 'education' : input.currentState,
    intent: { ...EMPTY_TURN_INTENT },
    citations: passagesToCitations(passages),
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
    risk_flags: [],
    analytics: {
      event_name: 'ai_abstention',
      topic_category: normalizeTopicCategory(input.topicCategory),
      conversation_stage: input.currentState,
      fallback_type: 'insufficient_evidence',
      handoff_reason: null,
      error_code: null,
    },
  };
}

/**
 * Builds a fallback response when the LLM or validation fails (Section 4.11).
 * Never contains fabricated information.
 */
function buildFallbackResponse(
  input: OrchestratorInput,
  errorType: string,
  errorDetail: string | null | undefined,
): AssistantResponse {
  const isTimeout = errorDetail?.includes('aborted') || errorType === 'llm_call_failed';

  return {
    assistant_message: isTimeout
      ? FALLBACK_MESSAGES.TIMEOUT
      : 'I encountered an issue processing that. Let me connect you with a licensed human who can help.',
    state: 'standby',
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
      handoff_reason: 'system_error',
      // The fallback summary is serialised to the browser. Keep it to the
      // stable error class: upstream detail may carry provider internals or
      // request content and belongs only in the server log.
      summary: `Fallback triggered: ${errorType}`,
    },
    visual_card: null,
    risk_flags: ['static_fallback_used'],
    analytics: {
      event_name: 'ai_fallback_shown',
      topic_category: normalizeTopicCategory(input.topicCategory),
      conversation_stage: input.currentState,
      fallback_type: errorType,
      handoff_reason: 'system_error',
      error_code: errorType,
    },
  };
}
