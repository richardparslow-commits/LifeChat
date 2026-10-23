/**
 * Builds the handoff archive, and then audits the archive it just built.
 *
 * `npm run handoff:package -- --out ../lifechat-handoff.zip`
 *
 * Why a script instead of a documented `zip -x` incantation: the exclusion list
 * is the security boundary (`.env` holds keys, `data/` holds DSR and lead
 * records, `.sites-build/sites-entry.js.map` is the server source). A flag in a
 * README is one copy-paste away from being wrong; this reads the same
 * `isForbiddenHandoffPath` the test suite pins, and refuses to finish if the
 * produced archive contains a single forbidden entry.
 *
 * Only files git knows about are considered — tracked plus untracked-but-not-
 * ignored — so the archive matches the working tree without ever sweeping in
 * `node_modules/` or a local `.env`.
 */

import { execFileSync } from 'child_process';
import path from 'path';

import { isForbiddenHandoffPath, selectHandoffFiles } from './handoff-archive';

interface Options {
  repoRoot: string;
  outPath: string;
}

function parseOptions(argv: readonly string[]): Options {
  const repoRoot = process.cwd();
  let outPath = path.resolve(
    repoRoot,
    '..',
    `lifechat-handoff-${new Date().toISOString().slice(0, 10)}.zip`,
  );

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out' && argv[index + 1]) {
      outPath = path.resolve(repoRoot, argv[index + 1]);
      index += 1;
    }
  }

  return { repoRoot, outPath };
}

/** Every path git would copy: tracked files plus untracked, minus ignored. */
function listCandidateFiles(repoRoot: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return output.split('\0').filter((entry) => entry.length > 0);
}

/** Entry names inside the produced archive, so the verification reads the file. */
function listArchiveEntries(archivePath: string): string[] {
  const output = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' });
  return output.split('\n').filter((entry) => entry.trim().length > 0);
}

export function runPackageHandoffCli(argv: readonly string[] = process.argv.slice(2)): number {
  const { repoRoot, outPath } = parseOptions(argv);

  let candidates: string[];
  try {
    candidates = listCandidateFiles(repoRoot);
  } catch (error) {
    console.error(
      `FAILED: could not read the file list from git (${(error as Error).message}). ` +
        'Run this from the repository root of a git checkout.',
    );
    return 1;
  }

  const { included, excluded } = selectHandoffFiles(candidates);
  if (included.length === 0) {
    console.error('FAILED: no files selected — refusing to write an empty archive.');
    return 1;
  }

  try {
    execFileSync('zip', ['-q', '-@', outPath], {
      cwd: repoRoot,
      input: `${included.join('\n')}\n`,
    });
  } catch (error) {
    const message = (error as Error).message;
    console.error(
      message.includes('ENOENT')
        ? 'FAILED: the `zip` binary is not installed. Install it, or run `git archive` from a commit.'
        : `FAILED: zip exited with an error (${message}).`,
    );
    return 1;
  }

  const entries = listArchiveEntries(outPath);
  const leaked = entries.filter((entry) => isForbiddenHandoffPath(entry));

  console.log(`Archive: ${outPath}`);
  console.log(`  files written: ${entries.length}`);
  console.log(`  excluded:      ${excluded.length}`);
  for (const { path: excludedPath, reason } of excluded.slice(0, 20)) {
    console.log(`    - ${excludedPath} (${reason})`);
  }
  if (excluded.length > 20) {
    console.log(`    … and ${excluded.length - 20} more`);
  }

  if (leaked.length > 0) {
    console.error(
      `FAILED: the archive contains ${leaked.length} forbidden entr${leaked.length === 1 ? 'y' : 'ies'}:`,
    );
    for (const entry of leaked) {
      console.error(`    - ${entry}`);
    }
    console.error('Delete the archive and fix the filter before handing it to anyone.');
    return 1;
  }

  console.log('Verified: no environment files, runtime records, build output or source maps.');
  return 0;
}

if (require.main === module) {
  process.exitCode = runPackageHandoffCli();
}

export { runPackageHandoffCli as run };
