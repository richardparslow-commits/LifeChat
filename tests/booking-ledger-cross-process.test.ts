/**
 * SEC-14 — two OS processes race for one slot.
 *
 * `tests/booking-ledger.test.ts` simulates a second instance by reloading the
 * in-memory index, which exercises the reload path but not the actual
 * arbitration: a process that has already loaded an empty ledger still has to
 * lose the claim-file create. This suite starts real child processes against
 * one ledger directory, releases them together, and asserts that exactly one
 * booking succeeds.
 *
 * The claim itself is `open(path, 'wx')` — `O_CREAT | O_EXCL` — so the
 * filesystem decides the winner. The barrier is a shared start timestamp
 * instead of a file handshake: it keeps the children from serialising behind
 * ts-node's startup, which would let the later processes see the claim during
 * hydration and never reach the create at all.
 */

import { spawn } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

/** Wednesday 2026-10-21, 10:00 in Chicago (CDT, UTC-5). */
const NOW = '2026-10-21T15:00:00.000Z';
/** 13:00 Central the same day — past the 2-hour notice window. */
const SLOT = 'slot_20261021T1800Z';

const RACERS = 4;
const START_DELAY_MS = 2_500;

const REPO_ROOT = path.resolve(__dirname, '..');

interface BookingOutcome {
  ok: boolean;
  code?: string;
  appointment?: { slot_id: string; session_id: string };
}

const CHILD_SCRIPT = `
const { bookSlot } = require('./src/scheduling/appointment-slots');
const startAt = Number(process.env.RACE_START_AT);
while (Date.now() < startAt) {}
const result = bookSlot({
  slotId: process.env.RACE_SLOT,
  sessionId: process.env.RACE_SESSION,
  idempotencyKey: process.env.RACE_KEY,
  now: new Date(process.env.RACE_NOW),
});
process.stdout.write(JSON.stringify(result));
`;

function runRacer(
  ledgerDir: string,
  index: number,
  startAt: number,
): Promise<{ outcome: BookingOutcome; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', CHILD_SCRIPT],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          BOOKING_LEDGER_PATH: ledgerDir,
          RACE_START_AT: String(startAt),
          RACE_NOW: NOW,
          RACE_SLOT: SLOT,
          RACE_SESSION: `lpp_racer_${index}`.padEnd(60, 'x'),
          RACE_KEY: `booking:racer-${index}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`racer ${index} exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve({ outcome: JSON.parse(stdout) as BookingOutcome, stderr });
      } catch {
        reject(new Error(`racer ${index} produced no JSON: ${stdout}\n${stderr}`));
      }
    });
  });
}

describe('SEC-14 cross-process slot claim', () => {
  it('lets exactly one of four competing processes book the slot', async () => {
    const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'lifechat-booking-race-'));
    try {
      // Spawn first, then release together: a child that starts late has
      // hydrated after the winner wrote the claim and is refused from the
      // index, which is a valid second-instance path, not the create race.
      const startAt = Date.now() + START_DELAY_MS;
      const racers = Array.from({ length: RACERS }, (_, index) =>
        runRacer(ledgerDir, index, startAt),
      );
      const results = await Promise.all(racers);

      const winners = results.filter(({ outcome }) => outcome.ok);
      const losers = results.filter(({ outcome }) => !outcome.ok);

      expect(winners).toHaveLength(1);
      expect(winners[0].outcome.appointment?.slot_id).toBe(SLOT);
      for (const { outcome } of losers) {
        expect(outcome.code).toBe('slot_already_booked');
      }

      // One claim file, named for the slot — the loser never wrote one.
      expect(readdirSync(ledgerDir)).toEqual([`${SLOT}.json`]);
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  }, 30_000);
});
