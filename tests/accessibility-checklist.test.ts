/**
 * The Section 508 assistive-technology walkthrough as an instrument.
 *
 * The matrix rows in src/accessibility/accessibility.ts cannot be run by CI.
 * What CI can do — and what this suite checks — is that the instrument for
 * running them is complete and honest: every row and every check is in the
 * receipt template and in the printed checklist, a row's status is derived
 * from recorded results rather than asserted, a pass without an environment
 * or a signature is refused, a recorded failure is an open defect, and the
 * committed receipt agrees with the code that describes it.
 *
 * Nothing here can run NVDA, VoiceOver, or TalkBack. These assertions are
 * about the paperwork around the walkthrough, not the walkthrough itself.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import {
  ACCESSIBILITY_TEST_MATRIX,
  ACCESSIBILITY_WALKTHROUGH_CHECKS,
  SECTION_508_REVIEW,
  WALKTHROUGH_RECEIPT_SCHEMA,
  WALKTHROUGH_RECORDED_STATUS,
  auditAccessibilityReview,
  auditWalkthroughReceipt,
  buildWalkthroughReceiptTemplate,
  deriveMatrixStatuses,
  deriveRowStatus,
  deriveSignOff,
  parseWalkthroughReceipt,
  walkthroughRowKey,
  type WalkthroughReceipt,
  type WalkthroughResult,
} from '../src/accessibility/accessibility';
import {
  auditSection508Walkthrough,
  loadWalkthroughReceipt,
  renderWalkthroughChecklist,
} from '../src/accessibility/accessibility-checklist';
import { runAccessibilityChecklistCli } from '../src/accessibility/accessibility-checklist-cli';

const FIRST_ROW = walkthroughRowKey(ACCESSIBILITY_TEST_MATRIX[0]);
const LAST_ROW = walkthroughRowKey(ACCESSIBILITY_TEST_MATRIX[ACCESSIBILITY_TEST_MATRIX.length - 1]);

/** A receipt with one row fully recorded and signed. */
function completedRow(rowKey: string = FIRST_ROW): WalkthroughReceipt {
  const receipt = buildWalkthroughReceiptTemplate();
  receipt.reviewer = 'A. Reviewer';
  receipt.reviewedAt = '2026-09-20';
  const entry = receipt.rows[rowKey];
  entry.environment = { browserVersion: '128.0', atVersion: '2024.4', os: 'Windows 11' };
  for (const check of ACCESSIBILITY_WALKTHROUGH_CHECKS) {
    entry.items[check.id] = {
      result: check.optional === true ? 'not_applicable' : 'pass',
      note: '',
    };
  }
  return receipt;
}

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'lifechat-a11y-'));
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

describe('the checklist instrument', () => {
  it('covers every matrix row and every check in the template', () => {
    const template = buildWalkthroughReceiptTemplate();
    expect(template.schema).toBe(WALKTHROUGH_RECEIPT_SCHEMA);
    expect(template.reviewer).toBe('');
    expect(Object.keys(template.rows).sort()).toEqual(
      ACCESSIBILITY_TEST_MATRIX.map((row) => walkthroughRowKey(row)).sort(),
    );
    const checkIds = ACCESSIBILITY_WALKTHROUGH_CHECKS.map((check) => check.id).sort();
    for (const key of Object.keys(template.rows)) {
      expect(Object.keys(template.rows[key].items).sort()).toEqual(checkIds);
      for (const item of Object.values(template.rows[key].items)) {
        expect(item).toEqual({ result: 'not_performed', note: '' });
      }
    }
    // A template is a valid receipt: it claims nothing, so nothing is a gap.
    expect(auditWalkthroughReceipt(template)).toEqual([]);
    expect(deriveSignOff(template).atWalkthrough).toBe('outstanding');
  });

  it('keeps the committed receipt in step with the library', () => {
    const { receipt, gaps } = loadWalkthroughReceipt();
    expect(gaps).toEqual([]);
    if (receipt === null) {
      throw new Error('the committed receipt is missing');
    }
    expect(receipt.schema).toBe(WALKTHROUGH_RECEIPT_SCHEMA);
    expect(Object.keys(receipt.rows)).toHaveLength(ACCESSIBILITY_TEST_MATRIX.length);
    for (const key of Object.keys(receipt.rows)) {
      expect(Object.keys(receipt.rows[key].items)).toHaveLength(
        ACCESSIBILITY_WALKTHROUGH_CHECKS.length,
      );
    }
    // The review record and the committed receipt must agree, whatever state
    // the walkthrough is in — that is the property that survives sign-off.
    expect(auditSection508Walkthrough().gaps).toEqual([]);
  });

  it('prints every check with its action and pass condition', () => {
    const text = renderWalkthroughChecklist(buildWalkthroughReceiptTemplate());
    for (const check of ACCESSIBILITY_WALKTHROUGH_CHECKS) {
      expect(text).toContain(check.id);
      expect(text).toContain(check.check);
      expect(text).toContain(check.expected);
    }
    for (const row of ACCESSIBILITY_TEST_MATRIX) {
      expect(text).toContain(walkthroughRowKey(row));
    }
    expect(text).toMatch(/Row 1 of 5/);
  });

  it('filters the checklist to one row on request', () => {
    const text = renderWalkthroughChecklist(buildWalkthroughReceiptTemplate(), { row: LAST_ROW });
    expect(text).toMatch(/Row 1 of 1/);
    expect(text).toContain(LAST_ROW);
    expect(text).toContain(ACCESSIBILITY_WALKTHROUGH_CHECKS[0].check);
  });

  it('names the known rows when asked for one that does not exist', () => {
    const text = renderWalkthroughChecklist(buildWalkthroughReceiptTemplate(), {
      row: 'Chrome / JAWS',
    });
    expect(text).toMatch(/No matrix row matches/);
    expect(text).toContain(FIRST_ROW);
  });
});

describe('a row status is derived from recorded results', () => {
  it('passes only when every check passed, the environment is recorded, and the receipt is signed', () => {
    const receipt = completedRow();
    expect(deriveRowStatus(receipt, ACCESSIBILITY_TEST_MATRIX[0])).toBe('pass');
    expect(deriveRowStatus(receipt, ACCESSIBILITY_TEST_MATRIX[1])).toBe('not_performed');
    const signOff = deriveSignOff(receipt);
    expect(signOff).toEqual({
      atWalkthrough: 'in_progress',
      rowsPassed: 1,
      rowsTotal: ACCESSIBILITY_TEST_MATRIX.length,
      rowsInProgress: 0,
      rowsFailed: 0,
    });
    expect(deriveMatrixStatuses(receipt).map((row) => row.humanStatus)).toEqual([
      'pass',
      'not_performed',
      'not_performed',
      'not_performed',
      'not_performed',
    ]);
  });

  it('records a single failure as a failure, whatever else passed', () => {
    const receipt = completedRow();
    receipt.rows[FIRST_ROW].items['AT-07'] = { result: 'fail', note: 'focus stayed on the body' };
    expect(deriveRowStatus(receipt, ACCESSIBILITY_TEST_MATRIX[0])).toBe('fail');
    expect(deriveSignOff(receipt).atWalkthrough).toBe('failed');
    const gaps = auditWalkthroughReceipt(receipt);
    expect(gaps).toEqual([]);
    const codes = auditAccessibilityReview(SECTION_508_REVIEW, receipt).map((gap) => gap.code);
    expect(codes).toContain('matrix_row_failed');
    // The record has not been told about the failure yet.
    expect(codes).toContain('matrix_status_not_from_receipt');
  });

  it('calls a half-run row in progress, not passed', () => {
    const receipt = buildWalkthroughReceiptTemplate();
    receipt.rows[FIRST_ROW].items['AT-01'] = { result: 'pass', note: '' };
    expect(deriveRowStatus(receipt, ACCESSIBILITY_TEST_MATRIX[0])).toBe('in_progress');
    expect(deriveSignOff(receipt).atWalkthrough).toBe('in_progress');
    // Partial work is honest, not a gap.
    expect(auditWalkthroughReceipt(receipt)).toEqual([]);
  });

  it('refuses a complete row with no environment, and one with no signature', () => {
    const noEnvironment = completedRow();
    noEnvironment.rows[FIRST_ROW].environment = { browserVersion: '', atVersion: '', os: '' };
    expect(deriveRowStatus(noEnvironment, ACCESSIBILITY_TEST_MATRIX[0])).toBe('in_progress');
    expect(auditWalkthroughReceipt(noEnvironment).map((gap) => gap.code)).toContain(
      'walkthrough_pass_without_environment',
    );

    const unsigned = completedRow();
    unsigned.reviewer = '';
    unsigned.reviewedAt = '';
    expect(deriveRowStatus(unsigned, ACCESSIBILITY_TEST_MATRIX[0])).toBe('in_progress');
    expect(auditWalkthroughReceipt(unsigned).map((gap) => gap.code)).toContain(
      'walkthrough_pass_without_signature',
    );
  });

  it('allows not_applicable only for optional checks', () => {
    const receipt = completedRow();
    // AT-13 is the Windows-only check: not applicable on this row is fine.
    expect(receipt.rows[FIRST_ROW].items['AT-13'].result).toBe('not_applicable');
    expect(deriveRowStatus(receipt, ACCESSIBILITY_TEST_MATRIX[0])).toBe('pass');

    const overstated = completedRow();
    overstated.rows[FIRST_ROW].items['AT-01'] = { result: 'not_applicable', note: 'skipped' };
    expect(deriveRowStatus(overstated, ACCESSIBILITY_TEST_MATRIX[0])).toBe('in_progress');
    expect(auditWalkthroughReceipt(overstated).map((gap) => gap.code)).toContain(
      'walkthrough_not_applicable_on_required_check',
    );
  });
});

describe('the gate reads the recorded results', () => {
  it('refuses a pass the receipt does not support', () => {
    const forged = {
      ...SECTION_508_REVIEW,
      matrix: SECTION_508_REVIEW.matrix.map((row) => ({ ...row, humanStatus: 'pass' as const })),
    };
    const withBlankReceipt = auditAccessibilityReview(forged, buildWalkthroughReceiptTemplate());
    expect(withBlankReceipt.map((gap) => gap.code)).toContain('matrix_status_not_from_receipt');
    // And with no receipt at all, any non-default status is a claim without evidence.
    expect(auditAccessibilityReview(forged).map((gap) => gap.code)).toContain(
      'matrix_status_without_receipt',
    );
  });

  it('requires the record to be updated before a completed row is accepted', () => {
    const receipt = completedRow();
    const asRecorded = auditAccessibilityReview(SECTION_508_REVIEW, receipt);
    expect(asRecorded.map((gap) => gap.code)).toEqual(['matrix_status_not_from_receipt']);

    const signedReview = { ...SECTION_508_REVIEW, matrix: deriveMatrixStatuses(receipt) };
    expect(auditAccessibilityReview(signedReview, receipt)).toEqual([]);
  });

  it('reads the receipt from disk and reports the sign-off it supports', () => {
    const receiptPath = path.join(tempDir, 'completed-receipt.json');
    writeFileSync(receiptPath, JSON.stringify(completedRow(), null, 2));
    const result = auditSection508Walkthrough(receiptPath);
    expect(result.signOff).toEqual({
      atWalkthrough: 'in_progress',
      rowsPassed: 1,
      rowsTotal: ACCESSIBILITY_TEST_MATRIX.length,
      rowsInProgress: 0,
      rowsFailed: 0,
    });
    expect(result.rows[0].humanStatus).toBe('pass');
    expect(result.gaps.map((gap) => gap.code)).toContain('matrix_status_not_from_receipt');
  });

  it('reports a missing or malformed receipt instead of guessing', () => {
    const missing = auditSection508Walkthrough(path.join(tempDir, 'nope.json'));
    expect(missing.gaps.map((gap) => gap.code)).toEqual(['walkthrough_receipt_missing']);
    expect(missing.signOff).toBeNull();

    const malformedPath = path.join(tempDir, 'malformed.json');
    writeFileSync(malformedPath, '{ not json');
    expect(auditSection508Walkthrough(malformedPath).gaps.map((gap) => gap.code)).toEqual([
      'walkthrough_receipt_malformed',
    ]);
  });

  it('keeps the status ledger pointed at real rows', () => {
    const ledger = WALKTHROUGH_RECORDED_STATUS as Record<string, string>;
    ledger['Chrome / JAWS'] = 'not_performed';
    try {
      expect(auditAccessibilityReview().map((gap) => gap.code)).toContain(
        'matrix_status_key_unknown',
      );
    } finally {
      delete ledger['Chrome / JAWS'];
    }
    const removed = WALKTHROUGH_RECORDED_STATUS[FIRST_ROW];
    delete WALKTHROUGH_RECORDED_STATUS[FIRST_ROW];
    try {
      expect(auditAccessibilityReview().map((gap) => gap.code)).toContain('matrix_status_missing');
    } finally {
      WALKTHROUGH_RECORDED_STATUS[FIRST_ROW] = removed;
    }
    expect(auditAccessibilityReview()).toEqual([]);
  });
});

describe('receipt structure', () => {
  it('rejects rows and checks that no longer exist', () => {
    const unknownRow = buildWalkthroughReceiptTemplate();
    unknownRow.rows['Chrome / JAWS'] = buildWalkthroughReceiptTemplate().rows[FIRST_ROW];
    expect(auditWalkthroughReceipt(unknownRow).map((gap) => gap.code)).toContain(
      'walkthrough_row_unknown',
    );

    const missingRow = buildWalkthroughReceiptTemplate();
    delete missingRow.rows[LAST_ROW];
    expect(auditWalkthroughReceipt(missingRow).map((gap) => gap.code)).toContain(
      'walkthrough_row_missing',
    );

    const unknownItem = buildWalkthroughReceiptTemplate();
    unknownItem.rows[FIRST_ROW].items['AT-99'] = { result: 'pass', note: '' };
    expect(auditWalkthroughReceipt(unknownItem).map((gap) => gap.code)).toContain(
      'walkthrough_item_unknown',
    );

    const missingItem = buildWalkthroughReceiptTemplate();
    delete missingItem.rows[FIRST_ROW].items['AT-13'];
    expect(auditWalkthroughReceipt(missingItem).map((gap) => gap.code)).toContain(
      'walkthrough_item_missing',
    );

    const unknownResult = buildWalkthroughReceiptTemplate();
    unknownResult.rows[FIRST_ROW].items['AT-01'].result = 'maybe' as WalkthroughResult;
    expect(auditWalkthroughReceipt(unknownResult).map((gap) => gap.code)).toContain(
      'walkthrough_result_unknown',
    );
  });

  it('requires a note on every recorded failure', () => {
    const receipt = buildWalkthroughReceiptTemplate();
    receipt.rows[FIRST_ROW].items['AT-05'] = { result: 'fail', note: '   ' };
    const gaps = auditWalkthroughReceipt(receipt);
    expect(gaps.map((gap) => gap.code)).toContain('walkthrough_failure_without_note');
    receipt.rows[FIRST_ROW].items['AT-05'].note = 'the failure notice was announced twice';
    expect(auditWalkthroughReceipt(receipt).map((gap) => gap.code)).not.toContain(
      'walkthrough_failure_without_note',
    );
  });

  it('rejects a malformed file and an unknown schema', () => {
    expect(parseWalkthroughReceipt('{').gaps.map((gap) => gap.code)).toEqual([
      'walkthrough_receipt_malformed',
    ]);
    expect(parseWalkthroughReceipt('[]').gaps.map((gap) => gap.code)).toEqual([
      'walkthrough_receipt_malformed',
    ]);
    const { receipt, gaps } = parseWalkthroughReceipt(
      JSON.stringify({ schema: 'lifechat.a11y-walkthrough-receipt/99', rows: {} }),
    );
    expect(receipt).not.toBeNull();
    expect(gaps.map((gap) => gap.code)).toContain('walkthrough_schema_unknown');
    expect(gaps.map((gap) => gap.code)).toContain('walkthrough_row_missing');
  });
});

describe('the CLI', () => {
  it('prints the checklist and the status and exits clean on the committed receipt', () => {
    const { code, out } = capture(() => runAccessibilityChecklistCli([]));
    expect(code).toBe(0);
    expect(out).toContain('Section 508 assistive-technology walkthrough');
    expect(out).toContain('No gaps');
    for (const check of ACCESSIBILITY_WALKTHROUGH_CHECKS) {
      expect(out).toContain(check.id);
    }
  });

  it('emits machine-readable status with --json', () => {
    const { code, out } = capture(() => runAccessibilityChecklistCli(['--json']));
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      signOff: { atWalkthrough: string };
      rows: Array<{ row: string; status: string }>;
      checks: Array<{ id: string }>;
      gaps: unknown[];
    };
    expect(parsed.signOff.atWalkthrough).toBe('outstanding');
    expect(parsed.rows).toHaveLength(ACCESSIBILITY_TEST_MATRIX.length);
    expect(parsed.checks).toHaveLength(ACCESSIBILITY_WALKTHROUGH_CHECKS.length);
    expect(parsed.gaps).toEqual([]);
  });

  it('filters to one row', () => {
    const { code, out } = capture(() => runAccessibilityChecklistCli(['--row', FIRST_ROW]));
    expect(code).toBe(0);
    expect(out).toMatch(/Row 1 of 1/);
    expect(out).toContain(FIRST_ROW);
  });

  it('exits 1 on an unknown row, an unknown argument, or a missing receipt', () => {
    expect(capture(() => runAccessibilityChecklistCli(['--row', 'Chrome / JAWS'])).code).toBe(1);
    expect(capture(() => runAccessibilityChecklistCli(['--wat'])).code).toBe(1);
    const missing = capture(() =>
      runAccessibilityChecklistCli(['--receipt', path.join(tempDir, 'nope.json')]),
    );
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('walkthrough_receipt_missing');
  });

  it('writes a template, refuses to overwrite a signed receipt, and obeys --force', () => {
    const target = path.join(tempDir, 'receipt.json');
    expect(capture(() => runAccessibilityChecklistCli(['--init', '--receipt', target])).code).toBe(
      0,
    );
    // A second init does not clobber the first without --force.
    expect(capture(() => runAccessibilityChecklistCli(['--init', '--receipt', target])).code).toBe(
      1,
    );

    writeFileSync(target, JSON.stringify(completedRow(), null, 2));
    const refused = capture(() => runAccessibilityChecklistCli(['--init', '--receipt', target]));
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/refusing to overwrite/);
    expect(loadWalkthroughReceipt(target).receipt?.reviewer).toBe('A. Reviewer');

    expect(
      capture(() => runAccessibilityChecklistCli(['--init', '--receipt', target, '--force'])).code,
    ).toBe(0);
    const rewritten = loadWalkthroughReceipt(target);
    expect(rewritten.gaps).toEqual([]);
    expect(rewritten.receipt?.reviewer).toBe('');
  });
});
