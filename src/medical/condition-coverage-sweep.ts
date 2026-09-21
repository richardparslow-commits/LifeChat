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
 *   deferred          deliberately left open, with the reason on file  ← a ledger
 *
 * "Silent" is the class the sweeps exist to find: a disclosure that reaches the
 * model unclassified and cannot be matched afterwards. The tool exits non-zero
 * on silent and mapped-not-gated rows, so it can gate a corpus in CI the same
 * way `test:verdicts` and `test:guardrails:golden` gate theirs.
 *
 * A deferral is the deliberate exception, and it is declared rather than
 * implied: a line `? <phrase> :: <reason>` (or a JSON object
 * `{ "phrase", "deferred_reason" }`) records why a row is left open. The row is
 * still measured on every run — that is what "re-asked" means — but it reports
 * as `deferred` instead of `silent`, so it stays visible without blocking CI on
 * a decision that was already made. The moment a deferred row is no longer
 * silent the sweep treats the deferral as **stale** and blocks: the ledger must
 * be updated (the row closed, or the declaration removed), so a deferral can
 * never quietly become a closure either. The committed ledger lives at
 * docs/medical-condition-deferred-candidates.txt.
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
 * The fifth committed corpus (2026-09-19): the three-character category titles
 * of ICD-10-CM Chapter XVIII, symptoms, signs and abnormal clinical and
 * laboratory findings — the third codebook enumeration, and the one whose rows
 * are least often diagnoses. A chapter of symptoms is mostly a description of
 * experience, so most of its 86 candidates close as gated-and-uncoded while the
 * 27 findings that do name a discrete entity became canonical rows in 1.11.0.
 * Rows that cannot be a disclosure at all (R27, R57, R99) are declared in the
 * file itself with a reason rather than listed as candidates.
 */
export const ICD10_CHAPTER_XVIII_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-xviii.txt';

/**
 * The sixth committed corpus (2026-09-19): the three-character category titles
 * of ICD-10-CM Chapter XXI, factors influencing health status and contact with
 * health services — the fourth codebook enumeration, and the first chapter that
 * is not a list of diseases. Its 90 titles include 48 that cannot be a
 * disclosure at all (encounters, socioeconomic circumstances, report and device
 * constructs), which are declared in the file with their reasons rather than
 * dropped, leaving 41 candidates. The chapter is where a carrier's questions
 * live: family history, personal history, genetic and carrier status, allergy.
 */
export const ICD10_CHAPTER_XXI_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-xxi.txt';

/**
 * The seventh committed corpus (2026-09-19): the three-character category
 * titles of ICD-10-CM Chapter V, mental and behavioural disorders — the fifth
 * codebook enumeration, and the first chapter whose rows are mostly
 * *stateable* rather than constructs. Where Chapter XIV asked whether a
 * category title ever closes, this one asks whether a vocabulary grown from
 * physical-condition sources sees what a person says about their mind; the
 * rows it found the vocabulary looking straight through (mania, paraphilia,
 * intellectual disability) are what 1.15.0 maps. Its ten coder-routing and
 * residual titles are declared in the file with their reasons rather than
 * dropped, leaving 62 candidates.
 */
export const ICD10_CHAPTER_V_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-v.txt';

/**
 * The eighth committed corpus (2026-09-20): the three-character category
 * titles of ICD-10-CM Chapter VI, diseases of the nervous system — the sixth
 * codebook enumeration, and the chapter that is the vocabulary's oldest
 * strength *and* its largest blind spot of the same kind: MS, migraine,
 * epilepsy and ALS arrived from the carrier sources, while the
 * peripheral-nerve and muscle rows never appeared on a questionnaire. WHO
 * lists 67 categories; CM adds G14 and leaves G42 unused, so the chapter
 * carries 68 titles — 50 candidates after the 18 in-diseases-classified-elsewhere
 * routing and sequela/postprocedural constructs are declared in the file with
 * their reasons. The sweep found seventeen silent rows; ten are named
 * diagnoses 1.17.0 maps.
 */
export const ICD10_CHAPTER_VI_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-vi.txt';

/**
 * The ninth committed corpus (2026-09-20): the three-character category
 * titles of ICD-10-CM Chapter X, diseases of the respiratory system — the
 * seventh codebook enumeration, and the mirror image of Chapter VI: carrier
 * strength in the chapter's centre (asthma, COPD, pneumonia, hay fever, sinus
 * trouble all arrived from the questionnaire sources) and named diagnoses
 * missing at its edges. The pneumoconiosis block is the sweep's
 * underwriting-weight finding — asbestos *exposure* was gated as a Chapter XXI
 * history row, but the diagnoses that follow from it were silent. WHO lists 63
 * categories; CM adds J4A and leaves J46, J83 and J97 unused, so the chapter
 * carries 64 titles — 60 candidates after the pneumonia/pleural-effusion
 * routing rows and the postprocedural block are declared in the file with
 * their reasons.
 */
export const ICD10_CHAPTER_X_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-x.txt';

/**
 * The committed ICD-10-CM Chapter XI corpus (2026-09-20): K00–K95, diseases of
 * the digestive system — the tenth source and the eighth codebook enumeration.
 * The chapter's centre is carrier-questionnaire strength (IBS, GERD, gastritis,
 * cirrhosis, pancreatitis, Crohn's, colitis, diverticular disease,
 * gallstones/gallbladder, hernia, hemorrhoids and piles all arrived from the
 * questionnaire sources, and the dental boundary probes carried caries and
 * gingivitis); the blind spots are the familiar edges — the dental and
 * salivary rows, the appendiceal rows, the peritoneal and hepatic-failure
 * rows, the cholecystitis/biliary rows and the intestinal-obstruction rows.
 * The chapter spans 77 three-character slots and the FY 2026 codebook leaves
 * K07, K10, K24, K84 and K93 unused, so it carries 72 titled categories — 65
 * candidates after the four in-diseases-classified-elsewhere routing rows and
 * the three postprocedural rows are declared in the file with their reasons.
 */
export const ICD10_CHAPTER_XI_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-xi.txt';

/**
 * The eleventh candidate corpus (2026-09-20): the three-character category
 * titles of ICD-10-CM Chapter XII (L00–L99), diseases of the skin and
 * subcutaneous tissue, verbatim FY 2026. The chapter spans 100 three-character
 * slots and the FY 2026 codebook leaves L06, L07, L61, L69 and L96 unused, so
 * it carries 74 titled categories — 67 candidates after the six
 * in-diseases-classified-elsewhere routing rows (L14/L45/L54/L62/L86/L99) and
 * the postprocedural row L76 are declared in the file with their reasons. The
 * chapter centre is carrier strength (atopic dermatitis, eczema, psoriasis,
 * urticaria, rosacea, acne, vitiligo, alopecia areata, melanoma, the
 * non-melanoma skin cancers); the sweep's job is the named edges — the bullous
 * and papulosquamous rarities, the erythemas, the radiation rows, the
 * follicular and sweat disorders, the chronic-wound and autoimmune-skin
 * residuals.
 */
export const ICD10_CHAPTER_XII_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-xii.txt';

/**
 * The twelfth candidate corpus (2026-09-20): the three-character category
 * titles of ICD-10-CM Chapter XIII (M00–M99), diseases of the musculoskeletal
 * system and connective tissue, verbatim FY 2026. The chapter spans 100
 * three-character slots and the FY 2026 codebook leaves M03, M28, M29, M37,
 * M38, M39, M44, M52, M55–M59, M68, M69, M73, M74 and M78 unused, so it
 * carries 80 titled categories (including the CM extension M1A Chronic gout)
 * — 72 candidates after the six in-diseases-classified-elsewhere routing rows
 * (M01/M14/M36/M49/M63/M90) and the postprocedural rows M96/M97 are declared
 * in the file with their reasons. The chapter centre is carrier strength
 * (gout, rheumatoid arthritis, SLE, ankylosing spondylitis, fibromyalgia,
 * osteoarthritis, osteoporosis, scoliosis, disc disorders, carpal tunnel);
 * the sweep's job is the named edges — the arthropathy residuals, TMJ, the
 * vasculitides and myositides, Sjögren's, the dorsopathy family, the tendon
 * and shoulder lesions, Dupuytren's, frozen shoulder, osteomalacia,
 * osteonecrosis, Paget's and the osteochondroses.
 */
export const ICD10_CHAPTER_XIII_CANDIDATE_LIST_PATH =
  'docs/medical-condition-candidates-icd10-chapter-xiii.txt';

/**
 * The committed deferral ledger (2026-09-19): the rows a sweep surfaced and the
 * project deliberately left open, each with its reason on file. It is not a
 * candidate *source* like the six above — it is the counterpart that keeps an
 * open row from being either dropped or quietly treated as a gap. Every run
 * re-asks each row and reports it as `deferred`; the sweep fails if one is ever
 * no longer silent, because then the ledger is stale and has to be updated.
 * `rash` is the worked example: it was deferred by the lay-word measurement and
 * left the ledger when the Chapter XVIII release gated it.
 */
export const DEFERRED_CANDIDATE_LIST_PATH = 'docs/medical-condition-deferred-candidates.txt';

/**
 * Every committed corpus, swept by default: seven independent sources, each a
 * different kind of document, plus the deferral ledger that records what is
 * deliberately still open. `npm run conditions:sweep` therefore re-measures the
 * whole coverage claim rather than one corpus's slice of it.
 */
export const COMMITTED_CANDIDATE_LIST_PATHS: readonly string[] = [
  DEFAULT_CANDIDATE_LIST_PATH,
  CRITICAL_ILLNESS_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_IX_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_XIV_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_XVIII_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_XXI_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_V_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_VI_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_X_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_XI_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_XII_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_XIII_CANDIDATE_LIST_PATH,
  DEFERRED_CANDIDATE_LIST_PATH,
];

/** Where a row stands after both systems have been asked about it. */
export type CoverageStatus =
  | 'mapped_and_gated'
  | 'mapped_not_gated'
  | 'gated_uncoded'
  | 'classified_other'
  | 'silent'
  | 'deferred';

export interface ConditionCandidateRow {
  phrase: string;
  /** The canonical condition the phrase resolves to, if any (exact alias match) */
  mapped: { icd10_cm: string; name: string; system: string } | null;
  /** What the disclosure form of the phrase classifies as, or null */
  category: string | null;
  /** The phrase as the gate was actually asked about it */
  probe: string;
  /** The measured status, or `deferred` when the row is declared and still silent. */
  status: CoverageStatus;
  /**
   * Present when the row carries a deferral declaration. `measured` is what the
   * row measured before the declaration was applied — always `silent` for a
   * live deferral, and something else for a stale one (which blocks).
   */
  deferral?: { reason: string; stale: boolean; measured: CoverageStatus };
}

/** A candidate deliberately left open, with the reason on file. */
export interface DeferredCandidate {
  phrase: string;
  reason: string;
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
    /** Rows on the deferral ledger — declared, still silent, re-asked every sweep. */
    deferred: number;
  };
  /** Rows that are holes: silent, mapped without the gate, or a stale deferral. */
  blocking: ConditionCandidateRow[];
  /** Declared rows that are no longer silent: the ledger has to be updated. */
  staleDeferrals: ConditionCandidateRow[];
}

/** A parsed candidate list: the rows to close, and the rows deliberately open. */
export interface ParsedCandidateList {
  phrases: string[];
  deferred: DeferredCandidate[];
}

/** The repository root, from either src/ (ts-node) or dist/ (built CLI). */
const REPO_ROOT = path.join(__dirname, '..', '..');

/** Resolves a candidate-list path; relative paths are relative to the repository root. */
export function resolveCandidateListPath(listPath: string): string {
  return path.isAbsolute(listPath) ? listPath : path.join(REPO_ROOT, listPath);
}

/**
 * Parses a candidate list: either a JSON array (of strings, or of objects
 * `{ "phrase", "deferred_reason" }`), or one phrase per line with `#` comments
 * and blanks ignored, where `? <phrase> :: <reason>` declares a deliberate
 * deferral. Duplicates are dropped in order.
 *
 * A deferral without a reason is refused rather than defaulted — the reason is
 * the record this format exists for — and a phrase may not be declared both as
 * a candidate and as a deferral, because that makes the ledger ambiguous.
 */
export function parseConditionCandidateList(text: string): ParsedCandidateList {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  const phrases: string[] = [];
  const deferred: DeferredCandidate[] = [];
  const deferredPhrases = new Set<string>();

  const addDeferred = (phrase: string, reason: string, where: string): void => {
    if (phrase.length === 0) throw new Error(`${where}: a deferred row needs a phrase`);
    if (reason.trim().length === 0) {
      throw new Error(`${where}: a deferred row needs a reason`);
    }
    if (deferredPhrases.has(phrase)) return; // deduped like a plain phrase
    deferredPhrases.add(phrase);
    deferred.push({ phrase, reason: reason.trim() });
  };

  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error('a JSON candidate list must be an array of strings or deferred objects');
    }
    for (const entry of parsed) {
      if (typeof entry === 'string') {
        const phrase = entry.trim();
        if (phrase.length > 0) phrases.push(phrase);
        continue;
      }
      const record = entry as { phrase?: unknown; deferred_reason?: unknown } | null;
      if (typeof record?.phrase === 'string' && typeof record.deferred_reason === 'string') {
        addDeferred(record.phrase.trim(), record.deferred_reason, 'a JSON deferred object');
        continue;
      }
      throw new Error(
        'a JSON candidate list must be an array of strings or deferred objects ({ phrase, deferred_reason })',
      );
    }
  } else {
    const lines = trimmed.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (line.length === 0 || line.startsWith('#')) continue;
      if (!line.startsWith('?')) {
        phrases.push(line);
        continue;
      }
      // `? <phrase> :: <reason>` — the separator is required, because a
      // deferral without its reason is an omission, not a declaration.
      const body = line.slice(1).trim();
      const separator = body.indexOf('::');
      if (separator < 0) {
        throw new Error(
          `candidate list line ${index + 1}: a deferred row needs "? <phrase> :: <reason>"`,
        );
      }
      addDeferred(
        body.slice(0, separator).trim(),
        body.slice(separator + 2),
        `candidate list line ${index + 1}`,
      );
    }
  }

  const candidates = [...new Set(phrases)];
  for (const entry of deferred) {
    if (candidates.includes(entry.phrase)) {
      throw new Error(`"${entry.phrase}" is declared both as a candidate and as deferred`);
    }
  }
  return { phrases: candidates, deferred };
}

/** Reads a candidate list from disk. Throws with the resolved path on failure. */
export function readConditionCandidateList(listPath: string = DEFAULT_CANDIDATE_LIST_PATH): {
  phrases: string[];
  deferred: DeferredCandidate[];
  resolved: string;
} {
  const resolved = resolveCandidateListPath(listPath);
  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch {
    throw new Error(`cannot read the candidate list at ${resolved}`);
  }
  return { ...parseConditionCandidateList(text), resolved };
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

/**
 * Measures a declared deferral: the measurement, plus the ledger state. A row
 * that is still silent reports as `deferred`; a row that is no longer silent
 * keeps its measured status and its declaration is marked stale, so the sweep
 * blocks until the ledger is updated.
 */
export function measureDeferredCandidate(deferred: DeferredCandidate): ConditionCandidateRow {
  const row = measureConditionCandidate(deferred.phrase);
  const stale = row.status !== 'silent';
  return {
    ...row,
    status: stale ? row.status : 'deferred',
    deferral: { reason: deferred.reason, stale, measured: row.status },
  };
}

/** Sweeps a candidate list and totals the outcome. */
export function sweepConditionCandidates(
  candidates: readonly string[],
  source = '(candidates)',
  deferred: readonly DeferredCandidate[] = [],
): ConditionCoverageSweep {
  const rows = [
    ...candidates.map((phrase) => measureConditionCandidate(phrase)),
    ...deferred.map((entry) => measureDeferredCandidate(entry)),
  ];
  const totals = {
    // Plain candidate rows — the deferral ledger is reported separately, so a
    // ledger of four open rows reads as 0 candidates + 4 deferred rather than
    // as four candidates that happen to be silent.
    candidates: candidates.length,
    mappedAndGated: rows.filter((row) => row.status === 'mapped_and_gated').length,
    mappedNotGated: rows.filter((row) => row.status === 'mapped_not_gated').length,
    gatedUncoded: rows.filter((row) => row.status === 'gated_uncoded').length,
    classifiedOther: rows.filter((row) => row.status === 'classified_other').length,
    silent: rows.filter((row) => row.status === 'silent').length,
    deferred: rows.filter((row) => row.status === 'deferred').length,
  };
  const staleDeferrals = rows.filter((row) => row.deferral?.stale === true);
  return {
    source,
    rows,
    totals,
    blocking: rows.filter(
      (row) =>
        row.status === 'silent' ||
        row.status === 'mapped_not_gated' ||
        row.deferral?.stale === true,
    ),
    staleDeferrals,
  };
}

/** Reads and sweeps in one step — what the CLI does for each input file. */
export function sweepConditionCandidateList(listPath?: string): ConditionCoverageSweep {
  const { phrases, deferred, resolved } = readConditionCandidateList(listPath);
  return sweepConditionCandidates(phrases, resolved, deferred);
}

/**
 * One row, for the `--all` and problem listings. A deferred row measured silent
 * before its declaration was applied, so it is labelled with its ledger status
 * rather than the SILENT a reader would otherwise mistake for a gap.
 */
function formatRow(row: ConditionCandidateRow): string {
  const mapped = row.mapped ? `${row.mapped.icd10_cm} ${row.mapped.name}` : '—';
  const gated = row.status === 'deferred' ? 'not yet (deferred)' : (row.category ?? 'SILENT');
  return `  ${row.phrase}  →  ${mapped}  |  gated: ${gated}`;
}

/** The human report. Problem buckets are always listed; `all` adds the rest. */
export function formatConditionCoverageSweep(
  sweep: ConditionCoverageSweep,
  options: { all?: boolean } = {},
): string {
  const candidatesLabel = `${sweep.totals.candidates} candidate${
    sweep.totals.candidates === 1 ? '' : 's'
  }`;
  const composition =
    sweep.totals.deferred > 0
      ? `${candidatesLabel} + ${sweep.totals.deferred} deferred`
      : candidatesLabel;
  const lines: string[] = [
    `Condition coverage sweep — ${composition} from ${sweep.source}`,
    `  mapped and gated:     ${sweep.totals.mappedAndGated}`,
    `  mapped, not gated:    ${sweep.totals.mappedNotGated}`,
    `  gated, not mapped:    ${sweep.totals.gatedUncoded}   (descriptive by policy — inspect, do not invent codes)`,
    `  classified otherwise: ${sweep.totals.classifiedOther}`,
    `  neither (silent):     ${sweep.totals.silent}`,
    `  deferred (recorded):  ${sweep.totals.deferred}   (re-asked every sweep; the reason is on file)`,
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
  const deferred = sweep.rows.filter((row) => row.status === 'deferred');
  if (deferred.length > 0) {
    lines.push('', `Deferred rows — recorded, re-asked every sweep (${deferred.length}):`);
    for (const row of deferred) {
      lines.push(`${formatRow(row)}  —  deferred: ${row.deferral?.reason ?? ''}`);
    }
  }
  if (sweep.staleDeferrals.length > 0) {
    lines.push(
      '',
      `Stale deferrals — no longer silent, so the ledger has to be updated (${sweep.staleDeferrals.length}):`,
    );
    for (const row of sweep.staleDeferrals) {
      lines.push(
        `${formatRow(row)}  —  deferred: ${row.deferral?.reason ?? ''} (measured as ${
          row.deferral?.measured ?? row.status
        })`,
      );
    }
  }
  if (options.all) {
    lines.push('', 'Every candidate:');
    for (const row of sweep.rows) {
      const suffix = row.deferral ? `  —  deferred: ${row.deferral.reason}` : '';
      lines.push(`  [${row.status}] ${formatRow(row).trim()}${suffix}`);
    }
  }
  if (sweep.blocking.length === 0) {
    const recorded =
      deferred.length > 0
        ? ` ${deferred.length} row${deferred.length === 1 ? '' : 's'} ${
            deferred.length === 1 ? 'is' : 'are'
          } deferred with a recorded reason (re-asked every sweep).`
        : '';
    lines.push(
      '',
      `No silent rows: every candidate is either mapped or classified as health data.${recorded}`,
    );
  } else {
    lines.push(
      '',
      `${sweep.blocking.length} blocking row${sweep.blocking.length === 1 ? '' : 's'}: ` +
        'map the named diagnoses, gate the descriptive ones, record a deferral with its reason, ' +
        'or close a deferral that is no longer silent.',
    );
  }
  return lines.join('\n');
}
