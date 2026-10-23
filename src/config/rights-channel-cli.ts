/**
 * Pre-deploy gate: does the published privacy-rights mailbox accept mail?
 *
 * `npm run rights:channel` — human-readable verdict, exit code for CI.
 * `npm run rights:channel -- --json` — machine-readable verdict.
 *
 * Exit codes
 *   0  deliverable, or the check was deliberately skipped
 *   1  undeliverable (also: the configured address is not a usable address)
 *   2  unverified — DNS could not answer; learned nothing
 *
 * Why this is a separate step and not part of `npm start`: a release must not
 * depend on the build machine's resolver, and a preview build must not fail
 * because it has no network. The gate is invoked by the release path (the
 * container posture stage and the deploy runbook) and can be turned off with
 * `DSR_CHANNEL_CHECK=off` where a preview has no DNS at all.
 */

import 'dotenv/config';

import { config, DEFAULT_DSR_CONTACT_EMAIL } from './app-config';
import { verifyRightsChannel, type RightsChannelVerdict } from './rights-channel';

interface Options {
  json: boolean;
  allowOffline: boolean;
  email: string;
  timeoutMs: number;
  skip: boolean;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options {
  const options: Options = {
    json: false,
    allowOffline: TRUTHY.has((env.DSR_CHANNEL_ALLOW_OFFLINE || '').toLowerCase()),
    email: (env.DSR_CONTACT_EMAIL || env.DSR_EMAIL || DEFAULT_DSR_CONTACT_EMAIL).trim(),
    timeoutMs: 3000,
    skip: ['off', '0', 'false', 'no'].includes((env.DSR_CHANNEL_CHECK || '').toLowerCase()),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--allow-offline') {
      options.allowOffline = true;
    } else if (argument === '--skip') {
      options.skip = true;
    } else if (argument === '--email' && argv[index + 1]) {
      options.email = argv[index + 1].trim();
      index += 1;
    } else if (argument.startsWith('--email=')) {
      options.email = argument.slice('--email='.length).trim();
    } else if (argument === '--timeout-ms' && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) options.timeoutMs = Math.min(parsed, 30000);
      index += 1;
    }
  }

  return options;
}

/**
 * Runs the gate and returns the process exit code.
 *
 * Exported so tests drive the real decision logic rather than a copy: the
 * difference between "skipped", "unverified but tolerated" and "refused" is
 * the whole point of the gate.
 */
export async function runRightsChannelCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  verify: (
    email: string,
    options: { timeoutMs: number },
  ) => Promise<RightsChannelVerdict> = verifyRightsChannel,
): Promise<number> {
  const options = parseOptions(argv, env);
  const configured = options.email || config.dsrEmail;

  if (options.skip) {
    const message = `Rights channel check skipped (DSR_CHANNEL_CHECK=off). Configured address: ${configured}.`;
    if (options.json) {
      console.log(
        JSON.stringify({ status: 'skipped', address: configured, reason: 'DSR_CHANNEL_CHECK=off' }),
      );
    } else {
      console.log(message);
    }
    return 0;
  }

  const verdict = await verify(configured, { timeoutMs: options.timeoutMs });

  if (options.json) {
    console.log(JSON.stringify(verdict));
  } else {
    console.log(`Rights channel: ${verdict.address || configured}`);
    if (verdict.domain) console.log(`  domain: ${verdict.domain}`);
    console.log(`  verdict: ${verdict.status.toUpperCase()} — ${verdict.reason}`);
  }

  if (verdict.status === 'deliverable') return 0;

  if (verdict.status === 'undeliverable') {
    if (!options.json) {
      console.error(
        'ERROR: the privacy notice publishes this address for TDPSA access, deletion, correction and ' +
          'portability requests. Mail sent to it would bounce. Point DSR_CONTACT_EMAIL at a mailbox ' +
          'that accepts mail before releasing.',
      );
    }
    return 1;
  }

  // Unverified: DNS did not answer. A release must not treat that as a pass.
  if (options.allowOffline) {
    if (!options.json) {
      console.warn(
        'WARN: mail routing could not be verified (no DNS answer). Tolerated because ' +
          '--allow-offline / DSR_CHANNEL_ALLOW_OFFLINE is set; re-run this gate with network access ' +
          'before a production release.',
      );
    }
    return 0;
  }

  if (!options.json) {
    console.error(
      `ERROR: mail routing could not be verified (${verdict.reason}). Re-run with network access, ` +
        'or pass --allow-offline for a preview build that has no verified channel.',
    );
  }
  return 2;
}

if (require.main === module) {
  void runRightsChannelCli().then((code) => {
    process.exitCode = code;
  });
}

export { parseOptions };
