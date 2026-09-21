/**
 * CLI for the Section 508 assistive-technology walkthrough.
 *
 *   npm run a11y:checklist                       the runnable checklist, with status
 *   npm run a11y:checklist -- --row "Chrome / NVDA"
 *   npm run a11y:checklist -- --json
 *   npm run a11y:checklist -- --receipt <path>   validate a filled receipt
 *   npm run a11y:checklist -- --init [--force]   rewrite the blank template
 *
 * Exits 1 when the receipt is missing or malformed, when it does not cover the
 * current matrix and checks, when a failure is recorded without a note, when a
 * row claims a pass without an environment or a signature, or when the review
 * record's row statuses disagree with what the receipt supports.
 */

import {
  ACCESSIBILITY_TEST_MATRIX,
  ACCESSIBILITY_WALKTHROUGH_CHECKS,
  WALKTHROUGH_RECEIPT_PATH,
  walkthroughRowKey,
} from './accessibility';
import {
  auditSection508Walkthrough,
  formatWalkthroughReport,
  renderWalkthroughChecklist,
  resolveReceiptPath,
  writeWalkthroughReceiptTemplate,
} from './accessibility-checklist';

const USAGE = [
  'Section 508 assistive-technology walkthrough',
  '',
  '  npm run a11y:checklist                        the runnable checklist, with current status',
  '  npm run a11y:checklist -- --row "Chrome / NVDA"',
  '  npm run a11y:checklist -- --json',
  '  npm run a11y:checklist -- --receipt <path>    validate a receipt (default: the committed one)',
  '  npm run a11y:checklist -- --init [--force]    write the blank receipt template',
  '',
  'Rows:',
  ...ACCESSIBILITY_TEST_MATRIX.map((row) => `  ${walkthroughRowKey(row)}`),
  '',
  `The receipt is committed at ${WALKTHROUGH_RECEIPT_PATH}; its recorded results are what`,
  'auditAccessibilityReview() accepts as evidence for a matrix row status.',
].join('\n');

function parseArgs(argv: readonly string[]): {
  receiptPath: string;
  row?: string;
  json: boolean;
  init: boolean;
  force: boolean;
  help: boolean;
} {
  const options = {
    receiptPath: WALKTHROUGH_RECEIPT_PATH,
    row: undefined as string | undefined,
    json: false,
    init: false,
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--receipt') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error('--receipt needs a path');
      }
      options.receiptPath = next;
      i += 1;
    } else if (arg.startsWith('--receipt=')) {
      options.receiptPath = arg.slice('--receipt='.length);
    } else if (arg === '--row') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error('--row needs a matrix row key, e.g. "Chrome / NVDA"');
      }
      options.row = next;
      i += 1;
    } else if (arg.startsWith('--row=')) {
      options.row = arg.slice('--row='.length);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--init') {
      options.init = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * The entry point, taking argv so tests can drive it without a process.
 * Returns the exit code.
 */
export function runAccessibilityChecklistCli(
  argv: readonly string[] = process.argv.slice(2),
): number {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(USAGE);
    return 1;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  if (options.init) {
    const result = writeWalkthroughReceiptTemplate(options.receiptPath, { force: options.force });
    console.log(result.detail);
    return result.written ? 0 : 1;
  }

  if (options.row !== undefined) {
    const known = ACCESSIBILITY_TEST_MATRIX.some((row) => walkthroughRowKey(row) === options.row);
    if (!known) {
      console.error(`No matrix row matches ${JSON.stringify(options.row)}.`);
      console.error(USAGE);
      return 1;
    }
  }

  const result = auditSection508Walkthrough(options.receiptPath);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          receiptPath: resolveReceiptPath(options.receiptPath),
          signOff: result.signOff,
          rows: result.rows.map((row) => ({
            row: walkthroughRowKey(row),
            status: row.humanStatus,
          })),
          checks: ACCESSIBILITY_WALKTHROUGH_CHECKS.map((check) => ({
            id: check.id,
            area: check.area,
            optional: check.optional === true,
            check: check.check,
            expected: check.expected,
          })),
          gaps: result.gaps,
        },
        null,
        2,
      ),
    );
    return result.gaps.length === 0 ? 0 : 1;
  }

  console.log(renderWalkthroughChecklist(result.receipt, { row: options.row }));
  console.log(formatWalkthroughReport(options.receiptPath));
  return result.gaps.length === 0 ? 0 : 1;
}

// Direct-invocation entry (e.g. `npm run a11y:checklist`).
if (require.main === module) {
  process.exitCode = runAccessibilityChecklistCli();
}
