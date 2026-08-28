import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  addCapture,
  apiFetch,
  fetchInbox,
  processCapture,
  type Capture,
} from '../api';

type TokenGetter = () => Promise<string | null>;

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

describe('fetchInbox', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /api/captures and returns the Inbox', async () => {
    const captures: Capture[] = [
      {
        id: '1',
        text: 'buy milk',
        createdAt: '2023-01-01T00:00:00.000Z',
        processedAt: null,
      },
    ];
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ captures }), { status: 200 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await fetchInbox(getToken, 'https://example.test');

    expect(result).toEqual(captures);
  });
});

describe('addCapture', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs the text with the Idempotency-Key and returns the created capture', async () => {
    const capture: Capture = {
      id: '1',
      text: 'call mom',
      createdAt: '2023-01-01T00:00:00.000Z',
      processedAt: null,
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ capture }), { status: 201 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await addCapture(
      getToken,
      'call mom',
      'write-42',
      'https://example.test',
    );

    expect(result).toEqual(capture);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/captures');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'call mom' });
    const headers = new Headers(init.headers);
    expect(headers.get('Idempotency-Key')).toBe('write-42');
  });
});

describe('processCapture', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs to /api/captures/{id}/process with the Bearer token', async () => {
    const capture: Capture = {
      id: 'abc',
      text: 'buy milk',
      createdAt: '2023-01-01T00:00:00.000Z',
      processedAt: '2023-01-02T00:00:00.000Z',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ capture }), { status: 200 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await processCapture(getToken, 'abc', 'https://example.test');

    expect(result).toEqual(capture);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/captures/abc/process');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });
});
