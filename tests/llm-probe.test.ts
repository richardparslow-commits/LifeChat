/**
 * The probe exists to tell "a key is present" apart from "the key works", so
 * these tests pin exactly that distinction: a missing key never reaches the
 * network, a rejected key reports the provider's own status and message, and a
 * 200 reports the model that answered.
 */

import { probeLlmCredential } from '../src/llm/llm-probe';

const KEY = 'sk-test-not-a-real-key-000000000000';

function fetchReturning(body: unknown, status = 200): jest.Mock {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    json: async () => body,
  }));
}

describe('probeLlmCredential', () => {
  it('reports a missing key without calling the provider', async () => {
    const fetchImpl = jest.fn();

    const result = await probeLlmCredential({
      baseUrl: 'https://example.test/v1',
      apiKey: '',
      model: 'gpt-4o',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('missing_key');
    expect(result.status).toBeNull();
  });

  it('reports a rejected key with the provider status and message', async () => {
    const fetchImpl = fetchReturning(
      { error: { message: 'Incorrect API key provided', type: 'authentication_error' } },
      401,
    );

    const result = await probeLlmCredential({
      baseUrl: 'https://example.test/v1',
      apiKey: KEY,
      model: 'gpt-4o',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.errorCode).toBe('authentication_error');
    expect(result.errorMessage).toBe('Incorrect API key provided');
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('sends the key as a bearer token to the chat completions path', async () => {
    const fetchImpl = fetchReturning({ model: 'gpt-4o-2024-08-06' });

    await probeLlmCredential({
      baseUrl: 'https://example.test/v1/',
      apiKey: KEY,
      model: 'gpt-4o',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-4o', max_tokens: 5 });
  });

  it('reports success with the model the provider actually answered with', async () => {
    const result = await probeLlmCredential({
      baseUrl: 'https://example.test/v1',
      apiKey: KEY,
      model: 'gpt-4o',
      fetchImpl: fetchReturning({ model: 'gpt-4o-2024-08-06' }) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.responseModel).toBe('gpt-4o-2024-08-06');
    expect(result.errorCode).toBeNull();
  });

  it('reports a transport failure as a network error rather than a bad key', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND example.test');
    });

    const result = await probeLlmCredential({
      baseUrl: 'https://example.test/v1',
      apiKey: KEY,
      model: 'gpt-4o',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.errorCode).toBe('network_error');
    expect(result.errorMessage).toContain('ENOTFOUND');
  });
});
