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
 *   7. Return the validated response or a safe fallback (Section 4.11)
 *
 * The orchestrator never trusts the LLM output blindly — it validates
 * every field, enforces consent rules, and falls back to a static safe
 * response if anything fails.
 */

import { config } from '../config/app-config';
import { SYSTEM_PROMPT, ABSTENTION_SENTENCE } from '../prompts/system-prompt';
import { callLLM, extractJSON, buildMessages, type LLMMessage } from './llm-client';
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
  type AssistantResponse,
  type Citation,
} from '../schema/response-schema';
import { sanitizeRetrievedContent } from '../security/security-controls';
import { FALLBACK_MESSAGES, LATENCY_CONFIG } from '../resilience/fallback-behavior';
import { isKillSwitchActive } from '../security/security-controls';
import type { ConversationState } from '../state-machine/state-machine';

export interface OrchestratorInput {
  userMessage: string;
  currentState: ConversationState;
  conversationHistory?: LLMMessage[];
  topicCategory?: string;
}

export interface OrchestratorResult {
  response: AssistantResponse;
  ragPassages: RetrievedPassage[];
  latencyMs: number;
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
    };
  }

  // 2. Retrieve RAG context (Section 4.6)
  const retrievalResult = retrieveFromCorpus(input.userMessage);
  const ragContext = formatRetrievedContext(retrievalResult.passages);

  // 3. If no sufficient evidence, return abstention immediately (Section 4.6)
  //    "If support is absent, conflicting, expired, or below threshold,
  //    say so and abstain."
  if (!retrievalResult.hasSufficientEvidence) {
    return {
      response: buildAbstentionResponse(input, retrievalResult.passages),
      ragPassages: retrievalResult.passages,
      latencyMs: Date.now() - startTime,
    };
  }

  // 4. Call the LLM (Section 4.6, 4.9, 4.11)
  const llmResult = await callLLM({
    systemPrompt: SYSTEM_PROMPT,
    ragContext,
    userMessage: sanitizeRetrievedContent(input.userMessage),
    conversationHistory: input.conversationHistory,
    currentState: input.currentState,
    temperature: 0.3,
    maxTokens: 800,
  });

  // 5. If LLM call failed, return a fallback response (Section 4.11)
  if (!llmResult.success || !llmResult.content) {
    console.error('LLM call failed:', llmResult.error);
    return {
      response: buildFallbackResponse(input, 'llm_call_failed', llmResult.error),
      ragPassages: retrievalResult.passages,
      latencyMs: Date.now() - startTime,
    };
  }

  // 6. Extract JSON from the response (Section 15)
  const jsonStr = extractJSON(llmResult.content);
  if (!jsonStr) {
    console.error('Failed to extract JSON from LLM response');
    return {
      response: buildFallbackResponse(input, 'json_extraction_failed', null),
      ragPassages: retrievalResult.passages,
      latencyMs: Date.now() - startTime,
    };
  }

  // 7. Parse and validate against the Zod schema (Section 15)
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error('JSON parse error:', e);
    return {
      response: buildFallbackResponse(input, 'json_parse_failed', null),
      ragPassages: retrievalResult.passages,
      latencyMs: Date.now() - startTime,
    };
  }

  const schemaResult = AssistantResponseSchema.safeParse(parsed);
  if (!schemaResult.success) {
    console.error('Schema validation failed:', schemaResult.error.issues);
    return {
      response: buildFallbackResponse(input, 'schema_validation_failed', null),
      ragPassages: retrievalResult.passages,
      latencyMs: Date.now() - startTime,
    };
  }

  const validated: AssistantResponse = schemaResult.data;

  // 8. Validate cross-field schema rules (Section 15)
  const ruleErrors = validateSchemaRules(validated);
  if (ruleErrors.length > 0) {
    console.error('Schema rule violations:', ruleErrors);
    return {
      response: buildFallbackResponse(input, 'schema_rule_violation', null),
      ragPassages: retrievalResult.passages,
      latencyMs: Date.now() - startTime,
    };
  }

  // 9. Override citations with retrieved RAG passages
  //    The model may not always include exact citations, so we inject
  //    the retrieved sources to ensure grounding (Section 4.6).
  const citations: Citation[] = passagesToCitations(retrievalResult.passages)
    .slice(0, 3); // Max 3 citations per Section 4.6

  // 10. Ensure privacy notice version is set from config
  validated.consent.privacy_notice_version = config.privacyNoticeVersion;

  // 11. Build final response
  const finalResponse: AssistantResponse = {
    ...validated,
    citations,
    analytics: {
      ...validated.analytics,
      topic_category: validated.analytics.topic_category || input.topicCategory || null,
      conversation_stage: validated.state,
    },
  };

  return {
    response: finalResponse,
    ragPassages: retrievalResult.passages,
    latencyMs: Date.now() - startTime,
  };
}

/**
 * Builds an abstention response when evidence is insufficient (Section 4.6).
 * Uses the required abstention sentence from the system prompt.
 */
function buildAbstentionResponse(
  input: OrchestratorInput,
  passages: RetrievedPassage[]
): AssistantResponse {
  return {
    assistant_message: ABSTENTION_SENTENCE,
    state: input.currentState === 'disclosure' ? 'education' : input.currentState,
    citations: passagesToCitations(passages),
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
    risk_flags: [],
    analytics: {
      event_name: 'ai_abstention',
      topic_category: input.topicCategory || null,
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
  errorDetail: string | null | undefined
): AssistantResponse {
  const isTimeout = errorDetail?.includes('aborted') || errorType === 'llm_call_failed';

  return {
    assistant_message: isTimeout
      ? FALLBACK_MESSAGES.TIMEOUT
      : 'I encountered an issue processing that. Let me connect you with a licensed human who can help.',
    state: 'standby',
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
    action_arguments: {
      handoff_reason: 'system_error',
      summary: `Fallback triggered: ${errorType}${errorDetail ? ` (${errorDetail.slice(0, 100)})` : ''}`,
    },
    risk_flags: ['static_fallback_used'],
    analytics: {
      event_name: 'ai_fallback_shown',
      topic_category: input.topicCategory || null,
      conversation_stage: input.currentState,
      fallback_type: errorType,
      handoff_reason: 'system_error',
      error_code: errorType,
    },
  };
}
