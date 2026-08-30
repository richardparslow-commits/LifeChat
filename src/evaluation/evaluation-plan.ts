/**
 * Evaluation and QA Plan (Section 4.14)
 *
 * RAG evaluation should test retrieval and generation separately.
 * Automated judges are useful but imperfect. Use both automated scoring
 * and licensed-human review.
 */

/**
 * Pre-launch golden set: at least 250 version-controlled tests
 * distributed across these categories (Section 4.14).
 */
export const GOLDEN_SET_CATEGORIES = [
  'definitions_and_article_questions',
  'texas_specific_law_regulation',
  'ambiguous_and_insufficient_evidence_questions',
  'individualized_recommendations_quotes',
  'annuity_replacement_tax_legal_medical_boundaries',
  'health_pii_disclosures',
  'ai_identity_and_licensing_questions',
  'refusals_objections_and_loop_prevention',
  'consent_and_scheduling_states',
  'stale_conflicting_sources',
  'direct_indirect_prompt_injection_and_exfiltration',
  'spanish_and_mixed_language_inputs',
  'accessibility_error_messages',
  'outages_and_tool_failures',
] as const;

/**
 * Minimum number of golden set tests (Section 4.14).
 */
export const MIN_GOLDEN_SET_SIZE = 250;

/**
 * Each golden test is scored on these dimensions (Section 4.14).
 */
export const SCORING_DIMENSIONS = [
  'retrieval_recall_at_k',
  'source_authority_and_freshness',
  'context_relevance',
  'claim_level_citation_precision',
  'faithfulness_groundedness',
  'factual_correctness',
  'completeness_without_over_answering',
  'policy_compliance_pass',
  'appropriate_abstention_and_escalation',
  'pii_health_data_handling',
  'tone_reading_level_question_count',
  'tool_schema_correctness',
  'latency',
] as const;

/**
 * Proposed release gates (Section 4.14).
 * These are proposed product gates, NOT industry benchmarks.
 * Recalibrate after a pilot, but never relax critical compliance tests
 * to improve conversion.
 */
export const RELEASE_GATES = {
  /** 100% pass on critical compliance tests */
  CRITICAL_COMPLIANCE_PASS_RATE: 1.0,
  /** 0 unsupported material insurance claims in the compliance-reviewed golden set */
  MAX_UNSUPPORTED_CLAIMS: 0,
  /** At least 95% citation precision on eligible educational questions */
  MIN_CITATION_PRECISION: 0.95,
  /** At least 90% answer correctness on eligible educational questions */
  MIN_ANSWER_CORRECTNESS: 0.9,
  /** At least 95% correct abstention/escalation on out-of-scope tests */
  MIN_ABSTENTION_ESCALATION_CORRECTNESS: 0.95,
  /** No critical or high security finding open */
  NO_OPEN_CRITICAL_HIGH_SECURITY_FINDINGS: true,
  /** WCAG 2.2 AA test pass on defined browser/AT matrix */
  WCAG_2_2_AA_PASS: true,
  /** P95 ordinary educational answer under 6 seconds */
  P95_ANSWER_MAX_MS: 6_000,
  /** Tool flow under the documented SLA */
  TOOL_FLOW_UNDER_SLA: true,
} as const;

/**
 * Critical compliance test categories that require 100% pass rate.
 */
export const CRITICAL_COMPLIANCE_TESTS = [
  'ai_disclosure',
  'prohibited_advice',
  'health_data_handling',
  'consent_enforcement',
  'pii_handling',
  'prompt_exfiltration_prevention',
  'booking_confirmation_accuracy',
] as const;

/**
 * Post-launch review schedule (Section 4.14).
 */
export const POST_LAUNCH_REVIEW = {
  /** Review 100% of risk-flagged conversations */
  RISK_FLAGGED_REVIEW_RATE: 1.0,
  /** Random sample for the first 8 weeks */
  INITIAL_SAMPLE_RATE: 0.05, // 5%
  INITIAL_SAMPLE_WEEKS: 8,
  /** After initial period: risk-adjusted sample */
  ONGOING_SAMPLE: 'risk_adjusted',
  /** Publish a monthly quality report */
  MONTHLY_REPORT: true,
  /** Regression-test every prompt, model, corpus, embedding, reranker,
   * vendor, consent, and tool change */
  REGRESSION_ON_CHANGE: true,
} as const;

/**
 * Governance and ownership matrix (Section 4.15).
 */
export const GOVERNANCE_MATRIX = [
  {
    control: 'Insurance/carrier/compliance/counsel approval',
    owner: 'Richard + carrier/compliance/counsel',
    frequency: 'Before use and every material change',
    evidence: 'Signed approval, version hash',
  },
  {
    control: 'Corpus review',
    owner: 'Content owner + compliance',
    frequency: 'Scheduled and source-change event',
    evidence: 'Source inventory, expiry log',
  },
  {
    control: 'Prompt/model release',
    owner: 'Product + compliance + security',
    frequency: 'Every version',
    evidence: 'Test report, approval record',
  },
  {
    control: 'Privacy/processor review',
    owner: 'Privacy owner/counsel',
    frequency: 'Annual and vendor/data change',
    evidence: 'Data map, contracts, assessment',
  },
  {
    control: 'Security/red-team',
    owner: 'Security owner/qualified tester',
    frequency: 'Prelaunch, quarterly, major change',
    evidence: 'Findings and remediation',
  },
  {
    control: 'Transcript sampling',
    owner: 'Licensed reviewer',
    frequency: 'Weekly/monthly risk-based QA',
    evidence: 'Scorecard',
  },
  {
    control: 'Incident response',
    owner: 'Named incident lead',
    frequency: 'Exercise twice yearly; incident',
    evidence: 'Timeline, actions, after-action review',
  },
  {
    control: 'Consent/DNC audit',
    owner: 'Compliance owner',
    frequency: 'Monthly',
    evidence: 'Consent samples, suppression test',
  },
  {
    control: 'Accessibility audit',
    owner: 'Accessibility owner',
    frequency: 'Prelaunch and major UI change',
    evidence: 'Test matrix and defects',
  },
] as const;

/**
 * NIST recommendations for ongoing monitoring (Section 4.14).
 * NIST recommends ongoing monitoring, independent evaluation proportional
 * to risk, incident response, and reassessment after RAG or third-party changes.
 */
export const NIST_MONITORING_PRINCIPLES = [
  'ongoing_monitoring',
  'independent_evaluation_proportional_to_risk',
  'incident_response',
  'reassessment_after_rag_or_third_party_changes',
] as const;
