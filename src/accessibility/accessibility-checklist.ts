/**
 * The runnable form of the Section 508 assistive-technology walkthrough.
 *
 * The five matrix rows cannot be run by anything in this repository — they
 * need a person at a keyboard with NVDA, VoiceOver, or TalkBack. This module
 * makes that run procedural:
 *
 *   npm run a11y:checklist                      print the checklist and status
 *   npm run a11y:checklist -- --row "Chrome / NVDA"
 *   npm run a11y:checklist -- --receipt <path>  validate a filled receipt
 *   npm run a11y:checklist -- --init [--force]  (re)write the blank template
 *
 * and makes its result auditable: the receipt at WALKTHROUGH_RECEIPT_PATH
 * records one result per check per row, and `auditSection508Walkthrough()`
 * composes the file with `auditAccessibilityReview()`, so the review record's
 * row statuses must equal what the receipt supports. A walkthrough that has
 * not been run says so; one that was run carries the environment and the
 * signature that make it checkable later.
 *
 * The pure parts (schema, template, derivation, structure audit) live in
 * accessibility.ts; this module is the file and terminal half.
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

import {
  ACCESSIBILITY_TEST_MATRIX,
  ACCESSIBILITY_WALKTHROUGH_CHECKS,
  SECTION_508_REVIEW,
  WALKTHROUGH_RECEIPT_PATH,
  WalkthroughReceipt,
  auditAccessibilityReview,
  auditWalkthroughReceipt,
  buildWalkthroughReceiptTemplate,
  deriveMatrixStatuses,
  deriveSignOff,
  parseWalkthroughReceipt,
  walkthroughRowKey,
  type AccessibilityReviewGap,
} from './accessibility';

/** The repository root, from either src/ (tests) or dist/ (built CLI). */
const REPO_ROOT = path.join(__dirname, '..', '..');

/** Resolves the receipt path — relative paths are relative to the repository root. */
export function resolveReceiptPath(receiptPath: string = WALKTHROUGH_RECEIPT_PATH): string {
  return path.isAbsolute(receiptPath) ? receiptPath : path.join(REPO_ROOT, receiptPath);
}

/** Reads the committed receipt, reporting a missing or unreadable file as a gap. */
export function loadWalkthroughReceipt(receiptPath: string = WALKTHROUGH_RECEIPT_PATH): {
  receipt: WalkthroughReceipt | null;
  gaps: AccessibilityReviewGap[];
} {
  const resolved = resolveReceiptPath(receiptPath);
  let json: string;
  try {
    json = readFileSync(resolved, 'utf8');
  } catch {
    return {
      receipt: null,
      gaps: [
        {
          code: 'walkthrough_receipt_missing',
          detail: `${receiptPath} cannot be read — run: npm run a11y:checklist -- --init`,
        },
      ],
    };
  }
  return parseWalkthroughReceipt(json);
}

/** Writes the blank template. Refuses to overwrite a receipt unless forced. */
export function writeWalkthroughReceiptTemplate(
  receiptPath: string = WALKTHROUGH_RECEIPT_PATH,
  options: { force?: boolean } = {},
): { written: boolean; detail: string } {
  const resolved = resolveReceiptPath(receiptPath);
  if (!options.force) {
    const existing = loadWalkthroughReceipt(receiptPath);
    if (existing.receipt !== null) {
      const signed = existing.receipt.reviewer.trim().length > 0;
      return {
        written: false,
        detail: signed
          ? `${receiptPath} holds a signed receipt — refusing to overwrite it without --force`
          : `${receiptPath} already exists — pass --force to replace the blank template`,
      };
    }
  }
  const json = `${JSON.stringify(buildWalkthroughReceiptTemplate(), null, 2)}\n`;
  writeFileSync(resolved, json, 'utf8');
  return { written: true, detail: `wrote ${receiptPath}` };
}

/**
 * The whole gate for the recorded walkthrough: the receipt's own structure,
 * the review record against the receipt, and the sign-off the receipt
 * supports. The CLI and the test suite both call this, so there is one
 * definition of "the walkthrough is valid".
 */
export function auditSection508Walkthrough(receiptPath: string = WALKTHROUGH_RECEIPT_PATH): {
  gaps: AccessibilityReviewGap[];
  receipt: WalkthroughReceipt | null;
  signOff: ReturnType<typeof deriveSignOff> | null;
  rows: ReturnType<typeof deriveMatrixStatuses>;
} {
  const { receipt, gaps } = loadWalkthroughReceipt(receiptPath);
  const reviewGaps = auditAccessibilityReview(SECTION_508_REVIEW, receipt);
  return {
    gaps: [...gaps, ...reviewGaps],
    receipt,
    signOff: receipt ? deriveSignOff(receipt) : null,
    rows: receipt ? deriveMatrixStatuses(receipt) : [...SECTION_508_REVIEW.matrix],
  };
}

/** The status label a row is printed with. */
function statusLabel(status: string): string {
  return `[${status}]`;
}

/**
 * The runnable checklist, as it prints in a terminal: every check for every
 * row, with the action and the observable pass condition, plus the row's
 * current recorded status. This is what a reviewer works from.
 */
export function renderWalkthroughChecklist(
  receipt: WalkthroughReceipt | null,
  options: { row?: string } = {},
): string {
  const blank = buildWalkthroughReceiptTemplate();
  const recorded = receipt ?? blank;
  const rows = ACCESSIBILITY_TEST_MATRIX.filter(
    (row) => options.row === undefined || walkthroughRowKey(row) === options.row,
  );
  if (rows.length === 0) {
    const known = ACCESSIBILITY_TEST_MATRIX.map((row) => walkthroughRowKey(row)).join(', ');
    return `No matrix row matches ${JSON.stringify(options.row)}. Known rows: ${known}`;
  }

  const lines: string[] = [
    'Section 508 assistive-technology walkthrough',
    `Receipt: ${WALKTHROUGH_RECEIPT_PATH}`,
    receipt === null
      ? 'No receipt on disk yet — run with --init first (the committed template should already exist).'
      : receipt.reviewer.trim().length > 0
        ? `Signed by ${receipt.reviewer} on ${receipt.reviewedAt || '(no date)'}`
        : 'Unsigned — a row cannot pass until reviewer and reviewedAt are filled in.',
    '',
    'CI already asserts the DOM contract (names, roles, live regions, keyboard paths, reflow',
    'constraints, contrast ratios). What follows is what only a person with the screen reader',
    'can establish. Record every check; a row passes only when all of them pass.',
    '',
  ];

  const statuses = deriveMatrixStatuses(recorded);
  const statusByKey = new Map(statuses.map((row) => [walkthroughRowKey(row), row.humanStatus]));

  rows.forEach((row, index) => {
    const key = walkthroughRowKey(row);
    const entry = recorded.rows[key];
    lines.push(
      `Row ${index + 1} of ${rows.length} — ${key}   ${statusLabel(statusByKey.get(key) ?? 'not_performed')}`,
      `  environment to record: browserVersion="${entry?.environment.browserVersion ?? ''}" atVersion="${
        entry?.environment.atVersion ?? ''
      }" os="${entry?.environment.os ?? ''}"`,
    );
    for (const check of ACCESSIBILITY_WALKTHROUGH_CHECKS) {
      const item = entry?.items[check.id];
      const result = item?.result ?? 'not_performed';
      lines.push(
        `  ${result === 'pass' ? '[x]' : result === 'fail' ? '[!]' : '[ ]'} ${check.id}  ${
          check.area
        }${check.optional === true ? '  (optional)' : ''}`,
        `        do:        ${check.check}`,
        `        pass when: ${check.expected}`,
      );
      if (item && item.note.trim().length > 0) {
        lines.push(`        note:      ${item.note.trim()}`);
      }
    }
    lines.push('');
  });

  lines.push(
    'How to record a result',
    `  Edit ${WALKTHROUGH_RECEIPT_PATH} and set each check's "result" to "pass", "fail",`,
    '  "not_performed", or "not_applicable" (optional checks only — AT-13 needs Windows).',
    '  A "fail" must carry a note. Fill in browserVersion, atVersion, and os for the row, and',
    "  the receipt's reviewer and reviewedAt. Then verify:",
    `    npm run a11y:checklist -- --receipt ${WALKTHROUGH_RECEIPT_PATH}`,
    '  When a row validates as pass, set its value in WALKTHROUGH_RECORDED_STATUS',
    '  (src/accessibility/accessibility.ts) to match, so the review record carries the result.',
  );
  return lines.join('\n');
}

/** The validation report: sign-off, per-row derived status, and every gap. */
export function formatWalkthroughReport(receiptPath: string = WALKTHROUGH_RECEIPT_PATH): string {
  const { gaps, signOff, rows } = auditSection508Walkthrough(receiptPath);
  const lines: string[] = [`Section 508 walkthrough — ${receiptPath}`];
  if (signOff) {
    lines.push(
      `Sign-off: ${signOff.atWalkthrough} — ${signOff.rowsPassed} of ${signOff.rowsTotal} rows passed, ` +
        `${signOff.rowsInProgress} in progress, ${signOff.rowsFailed} failed`,
    );
  } else {
    lines.push('Sign-off: unknown — no readable receipt');
  }
  const keyWidth = Math.max(...rows.map((row) => walkthroughRowKey(row).length)) + 2;
  for (const row of rows) {
    lines.push(`  ${walkthroughRowKey(row).padEnd(keyWidth)}${row.humanStatus}`);
  }
  if (gaps.length === 0) {
    lines.push('', 'No gaps: the receipt is structurally valid and the review record matches it.');
  } else {
    lines.push('', `${gaps.length} gap${gaps.length === 1 ? '' : 's'}:`);
    for (const gap of gaps) {
      lines.push(`  ${gap.code}: ${gap.detail}`);
    }
  }
  return lines.join('\n');
}

/** Every check the human walkthrough consists of — for tests and docs. */
export function walkthroughCheckIds(): string[] {
  return ACCESSIBILITY_WALKTHROUGH_CHECKS.map((check) => check.id);
}

/** Re-exported so callers of this module do not need both imports. */
export { WALKTHROUGH_RECEIPT_PATH, auditWalkthroughReceipt, buildWalkthroughReceiptTemplate };
