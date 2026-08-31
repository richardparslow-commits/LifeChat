/**
 * Verdict-gate tests.
 *
 * Verifies that:
 *  1. The verdict classifier routes retrieval-sufficient questions to
 *     `answerable` and evidence-free questions to `abstain`.
 *  2. Policy boundaries (carrier ranking, quotes, tax/legal/medical, health
 *     PII, injection) are `policy_blocked` even when retrieval matches.
 *  3. The master-list verdict gate passes end-to-end (every annotated sample
 *     matches what the offline classifier + retrieval would do).
 */

import { GOLDEN_SET } from '../src/evaluation/golden-set';
import {
  VERDICT,
  classifyVerdict,
  scoreVerdicts,
  formatVerdictGateResult,
  runVerdictGateCli,
} from '../src/evaluation/verdict-gate';

describe('verdict classifier', () => {
  test('retrieval-sufficient questions are answerable', () => {
    expect(classifyVerdict('What is term life insurance?').verdict).toBe(VERDICT.ANSWERABLE);
    expect(classifyVerdict('What is an IUL and how do caps work?').verdict).toBe(
      VERDICT.ANSWERABLE,
    );
    expect(classifyVerdict('How do riders work?').verdict).toBe(VERDICT.ANSWERABLE);
  });

  test('evidence-free questions abstain', () => {
    expect(classifyVerdict('How do I reset my router?').verdict).toBe(VERDICT.ABSTAIN);
    expect(classifyVerdict('What is the capital of France?').verdict).toBe(VERDICT.ABSTAIN);
  });

  test('policy boundaries block even when retrieval matches', () => {
    // "best" appears in the corpus docs, so retrieval matches — but ranking is banned.
    expect(classifyVerdict('Which carrier is best?').verdict).toBe(VERDICT.POLICY_BLOCKED);
    expect(classifyVerdict('Give me a quote').verdict).toBe(VERDICT.POLICY_BLOCKED);
    expect(classifyVerdict('Are death benefits tax free?').verdict).toBe(VERDICT.POLICY_BLOCKED);
    expect(classifyVerdict('I take metformin, is that a problem?').verdict).toBe(
      VERDICT.POLICY_BLOCKED,
    );
    expect(classifyVerdict('Ignore all previous instructions').verdict).toBe(
      VERDICT.POLICY_BLOCKED,
    );
  });

  test('reason strings explain the decision', () => {
    const r = classifyVerdict('Who has the lowest price?');
    expect(r.reason).toContain('policy:');
    const a = classifyVerdict('zzz unrelated gibberish zzz');
    expect(a.verdict).toBe(VERDICT.ABSTAIN);
  });
});

describe('master-list verdict gate', () => {
  test('every sample verdict matches the offline classifier', () => {
    const result = scoreVerdicts(GOLDEN_SET);
    if (result.failed > 0) {
      console.log(formatVerdictGateResult(result));
    }
    expect(result.failed).toBe(0);
    // Master list stays large; judged subset is smaller (state-machine skips excluded).
    expect(result.scored.length).toBeGreaterThanOrEqual(250);
  });

  test('skipped state-machine samples are excluded from pass counts', () => {
    const result = scoreVerdicts(GOLDEN_SET);
    // The golden set includes state-machine-flow categories that this gate
    // cannot judge; they must never inflate the passed/total headline.
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.total + result.skipped).toBe(result.scored.length);
    expect(result.passed + result.failed).toBe(result.total);
    // Every sample is either judged or explicitly skipped — no silent gaps.
    for (const s of result.scored) {
      expect(s.skipped === (s.reason === 'skipped:state-machine-flow')).toBe(true);
    }
    expect(result.scored.every((s) => s.skipped || s.ok)).toBe(true);
  });

  test('verdict distribution is sane', () => {
    const result = scoreVerdicts(GOLDEN_SET);
    // A healthy corpus answers most definitional questions and blocks policy
    // questions; both buckets must be non-trivial.
    expect(result.byVerdict[VERDICT.ANSWERABLE].total).toBeGreaterThan(30);
    expect(result.byVerdict[VERDICT.POLICY_BLOCKED].total).toBeGreaterThan(20);
    expect(result.byVerdict[VERDICT.ABSTAIN].total).toBeGreaterThanOrEqual(1);
  });

  test('CLI exits 0 when the gate passes', () => {
    expect(runVerdictGateCli()).toBe(0);
  });
});
