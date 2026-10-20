/**
 * CI supply-chain pinning (SEC-10, P1).
 *
 * A workflow that references `actions/checkout@v5` executes whatever that tag
 * points at when the job runs, so a compromised or retagged action runs with
 * the repository's token. Every action must therefore be pinned to a full
 * 40-character commit SHA. The human-readable version belongs in a trailing
 * comment, where it documents intent without controlling what executes.
 *
 * This is a static check so drift is caught in review and in CI, rather than
 * noticed after a workflow has already run.
 */

import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

function workflowFiles(): { name: string; source: string }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => ({ name, source: readFileSync(path.join(WORKFLOW_DIR, name), 'utf8') }));
}

/** Every `uses:` reference, as written (local `./` actions excluded). */
function actionReferences(source: string): string[] {
  return (
    [...source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)\s*$/gm)]
      .map((match) => match[1])
      .filter((ref) => !ref.startsWith('./'))
      /* Docker actions (docker://…) are referenced by tag and out of scope here. */
      .filter((ref) => !ref.startsWith('docker://'))
  );
}

describe('GitHub Actions are pinned to immutable commits', () => {
  it('has workflows to check', () => {
    expect(workflowFiles().length).toBeGreaterThan(0);
  });

  it('pins every action to a full 40-character SHA', () => {
    const unpinned: string[] = [];

    for (const file of workflowFiles()) {
      for (const ref of actionReferences(file.source)) {
        if (!/@[0-9a-f]{40}$/.test(ref)) {
          unpinned.push(`${file.name}: ${ref}`);
        }
      }
    }

    expect(unpinned).toEqual([]);
  });

  it('documents the version beside each pin', () => {
    for (const file of workflowFiles()) {
      for (const match of file.source.matchAll(/uses:\s*\S+@[0-9a-f]{40}\s*(#.*)?$/gm)) {
        expect(match[0]).toMatch(/#\s*v?\d+\.\d+/);
      }
    }
  });

  it('declares permissions explicitly and grants nothing beyond read', () => {
    for (const file of workflowFiles()) {
      // Either at the workflow level (applies to every job) or per job — what
      // must not happen is falling back to the repository default token scope.
      expect(file.source).toMatch(/^\s*permissions:\s*$/m);
      expect(file.source).not.toMatch(/permissions:[\s\S]*?\bwrite\b/);
    }
  });

  it('gives every job a permission block (workflow-level or its own)', () => {
    for (const file of workflowFiles()) {
      const hasWorkflowLevel = /^permissions:\s*$/m.test(file.source);
      if (hasWorkflowLevel) continue;

      // Job ids are the two-space-indented keys under `jobs:`.
      const jobIds = [...file.source.matchAll(/^\s{2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]);
      expect(jobIds.length).toBeGreaterThan(0);
      for (const jobId of jobIds) {
        const jobBlock = new RegExp(
          `^\\s{2}${jobId}:\\s*$([\\s\\S]*?)(?=^\\s{2}[a-z0-9-]+:\\s*$|(?![\\s\\S]))`,
          'm',
        ).exec(file.source);
        expect(jobBlock?.[1] ?? '').toMatch(/permissions:/);
      }
    }
  });

  it('installs dependencies from the lockfile, never with npm install', () => {
    for (const file of workflowFiles()) {
      if (!/npm ci/.test(file.source)) continue;
      const bareInstalls = [...file.source.matchAll(/^.*\bnpm install\b.*$/gm)].map((m) => m[0]);
      // The deploy job installs the Vercel CLI as a pinned, non-saved tool —
      // that is not a project dependency install.
      for (const line of bareInstalls) {
        expect(line).toMatch(/--no-save\s+vercel@\d+\.\d+\.\d+/);
      }
    }
  });
});
