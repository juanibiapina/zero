import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  addCapture,
  addTask,
  apiFetch,
  completeTask,
  editCapture,
  fetchCaptures,
  fetchTasks,
  processCapture,
  rescheduleCapture,
  type Capture,
  type Task,
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

describe('fetchCaptures', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /api/captures and returns the captures', async () => {
    const captures: Capture[] = [
      {
        id: '1',
        text: 'buy milk',
        createdAt: '2023-01-01T00:00:00.000Z',
        processedAt: null,
        showUpDate: null,
      },
    ];
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ captures }), { status: 200 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await fetchCaptures(getToken, 'https://example.test');

    expect(result).toEqual(captures);
  });
});

describe('addCapture', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs the id and text and returns the created capture', async () => {
    const capture: Capture = {
      id: 'cid-1',
      text: 'call mom',
      createdAt: '2023-01-01T00:00:00.000Z',
      processedAt: null,
      showUpDate: null,
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ capture }), { status: 201 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await addCapture(
      getToken,
      { id: 'cid-1', text: 'call mom' },
      'https://example.test',
    );

    expect(result).toEqual(capture);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/captures');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      id: 'cid-1',
      text: 'call mom',
    });
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
      showUpDate: null,
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

describe('editCapture', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('PATCHes /api/captures/{id} with the text and Bearer token', async () => {
    const capture: Capture = {
      id: 'abc',
      text: 'buy oat milk',
      createdAt: '2023-01-01T00:00:00.000Z',
      processedAt: null,
      showUpDate: null,
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ capture }), { status: 200 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await editCapture(
      getToken,
      'abc',
      'buy oat milk',
      'https://example.test',
    );

    expect(result).toEqual(capture);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/captures/abc');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'buy oat milk' });
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });
});

describe('rescheduleCapture', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('PATCHes /api/captures/{id} with the showUpDate and Bearer token', async () => {
    const capture: Capture = {
      id: 'abc',
      text: 'buy milk',
      createdAt: '2023-01-01T00:00:00.000Z',
      processedAt: null,
      showUpDate: '2099-01-01',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ capture }), { status: 200 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await rescheduleCapture(
      getToken,
      'abc',
      '2099-01-01',
      'https://example.test',
    );

    expect(result).toEqual(capture);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/captures/abc');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ showUpDate: '2099-01-01' });
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });
});

const task = (id: string, text: string): Task => ({
  id,
  text,
  createdAt: '2023-01-01T00:00:00.000Z',
  showUpDate: '2023-01-01',
  completedAt: null,
});

describe('fetchTasks', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /api/tasks and returns the open tasks', async () => {
    const tasks: Task[] = [task('1', 'ship it')];
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ tasks }), { status: 200 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await fetchTasks(getToken, 'https://example.test');

    expect(result).toEqual(tasks);
  });
});

describe('addTask', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs id, text and showUpDate and returns the created task', async () => {
    const created = task('tid-1', 'call plumber');
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ task: created }), { status: 201 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await addTask(
      getToken,
      { id: 'tid-1', text: 'call plumber', showUpDate: '2023-01-01' },
      'https://example.test',
    );

    expect(result).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/tasks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      id: 'tid-1',
      text: 'call plumber',
      showUpDate: '2023-01-01',
    });
  });
});

describe('completeTask', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs to /api/tasks/{id}/complete with the Bearer token', async () => {
    const completed: Task = {
      ...task('abc', 'ship it'),
      completedAt: '2023-01-02T00:00:00.000Z',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ task: completed }), { status: 200 }),
      );
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await completeTask(getToken, 'abc', 'https://example.test');

    expect(result).toEqual(completed);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/tasks/abc/complete');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
  });
});
