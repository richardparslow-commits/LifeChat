/**
 * Compliance Classification Matrix — machine-readable (Phase 0)
 *
 * Machine-readable mirror of docs/compliance-classification-matrix.md.
 * Every conversation flow the implementation can execute is listed with its
 * proposed advertising/educational classification, the regulatory duties it
 * triggers, its counsel-approval status, and its runtime gating.
 *
 * Approval is a human step: nothing here is "approved" until Texas insurance
 * counsel signs the determination table in the markdown document. The
 * approvalStatus values therefore reflect the signed record, not the code's
 * intent; runtimeStatus reflects what is actually gated at runtime.
 */

import { config } from '../config/app-config';

export type FlowId = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10';

/** Counsel sign-off state. All flows start at pending_counsel. */
export type FlowApprovalStatus = 'pending_counsel' | 'approved';

/**
 * Runtime gating, derived from live configuration:
 * - 'enabled'           — the flow can execute (pilot mode where applicable)
 * - 'gated_by_flag'     — blocked by a feature flag until post-approval flip
 * - 'not_connected'     — structured but no downstream integration is wired
 */
export type FlowRuntimeStatus = 'enabled' | 'gated_by_flag' | 'not_connected';

export interface ComplianceFlow {
  id: FlowId;
  name: string;
  states: string[];
  description: string;
  proposedClassification: string;
  regulatoryDuties: string[];
  approvalStatus: FlowApprovalStatus;
  approvalArtifacts: string[];
}

export interface ComplianceFlowOverview extends ComplianceFlow {
  runtimeStatus: FlowRuntimeStatus;
}

export interface ComplianceOverview {
  phase: string;
  phaseStatus: 'pending_counsel_sign_off';
  matrixVersion: string;
  matrixDocument: string;
  flowCount: number;
  flows: ComplianceFlowOverview[];
}

export const MATRIX_VERSION = '1.4.0';
export const MATRIX_DOCUMENT = 'docs/compliance-classification-matrix.md';

/**
 * The ten classified flows (mirrors Section 2 of the markdown matrix).
 * approvalStatus is the counsel record — every flow is pending sign-off.
 */
export const COMPLIANCE_CLASSIFICATION_MATRIX: ComplianceFlow[] = [
  {
    id: 'F1',
    name: 'Disclosure',
    states: ['disclosure'],
    description:
      'Shows AI identity, scope, and privacy warning before the first message; banner persists in the widget header.',
    proposedClassification: 'Educational + AI identity disclosure',
    regulatoryDuties: [
      'NAIC Model 570 disclosure',
      'Texas Insurance Code §541.061 truthfulness',
      'Texas H.B. 149 transparency',
    ],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: ['Approve first-message disclosure & banner copy', 'Record version hash'],
  },
  {
    id: 'F2',
    name: 'Education',
    states: ['education', 'dime_estimator'],
    description:
      'Answers from RAG over the compliance-reviewed corpus with claim-level citations; abstains with a reason when evidence is absent, conflicting, or expired. Includes the DIME coverage-needs estimator, a 3-step educational exercise (Debt, Income, Mortgage, Education) whose illustrative range is computed by the application from coarse, non-sensitive inputs — never a recommendation or quote.',
    proposedClassification: 'Educational; at most institutional advertisement',
    regulatoryDuties: [
      'Texas Insurance Code §541.061',
      '28 TAC §21.104 identification of responsible person',
      'NAIC Model 570',
      'Texas H.B. 149',
      'FTC AI guidance substantiation (FTC Act §5; 2023–2025 guidance) — educational outputs are RAG-grounded with citations; abstention is the default when evidence is insufficient',
      'Comparative statements — only fair, accurate, non-misleading category-level comparisons from approved sources; ranking, disparagement, and carrier-to-carrier comparisons prohibited (§541.061)',
    ],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: [
      'Approve corpus source list',
      'Approve citation format',
      'Approve abstention wording',
      'Confirm no policy/quote offers',
      'Approve DIME estimator questions & illustrative range table',
    ],
  },
  {
    id: 'F3',
    name: 'Clarify',
    states: ['clarify'],
    description:
      'Asks one clarifying question; never requests PII merely to answer; after two failed clarifications offers links and human help.',
    proposedClassification: 'Educational',
    regulatoryDuties: ['Texas Insurance Code §541.061', '28 TAC §21.104 (as F2)'],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: ['Covered by F2 approval'],
  },
  {
    id: 'F4',
    name: 'Qualification',
    states: ['qualification_offer', 'qualification'],
    description:
      'After value is delivered, offers up to three optional questions (goal, timeline, current coverage), one at a time, with no health details; decline suppresses re-offer in the session.',
    proposedClassification: 'Educational context-gathering (lead-generation precursor)',
    regulatoryDuties: [
      'Texas Insurance Code §541.061',
      '28 TAC §21.104 if it invites inquiry',
      'TDPSA not triggered (no contact/sensitive data collected)',
    ],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: ['Approve the three questions', 'Approve offer/decline handling'],
  },
  {
    id: 'F5',
    name: 'Medical review',
    states: ['medical_offer', 'medical_review'],
    description:
      'Proposes optional medical fact-finding with a just-in-time notice; requires explicit, unchecked, versioned medical consent; asks approved topics one at a time; health data is accepted only in the medical_review state.',
    proposedClassification: 'Lead generation collecting TDPSA sensitive data (health)',
    regulatoryDuties: [
      'TDPSA explicit consent, minimization, deletion/withdrawal',
      'Texas Insurance Code §541.061',
      '28 TAC §21.104 admissibility of MIB transparency statement',
      'Texas H.B. 149 human review if used in consequential decisions',
    ],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: [
      'Sign §7 checklist of docs/medical-lead-capture-phase2.md',
      'Approve RECOMMENDED_MEDICAL_CONSENT_COPY + just-in-time notice',
      'Approve field list (TDPSA minimization)',
    ],
  },
  {
    id: 'F6',
    name: 'Lead capture',
    states: ['contact_offer', 'consent', 'lead_submit'],
    description:
      'Offers email, call, or calendar; collects only minimum contact fields with channel-specific, versioned consent; create_lead executes only with user request, affirmative consent, valid fields, suppression/DNC pass, and an idempotency key.',
    proposedClassification: 'Lead generation (commercial)',
    regulatoryDuties: [
      'TDPSA consent (personal data)',
      'TDPSA privacy notice — categories, purposes, sharing, third parties, and rights methods (linked from the disclosure/consent flows)',
      'TDPSA consumer rights — DSR process (access, deletion, correction, portability; 45-day response window)',
      'TCPA / prior express written consent for SMS and calls',
      'Do-Not-Call suppression',
      '28 TAC §21.104 identification',
      'Texas Insurance Code §541.061',
    ],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: [
      'Approve RECOMMENDED_PHONE_CONSENT_COPY',
      'Approve field list',
      'Approve retention schedule (counsel_approved)',
      'Approve suppression handling',
    ],
  },
  {
    id: 'F7',
    name: 'Scheduling',
    states: ['scheduling', 'confirmation'],
    description:
      'Presents read-only availability from the calendar tool with time zone; rechecks the slot at commit; confirms booking only after downstream success; sends a transactional confirmation.',
    proposedClassification: 'Service facilitation (not advertising)',
    regulatoryDuties: [
      'Texas Insurance Code §541.061 (no misrepresentation of booking status)',
      'TDPSA (calendar/contact data)',
      'Confirmation must not carry marketing',
    ],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: ['Approve confirmation copy', 'Approve calendar/CRM integration when added'],
  },
  {
    id: 'F8',
    name: 'Handoff',
    states: ['handoff'],
    description:
      'Summarizes with consent, provides availability/SLA, stops giving advice, and routes to the licensed broker.',
    proposedClassification: 'Customer-service referral',
    regulatoryDuties: [
      'Texas Insurance Code §541.061',
      'Clear that follow-up is by the licensed broker, not the assistant',
    ],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: ['Approve handoff summary copy'],
  },
  {
    id: 'F9',
    name: 'Standby',
    states: ['standby'],
    description:
      'Post-flow state; education only; re-enters an active flow only on user initiative.',
    proposedClassification: 'Educational',
    regulatoryDuties: ['As F2'],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: ['Covered by F2 approval'],
  },
  {
    id: 'F10',
    name: 'Safety paths',
    states: ['kill switch', 'abstention', 'static fallback', 'rate limit', 'detection'],
    description:
      'Risk-control layer (kill switch, abstention, static fallback, rate limiting, prompt-injection and sensitive-data detection); not a consumer-facing flow.',
    proposedClassification: 'AI-system risk control (no advertising classification)',
    regulatoryDuties: [
      'Texas H.B. 149 human oversight / kill switch',
      'NAIC AI Bulletin monitoring',
      'NIST AI 600-1',
      'FTC substantiation (FTC Act §5; 2023–2025 guidance) — abstention gate prevents unsupported claims',
      'Marketing-review gate — free-offer phrasing (free quote / free consultation / no-obligation) blocked in outputs until FREE_OFFER_MARKETING_APPROVED=true after review',
    ],
    approvalStatus: 'pending_counsel',
    approvalArtifacts: [
      'Covered by governance matrix security control (prelaunch red-team, quarterly)',
    ],
  },
];

/**
 * Derives the runtime gating for a flow from live configuration.
 * F5 (medical review) is blocked by HEALTH_DATA_COLLECTION_DISABLED until it
 * is flipped after counsel approval; F7 (scheduling) has no calendar API
 * connected yet; every other structured flow can execute in pilot mode.
 */
function getRuntimeStatus(id: FlowId): FlowRuntimeStatus {
  switch (id) {
    case 'F5':
      return config.healthDataCollectionDisabled ? 'gated_by_flag' : 'enabled';
    case 'F7':
      return 'not_connected';
    default:
      return 'enabled';
  }
}

/**
 * Builds the machine-readable compliance overview surfaced by GET /health.
 * approvalStatus is the counsel record (static); runtimeStatus reflects the
 * live configuration so monitoring can see which flows run without sign-off.
 */
export function getComplianceOverview(): ComplianceOverview {
  const flows: ComplianceFlowOverview[] = COMPLIANCE_CLASSIFICATION_MATRIX.map((flow) => ({
    ...flow,
    runtimeStatus: getRuntimeStatus(flow.id),
  }));

  return {
    phase: 'Phase 0 — compliance design (counsel classification)',
    phaseStatus: 'pending_counsel_sign_off',
    matrixVersion: MATRIX_VERSION,
    matrixDocument: MATRIX_DOCUMENT,
    flowCount: flows.length,
    flows,
  };
}
