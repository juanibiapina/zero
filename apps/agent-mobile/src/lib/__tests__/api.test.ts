import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { apiFetch, fetchIconSuggestions, patchTimezone, uploadRecordingForTranscript } from '../api';

describe('mobile HTTP API', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('attaches the Clerk token to requests', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const getToken = jest
      .fn<() => Promise<string | null>>()
      .mockResolvedValue('tok123');

    await apiFetch(getToken, '/api/user-settings', {}, 'https://example.test');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/user-settings');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer tok123',
    );
  });

  it('omits the Authorization header when signed out', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const getToken = jest
      .fn<() => Promise<string | null>>()
      .mockResolvedValue(null);

    await apiFetch(getToken, '/api/user-settings', {}, 'https://example.test');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('writes the device timezone', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const getToken = jest
      .fn<() => Promise<string | null>>()
      .mockResolvedValue('tok');

    await patchTimezone(getToken, 'Europe/Berlin');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/user-settings');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      timezone: 'Europe/Berlin',
    });
  });

  it('returns project icon suggestions', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ icons: ['🚀', '🎯'] }), { status: 200 }),
    );
    const getToken = jest
      .fn<() => Promise<string | null>>()
      .mockResolvedValue('tok');

    await expect(
      fetchIconSuggestions(
        getToken,
        { title: 'Ship it', description: 'Release the app' },
        undefined,
        'https://example.test',
      ),
    ).resolves.toEqual(['🚀', '🎯']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/projects/icon-suggestions');
    expect(init.method).toBe('POST');
  });

  it('sends a voice note for its transcript and tells whether the server had it', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    const getToken = jest.fn<() => Promise<string | null>>().mockResolvedValue('tok');
    const send = async (status: number) => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status }));
      return uploadRecordingForTranscript(getToken, 'rec-1', 'file:///recordings/rec-1.m4a', 'https://example.test');
    };

    expect(await send(200)).toBe('done');
    expect(await send(404)).toBe('not-synced');
    expect(await send(502)).toBe('later');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/recordings/rec-1/transcript');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });
});
