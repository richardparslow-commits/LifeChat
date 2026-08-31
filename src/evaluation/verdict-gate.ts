/**
 * Verdict Gate (offline golden-set scoring)
 *
 * Scores every golden-set sample's expected verdict against what the system
 * would actually do today:
 *
 *   answerable     — retrieval must find sufficient approved evidence AND the
 *                    question must not hit a policy boundary
 *   abstain        — retrieval must NOT find sufficient approved evidence
 *                    (assistant falls back to the abstention sentence)
 *   policy_blocked — question hits a hard policy boundary (carrier ranking,
 *                    quotes/recommendations, tax/legal/medical advice,
 *                    health/PII, injection) regardless of retrieval
 *
 * This catches two regression classes after any corpus or prompt change:
 *   1. A question that used to be answerable starts abstaining (corpus drift).
 *   2. A question that must abstain/block starts being answered (policy drift).
 *
 * Runs offline — no LLM call. The classifier mirrors the runtime rules:
 *   - retrieval: src/rag/retrieval.ts (hasSufficientEvidence)
 *   - policy: category-based boundaries from the compliance matrix (F2/F5/F10)
 *
 * Runs as an optional CI check:
 *
 *   npm run test:verdicts
 *
 * Exits non-zero when any sample's expected verdict mismatches.
 */

import { retrieveFromCorpus } from '../rag/retrieval';
import { GOLDEN_SET } from './golden-set';

/**
 * What the system is expected to do with a question.
 *   ANSWERABLE     — grounded educational answer expected
 *   ABSTAIN        — insufficient approved evidence; abstention sentence expected
 *   POLICY_BLOCKED — hard policy boundary; refuse/redirect regardless of evidence
 */
export const VERDICT = {
  ANSWERABLE: 'answerable',
  ABSTAIN: 'abstain',
  POLICY_BLOCKED: 'policy_blocked',
} as const;

export type ExpectedVerdict = (typeof VERDICT)[keyof typeof VERDICT];

/** Policy-boundary keyword groups (mirror of runtime policy rules). */
const POLICY_BLOCK_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  {
    id: 'carrier_ranking',
    pattern:
      /\b(best|cheapest|lowest\s+price|top\s+carrier|which\s+carrier|who\s+has\s+the\s+lowest|better\s+carrier|carrier\s+comparison|which\s+is\s+better)\b/i,
  },
  { id: 'carrier_detail', pattern: /\bwhat\s+does\b.{0,40}\boffer\b/i },
  {
    id: 'quote_request',
    pattern:
      /\b(quote|quotation|exact\s+premium|my\s+premium|policy\s+cost|my\s+policy\s+cost|price\s+for\s+me|get\s+me\s+a|exact\s+coverage|coverage\s+need)\b/i,
  },
  {
    id: 'coverage_amount',
    pattern:
      /\bi\s+need\s+\$?\d|\$\d[\d,]*\s+of\s+coverage\b|is\s+\$?\d[\d,]*\s+of\s+coverage\s+enough|coverage\s+enough|enough\s+coverage\b/i,
  },
  { id: 'ungrounded_figure', pattern: /\bguaranteed\s+(return|rate|profit)\b/i },
  {
    id: 'personal_recommendation',
    pattern:
      /\b(should\s+i\s+(buy|get|choose|pick|add|replace|skip|use|name|insure|prioritize)|which\s+(policy|rider|carrier)\s+(should|is\s+best)|recommend\s+(a|me|the)|worth\s+it|is\s+it\s+better|better\s+to\s+(buy|add|get|choose)|add\s+a\s+[\w-]+\s+rider|rider\s+to\s+my\s+policy)\b/i,
  },
  { id: 'investment_suitability', pattern: /\b(good\s+investment|as\s+an?\s+investment)\b/i },
  { id: 'savings_vehicle', pattern: /\b(college\s+savings|529\s+plan|savings\s+vehicle)\b/i },
  {
    id: 'tax_advice',
    pattern:
      /\b(tax(es|able|ation)?\b.{0,40}\b(avoid|reduce|estate|trust|strategy)|tax\s+(advice|rules|mistake|free)|tax\s?free|taxed)\b/i,
  },
  {
    id: 'legal_advice',
    pattern:
      /\b(put\b.{0,30}\btrust|into\s+a\s+trust|estate\s+plan(ning)?|guardian|legal\s+advice|attorney|need\s+a\s+will|write\s+a\s+will)\b/i,
  },
  {
    id: 'medical_advice',
    pattern:
      /\b(diagnos(e|is)|medication|metformin|insulin|antidepressant|blood\s+pressure\s+med|marijuana|my\s+(condition|diagnosis)|disqualif|health\s+condition|disclose)\b/i,
  },
  {
    id: 'health_disclosure',
    pattern:
      /\b(i\s+(have|had|weigh|smoke|take)|my\s+(weight|condition|medication|health)|diabetes|cancer|allergy|depression|pregnan)\b/i,
  },
  {
    id: 'underwriting_prediction',
    pattern:
      /\b(will\s+i\s+(qualify|be\s+approved|get\s+approved)|qualify\s+for\s+(standard|preferred)|what\s+(rating|class)\s+will)\b/i,
  },
  {
    id: 'family_pii',
    pattern:
      /\bmy\s+(son|daughter|wife|husband|mother|father|mom|dad)\b.{0,40}beneficiar|beneficiar\w*.{0,30}\bmy\s+(son|daughter|wife|husband|mother|father)\b/i,
  },
  { id: 'origin_pii', pattern: /\bi\s+was\s+born\b/i },
  {
    id: 'address_pii',
    pattern: /\bi\s+live\s+at\b|\b\d+\s+\w+\s+(street|st|avenue|ave|road|rd)\b/i,
  },
  {
    id: 'pii_disclosure',
    pattern: /\b(social\s+security|ssn|date\s+of\s+birth|my\s+(address|income|salary|debt))\b/i,
  },
  {
    id: 'injection',
    pattern: /\b(bypass|exploit|jailbreak|prompt\s+inject|system\s+prompt|ignore\s+all)\b/i,
  },
];

/**
 * Categories handled by the conversation state machine / system prompt rather
 * than RAG retrieval. The verdict gate only scores the education flow (F2).
 */
export const SKIP_CATEGORIES: ReadonlySet<string> = new Set([
  'ai_identity_and_licensing_questions',
  'refusals_objections_and_loop_prevention',
  'consent_and_scheduling_states',
  'stale_conflicting_sources',
  'direct_indirect_prompt_injection_and_exfiltration',
  'spanish_and_mixed_language_inputs',
  'accessibility_error_messages',
  'outages_and_tool_failures',
]);

export interface VerdictSampleScored {
  id: string;
  category: string;
  userMessage: string;
  expected: ExpectedVerdict;
  actual: ExpectedVerdict;
  ok: boolean;
  /** Why the actual verdict was produced (retrieval score / policy id). */
  reason: string;
  /** True when the sample is outside the education flow and not scored. */
  skipped: boolean;
}

export interface VerdictGateResult {
  /** Samples actually judged by this gate (skipped samples excluded). */
  total: number;
  passed: number;
  failed: number;
  /** Samples handled by the state machine / system prompt, not scored here. */
  skipped: number;
  byVerdict: Record<ExpectedVerdict, { total: number; passed: number; failed: number }>;
  scored: VerdictSampleScored[];
}

/** Minimal shape this gate needs from a sample (GoldenSample-compatible). */
export interface VerdictSample {
  id: string;
  category: string;
  userMessage: string;
  expectedVerdict?: ExpectedVerdict;
}

/**
 * Decides what the system would actually do with a user message today.
 *
 * Order matters: policy boundaries win over retrieval, because a question can
 * retrieve relevant text (e.g. "best carrier" retrieves the FAQ) yet must still
 * be blocked. Retrieval wins only when no policy boundary is hit.
 */
export function classifyVerdict(userMessage: string): { verdict: ExpectedVerdict; reason: string } {
  // 1. Policy boundaries first.
  for (const rule of POLICY_BLOCK_PATTERNS) {
    if (rule.pattern.test(userMessage)) {
      return { verdict: VERDICT.POLICY_BLOCKED, reason: `policy:${rule.id}` };
    }
  }

  // 2. Retrieval-based answerability.
  const result = retrieveFromCorpus(userMessage, 3);
  if (result.hasSufficientEvidence) {
    return {
      verdict: VERDICT.ANSWERABLE,
      reason: `retrieval:score=${result.passages[0].score}`,
    };
  }
  return {
    verdict: VERDICT.ABSTAIN,
    reason:
      result.passages.length === 0
        ? 'retrieval:no-match'
        : `retrieval:below-threshold:score=${result.passages[0].score}`,
  };
}

/** Scores one sample: expected verdict vs. what the system would do today. */
export function scoreVerdictSample(sample: VerdictSample): VerdictSampleScored {
  // Non-education flows (identity, consent, refusal, outage, ...) are handled
  // by the conversation state machine, not RAG retrieval. Mark them skipped
  // so the gate only judges the education flow (matrix F2).
  if (SKIP_CATEGORIES.has(sample.category)) {
    return {
      id: sample.id,
      category: sample.category,
      userMessage: sample.userMessage,
      expected: sample.expectedVerdict ?? VERDICT.ANSWERABLE,
      actual: sample.expectedVerdict ?? VERDICT.ANSWERABLE,
      ok: true,
      reason: 'skipped:state-machine-flow',
      skipped: true,
    };
  }
  const { verdict, reason } = classifyVerdict(sample.userMessage);
  const expected = sample.expectedVerdict ?? VERDICT.ANSWERABLE;
  return {
    id: sample.id,
    category: sample.category,
    userMessage: sample.userMessage,
    expected,
    actual: verdict,
    ok: expected === verdict,
    reason,
    skipped: false,
  };
}

/**
 * Scores every sample and aggregates by verdict.
 *
 * State-machine samples are tracked separately: they are counted in `scored`
 * (so the raw sample list is preserved) but excluded from `total`, `passed`,
 * and `failed`. The gate only claims coverage for what it actually judged —
 * previously the headline counted every force-passed skip as a "pass", which
 * overstated coverage by the skipped population.
 */
export function scoreVerdicts(samples: readonly VerdictSample[]): VerdictGateResult {
  const scored = samples.map(scoreVerdictSample);
  const judged = scored.filter((s) => !s.skipped);
  const byVerdict: VerdictGateResult['byVerdict'] = {
    [VERDICT.ANSWERABLE]: { total: 0, passed: 0, failed: 0 },
    [VERDICT.ABSTAIN]: { total: 0, passed: 0, failed: 0 },
    [VERDICT.POLICY_BLOCKED]: { total: 0, passed: 0, failed: 0 },
  };
  for (const s of judged) {
    const bucket = byVerdict[s.expected];
    bucket.total += 1;
    if (s.ok) {
      bucket.passed += 1;
    } else {
      bucket.failed += 1;
    }
  }
  return {
    total: judged.length,
    passed: judged.filter((s) => s.ok).length,
    failed: judged.filter((s) => !s.ok).length,
    skipped: scored.length - judged.length,
    byVerdict,
    scored,
  };
}

/** Human-readable report; only failures are listed individually. */
export function formatVerdictGateResult(result: VerdictGateResult): string {
  const skipNote =
    result.skipped > 0
      ? ` (${result.skipped} skipped — state-machine flows, not scored by this gate)`
      : '';
  const lines: string[] = [
    `Verdict gate: ${result.passed}/${result.total} judged samples match expected behavior${skipNote}`,
    `  answerable:     ${result.byVerdict[VERDICT.ANSWERABLE].passed}/${result.byVerdict[VERDICT.ANSWERABLE].total} ok`,
    `  abstain:        ${result.byVerdict[VERDICT.ABSTAIN].passed}/${result.byVerdict[VERDICT.ABSTAIN].total} ok`,
    `  policy_blocked: ${result.byVerdict[VERDICT.POLICY_BLOCKED].passed}/${result.byVerdict[VERDICT.POLICY_BLOCKED].total} ok`,
    `  skipped:        ${result.skipped} (state-machine flows, not scored by this gate)`,
  ];
  for (const s of result.scored) {
    if (!s.skipped && !s.ok) {
      lines.push(
        `  FAIL ${s.id} (${s.category}): expected=${s.expected} actual=${s.actual} (${s.reason})`,
        `       "${s.userMessage}"`,
      );
    }
  }
  return lines.join('\n');
}

/** CLI entry point: exit 1 when any expected verdict mismatches. */
export function runVerdictGateCli(): number {
  const result = scoreVerdicts(
    GOLDEN_SET.map((s) => ({
      id: s.id,
      category: s.category,
      userMessage: s.userMessage,
      expectedVerdict: s.expectedVerdict,
    })),
  );
  console.log(formatVerdictGateResult(result));
  return result.failed === 0 ? 0 : 1;
}

// Direct-invocation entry (e.g. `npm run test:verdicts`).
if (require.main === module) {
  process.exitCode = runVerdictGateCli();
}
