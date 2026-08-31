/**
 * Persona-Guardrail Gate (offline golden-set scoring)
 *
 * Applies the same post-generation persona guardrails that the orchestrator enforces at
 * runtime (src/llm/orchestrator.ts) to the off-line golden set: every sample's expected
 * `assistant_message` is scored against the three text-level violations
 * (presumptive purchase framing, pressure language, fabricated anecdotes). If any
 * approved sample would fail the runtime gate, this reports it as a failure so the
 * golden set cannot drift into non-compliant phrasing.
 *
 * Runs as an optional CI check:
 *
 *   npm run test:guardrails:golden
 *
 * Exits non-zero when any sample violates a guardrail so CI can fail the gate.
 */

import { detectPersonaGuardrailViolation } from '../compliance/persona-guardrails';
import { GOLDEN_SET, type GoldenSample } from './golden-set';

export interface GuardrailSampleScored {
  sample: GoldenSample;
  ok: boolean;
  /** The guardrail id that was violated, or null when clean. */
  violation: string | null;
}

export interface GuardrailGateResult {
  total: number;
  passed: number;
  failed: number;
  scored: GuardrailSampleScored[];
}

/**
 * Scores a single golden-set sample's expected assistant message against the
 * three text-level persona guardrails.
 */
export function scoreSampleAgainstPersonaGuardrails(sample: GoldenSample): GuardrailSampleScored {
  const violation = detectPersonaGuardrailViolation(sample.expectedAssistantMessage);
  return {
    sample,
    ok: violation === null,
    violation,
  };
}

/**
 * Scores every sample in the golden set against the persona guardrails.
 */
export function scoreGoldenSetAgainstPersonaGuardrails(
  samples: readonly GoldenSample[] = GOLDEN_SET,
): GuardrailGateResult {
  const scored = samples.map(scoreSampleAgainstPersonaGuardrails);
  return {
    total: scored.length,
    passed: scored.filter((s) => s.ok).length,
    failed: scored.filter((s) => !s.ok).length,
    scored,
  };
}

/**
 * Prints a human-readable report for a gate result.
 */
export function formatGuardrailGateResult(result: GuardrailGateResult): string {
  const lines: string[] = [
    `Persona-guardrail golden-set gate: ${result.passed}/${result.total} samples clean`,
  ];
  for (const s of result.scored) {
    if (!s.ok) {
      lines.push(
        `  FAIL ${s.sample.id} (${s.sample.category}): guardrail "${s.violation}" in expected assistant message.`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * CLI entry point. Runs the gate over the golden set and exits 1 if any sample
 * would be blocked by the runtime persona guardrail. Used by the optional CI
 * check `npm run test:guardrails:golden`.
 */
export function runPersonaGuardrailGateCli(): number {
  const result = scoreGoldenSetAgainstPersonaGuardrails();
  console.log(formatGuardrailGateResult(result));
  return result.failed === 0 ? 0 : 1;
}

// Direct-invocation entry (e.g. `npx ts-node src/evaluation/persona-guardrail-gate.ts`).
if (require.main === module) {
  process.exitCode = runPersonaGuardrailGateCli();
}
