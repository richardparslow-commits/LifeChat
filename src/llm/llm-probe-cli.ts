/**
 * Model credential probe CLI.
 *
 *   npm run llm:probe            check .env's endpoint + key + model
 *   npm run llm:probe -- --json  machine-readable result
 *
 * Use it before a demo and after rotating `LLM_API_KEY`. `/api/admin/health`
 * saying `llm.configured: true` only means a key is present; this command
 * proves the key is accepted, the endpoint answers, and the model name exists.
 *
 * The key is never printed — only its length and prefix, so a truncated paste
 * or a wrong-kind-of-token (an `adt_` mount token, say) is visible without the
 * value appearing in a terminal scrollback or a CI log.
 *
 * Exit codes: 0 the model answered, 1 the probe failed, 2 bad usage.
 */

import 'dotenv/config';

import { config } from '../config/app-config';
import { probeLlmCredential } from './llm-probe';

const USAGE = [
  'Model credential probe (LLM_API_BASE_URL, LLM_API_KEY, LLM_MODEL)',
  '',
  '  npm run llm:probe             probe the configured endpoint',
  '  npm run llm:probe -- --json   machine-readable result',
  '  npm run llm:probe -- --help    this message',
  '',
  'Exit 0 means the provider accepted the key and answered for the model.',
  'Exit 1 means it did not; the reason is printed without the key.',
].join('\n');

function maskKey(key: string): string {
  if (!key) return '(unset)';
  return `${key.slice(0, 3)}… (${key.length} chars)`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const json = args.includes('--json');
  const result = await probeLlmCredential();

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...result, apiKey: maskKey(config.llmApiKey) }, null, 2)}\n`,
    );
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  process.stdout.write(
    [
      `Endpoint:  ${result.baseUrl}`,
      `Model:     ${result.model}`,
      `Key:       ${maskKey(config.llmApiKey)}`,
      '',
    ].join('\n'),
  );

  if (result.ok) {
    process.stdout.write(
      [
        `OK — the provider answered in ${result.latencyMs}ms (model: ${result.responseModel}).`,
        'Real answers will be used; no fallback is expected.',
        '',
      ].join('\n'),
    );
    return;
  }

  const explanation =
    result.errorCode === 'missing_key'
      ? 'Set LLM_API_KEY in .env (see .env.example).'
      : 'Until this passes, /api/chat answers from the static fallback while\n' +
        '/api/admin/health still reports llm.configured: true.';

  process.stdout.write(
    [
      `FAILED — ${result.errorCode ?? 'unknown'}${result.status ? ` (HTTP ${result.status})` : ''}`,
      `  ${result.errorMessage ?? 'no message'}`,
      '',
      explanation,
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
