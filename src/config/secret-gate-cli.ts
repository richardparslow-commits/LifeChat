/**
 * Pre-deploy posture gate CLI.
 *
 *   npm run secrets:gate                        production: all four values required
 *   npm run secrets:gate -- --mode pilot        pilot: optional, but validated
 *   npm run secrets:gate -- --json
 *   npm run secrets:gate -- --help
 *
 * Reads ADMIN_API_KEY, RECORD_ENCRYPTION_KEY, LLM_API_KEY and
 * TEXAS_LICENSE_NUMBER from the environment. Values are never printed: the
 * report carries only length and the measured shape, so a CI log cannot leak
 * the secret it is validating (and does not become a copy of the config).
 *
 * Exit codes: 0 the values meet the contract, 1 a value is missing or weak,
 * 2 bad usage.
 */

import { formatGateReport, evaluateSecretPosture, type GateMode } from './secret-gate';

const USAGE = [
  'Pre-deploy gate (ADMIN_API_KEY, RECORD_ENCRYPTION_KEY, LLM_API_KEY, TEXAS_LICENSE_NUMBER)',
  '',
  '  npm run secrets:gate                     production: all four required and well-formed',
  '  npm run secrets:gate -- --mode pilot     pilot: optional, but any value must pass',
  '  npm run secrets:gate -- --json           machine-readable report',
  '  npm run secrets:gate -- --help',
  '',
  'The secrets must be random and distinct; the license number must be the',
  'verified digits, never the pending sentinel or a placeholder.',
  '',
  'Values are read from the process environment only (no .env is loaded, so a',
  'local file cannot satisfy a CI gate) and are never printed. Exit 1 means the',
  'deploy must not proceed.',
].join('\n');

interface CliOptions {
  mode: GateMode;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { mode: 'production', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] =
      arg.startsWith('--') && arg.includes('=')
        ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
        : [arg, undefined];

    if (flag === '--mode') {
      const value = inline ?? argv[(i += 1)];
      if (value !== 'production' && value !== 'pilot') {
        throw new Error(`--mode must be "production" or "pilot", got ${value ?? 'nothing'}`);
      }
      options.mode = value;
    } else if (flag === '--json') {
      options.json = true;
    } else if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Entry point; returns the exit code instead of exiting, so tests can drive it. */
export function runSecretGateCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('');
    console.error(USAGE);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const report = evaluateSecretPosture(
    {
      adminApiKey: env.ADMIN_API_KEY,
      recordEncryptionKey: env.RECORD_ENCRYPTION_KEY,
      llmApiKey: env.LLM_API_KEY,
      texasLicenseNumber: env.TEXAS_LICENSE_NUMBER,
    },
    { mode: options.mode },
  );

  console.log(options.json ? JSON.stringify(report, null, 2) : formatGateReport(report));
  return report.ok ? 0 : 1;
}

// Direct invocation (e.g. `npm run secrets:gate`).
if (require.main === module) {
  process.exitCode = runSecretGateCli();
}
