/**
 * The condition-coverage sweep — the tool that measures a candidate phrase list
 * against the vocabulary and the gate.
 *
 * What this suite pins: the list parser accepts the formats a reviewer will
 * actually hand it, the classifier puts a row in the right bucket in both
 * directions (mapped but ungated and unmapped but gated are different findings),
 * a deliberately deferred row reports as `deferred` with its reason on file —
 * re-asked on every run, never counted as a gap, and blocking the moment it is
 * no longer silent — and the committed 237-phrase corpus sweeps clean, so the
 * questionnaire sweep's "no silent rows" claim is re-measured on every run
 * rather than remembered from the session that made it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  COMMITTED_CANDIDATE_LIST_PATHS,
  CRITICAL_ILLNESS_CANDIDATE_LIST_PATH,
  DEFAULT_CANDIDATE_LIST_PATH,
  DEFERRED_CANDIDATE_LIST_PATH,
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
    expect(parseConditionCandidateList(text)).toEqual({
      phrases: ['hypertension', 'sciatica'],
      deferred: [],
    });
  });

  it('reads CRLF and a byte-order mark', () => {
    expect(parseConditionCandidateList('\uFEFFgout\r\nsciatica\r\n')).toEqual({
      phrases: ['gout', 'sciatica'],
      deferred: [],
    });
  });

  it('reads a JSON array of strings, and refuses anything else', () => {
    expect(parseConditionCandidateList('["gout", " sciatica ", "gout"]')).toEqual({
      phrases: ['gout', 'sciatica'],
      deferred: [],
    });
    expect(() => parseConditionCandidateList('[1, 2]')).toThrow(/array of strings/);
  });

  it('reads `? <phrase> :: <reason>` as a deferral, keeping the reason verbatim', () => {
    const text =
      '# the ledger\n\n? cold :: its guard would be an open list of noun senses\n? bug :: the ordinary sense is the product’s own vocabulary\n';
    expect(parseConditionCandidateList(text)).toEqual({
      phrases: [],
      deferred: [
        { phrase: 'cold', reason: 'its guard would be an open list of noun senses' },
        { phrase: 'bug', reason: 'the ordinary sense is the product’s own vocabulary' },
      ],
    });
  });

  it('reads deferred objects alongside plain phrases in a JSON list', () => {
    const parsed = parseConditionCandidateList(
      '["gout", { "phrase": "cold", "deferred_reason": "an open list of noun senses" }]',
    );
    expect(parsed.phrases).toEqual(['gout']);
    expect(parsed.deferred).toEqual([{ phrase: 'cold', reason: 'an open list of noun senses' }]);
  });

  it('refuses a deferral without a reason, in both formats', () => {
    // The reason is the record the format exists for, so its absence is an
    // error rather than a default.
    expect(() => parseConditionCandidateList('? cold')).toThrow(/needs "\? <phrase> :: <reason>"/);
    expect(() => parseConditionCandidateList('? cold ::   ')).toThrow(/needs a reason/);
    expect(() => parseConditionCandidateList('? :: a reason')).toThrow(/needs a phrase/);
    expect(() => parseConditionCandidateList('[{"phrase": "cold"}]')).toThrow(
      /array of strings or deferred objects/,
    );
    expect(() =>
      parseConditionCandidateList('[{"phrase": "cold", "deferred_reason": ""}]'),
    ).toThrow(/needs a reason/);
  });

  it('refuses a phrase declared both as a candidate and as deferred', () => {
    expect(() => parseConditionCandidateList('cold\n? cold :: a reason')).toThrow(
      /both as a candidate and as deferred/,
    );
  });

  it('dedupes deferred rows the way it dedupes candidates', () => {
    const parsed = parseConditionCandidateList('? cold :: first\n? cold :: second\n');
    expect(parsed.deferred).toEqual([{ phrase: 'cold', reason: 'first' }]);
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
      deferred: 0,
    });
    expect(sweep.blocking.map((row) => row.phrase)).toEqual(['zonkosis']);

    // The same rows minus the hole: nothing to block on.
    const closed = sweepConditionCandidates(['hypertension', 'stent', 'piles'], 'synthetic');
    expect(closed.blocking).toEqual([]);
    expect(closed.totals.silent).toBe(0);
  });
});

describe('declared deferrals', () => {
  it('reports a declared row as `deferred`, with the reason and the measurement kept', () => {
    const sweep = sweepConditionCandidates(['hypertension'], 'synthetic', [
      { phrase: 'zonkosis', reason: 'no treatment for it has been agreed' },
    ]);
    const row = sweep.rows.find((candidate) => candidate.phrase === 'zonkosis');
    expect(row?.status).toBe('deferred');
    expect(row?.deferral).toEqual({
      reason: 'no treatment for it has been agreed',
      stale: false,
      measured: 'silent',
    });
    // A declaration is recorded, not a gap: it is counted as deferred, is not
    // listed among the silent rows, and does not block.
    expect(sweep.totals.candidates).toBe(1);
    expect(sweep.totals.deferred).toBe(1);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.staleDeferrals).toEqual([]);
  });

  it('makes a deferral stale the moment its row stops being silent', () => {
    // `piles` is the worked example: deferred by the lay-word measurement while
    // it was silent, closed by the context rule since. A declaration left on
    // file must block until the ledger is updated rather than pass quietly —
    // this is the direction that stops a deferral becoming a quiet closure.
    const sweep = sweepConditionCandidates([], 'synthetic', [
      { phrase: 'piles', reason: 'its ordinary sense is a quantifier' },
    ]);
    const row = sweep.rows[0];
    expect(row.status).toBe('mapped_and_gated');
    expect(row.deferral).toEqual({
      reason: 'its ordinary sense is a quantifier',
      stale: true,
      measured: 'mapped_and_gated',
    });
    expect(sweep.totals.deferred).toBe(0);
    expect(sweep.totals.mappedAndGated).toBe(1);
    expect(sweep.staleDeferrals.map((entry) => entry.phrase)).toEqual(['piles']);
    expect(sweep.blocking.map((entry) => entry.phrase)).toEqual(['piles']);
  });

  it('treats a declared row that is now gated-but-uncoded as stale too', () => {
    // Any measured status other than `silent` means the declaration is out of
    // date, not only a mapped one.
    const sweep = sweepConditionCandidates([], 'synthetic', [
      { phrase: 'stent', reason: 'left open, since a stent is a procedure' },
    ]);
    expect(sweep.rows[0].status).toBe('gated_uncoded');
    expect(sweep.rows[0].deferral?.stale).toBe(true);
    expect(sweep.blocking.map((entry) => entry.phrase)).toEqual(['stent']);
  });

  it('lists the deferred rows with their reasons and does not call them gaps', () => {
    const report = formatConditionCoverageSweep(
      sweepConditionCandidates(['hypertension'], 'synthetic', [
        { phrase: 'zonkosis', reason: 'waiting on the next codebook revision' },
      ]),
    );
    expect(report).toContain('1 candidate + 1 deferred');
    expect(report).toContain('deferred (recorded):  1');
    expect(report).toContain('Deferred rows — recorded, re-asked every sweep (1):');
    expect(report).toContain('zonkosis');
    expect(report).toContain('gated: not yet (deferred)');
    expect(report).toContain('deferred: waiting on the next codebook revision');
    expect(report).toContain('1 row is deferred with a recorded reason');
    expect(report).not.toContain('Silent rows');
    expect(report).not.toContain('blocking row');
  });

  it('blocks on a stale deferral and says the ledger has to be updated', () => {
    const report = formatConditionCoverageSweep(
      sweepConditionCandidates([], 'synthetic', [
        { phrase: 'piles', reason: 'its ordinary sense is a quantifier' },
      ]),
    );
    expect(report).toContain('Stale deferrals');
    expect(report).toContain('no longer silent');
    expect(report).toContain('the ledger has to be updated');
    expect(report).toContain('(measured as mapped_and_gated)');
    expect(report).toContain('1 blocking row');
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
    // category titles, anatomy, and the row whose code depends on the person's
    // sex (urethral stricture — FY2026 N35.919 male / N35.92 female, which the
    // crosswalk resolves from the consented profile since 1.10.0). The sweep
    // probes without any context on purpose, so the row reads gated-uncoded here
    // exactly as it would in a chat where nobody had answered the sex question.
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

  it('sweeps the ICD-10 Chapter XVIII enumeration clean, findings and symptom constructs alike', () => {
    // The fifth source and the third codebook enumeration: the R00–R99 category
    // titles — symptoms, signs and abnormal clinical and laboratory findings. It
    // is the corpus whose rows are least often diagnoses, so the split is the
    // widest yet: the 27 findings that name a discrete entity became canonical
    // rows in 1.11.0 and the rest closed as gate terms, each declared with its
    // reason (a cough, a headache or a rash is not a diagnosis).
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_XVIII_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(86);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.totals.mappedAndGated + sweep.totals.gatedUncoded).toBe(86);

    // The category titles whose finding the release mapped, title-text and all.
    for (const [phrase, code] of [
      ['unspecified jaundice', 'R17'],
      ['ascites', 'R18.8'],
      ['hematuria', 'R31.9'],
      ['retention of urine', 'R33.9'],
      ['anuria and oliguria', 'R34'],
      ['polyuria', 'R35.89'],
      ['syncope and collapse', 'R55'],
      ['enlarged lymph nodes', 'R59.9'],
      ['proteinuria', 'R80.9'],
      ['glycosuria', 'R81'],
    ] as const) {
      const row = sweep.rows.find((candidate) => candidate.phrase === phrase);
      expect(row?.mapped?.icd10_cm).toBe(code);
      expect(row?.status).toBe('mapped_and_gated');
    }

    // The joined title gates as written while each half is its own row (the
    // Chapter IX and XIV precedent), and the R35 coda reaches the two members
    // the polyuria title names.
    const joined = sweep.rows.find(
      (candidate) => candidate.phrase === 'hepatomegaly and splenomegaly, not elsewhere classified',
    );
    expect(joined?.status).toBe('gated_uncoded');
    expect(findCanonicalCondition('hepatomegaly')?.icd10_cm).toBe('R16.0');
    expect(findCanonicalCondition('splenomegaly')?.icd10_cm).toBe('R16.1');
    expect(findCanonicalCondition('frequency of micturition')?.icd10_cm).toBe('R35.0');

    // The symptom vocabulary the chapter is built from is gated, not coded —
    // including the row whose words the registry carries because their ordinary
    // senses are common ("a rash decision"), and the two report constructs that
    // are the product's own subject matter rather than a visitor's disclosure.
    for (const phrase of [
      'cough',
      'nausea and vomiting',
      'rash and other nonspecific skin eruption',
      'abnormal results of function studies',
      'abnormal tumor markers',
    ]) {
      const row = sweep.rows.find((candidate) => candidate.phrase === phrase);
      expect(row?.status).toBe('gated_uncoded');
      expect(findCanonicalCondition(phrase)).toBeNull();
    }
  });

  it('sweeps the ICD-10 Chapter XXI enumeration clean, where the chapter is mostly status', () => {
    // The sixth source and the fourth codebook enumeration: the Z00–Z99
    // category titles — factors influencing health status, the first chapter
    // that is not a list of diseases. Forty-eight of its 90 titles are encounter,
    // socioeconomic and report constructs that cannot be a disclosure (declared
    // in the file, with reasons), and the 41 candidates close without a gap:
    // forty of them became canonical *history/status* rows in 1.12.0 and the
    // rest are gated descriptively. The sweep's mapped bucket is small on
    // purpose — the corpus carries the codebook's wording, so most mapped rows
    // are reached by the shorter phrasing a person states, which the gate
    // suite's scope ledger asserts one by one.
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_XXI_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(41);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.totals.mappedAndGated + sweep.totals.gatedUncoded).toBe(41);

    // The three rows whose *own title* is the phrase a person states, and the
    // rows the chapter is built from: each is gated, and the stateable forms of
    // the declared non-stateable blocks are gated too (the declarations are only
    // safe because the content is covered).
    for (const [phrase, code] of [
      ['Genetic carrier', 'Z14.8'],
      ['Do not resuscitate', 'Z66'],
      ['Asymptomatic human immunodeficiency virus [HIV] infection status', 'Z21'],
    ] as const) {
      const row = sweep.rows.find((candidate) => candidate.phrase === phrase);
      expect(row?.mapped?.icd10_cm).toBe(code);
      expect(row?.status).toBe('mapped_and_gated');
    }
    for (const phrase of [
      'Pregnant state',
      'Blood type',
      'Weeks of gestation',
      'Acquired absence of organs, not elsewhere classified',
      'Artificial opening status',
      'Long term (current) drug therapy',
    ]) {
      const row = sweep.rows.find((candidate) => candidate.phrase === phrase);
      expect(row?.status).toBe('gated_uncoded');
    }
    // The declared blocks are not candidates, so the chapter's 90 titles measure
    // as 41 candidates — and the count is asserted rather than implied, so a row
    // cannot quietly join or leave the declared set.
    expect(readConditionCandidateList(ICD10_CHAPTER_XXI_CANDIDATE_LIST_PATH).phrases).toHaveLength(
      41,
    );
  });

  it('re-asks the deferral ledger every run: the three recorded rows, none silent', () => {
    // The ledger is the counterpart to the corpora, not another source: it is
    // where the rows deliberately left open stay visible. Every run measures
    // each row afresh (a declaration is not a stored verdict), so a row that has
    // quietly closed comes back as stale and stops the sweep.
    const sweep = sweepConditionCandidateList(DEFERRED_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(0);
    expect(sweep.totals.deferred).toBe(3);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.staleDeferrals).toEqual([]);
    expect(sweep.rows.map((row) => row.phrase)).toEqual(['fit', 'mole', 'cold']);
    for (const row of sweep.rows) {
      expect(row.status).toBe('deferred');
      expect(row.deferral?.measured).toBe('silent');
      expect(row.deferral?.reason.length).toBeGreaterThan(0);
    }
    // The worked example of a deferral that ended: `rash` closed with the
    // Chapter XVIII release, so it must not still be sitting on the ledger.
    expect(sweep.rows.some((row) => row.phrase === 'rash')).toBe(false);
    const { phrases, deferred } = readConditionCandidateList(DEFERRED_CANDIDATE_LIST_PATH);
    expect(phrases).toEqual([]);
    expect(deferred.map((entry) => entry.phrase)).toEqual(['fit', 'mole', 'cold']);
  });

  it('declares the seven corpora and the deferral ledger as the committed set, and reads each', () => {
    expect(COMMITTED_CANDIDATE_LIST_PATHS).toEqual([
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
    ]);
    for (const listPath of COMMITTED_CANDIDATE_LIST_PATHS) {
      const { phrases, deferred } = readConditionCandidateList(listPath);
      expect(phrases.length + deferred.length).toBeGreaterThan(0);
    }
  });

  it('sweeps the ICD-10 Chapter V enumeration clean, stateable rows and constructs alike', () => {
    // The seventh source and the fifth codebook enumeration, and the first
    // chapter whose rows are mostly *stateable*: a mental and behavioural
    // disorder is something a person says about themselves, so a bare category
    // title is close to what a visitor types. The vocabulary — grown from
    // physical-condition sources — was looking straight through mania, the
    // depressive episode and the whole intellectual-disability block; 1.16.0
    // closed that, and this is the corpus that measured it. The ten titles
    // declared in the file are coder-routing constructs (an "other ..."
    // residual, a chapter-level "unspecified ..." row), which is why the
    // gated bucket stays large while the sweep is still clean.
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_V_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(62);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.totals.mappedAndGated + sweep.totals.gatedUncoded).toBe(62);

    // The rows the enumeration surfaced because the chapter is about the mind:
    // each is the wording a person states, so each had to become a canonical row
    // rather than a descriptive gate term.
    const named = new Map<string, string>([
      ['manic episode', 'F30.9'],
      ['depressive episode', 'F32.9'],
      ['paraphilias', 'F65.9'],
      ['mild intellectual disabilities', 'F70'],
      ['moderate intellectual disabilities', 'F71'],
      ['severe intellectual disabilities', 'F72'],
      ['profound intellectual disabilities', 'F73'],
      ['unspecified intellectual disabilities', 'F79'],
    ]);
    for (const [phrase, code] of named) {
      expect({ phrase, code: findCanonicalCondition(phrase)?.icd10_cm }).toEqual({ phrase, code });
    }

    // The residual the chapter files beside them is *not* mapped, and that is a
    // finding rather than an omission: F78 is a non-billable header whose only
    // members are genetic-related, so "other intellectual disabilities" is
    // gated and deliberately uncoded.
    expect(findCanonicalCondition('other intellectual disabilities')).toBeNull();
  });

  it('sweeps the ICD-10 Chapter X enumeration clean, with twenty-five named diagnoses mapped', () => {
    // The ninth source and the seventh codebook enumeration: J00–J99, diseases
    // of the respiratory system. The chapter's strong block — asthma, COPD,
    // pneumonia, OSA — arrived from the carrier sources long ago; its blind
    // spot sat exactly where Chapter XXI's exposure row pointed: the
    // occupational-lung diagnoses that follow asbestos were silent before
    // 1.19.0 closed them.
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_X_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(60);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.totals.mappedAndGated + sweep.totals.gatedUncoded).toBe(60);

    // The named diagnoses the enumeration surfaced: each is a discrete,
    // stateable entity the person can claim, so each became a canonical row.
    const named = new Map<string, string>([
      ['Acute nasopharyngitis [common cold]', 'J00'],
      ['Streptococcal pharyngitis', 'J02.0'],
      ['Streptococcal pharyngitis, unspecified', 'J02.9'],
      ['Acute upper respiratory infection, unspecified', 'J06.9'],
      ['Acute bronchiolitis, unspecified', 'J21.9'],
      [
        'Influenza due to unidentified influenza virus with other respiratory manifestations',
        'J11.1',
      ],
      [
        'Influenza due to other identified influenza virus with other respiratory manifestations',
        'J10.1',
      ],
      ['Acute respiratory distress syndrome', 'J80'],
      ['Pleural effusion, not elsewhere classified', 'J90'],
      [
        'Respiratory failure, unspecified, unspecified whether with hypoxia or hypercapnia',
        'J96.90',
      ],
      ['Unspecified pneumoconiosis', 'J64'],
      ["Coalworker's pneumoconiosis", 'J60'],
      ['Pneumoconiosis due to other dust containing silica', 'J62.8'],
      ['Pneumoconiosis due to asbestos and other mineral fibers', 'J61'],
      ['Hypersensitivity pneumonitis due to unspecified organic dust', 'J67.9'],
      ['Berylliosis', 'J63.2'],
      ['Byssinosis', 'J66.0'],
      ["Farmer's lung", 'J67.0'],
      ["Bird fancier's lung", 'J67.2'],
      ['Unspecified respiratory condition due to chemicals, gases, fumes and vapours', 'J68.9'],
      ['Peritonsillar abscess', 'J36'],
      ['Paralysis of vocal cords and larynx, unspecified', 'J38.00'],
      ['Chronic disease of tonsils and adenoids, unspecified', 'J35.9'],
      ['Acute obstructive laryngitis [croup]', 'J05.0'],
      ['Acute laryngitis and tracheitis, unspecified', 'J04.9'],
    ]);
    for (const [phrase, code] of named) {
      expect({ phrase, code: findCanonicalCondition(phrase)?.icd10_cm }).toEqual({ phrase, code });
    }

    // The strain-qualified influenza categories are gated, not coded: the flu
    // stem covers the disclosure, and a bare category header does not invent a
    // billable home. The same rule keeps J81 pulmonary edema uncoded — the
    // words do not carry an acuity — and "pleural plaque" gates without a code
    // rather than misstating the J92 with/without-asbestos split.
    expect(
      findCanonicalCondition('Influenza due to identified novel influenza A virus'),
    ).toBeNull();
    expect(findCanonicalCondition('Pulmonary edema')).toBeNull();
    expect(findCanonicalCondition('Pleural plaque')).toBeNull();
  });

  it('sweeps the ICD-10 Chapter XI enumeration clean, with seventeen named diagnoses mapped', () => {
    // The tenth source and the eighth codebook enumeration: K00–K95, diseases
    // of the digestive system. The chapter's centre — IBS, GERD, gastritis,
    // cirrhosis, pancreatitis, Crohn's, colitis, diverticular disease,
    // gallstones, hernia, hemorrhoids — arrived from the carrier sources long
    // ago; its edges were the appendiceal rows, the peritoneal and hepatic
    // residuals, the salivary and dental rows, and the obstruction rows.
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_XI_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(65);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.totals.mappedAndGated).toBe(12);
    expect(sweep.totals.gatedUncoded).toBe(53);
    expect(sweep.blocking).toEqual([]);

    // The named diagnoses the enumeration surfaced, mapped 1.20.0 in four
    // batches (5/5/5/2 — the anal-fistula row the chapter would have repeated
    // is already carried at K60.3). Bare "appendicitis" resolves to the
    // codebook's unspecified home K37, disjoint from the acute row.
    const named = new Map<string, string>([
      ['Unspecified acute appendicitis', 'K35.80'],
      ['Unspecified appendicitis', 'K37'],
      ['Other appendicitis', 'K36'],
      ['Functional dyspepsia', 'K30'],
      ['Peritonitis, unspecified', 'K65.9'],
      ['Fatty (change of) liver, not elsewhere classified', 'K76.0'],
      ['Disease of salivary gland, unspecified', 'K11.9'],
      ['Recurrent oral aphthae', 'K12.0'],
      ['Leukoplakia of oral mucosa, including tongue', 'K13.21'],
      ['Rectal prolapse', 'K62.3'],
      ['Disease of biliary tract, unspecified', 'K83.9'],
      ['Disease of pancreas, unspecified', 'K86.9'],
      ['Disease of tongue, unspecified', 'K14.9'],
      ['Ulcer of anus and rectum', 'K62.6'],
      ['Paralytic ileus', 'K56.0'],
      ['Ileus, unspecified', 'K56.7'],
      ['Intestinal malabsorption, unspecified', 'K90.9'],
    ]);
    for (const [phrase, code] of named) {
      expect({ phrase, code: findCanonicalCondition(phrase)?.icd10_cm }).toEqual({ phrase, code });
    }

    // The headers stayed gated-not-coded, the same rule as every chapter: the
    // K38 appendix residual is closed by its category-title stems (bare
    // "appendix" is a document's appendix), and the dental residuals close
    // gated-not-coded per the 2026-09-18 boundary ruling.
    expect(findCanonicalCondition('Other diseases of appendix')).toBeNull();
    expect(findCanonicalCondition('Anal fistula, unspecified')).toBeNull();
  });

  it('sweeps the ICD-10 Chapter XII enumeration clean, with thirteen named diagnoses mapped', () => {
    // The eleventh source and the ninth codebook enumeration: L00–L99,
    // diseases of the skin and subcutaneous tissue. The chapter's centre —
    // atopic dermatitis, eczema, psoriasis, urticaria, rosacea, acne,
    // vitiligo, alopecia areata, melanoma, the non-melanoma skin cancers —
    // arrived from the carrier sources long ago; its edges were the bullous
    // disorders, the erythemas, the radiation and hair residuals, and the
    // autoimmune-skin rarities.
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_XII_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(67);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.totals.mappedAndGated).toBe(22);
    expect(sweep.totals.gatedUncoded).toBe(45);
    expect(sweep.blocking).toEqual([]);

    // The named diagnoses the enumeration surfaced, mapped 1.21.0 in three
    // batches. The two category-with-member shapes follow the chapter rules:
    // impetigo maps to the billable unspecified L01.00 of its non-billable
    // header, and lichen sclerosus is the stateable member of the
    // atrophic-disorders category whose bare title stays descriptive.
    const named = new Map<string, string>([
      ['Staphylococcal scalded skin syndrome', 'L00'],
      ['Impetigo', 'L01.00'],
      ['Pemphigus', 'L10.9'],
      ['Pemphigoid', 'L12.9'],
      ['Lichen simplex chronicus', 'L28.0'],
      ['Pityriasis rosea', 'L42'],
      ['Erythema multiforme', 'L51.9'],
      ['Erythema nodosum', 'L52'],
      ['Sunburn', 'L55.9'],
      ['Hypertrichosis', 'L68.9'],
      ['Acanthosis nigricans', 'L83'],
      ['Pyoderma gangrenosum', 'L88'],
      ['Lichen sclerosus', 'L90.0'],
    ]);
    for (const [phrase, code] of named) {
      expect({ phrase, code: findCanonicalCondition(phrase)?.icd10_cm }).toEqual({ phrase, code });
    }

    // Pilonidal cyst gates without a code: the L05 with/without-abscess split
    // is not carried by the bare words, the same rule as pleural plaque. Bare
    // "pigmentation", "corns" and "exfoliation" stay unwatched for their
    // ordinary cosmetics and food senses — the category-title wordings close
    // the L81/L84/L85 residuals instead.
    expect(findCanonicalCondition('Pilonidal cyst and sinus')).toBeNull();
    expect(findCanonicalCondition('Other disorders of pigmentation')).toBeNull();
    expect(findCanonicalCondition('Corns and callosities')).toBeNull();
  });

  it('sweeps the ICD-10 Chapter XIII enumeration clean, with eleven named diagnoses mapped', () => {
    // The twelfth source and the tenth codebook enumeration: M00–M99,
    // diseases of the musculoskeletal system and connective tissue — the
    // largest body-system chapter. Its centre is carrier strength (gout,
    // rheumatoid arthritis, SLE, psoriatic arthritis, ankylosing spondylitis,
    // scleroderma, fibromyalgia, osteoarthritis, osteoporosis, scoliosis,
    // disc disorders, spinal stenosis, sciatica, carpal tunnel, Ehlers-Danlos,
    // Marfan) and its edges were the vasculitides, the myositides, the
    // dorsopathy family, and the bone-density and osteochondrosis residuals.
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_XIII_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(71);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.totals.mappedAndGated).toBe(7);
    expect(sweep.totals.gatedUncoded).toBe(64);
    expect(sweep.blocking).toEqual([]);

    // The named diagnoses the enumeration surfaced, mapped 1.22.0 in three
    // batches. The shoulder rows the chapter would have repeated — frozen
    // shoulder and rotator cuff — are carried from the carrier sources,
    // the same repeat-check that caught the Chapter XI duplicates.
    const named = new Map<string, string>([
      ['Calcaneal spur, unspecified foot', 'M77.30'],
      ['Palmar fascial fibromatosis [Dupuytren]', 'M72.0'],
      ['Adult osteomalacia, unspecified', 'M83.9'],
      ['Osteonecrosis, unspecified', 'M87.9'],
      ['Osteitis deformans of unspecified bone', 'M88.9'],
      ['Disorder of continuity of bone, unspecified', 'M84.9'],
      ['Myositis, unspecified', 'M60.9'],
      ['Polyarteritis nodosa', 'M30.0'],
      ['Other giant cell arteritis', 'M31.6'],
      ['Other dermatomyositis, organ involvement unspecified', 'M33.10'],
      ['Polymyalgia rheumatica', 'M35.3'],
    ]);
    for (const [phrase, code] of named) {
      expect({ phrase, code: findCanonicalCondition(phrase)?.icd10_cm }).toEqual({ phrase, code });
    }

    // The carried shoulder rows still resolve, so the chapter repeats none of
    // them; the dorsopathy and deformity residuals are descriptions rather
    // than stateable entities and stay gated-not-coded.
    expect(findCanonicalCondition('Adhesive capsulitis of unspecified shoulder')?.icd10_cm).toBe(
      'M75.00',
    );
    expect(findCanonicalCondition('Other deforming dorsopathies')).toBeNull();
  });

  it('sweeps the ICD-10 Chapter VI enumeration clean, with ten named diagnoses mapped', () => {
    // The eighth source and the sixth codebook enumeration: G00–G99, diseases
    // of the nervous system. The chapter is the vocabulary's oldest strength —
    // MS, migraine, epilepsy, ALS all arrived from carrier sources — and its
    // largest blind spot of the same kind: the peripheral-nerve and muscle rows
    // never appeared on a questionnaire, and seventeen of the fifty candidates
    // were silent before 1.17.0 closed them. The 18 titles declared in the file
    // are in-diseases-classified-elsewhere routing and sequela/postprocedural
    // constructs, which is why the gated bucket stays large while the sweep is
    // still clean.
    const sweep = sweepConditionCandidateList(ICD10_CHAPTER_VI_CANDIDATE_LIST_PATH);
    expect(sweep.totals.candidates).toBe(50);
    expect(sweep.totals.silent).toBe(0);
    expect(sweep.totals.mappedNotGated).toBe(0);
    expect(sweep.totals.classifiedOther).toBe(0);
    expect(sweep.blocking).toEqual([]);
    expect(sweep.totals.mappedAndGated + sweep.totals.gatedUncoded).toBe(50);

    // The named diagnoses the enumeration surfaced: each is a discrete,
    // stateable entity the person can claim, so each became a canonical row.
    const named = new Map<string, string>([
      ['Spinal muscular atrophy and related syndromes', 'G12.9'],
      ['Dystonia', 'G24.9'],
      ['Hemiplegia and hemiparesis', 'G81.90'],
      ['Primary disorders of muscles', 'G71.9'],
      ['Other myopathies', 'G72.9'],
      ['Disorders of trigeminal nerve', 'G50.0'],
      ['Toxic encephalopathy', 'G92.9'],
      ['Other disorders of brain', 'G93.9'],
      ['Other diseases of spinal cord', 'G95.9'],
      ['Other disorders of nervous system, not elsewhere classified', 'G98'],
    ]);
    for (const [phrase, code] of named) {
      expect({ phrase, code: findCanonicalCondition(phrase)?.icd10_cm }).toEqual({ phrase, code });
    }

    // The organ and residual constructs beside them are *not* mapped, and that
    // is a finding rather than an omission: no code invents itself for "other
    // disorders of peripheral nervous system" — the person's words would name
    // the specific diagnosis if they carried one.
    expect(findCanonicalCondition('Other disorders of peripheral nervous system')).toBeNull();
    expect(
      findCanonicalCondition(
        'Other degenerative diseases of nervous system, not elsewhere classified',
      ),
    ).toBeNull();
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
  it('sweeps every committed corpus and the deferral ledger, and exits clean', () => {
    const { code, out } = capture(() => runConditionCoverageSweepCli([]));
    expect(code).toBe(0);
    // Every source, in one run: the questionnaire corpus, the critical-illness
    // lists, the four codebook enumerations — and the deferral ledger, which is
    // re-asked rather than remembered.
    expect(out).toContain('237 candidates');
    expect(out).toContain('51 candidates');
    expect(out).toContain('77 candidates');
    expect(out).toContain('85 candidates');
    expect(out).toContain('86 candidates');
    expect(out).toContain('41 candidates');
    expect(out).toContain('50 candidates');
    expect(out).toContain(CRITICAL_ILLNESS_CANDIDATE_LIST_PATH);
    expect(out).toContain(ICD10_CHAPTER_IX_CANDIDATE_LIST_PATH);
    expect(out).toContain(ICD10_CHAPTER_XIV_CANDIDATE_LIST_PATH);
    expect(out).toContain(ICD10_CHAPTER_XVIII_CANDIDATE_LIST_PATH);
    expect(out).toContain(ICD10_CHAPTER_XXI_CANDIDATE_LIST_PATH);
    expect(out).toContain(DEFERRED_CANDIDATE_LIST_PATH);
    expect(out).toContain('0 candidates + 3 deferred');
    expect(out).toContain('deferred (recorded):  3');
    expect(out).toContain('No silent rows');
    expect(out).not.toContain('Silent rows');
    expect(out.match(/No silent rows/g)).toHaveLength(13);
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
    expect(parsed).toHaveLength(13);
    expect(parsed[0].totals).toEqual({
      candidates: 237,
      mappedAndGated: 185,
      mappedNotGated: 0,
      gatedUncoded: 52,
      classifiedOther: 0,
      silent: 0,
      deferred: 0,
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
      deferred: 0,
    });
    expect(parsed[3].blocking).toEqual([]);
    expect(parsed[3].rows).toHaveLength(85);
    // …and the third codebook enumeration in the same shape. The widest
    // gated-not-coded share of any corpus: a chapter of symptoms is mostly a
    // description of experience, and the findings inside it are carried as rows.
    expect(parsed[4].source.endsWith(ICD10_CHAPTER_XVIII_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[4].totals).toEqual({
      candidates: 86,
      mappedAndGated: 12,
      mappedNotGated: 0,
      gatedUncoded: 74,
      classifiedOther: 0,
      silent: 0,
      deferred: 0,
    });
    expect(parsed[4].blocking).toEqual([]);
    expect(parsed[4].rows).toHaveLength(86);
    // …and the fourth codebook enumeration in the same shape: the chapter that
    // is mostly status, whose mapped-and-gated bucket is small because the
    // corpus carries the codebook's wording rather than the sentence a person
    // writes (the gate suite's scope ledger asserts those one by one).
    expect(parsed[5].source.endsWith(ICD10_CHAPTER_XXI_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[5].totals).toEqual({
      candidates: 41,
      mappedAndGated: 3,
      mappedNotGated: 0,
      gatedUncoded: 38,
      classifiedOther: 0,
      silent: 0,
      deferred: 0,
    });
    expect(parsed[5].blocking).toEqual([]);
    expect(parsed[5].rows).toHaveLength(41);
    // …then the first chapter of *stateable* rows: the Chapter V enumeration,
    // where the named diagnoses became canonical conditions in 1.16.0 and the
    // rest of the mind's vocabulary was already gated descriptively.
    expect(parsed[6].source.endsWith(ICD10_CHAPTER_V_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[6].totals).toEqual({
      candidates: 62,
      mappedAndGated: 14,
      mappedNotGated: 0,
      gatedUncoded: 48,
      classifiedOther: 0,
      silent: 0,
      deferred: 0,
    });
    expect(parsed[6].blocking).toEqual([]);
    expect(parsed[6].rows).toHaveLength(62);
    // …then the second stateable chapter: the Chapter VI enumeration, where
    // the ten named diagnoses became canonical conditions in 1.17.0 and the
    // organ/residual constructs are gated descriptively.
    expect(parsed[7].source.endsWith(ICD10_CHAPTER_VI_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[7].totals).toEqual({
      candidates: 50,
      mappedAndGated: 15,
      mappedNotGated: 0,
      gatedUncoded: 35,
      classifiedOther: 0,
      silent: 0,
      deferred: 0,
    });
    expect(parsed[7].blocking).toEqual([]);
    expect(parsed[7].rows).toHaveLength(50);
    // …then Chapter X, the ninth source: 60 candidates, every mapped row also
    // gated, the headers and descriptive residuals gated without codes.
    expect(parsed[8].source.endsWith(ICD10_CHAPTER_X_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[8].totals).toEqual({
      candidates: 60,
      mappedAndGated: 14,
      mappedNotGated: 0,
      gatedUncoded: 46,
      classifiedOther: 0,
      silent: 0,
      deferred: 0,
    });
    expect(parsed[8].blocking).toEqual([]);
    expect(parsed[8].rows).toHaveLength(60);
    // …then Chapter XI, the tenth source: 65 candidates, every mapped row
    // also gated, the headers and dental residuals gated without codes.
    expect(parsed[9].source.endsWith(ICD10_CHAPTER_XI_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[9].totals).toEqual({
      candidates: 65,
      mappedAndGated: 12,
      mappedNotGated: 0,
      gatedUncoded: 53,
      classifiedOther: 0,
      silent: 0,
      deferred: 0,
    });
    expect(parsed[9].blocking).toEqual([]);
    expect(parsed[9].rows).toHaveLength(65);
    // …then Chapter XII, the eleventh source: 67 candidates, every mapped row
    // also gated, the headers and descriptive residuals gated without codes.
    expect(parsed[10].source.endsWith(ICD10_CHAPTER_XII_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[10].totals).toEqual({
      candidates: 67,
      mappedAndGated: 22,
      mappedNotGated: 0,
      gatedUncoded: 45,
      classifiedOther: 0,
      silent: 0,
      deferred: 0,
    });
    expect(parsed[10].blocking).toEqual([]);
    expect(parsed[10].rows).toHaveLength(67);
    // …then Chapter XIII, the twelfth source: 71 candidates, the largest
    // body-system chapter, whose named edges (the vasculitides, myositides,
    // bone residuals) are rows and whose category nouns stay descriptive.
    expect(parsed[11].source.endsWith(ICD10_CHAPTER_XIII_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[11].totals).toEqual({
      candidates: 71,
      mappedAndGated: 7,
      mappedNotGated: 0,
      gatedUncoded: 64,
      classifiedOther: 0,
      silent: 0,
      deferred: 0,
    });
    expect(parsed[11].blocking).toEqual([]);
    expect(parsed[11].rows).toHaveLength(71);
    // …and the deferral ledger last: zero candidates, three deliberately open
    // rows, each measured afresh and reported with its reason — nothing silent.
    expect(parsed[12].source.endsWith(DEFERRED_CANDIDATE_LIST_PATH)).toBe(true);
    expect(parsed[12].totals).toEqual({
      candidates: 0,
      mappedAndGated: 0,
      mappedNotGated: 0,
      gatedUncoded: 0,
      classifiedOther: 0,
      silent: 0,
      deferred: 3,
    });
    expect(parsed[12].blocking).toEqual([]);
    expect(parsed[12].rows).toHaveLength(3);
  });

  it('lists every row with --all, including the good ones and the deferred', () => {
    const { code, out } = capture(() => runConditionCoverageSweepCli(['--all']));
    expect(code).toBe(0);
    expect(out).toContain('[mapped_and_gated]');
    expect(out).toContain('[gated_uncoded]');
    expect(out).toContain('[deferred]');
    expect(out).toContain('Every candidate:');
  });

  it('reports a declared deferral without failing, and fails on a stale one', () => {
    const ledger = writeList('ledger.txt', '? zonkosis :: waiting on the next codebook revision\n');
    const live = capture(() => runConditionCoverageSweepCli([ledger]));
    expect(live.code).toBe(0);
    expect(live.out).toContain('deferred (recorded):  1');
    expect(live.out).toContain('Deferred rows');
    expect(live.out).toContain('waiting on the next codebook revision');
    expect(live.out).not.toContain('blocking row');

    // The direction that keeps a deferral from becoming a quiet closure: once
    // the row is no longer silent the declaration blocks, and only the
    // documented escape hatch turns that into a report.
    const stale = writeList('stale.txt', '? piles :: its ordinary sense is a quantifier\n');
    const staleRun = capture(() => runConditionCoverageSweepCli([stale]));
    expect(staleRun.code).toBe(1);
    expect(staleRun.out).toContain('Stale deferrals');
    expect(staleRun.out).toContain('piles');
    expect(staleRun.out).toContain('the ledger has to be updated');
    expect(capture(() => runConditionCoverageSweepCli([stale, '--report-only'])).code).toBe(0);
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
    expect(help.out).toContain('? <phrase> :: <reason>');
    expect(help.out).toContain(DEFERRED_CANDIDATE_LIST_PATH);
  });
});
