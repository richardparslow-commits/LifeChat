/**
 * SEC-05 regression: a provider error body must never become a client-visible
 * value.
 *
 * The body can echo the bearer prefix, an org/project id, or the request
 * content itself (gateways commonly do). `lastError` is the string that the
 * orchestrator's fallback summary was built from, and that summary is
 * serialised to the browser — so the status is all that may survive.
 */

import { callLLM } from '../src/llm/llm-client';
import { config } from '../src/config/app-config';

describe('callLLM — provider bodies stay server-side (SEC-05)', () => {
  const originalFetch = global.fetch;
  const originalKey = config.llmApiKey;

  afterEach(() => {
    global.fetch = originalFetch;
    config.llmApiKey = originalKey;
    jest.restoreAllMocks();
  });

  it('returns a status-only error and never the provider body', async () => {
    config.llmApiKey = 'sk-test-key';
    // Synthetic provider body: the point of the test is that this text never
    // reaches the client, so it must look like a real leaked key.
    const providerBody =
      'Incorrect API key provided: sk-live-SECRET-ABC123. Organization: org-LEAK-4'; // gitleaks:allow - synthetic test fixture
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 401,
      headers: new Headers({ 'x-request-id': 'req_abc123' }),
      text: async () => providerBody,
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const logged: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });

    const result = await callLLM({
      systemPrompt: 'system',
      ragContext: 'evidence',
      userMessage: 'What is term life insurance?',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('api_error_401');

    // Neither the returned value nor the operator log may carry the body.
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('org-LEAK');
    expect(logged.join(' ')).not.toContain('SECRET');
    expect(logged.join(' ')).not.toContain('org-LEAK');

    // Triage information survives: status + provider request id.
    expect(logged.join(' ')).toContain('401');
    expect(logged.join(' ')).toContain('req_abc123');
  });
});
