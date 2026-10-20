/**
 * Supply-chain guard for GitHub Actions workflows.
 *
 * A mutable action ref (`actions/checkout@v4`, `@main`, `@latest`) means the
 * code CI runs can change without a commit in this repository. Every `uses:`
 * must therefore name a full 40-character commit SHA; docker actions must be
 * pinned by digest; local actions (`./path`) carry no ref. `@latest` is also
 * rejected anywhere else in a workflow (install steps included), because it
 * reintroduces the same "upgrade without review" problem.
 *
 * The scanner is line-based rather than YAML-parsed on purpose: js-yaml is only
 * a transitive override for the coverage toolchain, and promoting it to a
 * direct dependency for one guard is not worth the surface. The self-tests
 * below feed the scanner representative YAML — quoted values, list items,
 * inline comments — so the real-workflow assertion cannot pass vacuously.
 */

import { readFileSync, readdirSync } from 'fs';
import path from 'path';

interface Violation {
  file: string;
  line: number;
  ref: string;
  reason: string;
}

interface ScanResult {
  /** Number of `uses:` references seen, used to prove the guard is not empty. */
  refs: number;
  violations: Violation[];
}

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

const LOCAL_ACTION = /^\.{1,2}\//;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const DOCKER_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/i;
// `uses:` optionally written as a YAML list item and/or a quoted key.
const USES_LINE = /^\s*(?:-\s+)*(?:"uses"|'uses'|uses)\s*:\s*(.+?)\s*$/;
const LATEST = /@latest\b/i;

/**
 * Removes a YAML comment from a line, respecting quoted scalars.
 *
 * Comments matter here because the workflows legitimately *mention* the
 * mutable refs they moved away from in prose (deploy.yml documents why
 * `vercel@latest` was pinned). Those lines must not trip the guard.
 */
function stripYamlComment(line: string): string {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

/** Unquotes a scalar `uses:` value after its comment has been removed. */
function parseUsesValue(raw: string): string {
  const value = raw.trim();
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1).trim() : value;
}

/** Returns why an action reference is not immutably pinned, or null when it is. */
function unpinnedReason(ref: string): string | null {
  if (LOCAL_ACTION.test(ref)) return null; // in-repo action — versioned with this commit

  if (ref.startsWith('docker://')) {
    return DOCKER_DIGEST.test(ref)
      ? null
      : 'docker action is not pinned by a sha256 digest (a tag is mutable)';
  }

  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) {
    return 'action reference has no @<commit-sha> pin';
  }

  const pin = ref.slice(at + 1);
  if (pin.toLowerCase() === 'latest') return '@latest is mutable';
  if (!COMMIT_SHA.test(pin)) {
    return `@${pin} is a mutable tag or branch (expected a 40-character commit SHA)`;
  }
  return null;
}

/** Line-scans one workflow's source for unpinned actions and stray @latest. */
function scanWorkflow(file: string, source: string): ScanResult {
  const violations: Violation[] = [];
  let refs = 0;

  source.split('\n').forEach((rawLine, index) => {
    const line = stripYamlComment(rawLine);
    const uses = USES_LINE.exec(line);

    if (uses) {
      const ref = parseUsesValue(uses[1]);
      if (!ref) return;
      refs++;
      const reason = unpinnedReason(ref);
      if (reason) {
        violations.push({ file, line: index + 1, ref, reason });
      }
      return;
    }

    if (LATEST.test(line)) {
      violations.push({
        file,
        line: index + 1,
        ref: line.trim(),
        reason: '@latest outside an action pin is mutable and not allowed',
      });
    }
  });

  return { refs, violations };
}

function scanSource(source: string): ScanResult {
  return scanWorkflow('inline.yml', source);
}

function reasons(source: string): string[] {
  return scanSource(source).violations.map((violation) => violation.reason);
}

describe('workflow scanner — detects mutable refs (self-test)', () => {
  it('rejects a major-version tag', () => {
    const result = scanSource('steps:\n  - uses: actions/checkout@v4\n');
    expect(result.refs).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].reason).toContain('@v4 is a mutable tag');
  });

  it('rejects @latest, a branch ref, and a reusable workflow on a branch', () => {
    expect(reasons('uses: actions/setup-node@latest')).toEqual(['@latest is mutable']);
    expect(reasons('uses: actions/checkout@main')[0]).toContain('@main is a mutable tag');
    expect(reasons('uses: owner/repo/.github/workflows/ci.yml@main')[0]).toContain(
      '@main is a mutable tag',
    );
  });

  it('rejects a docker action on a tag but accepts a digest', () => {
    expect(reasons('uses: docker://alpine:3.19')[0]).toContain('sha256 digest');
    expect(reasons('uses: docker://alpine@sha256:'.concat('a'.repeat(64)))).toEqual([]);
  });

  it('accepts a full commit SHA, a local action, and a quoted SHA with a comment', () => {
    const sha = 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09';
    expect(reasons(`uses: actions/checkout@${sha} # v5.1.0`)).toEqual([]);
    expect(reasons("uses: 'actions/checkout@".concat(sha).concat("'"))).toEqual([]);
    expect(reasons('uses: ./.github/actions/local')).toEqual([]);
  });

  it('finds uses: under nested jobs, list items, and quoted keys', () => {
    const source = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - name: Checkout',
      `        uses: actions/checkout@${'a'.repeat(40)}`,
      '      - "uses": actions/setup-node@v4',
    ].join('\n');
    const result = scanSource(source);
    expect(result.refs).toBe(2);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].line).toBe(6);
  });

  it('rejects a mutable install step elsewhere in the workflow', () => {
    const source =
      'steps:\n  - name: Install CLI\n    run: |\n      npm install --no-save vercel@latest\n';
    expect(reasons(source)[0]).toContain('@latest outside an action pin');
  });

  it('ignores @latest and mutable refs mentioned only in comments', () => {
    const source = [
      '# We moved off actions/checkout@v4 and never use vercel@latest again.',
      `uses: actions/checkout@${'b'.repeat(40)} # previously @main`,
    ].join('\n');
    expect(scanSource(source).violations).toEqual([]);
  });
});

describe('repository workflows — every action is immutably pinned', () => {
  const workflowFiles = readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();

  it('has workflows to scan', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  it('pins every action to a commit SHA, pins docker actions by digest, and never uses @latest', () => {
    const scans = workflowFiles.map((file) => ({
      file,
      ...scanWorkflow(file, readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')),
    }));

    // Guard against a vacuous pass: if the workflow layout changes so the
    // scanner sees no actions at all, this test should say so rather than
    // silently approving everything.
    expect(scans.reduce((total, scan) => total + scan.refs, 0)).toBeGreaterThan(0);

    const violations = scans.flatMap((scan) => scan.violations);
    expect(violations).toEqual([]);
  });
});
