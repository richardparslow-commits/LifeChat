/**
 * The handoff archive is the one artefact that leaves the machine, so the
 * exclusion rules are pinned here rather than trusted to a documented command.
 *
 * Each case is a real path from the readiness audit: two Blockers (`.env` and
 * `data/`), one High (the generated server bundle and its source map), and the
 * files that must still ship.
 */

import { readFileSync } from 'fs';
import path from 'path';

import {
  exclusionReason,
  isForbiddenHandoffPath,
  selectHandoffFiles,
} from '../src/tooling/handoff-archive';

const REPO_ROOT = path.join(__dirname, '..');

describe('handoff archive filter', () => {
  it.each([
    ['.env', 'environment file (secret)'],
    ['.env.local', 'environment file (secret)'],
    ['.env.production', 'environment file (secret)'],
    ['data/dsr-records.jsonl', 'runtime records (personal data)'],
    ['data', 'runtime records (personal data)'],
    ['.sites-build/sites-entry.js.map', 'generated server bundle and source map'],
    ['sites-deploy/worker.js', 'generated deployment bundle'],
    ['sites-probe/index.js', 'throwaway deploy probe'],
    ['worker/.wrangler/config.json', 'local wrangler cache'],
    ['dist/index.js', 'build output'],
    ['coverage/lcov.info', 'test coverage output'],
    ['node_modules/express/index.js', 'dependencies'],
    ['.git/config', 'git internals'],
    ['.DS_Store', 'OS metadata'],
    ['runtime.log', 'log file'],
    ['tsconfig.tsbuildinfo', 'incremental build metadata'],
    ['probe-iframe.tmp.mjs', 'throwaway debug script'],
    ['../outside-the-repo.txt', 'outside the repository'],
    ['/etc/passwd', 'outside the repository'],
  ])('excludes %s', (candidate, reason) => {
    expect(isForbiddenHandoffPath(candidate)).toBe(true);
    expect(exclusionReason(candidate)).toBe(reason);
  });

  it.each([
    '.env.example',
    '.env.sample',
    'package.json',
    'src/app.ts',
    'public/widget.js',
    'worker/sites-entry.mjs',
    'sites-manifest.json',
    'docs/lovable-migration-readiness-audit.md',
    'tests/api-endpoints.test.ts',
  ])('keeps %s', (candidate) => {
    expect(isForbiddenHandoffPath(candidate)).toBe(false);
  });

  it('reports what it dropped instead of only a count', () => {
    const selection = selectHandoffFiles([
      'src/app.ts',
      '.env',
      'data/lead.jsonl',
      '.sites-build/sites-entry.js',
      'public/widget.js',
    ]);

    expect(selection.included).toEqual(['src/app.ts', 'public/widget.js']);
    expect(selection.excluded.map((entry) => entry.path)).toEqual([
      '.env',
      'data/lead.jsonl',
      '.sites-build/sites-entry.js',
    ]);
    expect(selection.excluded.every((entry) => entry.reason.length > 0)).toBe(true);
  });
});

describe('generated directories are ignored by git as well', () => {
  const gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');

  it.each(['.sites-build/', 'sites-deploy/', 'sites-probe/', 'worker/.wrangler/', '*.tmp.mjs'])(
    'ignores %s',
    (entry) => {
      const line = gitignore
        .split('\n')
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate === entry);
      expect(line).toBe(entry);
    },
  );
});
