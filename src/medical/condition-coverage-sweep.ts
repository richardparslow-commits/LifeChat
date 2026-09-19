/**
 * Condition-coverage sweep — the measurement behind the vocabulary's claim.
 *
 * The vocabulary's closure claims are asserted against declared scopes in
 * tests/medical-condition-gate.test.ts, but a declared scope can only ever be
 * as good as the list it came from. This module is how a *new* source gets
 * measured: hand it a candidate phrase list — a carrier questionnaire, an
 * ICD-10 chapter enumeration, a pile of lay phrasings from support tickets —
 * and it reports, for every phrase, whether the row is
 *
 *   mapped_and_gated  a canonical condition AND classified as health data
 *   mapped_not_gated  the vocabulary carries it, the gate misses it   ← a hole
 *   gated_uncoded     the gate protects it, the vocabulary has no code (policy)
 *   classified_other  classified, but not as health data (inspect it)
 *   silent            neither mapped nor gated                        ← a hole
 *
 * "Silent" is the class the sweeps exist to find: a disclosure that reaches the
 * model unclassified and cannot be matched afterwards. The tool exits non-zero
 * on silent and mapped-not-gated rows, so it can gate a corpus in CI the same
 * way `test:verdicts` and `test:guardrails:golden` gate theirs.
 *
 * This is deliberately the same measurement the 2026-09-19 questionnaire sweep
 * used by hand: run the static part of the medical gate over a list that was
 * written by someone else, and let the failures be the work queue.
 */

import { readFileSync } from 'fs';
import path from 'path';

import { findCanonicalCondition } from './condition-crosswalk';
import { detectSensitiveData } from '../security/security-controls';

/** The committed candidate corpus: 237 phrases from carrier questionnaires. */
export const DEFAULT_CANDIDATE_LIST_PATH = 'docs/medical-condition-candidate-phrases.txt';

/**
 * The second committed corpus (2026-09-19): the covered-condition lists
 * (10/30/36-condition enumerations) a carrier publishes for critical illness —
 * a different kind of source from a questionnaire, written by someone else,
 * well before this vocabulary existed.
 */
export const CRITICAL_ILLNESS_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-critical-illness.txt';

/**
 * The third committed corpus (2026-09-19): the three-character category titles
 * of WHO ICD-10 Chapter IX — a codebook enumeration, written by the WHO as a
 * classification structure rather than by a carrier or a visitor, and the first
 * source whose rows include British spellings the vocabulary did not carry.
 */
export const ICD10_CHAPTER_IX_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-ix.txt';

/**
 * The fourth committed corpus (2026-09-19): the three-character category titles
 * of ICD-10-CM Chapter XIV, diseases of the genitourinary system — the chapter
 * the stone family sits in, and the second codebook enumeration. It is the
 * largest source so far (87 rows) and the first one whose rows are almost all
 * category constructs rather than stateable diagnoses, which is what made the
 * gated-not-coded bucket as large as it is.
 */
export const ICD10_CHAPTER_XIV_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-xiv.txt';

/**
 * Every committed corpus, swept by default. Four independent sources, each a
 * different kind of document, so `npm run conditions:sweep` re-measures the
 * whole coverage claim rather than one corpus's slice of it.
 */
export const COMMITTED_CANDIDATE_LIST_PATHS: readonly string[] = [
  DEFAULT_CANDIDATE_LIST_PATH,
  CRITICAL_ILLNESS_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_IX_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_XIV_CANDIDATE_LIST_PATH,
];

/** Where a row stands after both systems have been asked about it. */
export type CoverageStatus =
  'mapped_and_gated' | 'mapped_not_gated' | 'gated_uncoded' | 'classified_other' | 'silent';

export interface ConditionCandidateRow {
  phrase: string;
  /** The canonical condition the phrase resolves to, if any (exact alias match) */
  mapped: { icd10_cm: string; name: string; system: string } | null;
  /** What the disclosure form of the phrase classifies as, or null */
  category: string | null;
  /** The phrase as the gate was actually asked about it */
  probe: string;
  status: CoverageStatus;
}

export interface ConditionCoverageSweep {
  source: string;
  rows: ConditionCandidateRow[];
  totals: {
    candidates: number;
    mappedAndGated: number;
    mappedNotGated: number;
    gatedUncoded: number;
    classifiedOther: number;
    silent: number;
  };
  /** Rows that are holes: silent, or mapped without the gate watching for them */
  blocking: ConditionCandidateRow[];
}

/** The repository root, from either src/ (ts-node) or dist/ (built CLI). */
const REPO_ROOT = path.join(__dirname, '..', '..');

/** Resolves a candidate-list path; relative paths are relative to the repository root. */
export function resolveCandidateListPath(listPath: string): string {
  return path.isAbsolute(listPath) ? listPath : path.join(REPO_ROOT, listPath);
}

/**
 * Parses a candidate list: either a JSON array of strings, or one phrase per
 * line with `#` comments and blanks ignored. Duplicates are dropped in order.
 */
export function parseConditionCandidateList(text: string): string[] {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      throw new Error('a JSON candidate list must be an array of strings');
    }
    return [...new Set(parsed.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
  }
  const phrases: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const phrase = line.trim();
    if (phrase.length > 0) phrases.push(phrase);
  }
  return [...new Set(phrases)];
}

/** Reads a candidate list from disk. Throws with the resolved path on failure. */
export function readConditionCandidateList(listPath: string = DEFAULT_CANDIDATE_LIST_PATH): {
  phrases: string[];
  resolved: string;
} {
  const resolved = resolveCandidateListPath(listPath);
  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch {
    throw new Error(`cannot read the candidate list at ${resolved}`);
  }
  return { phrases: parseConditionCandidateList(text), resolved };
}

/**
 * Measures one candidate: mapped (exact alias match), and gated (a disclosure
 * of it is classified as health data).
 *
 * The gate is asked the phrase as written first, then framed as a disclosure
 * ("I have <phrase>"), so a bare term and a full visitor sentence both measure
 * the way they would in a chat.
 */
export function measureConditionCandidate(phrase: string): ConditionCandidateRow {
  const condition = findCanonicalCondition(phrase);
  const mapped = condition
    ? { icd10_cm: condition.icd10_cm, name: condition.name, system: condition.system }
    : null;

  const probes = [phrase, `I have ${phrase}`];
  let probe = probes[0];
  let category: string | null = null;
  for (const candidate of probes) {
    const detected = detectSensitiveData(candidate);
    if (detected !== null) {
      probe = candidate;
      category = detected;
      break;
    }
  }

  const status: CoverageStatus = mapped
    ? category === 'health_data'
      ? 'mapped_and_gated'
      : 'mapped_not_gated'
    : category === 'health_data'
      ? 'gated_uncoded'
      : category === null
        ? 'silent'
        : 'classified_other';

  return { phrase, mapped, category, probe, status };
}

/** Sweeps a candidate list and totals the outcome. */
export function sweepConditionCandidates(
  candidates: readonly string[],
  source = '(candidates)',
): ConditionCoverageSweep {
  const rows = candidates.map((phrase) => measureConditionCandidate(phrase));
  const totals = {
    candidates: rows.length,
    mappedAndGated: rows.filter((row) => row.status === 'mapped_and_gated').length,
    mappedNotGated: rows.filter((row) => row.status === 'mapped_not_gated').length,
    gatedUncoded: rows.filter((row) => row.status === 'gated_uncoded').length,
    classifiedOther: rows.filter((row) => row.status === 'classified_other').length,
    silent: rows.filter((row) => row.status === 'silent').length,
  };
  return {
    source,
    rows,
    totals,
    blocking: rows.filter((row) => row.status === 'silent' || row.status === 'mapped_not_gated'),
  };
}

/** Reads and sweeps in one step — what the CLI does for each input file. */
export function sweepConditionCandidateList(listPath?: string): ConditionCoverageSweep {
  const { phrases, resolved } = readConditionCandidateList(listPath);
  return sweepConditionCandidates(phrases, resolved);
}

/** One row, for the `--all` and problem listings. */
function formatRow(row: ConditionCandidateRow): string {
  const mapped = row.mapped ? `${row.mapped.icd10_cm} ${row.mapped.name}` : '—';
  return `  ${row.phrase}  →  ${mapped}  |  gated: ${row.category ?? 'SILENT'}`;
}

/** The human report. Problem buckets are always listed; `all` adds the rest. */
export function formatConditionCoverageSweep(
  sweep: ConditionCoverageSweep,
  options: { all?: boolean } = {},
): string {
  const lines: string[] = [
    `Condition coverage sweep — ${sweep.totals.candidates} candidates from ${sweep.source}`,
    `  mapped and gated:     ${sweep.totals.mappedAndGated}`,
    `  mapped, not gated:    ${sweep.totals.mappedNotGated}`,
    `  gated, not mapped:    ${sweep.totals.gatedUncoded}   (descriptive by policy — inspect, do not invent codes)`,
    `  classified otherwise: ${sweep.totals.classifiedOther}`,
    `  neither (silent):     ${sweep.totals.silent}`,
  ];

  const silent = sweep.rows.filter((row) => row.status === 'silent');
  if (silent.length > 0) {
    lines.push('', `Silent rows — neither mapped nor gated (${silent.length}):`);
    for (const row of silent) lines.push(formatRow(row));
  }
  const mappedNotGated = sweep.rows.filter((row) => row.status === 'mapped_not_gated');
  if (mappedNotGated.length > 0) {
    lines.push('', `Mapped but not gated (${mappedNotGated.length}):`);
    for (const row of mappedNotGated) lines.push(formatRow(row));
  }
  const other = sweep.rows.filter((row) => row.status === 'classified_other');
  if (other.length > 0) {
    lines.push('', `Classified as something other than health data (${other.length}):`);
    for (const row of other) lines.push(formatRow(row));
  }
  if (options.all) {
    lines.push('', 'Every candidate:');
    for (const row of sweep.rows) lines.push(`  [${row.status}] ${formatRow(row).trim()}`);
  }
  if (sweep.blocking.length === 0) {
    lines.push(
      '',
      'No silent rows: every candidate is either mapped or classified as health data.',
    );
  } else {
    lines.push(
      '',
      `${sweep.blocking.length} blocking row${sweep.blocking.length === 1 ? '' : 's'}: ` +
        'map the named diagnoses, gate the descriptive ones, or document the deferral with its reason.',
    );
  }
  return lines.join('\n');
}
