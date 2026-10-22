import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * SEC-17 — the gates that stop a regression without a human noticing.
 *
 * These are contracts over configuration, not implementations: a coverage
 * floor in `jest.config.js`, checksum-pinned secret scanning and dependency
 * review in `security.yml`, Dependabot coverage, and the security rules the
 * required lint step now enforces. The ESLint case is exercised against a real
 * `eval` call so the SAST claim is falsifiable rather than a config string.
 */

const read = (relative: string): string => readFileSync(path.join(process.cwd(), relative), 'utf8');

const JEST_CONFIG = read('jest.config.js');
const SECURITY_WORKFLOW = read('.github/workflows/security.yml');
const GITLEAKS_CONFIG = read('.gitleaks.toml');
const DEPENDABOT = read('.github/dependabot.yml');
const ESLINT_CONFIG = read('eslint.config.mjs');

function threshold(name: string): number | undefined {
  const match = new RegExp(`${name}:\\s*(\\d+)`).exec(JEST_CONFIG);
  return match ? Number(match[1]) : undefined;
}

describe('coverage floor', () => {
  it('fails CI below the audit targets', () => {
    expect(threshold('statements')).toBeGreaterThanOrEqual(85);
    expect(threshold('branches')).toBeGreaterThanOrEqual(75);
    expect(threshold('functions')).toBeGreaterThanOrEqual(85);
    expect(threshold('lines')).toBeGreaterThanOrEqual(85);
  });
});

describe('secret scanning', () => {
  it('runs gitleaks over full history with a checksum-verified binary', () => {
    expect(SECURITY_WORKFLOW).toContain('fetch-depth: 0');
    expect(SECURITY_WORKFLOW).toContain('gitleaks_8.30.1_linux_x64.tar.gz');
    // The archive digest published in gitleaks_8.30.1_checksums.txt.
    expect(SECURITY_WORKFLOW).toContain(
      '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    );
    expect(SECURITY_WORKFLOW).toContain('sha256sum -c -');
    expect(SECURITY_WORKFLOW).toContain('--exit-code 1');
    expect(SECURITY_WORKFLOW).toContain('--config .gitleaks.toml');
    expect(SECURITY_WORKFLOW).toMatch(/schedule:[\s\S]*cron:/);
  });

  it('keeps the allowlist to the three verified historical fixtures', () => {
    expect(GITLEAKS_CONFIG).toContain('useDefault = true');
    // A path allowlist would hide any future secret added to a test file.
    expect(GITLEAKS_CONFIG).not.toMatch(/^\s*paths\s*=/m);
    expect(GITLEAKS_CONFIG).toContain('test-record-encryption-key-0123456789abcdef');
    expect(GITLEAKS_CONFIG).toContain('test-encryption-key-999');
    expect(GITLEAKS_CONFIG).toContain('test-encryption-key-123');
    // No catch-all pattern: allowlist regexes must name the fixture text and
    // must not match an arbitrary line.
    for (const line of GITLEAKS_CONFIG.split('\n').filter((l) => l.includes("'''"))) {
      expect(line).not.toMatch(/'''\.\*'''/);
    }
  });

  it('keeps inline exemptions on documented synthetic fixtures only', () => {
    // The scan cannot pass on this repository without a few inline
    // scanner-exemption markers: the Dockerfile build script names secret ids
    // (`id=…,env=…`) and the tests use deliberately realistic fake keys. An
    // inline exemption is easy to abuse, so this pins the justification text:
    // a new suppression must say what it is, and a real credential cannot be
    // hidden behind a bare marker. The marker is assembled so this file's own
    // source does not match the scan it performs.
    const MARKER = 'gitleaks' + ':allow';
    const extensions = /\.(ts|mjs|js|sh)$/;
    const files = ['src', 'tests', 'scripts'].flatMap((dir) =>
      readdirSync(path.join(process.cwd(), dir), { recursive: true })
        .map(String)
        .filter((entry) => extensions.test(entry))
        .map((entry) => path.join(dir, entry)),
    );

    const exemptions = files.flatMap((file) =>
      readFileSync(path.join(process.cwd(), file), 'utf8')
        .split('\n')
        .filter((line) => line.includes(MARKER))
        .map((line) => ({ file, line: line.trim() })),
    );

    // A checkout may legitimately carry no inline exemptions: the rule governs
    // the markers that exist, it does not require one. Prove the walk itself
    // ran, so an empty result cannot come from a broken scan.
    expect(files).toContain(path.join('src', 'index.ts'));
    for (const { file, line } of exemptions) {
      expect({ file, line }).toEqual({
        file,
        line: expect.stringMatching(
          new RegExp(`${MARKER} - (synthetic test fixture|argument name, not a value)$`),
        ),
      });
    }
  });
});

describe('dependency review', () => {
  it('blocks high-severity dependency changes on pull requests with a read-only token', () => {
    expect(SECURITY_WORKFLOW).toContain("if: github.event_name == 'pull_request'");
    expect(SECURITY_WORKFLOW).toContain(
      'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294',
    );
    expect(SECURITY_WORKFLOW).toContain('fail-on-severity: high');
    expect(SECURITY_WORKFLOW).toContain('comment-summary-in-pr: never');
    // The workflow-level permission set is read-only; the pinning suite also
    // rejects any `write` scope in .github/workflows.
    expect(SECURITY_WORKFLOW).toContain('permissions:\n  contents: read');
  });

  it('keeps Dependabot covering npm and pinned GitHub Actions', () => {
    expect(existsSync(path.join(process.cwd(), '.github', 'dependabot.yml'))).toBe(true);
    expect(DEPENDABOT).toContain('version: 2');
    expect(DEPENDABOT).toContain('package-ecosystem: npm');
    expect(DEPENDABOT).toContain('package-ecosystem: github-actions');
    expect(DEPENDABOT).toContain('interval: weekly');
    // Majors are a deliberate window (SEC-25), but security updates still flow.
    expect(DEPENDABOT).toContain('version-update:semver-major');
  });
});

describe('SAST in the required lint step', () => {
  it('wires the security plugin as an error, not an advisory', () => {
    expect(ESLINT_CONFIG).toContain("from 'eslint-plugin-security'");
    expect(ESLINT_CONFIG).toContain("'security/detect-eval-with-expression': 'error'");
    expect(ESLINT_CONFIG).toContain("'security/detect-child-process': 'error'");
    expect(ESLINT_CONFIG).toContain("'security/detect-non-literal-require': 'error'");
  });

  it('actually reports a dynamic eval through the project config', () => {
    // ESLint loads the flat config through a dynamic import, which Jest's VM
    // cannot provide without --experimental-vm-modules. Run the shipped CLI on
    // stdin instead: same config, same rules, no test-runner flags.
    const result = spawnSync(
      process.execPath,
      [
        path.join(process.cwd(), 'node_modules', 'eslint', 'bin', 'eslint.js'),
        '--stdin',
        '--stdin-filename',
        'src/gate-probe.ts',
        '--format',
        'json',
      ],
      {
        cwd: process.cwd(),
        input: 'export function run(input: string) { return eval(input); }\n',
        encoding: 'utf8',
      },
    );

    const [report] = JSON.parse(result.stdout) as Array<{
      messages: Array<{ ruleId: string | null }>;
    }>;
    expect(report.messages.map((message) => message.ruleId)).toContain(
      'security/detect-eval-with-expression',
    );
  });
});
