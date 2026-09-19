/**
 * The condition-coverage sweep — the tool that measures a candidate phrase list
 * against the vocabulary and the gate.
 *
 * What this suite pins: the list parser accepts the formats a reviewer will
 * actually hand it, the classifier puts a row in the right bucket in both
 * directions (mapped but ungated and unmapped but gated are different findings),
 * and the committed 237-phrase corpus sweeps clean — so the questionnaire
 * sweep's "no silent rows" claim is re-measured on every run rather than
 * remembered from the session that made it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  COMMITTED_CANDIDATE_LIST_PATHS,
  CRITICAL_ILLNESS_CANDIDATE_LIST_PATH,
  DEFAULT_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_IX_CANDIDATE_LIST_PATH,
  ICD10_CHAPTER_XIV_CANDIDATE_LIST_PATH,
  formatConditionCoverageSweep,
  measureConditionCandidate,
  parseConditionCandidateList,
  readConditionCandidateList,
  sweepConditionCandidateList,
  sweepConditionCandidates,
} from '../src/medical/condition-coverage-sweep';
import { findCanonicalCondition } from '../src/medical/condition-crosswalk';
import { runConditionCoverageSweepCli } from '../src/medical/condition-coverage-sweep-cli';

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'lifechat-sweep-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function capture(fn: () => number): { code: number; out: string } {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = fn();
    return {
      code,
      out: [...log.mock.calls, ...error.mock.calls].map((call) => call.join(' ')).join('\n'),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

function writeList(name: string, content: string): string {
  const file = path.join(tempDir, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

describe('the candidate-list parser', () => {
  it('reads one phrase per line, ignoring comments and blanks', () => {
    const text = '# a corpus\n\nhypertension\n\n# section\n  sciatica  \nhypertension\n';
    expect(parseConditionCandidateList(text)).toEqual(['hypertension', 'sciatica']);
  });

  it('reads CRLF and a byte-order mark', () => {
    expect(parseConditionCandidateList('\uFEFFgout\r\nsciatica\r\n')).toEqual(['gout', 'sciatica']);
  });

  it('reads a JSON array of strings, and refuses anything else', () => {
    expect(parseConditionCandidateList('["gout", " sciatica ", "gout"]')).toEqual([
      'gout',
      'sciatica',
    ]);
    expect(() => parseConditionCandidateList('[1, 2]')).toThrow(/array of strings/);
  });
});

describe('how a candidate is measured', () => {
  it('asks the phrase as written first, then as a disclosure', () => {
    // 'hemorrhoids' gates on its own; 'piles' only in context, which is the
    // whole reason the tool has a disclosure framing at all.
    expect(measureConditionCandidate('hemorrhoids').probe).toBe('hemorrhoids');
    const piles = measureConditionCandidate('piles');
    expect(piles.probe).toBe('I have piles');
    expect(piles.status).toBe('mapped_and_gated');
    expect(piles.mapped?.icd10_cm).toBe('K64.9');
  });

  it('separates mapped-but-ungated from gated-but-uncoded', () => {
    // A procedure row: protected by the gate, deliberately without a code.
    const stent = measureConditionCandidate('stent');
    expect(stent.mapped).toBeNull();
    expect(stent.category).toBe('health_data');
    expect(stent.status).toBe('gated_uncoded');
  });

  it('calls a row with neither treatment silent', () => {
    const silent = measureConditionCandidate('zonkosis');
    expect(silent.mapped).toBeNull();
    expect(silent.category).toBeNull();
    expect(silent.status).toBe('silent');
  });

  it('totals the buckets and blocks on the holes only', () => {
    const sweep = sweepConditionCandidates(
      ['hypertension', 'stent', 'zonkosis', 'piles'],
      'synthetic',
    );
    expect(sweep.totals).toEqual({
      candidates: 4,
      mappedAndGated: 2,
      mappedNotGated: 0,
      gatedUncoded: 1,
      classifiedOther: 0,
      silent: 1,
    });
    expect(sweep.blocking.map((row) => row.phrase)).toEqual(['zonkosis']);

    // The same rows minus the hole: nothing to block on.
    const closed = sweepConditionCandidates(['hypertension', 'stent', 'piles'], 'synthetic');
    expect(closed.blocking).toEqual([]);
    expect(closed.totals.silent).toBe(0);
  });
});

describe('the committed corpus', () => {
  it('is the 237-phrase questionnaire sweep and still sweeps clean', () => {
    const sweep = sweepConditionCandidateList(DEFAULT_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(237);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.blocking).toEqual([]);
    // Every candidate is accounted for by one of the two closed buckets.
    expect(sweep.totals.mappedAndGated + sweep.totals.gatedUncoded).toBe(237);
    // And the row that was deferred until the context rule closed it is here.
    const piles = sweep.rows.find((row) => row.phrase === 'piles');
    expect(piles?.status).toBe('mapped_and_gated');
  });

  it('reads the file from the repository root, whatever the working directory', () => {
    const { phrases, resolved } = readConditionCandidateList();
    expect(phrases).toHaveLength(237);
    expect(resolved.endsWith(DEFAULT_CANDIDATE_LIST_PATH)).toBe(true);
  });

  it('sweeps the critical-illness corpus clean, with the two count buckets', () => {
    // The second independent source: covered-condition lists (10/30/36) from a
    // carrier publication — a different kind of document from a questionnaire,
    // and the first thing a claim is judged against. The named diagnoses it
    // surfaced are canonical conditions now; the procedure, injury and
    // functional rows it also carries are gated-and-uncoded by policy. Both
    // are closed outcomes, so "no silent rows" is measured here, not asserted.
    const sweep = sweepConditionCandidateList(CRITICAL_ILLNESS_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(51);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.totals.mappedAndGated + sweep.totals.gatedUncoded).toBe(51);
    // The rows that became canonical conditions in 1.6.0, including the alias
    // the carrier list exposed on an existing one.
    for (const [phrase, code] of [
      ['viral encephalitis', 'A86'],
      ['poliomyelitis', 'A80.9'],
      ['bacterial meningitis', 'G00.9'],
      ['motor neurone disease', 'G12.29'],
      ['coma', 'R40.20'],
      ['paraplegia', 'G82.20'],
      ['end stage liver failure', 'K72.90'],
      ['chronic liver disease', 'K76.9'],
      ['aplastic anaemia', 'D61.9'],
      ['benign brain tumour', 'D33.2'],
      ['loss of hearing', 'H91.90'],
    ] as const) {
      const row = sweep.rows.find((candidate) => candidate.phrase === phrase);
      expect(row?.mapped?.icd10_cm).toBe(code);
      expect(row?.status).toBe('mapped_and_gated');
    }
    // And the procedure/injury rows are protected without an invented code.
    for (const phrase of ['coronary artery bypass', 'severe burn', 'major organ transplant']) {
      expect(sweep.rows.find((row) => row.phrase === phrase)?.status).toBe('gated_uncoded');
    }
  });

  it('sweeps the ICD-10 Chapter IX enumeration clean, spelling holes included', () => {
    // The first codebook source: WHO category titles, not visitor phrases. The
    // sweep asks whether the vocabulary sees the thing the code book names —
    // which is how two British spellings and one synonym hole turned up.
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_IX_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(77);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.totals.mappedAndGated + sweep.totals.gatedUncoded).toBe(77);

    for (const [phrase, code] of [
      ['subarachnoid haemorrhage', 'I60.9'],
      ['intracerebral haemorrhage', 'I61.9'],
      ['cerebral infarction', 'I63.9'],
      ['phlebitis and thrombophlebitis', 'I80.9'],
      ['haemorrhoids', 'K64.9'],
      ['nonspecific lymphadenitis', 'I88.9'],
    ] as const) {
      const row = sweep.rows.find((candidate) => candidate.phrase === phrase);
      if (code === 'I80.9') {
        // The category title is two conditions joined by "and" — the gate
        // protects it, the vocabulary resolves each half on its own.
        expect(row?.status).toBe('gated_uncoded');
        expect(findCanonicalCondition('phlebitis')?.icd10_cm).toBe('I80.9');
      } else {
        expect(row?.mapped?.icd10_cm).toBe(code);
        expect(row?.status).toBe('mapped_and_gated');
      }
    }

    // The category constructs are protected without an invented code.
    for (const phrase of [
      'other diseases of pericardium',
      'other disorders of veins',
      'other and unspecified disorders of circulatory system',
    ]) {
      expect(sweep.rows.find((row) => row.phrase === phrase)?.status).toBe('gated_uncoded');
    }
  });

  it('sweeps the ICD-10 Chapter XIV enumeration clean, named rows and constructs alike', () => {
    // The fourth source and the second codebook enumeration: the N00–N99
    // category titles, the chapter the stone family sits in. It is the first
    // corpus whose rows are mostly category constructs rather than stateable
    // diagnoses — which is why most of it closes as gated-and-uncoded while
    // thirty named diagnoses became canonical rows in 1.9.0.
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_XIV_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(85);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.totals.mappedAndGated + sweep.totals.gatedUncoded).toBe(85);

    // The named diagnoses the sweep surfaced, one batch per domain.
    for (const [phrase, code] of [
      ['acute nephritic syndrome', 'N00.9'],
      ['recurrent and persistent hematuria', 'N02.9'],
      ['acute pyelonephritis', 'N10'],
      ['chronic tubulo-interstitial nephritis', 'N11.9'],
      ['acute kidney failure', 'N17.9'],
      ['unspecified kidney failure', 'N19'],
      ['obstructive and reflux uropathy', 'N13.9'],
      ['calculus of lower urinary tract', 'N21.9'],
      ['unspecified renal colic', 'N23'],
      ['cystitis', 'N30.90'],
      ['hydrocele and spermatocele', 'N43.3'],
      ['orchitis and epididymitis', 'N45.1'],
      ['benign mammary dysplasia', 'N60.99'],
      ['hypertrophy of breast', 'N62'],
      ['unspecified lump in breast', 'N63.0'],
      ["diseases of bartholin's gland", 'N75.9'],
      ['female genital prolapse', 'N81.9'],
      ['erosion and ectropion of cervix uteri', 'N86'],
      ['dysplasia of cervix uteri', 'N87.9'],
      ['recurrent pregnancy loss', 'N96'],
    ] as const) {
      const row = sweep.rows.find((candidate) => candidate.phrase === phrase);
      if (phrase === 'hydrocele and spermatocele') {
        // The category title joins two conditions, so it gated without a single
        // code — each half resolved on its own row instead (Chapter IX's
        // "phlebitis and thrombophlebitis" pattern).
        expect(row?.status).toBe('gated_uncoded');
        expect(findCanonicalCondition('hydrocele')?.icd10_cm).toBe('N43.3');
        expect(findCanonicalCondition('spermatocele')?.icd10_cm).toBe('N43.40');
      } else if (phrase === 'orchitis and epididymitis') {
        expect(row?.status).toBe('gated_uncoded');
        expect(findCanonicalCondition('orchitis')?.icd10_cm).toBe('N45.2');
        expect(findCanonicalCondition('epididymitis')?.icd10_cm).toBe('N45.1');
      } else {
        expect(row?.mapped?.icd10_cm).toBe(code);
        expect(row?.status).toBe('mapped_and_gated');
      }
    }

    // And the codebook constructs the chapter enumerates are gated, not coded:
    // category titles, anatomy, and the one row where FY2026 left no sex-free
    // billable code (urethral stricture, now N35.91 male / N35.92 female).
    for (const phrase of [
      'other disorders of bladder',
      'other disorders of urinary system',
      'other noninflammatory disorders of vagina',
      'noninflammatory disorders of testis',
      'intraoperative and postprocedural complications and disorders of genitourinary system, not elsewhere classified',
      'urethral stricture',
    ]) {
      const row = sweep.rows.find((candidate) => candidate.phrase === phrase);
      expect(row?.status).toBe('gated_uncoded');
      expect(findCanonicalCondition(phrase)).toBeNull();
    }
  });

  it('declares all four corpora as the committed set, and reads each of them', () => {
    expect(COMMITTED_CANDIDATE_LIST_PATHS).toEqual([
      DEFAULT_CANDIDATE_LIST_PATH,
      CRITICAL_ILLNESS_CANDIDATE_LIST_PATH,
      ICD10_CHAPTER_IX_CANDIDATE_LIST_PATH,
      ICD10_CHAPTER_XIV_CANDIDATE_LIST_PATH,
    ]);
    for (const listPath of COMMITTED_CANDIDATE_LIST_PATHS) {
      expect(readConditionCandidateList(listPath).phrases.length).toBeGreaterThan(0);
    }
  });

  it('prints the counts, and lists problem rows when there are any', () => {
    const clean = formatConditionCoverageSweep(sweepConditionCandidates(['hypertension']));
    expect(clean).toContain('mapped and gated:     1');
    expect(clean).toContain('No silent rows');

    const noisy = formatConditionCoverageSweep(sweepConditionCandidates(['zonkosis', 'stent']));
    expect(noisy).toContain('Silent rows');
    expect(noisy).toContain('zonkosis');
    expect(noisy).toContain('gated: SILENT');
    expect(noisy).toContain('gated, not mapped:    1');
    expect(noisy).toContain('blocking row');
  });
});

describe('the sweep CLI', () => {
  it('sweeps every committed corpus and exits clean', () => {
    const { code, out } = capture(() => runConditionCoverageSweepCli([]));
    expect(code).toBe(0);
    // Every source, in one run: the questionnaire corpus, the critical-illness
    // lists, and the two codebook enumerations.
    expect(out).toContain('237 candidates');
    expect(out).toContain('51 candidates');
    expect(out).toContain('77 candidates');
    expect(out).toContain('85 candidates');
    expect(out).toContain(CRITICAL_ILLNESS_CANDIDATE_LIST_PATH);
    expect(out).toContain(ICD10_CHAPTER_IX_CANDIDATE_LIST_PATH);
    expect(out).toContain(ICD10_CHAPTER_XIV_CANDIDATE_LIST_PATH);
    expect(out).toContain('No silent rows');
    expect(out).not.toContain('Silent rows');
    expect(out.match(/No silent rows/g)).toHaveLength(4);
  });

  it('emits machine-readable output with --json', () => {
    const { code, out } = capture(() => runConditionCoverageSweepCli(['--json']));
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<{
      source: string;
      totals: {
        candidates: number;
        mappedAndGated: number;
        mappedNotGated: number;
        gatedUncoded: number;
        silent: number;
      };
      blocking: unknown[];
      rows: Array<{ phrase: string; status: string; category: string | null }>;
    }>;
    expect(parsed).toHaveLength(4);
    expect(parsed[0].totals).toEqual({
      candidates: 237,
      mappedAndGated: 184,
      mappedNotGated: 0,
      gatedUncoded: 53,
      classifiedOther: 0,
      silent: 0,
    });
    expect(parsed[0].blocking).toEqual([]);
    expect(parsed[0].rows).toHaveLength(237);
    // The second corpus is machine-readable in the same shape.
    expect(parsed[1].source.endsWith(CRITICAL_ILLNESS_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[1].totals.candidates).toBe(51);
    expect(parsed[1].totals.silent).toBe(0);
    expect(parsed[1].totals.mappedNotGated).toBe(0);
    expect(parsed[1].blocking).toEqual([]);
    expect(parsed[1].rows).toHaveLength(51);
    // …and the codebook enumeration in the same shape.
    expect(parsed[2].source.endsWith(ICD10_CHAPTER_IX_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[2].totals.candidates).toBe(77);
    expect(parsed[2].totals.mappedAndGated).toBe(14);
    expect(parsed[2].totals.gatedUncoded).toBe(63);
    expect(parsed[2].totals.silent).toBe(0);
    expect(parsed[2].totals.mappedNotGated).toBe(0);
    expect(parsed[2].blocking).toEqual([]);
    expect(parsed[2].rows).toHaveLength(77);
    // …and the second codebook enumeration in the same shape. Its bucket split
    // is the largest gated-not-coded share of any corpus: most of the chapter is
    // category constructs, and the thirty named diagnoses it does surface are
    // canonical rows now.
    expect(parsed[3].source.endsWith(ICD10_CHAPTER_XIV_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[3].totals).toEqual({
      candidates: 85,
      mappedAndGated: 28,
      mappedNotGated: 0,
      gatedUncoded: 57,
      classifiedOther: 0,
      silent: 0,
    });
    expect(parsed[3].blocking).toEqual([]);
    expect(parsed[3].rows).toHaveLength(85);
  });

  it('lists every row with --all, including the good ones', () => {
    const { code, out } = capture(() => runConditionCoverageSweepCli(['--all']));
    expect(code).toBe(0);
    expect(out).toContain('[mapped_and_gated]');
    expect(out).toContain('[gated_uncoded]');
    expect(out).toContain('Every candidate:');
  });

  it('exits 1 on a candidate list with a silent row, and reports it', () => {
    const file = writeList('mixed.txt', '# scratch\nhypertension\nzonkosis\n');
    const { code, out } = capture(() => runConditionCoverageSweepCli([file]));
    expect(code).toBe(1);
    expect(out).toContain('zonkosis');
    expect(out).toContain('Silent rows');
  });

  it('exits 0 on a clean list, and with --report-only even on a dirty one', () => {
    const clean = writeList('clean.txt', 'gout\nsciatica\n');
    expect(capture(() => runConditionCoverageSweepCli([clean])).code).toBe(0);

    const dirty = writeList('dirty.txt', 'zonkosis\n');
    expect(capture(() => runConditionCoverageSweepCli([dirty])).code).toBe(1);
    const reportOnly = capture(() => runConditionCoverageSweepCli([dirty, '--report-only']));
    expect(reportOnly.code).toBe(0);
    expect(reportOnly.out).toContain('zonkosis');
  });

  it('sweeps several lists in one run', () => {
    const a = writeList('a.txt', 'gout\n');
    const b = writeList('b.json', '["sciatica", "piles"]');
    const { code, out } = capture(() => runConditionCoverageSweepCli([a, b, '--json']));
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<{ totals: { candidates: number } }>;
    expect(parsed.map((sweep) => sweep.totals.candidates)).toEqual([1, 2]);
  });

  it('fails loudly on a missing list and on an unknown flag', () => {
    const missing = capture(() => runConditionCoverageSweepCli([path.join(tempDir, 'nope.txt')]));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('cannot read the candidate list');

    const unknown = capture(() => runConditionCoverageSweepCli(['--wat']));
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('unknown argument');

    const help = capture(() => runConditionCoverageSweepCli(['--help']));
    expect(help.code).toBe(0);
    expect(help.out).toContain('Condition coverage sweep');
  });
});
