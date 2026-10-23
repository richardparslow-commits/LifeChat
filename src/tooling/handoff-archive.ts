/**
 * Which files may leave this repository in a handoff archive.
 *
 * The audit that prompted this module found that a plain `zip -r .` ships four
 * things that must never be handed to another team or toolchain:
 *
 *   1. `.env` — live API and encryption keys. `git` ignores it, `zip` does not.
 *   2. `data/` — the runtime record store (DSR requests, lead records,
 *      abstention feed). Gitignored, zip-included, and full of personal data.
 *   3. `.sites-build/` — bundled server output plus `sites-entry.js.map`, which
 *      is the server source in readable form.
 *   4. `dist/` and `coverage/` — stale build and test output, ~13 MB of noise.
 *
 * A deny list is the only durable fix: an allow list would silently omit new
 * source files, and "remember to pass -x" fails the first time someone forgets.
 * The filter is a pure function so the packaging CLI and the test suite agree
 * on exactly what is excluded.
 */

/** Directory prefixes that never belong in a handoff archive. */
export const HANDOFF_DENY_PREFIXES: readonly string[] = [
  '.git/',
  'node_modules/',
  'data/',
  'dist/',
  'coverage/',
  '.sites-build/',
  'sites-deploy/',
  'sites-probe/',
  'worker/.wrangler/',
  '.freebuff/',
  '.vercel/',
];

/** Exact file names that never belong in a handoff archive. */
export const HANDOFF_DENY_BASENAMES: readonly string[] = ['.DS_Store'];

/** File extensions that are always local noise. */
export const HANDOFF_DENY_EXTENSIONS: readonly string[] = ['.log', '.tsbuildinfo'];

/** Suffixes for throwaway debugging scripts. */
export const HANDOFF_DENY_SUFFIXES: readonly string[] = ['.tmp.mjs'];

/**
 * Environment templates are the one exception to "no dotenv files": they
 * document the variables without carrying a value.
 */
const ENV_TEMPLATE = /^\.env\.(example|sample|template)$/;

/**
 * True when a repository-relative path must be excluded from a handoff.
 *
 * Deny-by-default for anything outside the repository (`../`, absolute paths)
 * so a malformed file list cannot walk upward into a home directory.
 */
export function isForbiddenHandoffPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.length === 0) return true;
  if (normalized.startsWith('/') || normalized.startsWith('../')) return true;
  if (normalized.includes('/../')) return true;

  for (const prefix of HANDOFF_DENY_PREFIXES) {
    if (normalized === prefix.slice(0, -1) || normalized.startsWith(prefix)) return true;
  }

  const segments = normalized.split('/');
  const base = segments[segments.length - 1];

  // Every .env* file is secret material except the documented templates.
  if (base.startsWith('.env') && !ENV_TEMPLATE.test(base)) return true;
  if (HANDOFF_DENY_BASENAMES.includes(base)) return true;
  if (HANDOFF_DENY_EXTENSIONS.some((extension) => base.endsWith(extension))) return true;
  if (HANDOFF_DENY_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;

  return false;
}

export interface HandoffSelection {
  /** Paths to write into the archive, in the order they were supplied. */
  included: string[];
  /** Paths that were dropped, with the reason, for the run report. */
  excluded: { path: string; reason: string }[];
}

/**
 * Partitions a file list into what ships and what does not.
 *
 * `reason` is derived from the rule that matched so the CLI can print an
 * auditable summary instead of a bare count — an operator who sees
 * `data/dsr-records.jsonl (runtime records)` knows the filter is doing the
 * right thing, where "412 excluded" proves nothing.
 */
export function selectHandoffFiles(paths: readonly string[]): HandoffSelection {
  const included: string[] = [];
  const excluded: { path: string; reason: string }[] = [];

  for (const path of paths) {
    if (!isForbiddenHandoffPath(path)) {
      included.push(path);
      continue;
    }
    excluded.push({ path, reason: exclusionReason(path) });
  }

  return { included, excluded };
}

/** The rule that excludes a path, phrased for a run report. */
export function exclusionReason(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = normalized.split('/').pop() ?? normalized;

  if (normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../')) {
    return 'outside the repository';
  }
  if (base.startsWith('.env') && !ENV_TEMPLATE.test(base)) return 'environment file (secret)';
  if (normalized === 'data' || normalized.startsWith('data/'))
    return 'runtime records (personal data)';
  if (normalized.startsWith('.sites-build/')) return 'generated server bundle and source map';
  if (normalized.startsWith('sites-deploy/')) return 'generated deployment bundle';
  if (normalized.startsWith('sites-probe/')) return 'throwaway deploy probe';
  if (normalized.startsWith('worker/.wrangler/')) return 'local wrangler cache';
  if (normalized.startsWith('dist/')) return 'build output';
  if (normalized.startsWith('coverage/')) return 'test coverage output';
  if (normalized.startsWith('node_modules/')) return 'dependencies';
  if (normalized.startsWith('.git/')) return 'git internals';
  if (normalized.startsWith('.freebuff/')) return 'local client metadata';
  if (normalized.startsWith('.vercel/')) return 'local vercel link';
  if (base === '.DS_Store') return 'OS metadata';
  if (base.endsWith('.log')) return 'log file';
  if (base.endsWith('.tsbuildinfo')) return 'incremental build metadata';
  if (base.endsWith('.tmp.mjs')) return 'throwaway debug script';
  return 'excluded';
}
