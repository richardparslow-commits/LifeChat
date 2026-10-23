/**
 * One-shot credential probe for the model provider.
 *
 * `/api/admin/health` reports `llm.configured` from the presence of
 * `LLM_API_KEY`, which is all a readiness check should do — it must not spend
 * money or block on a provider. The cost of that choice is that a revoked, expired, or
 * wrong-region key still looks healthy, and the first symptom is a chat that
 * quietly answers from the static fallback. This probe is the explicit check:
 * one minimal completion against the configured endpoint, reported as a
 * verdict rather than a log line buried in the server output.
 *
 * It is deliberately not wired into the health routes or into app startup: a
 * probe on every request would add a network round trip to a health check, and
 * a probe at boot would turn a provider outage into a failed deploy.
 *
 * The key is never returned, logged, or echoed — including on failure, where
 * only the provider's own message (which never contains the key) is surfaced.
 */

import { config } from '../config/app-config';

/** Timeout for the probe; short enough to be interactive, long enough for a cold provider. */
export const LLM_PROBE_TIMEOUT_MS = 15_000;

export interface LlmProbeResult {
  ok: boolean;
  /** HTTP status, or null when the request never completed. */
  status: number | null;
  latencyMs: number;
  /** Endpoint that was probed (no credentials in it). */
  baseUrl: string;
  model: string;
  /** Model the provider reported answering, when it did. */
  responseModel: string | null;
  /** Machine-readable reason: `http_401`, `missing_key`, `timeout`, `network_error`. */
  errorCode: string | null;
  /** The provider's message, safe to show: it never contains the key. */
  errorMessage: string | null;
}

export interface LlmProbeOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

interface ProviderErrorBody {
  error?: { message?: string; code?: string; type?: string };
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return { code: 'timeout', message: `No response within ${LLM_PROBE_TIMEOUT_MS}ms` };
    }
    return { code: 'network_error', message: error.message };
  }
  return { code: 'network_error', message: String(error) };
}

/**
 * Send one minimal chat completion and classify the answer.
 *
 * A 200 proves three things at once that the health routes cannot: the key is accepted,
 * the endpoint is reachable from this process, and the configured model name
 * exists for this account.
 */
export async function probeLlmCredential(options: LlmProbeOptions = {}): Promise<LlmProbeResult> {
  const baseUrl = (options.baseUrl ?? config.llmApiBaseUrl).replace(/\/+$/, '');
  const apiKey = options.apiKey ?? config.llmApiKey;
  const model = options.model ?? config.llmModel;
  const timeoutMs = options.timeoutMs ?? LLM_PROBE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const base: Omit<LlmProbeResult, 'ok' | 'status' | 'latencyMs' | 'errorCode' | 'errorMessage'> = {
    baseUrl,
    model,
    responseModel: null,
  };

  if (!apiKey.trim()) {
    return {
      ...base,
      ok: false,
      status: null,
      latencyMs: 0,
      errorCode: 'missing_key',
      errorMessage: 'LLM_API_KEY is not set',
    };
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 5,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const { code, message } = describeError(error);
    return {
      ...base,
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      errorCode: code,
      errorMessage: message,
    };
  }

  const latencyMs = Date.now() - startedAt;

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body is itself the finding; the status below carries it.
  }

  if (!response.ok) {
    const providerError = (body as ProviderErrorBody | null)?.error;
    return {
      ...base,
      ok: false,
      status: response.status,
      latencyMs,
      errorCode: providerError?.code ?? providerError?.type ?? `http_${response.status}`,
      errorMessage: providerError?.message ?? response.statusText ?? `HTTP ${response.status}`,
    };
  }

  return {
    ...base,
    ok: true,
    status: response.status,
    latencyMs,
    responseModel: (body as { model?: string } | null)?.model ?? model,
    errorCode: null,
    errorMessage: null,
  };
}
