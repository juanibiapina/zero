import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { apiFetch } from '../api';

describe('apiFetch', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prefixes the base URL and attaches the Bearer token', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const getToken = jest.fn<() => Promise<string | null>>().mockResolvedValue('tok123');

    await apiFetch(getToken, '/api/user-settings', {}, 'https://example.test');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/user-settings');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok123');
  });

  it('omits the Authorization header when there is no token', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const getToken = jest.fn<() => Promise<string | null>>().mockResolvedValue(null);

    await apiFetch(getToken, '/api/user-settings', {}, 'https://example.test');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has('Authorization')).toBe(false);
  });
});
