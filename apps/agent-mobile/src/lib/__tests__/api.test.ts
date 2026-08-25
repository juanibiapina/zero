import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { addTodo, apiFetch, fetchTodos, type Todo } from '../api';

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

describe('fetchTodos', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GETs /api/todos and returns the list', async () => {
    const todos: Todo[] = [
      { id: '1', text: 'buy milk', createdAt: '2023-01-01T00:00:00.000Z' },
    ];
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ todos }), { status: 200 }));
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await fetchTodos(getToken, 'https://example.test');

    expect(result).toEqual(todos);
  });
});

describe('addTodo', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSTs the text and returns the created todo', async () => {
    const todo: Todo = {
      id: '1',
      text: 'call mom',
      createdAt: '2023-01-01T00:00:00.000Z',
    };
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ todo }), { status: 201 }));
    const getToken = jest.fn<TokenGetter>().mockResolvedValue('tok');

    const result = await addTodo(getToken, 'call mom', 'https://example.test');

    expect(result).toEqual(todo);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/api/todos');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'call mom' });
  });
});
