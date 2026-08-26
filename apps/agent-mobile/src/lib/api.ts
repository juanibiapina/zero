import { API_BASE_URL } from './env';

// Returns the current Clerk session JWT (or null when signed out). Matches the
// shape of `getToken` from `@clerk/expo`'s `useAuth()`.
export type TokenGetter = () => Promise<string | null>;

// Authenticated fetch against the worker API. Prefixes the base URL and attaches
// the Clerk session token as a Bearer header, which `clerkMiddleware` on the
// worker reads to authenticate the request.
export async function apiFetch(
  getToken: TokenGetter,
  path: string,
  init: RequestInit = {},
  baseUrl: string = API_BASE_URL,
): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

export type UserSettings = {
  onboardingSeen: boolean;
  googleOnboardingStatus: string | null;
  createdAt: string | null;
  timezone: string | null;
};

export async function fetchUserSettings(
  getToken: TokenGetter,
): Promise<UserSettings> {
  const res = await apiFetch(getToken, '/api/user-settings');
  if (!res.ok) {
    throw new Error(`GET /api/user-settings failed: ${res.status}`);
  }
  return (await res.json()) as UserSettings;
}

export type Todo = {
  id: string;
  text: string;
  createdAt: string;
};

// The caller's open todo list, oldest first.
export async function fetchTodos(
  getToken: TokenGetter,
  baseUrl: string = API_BASE_URL,
): Promise<Todo[]> {
  const res = await apiFetch(getToken, '/api/todos', {}, baseUrl);
  if (!res.ok) {
    throw new Error(`GET /api/todos failed: ${res.status}`);
  }
  const body = (await res.json()) as { todos: Todo[] };
  return body.todos;
}

// Capture a new todo; returns the created row (with its server id).
export async function addTodo(
  getToken: TokenGetter,
  text: string,
  baseUrl: string = API_BASE_URL,
): Promise<Todo> {
  const res = await apiFetch(
    getToken,
    '/api/todos',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`POST /api/todos failed: ${res.status}`);
  }
  const body = (await res.json()) as { todo: Todo };
  return body.todo;
}
