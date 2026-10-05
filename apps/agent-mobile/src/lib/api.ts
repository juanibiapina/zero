import type { ProjectSuggestionCandidate } from '@zero/agent-core';

import { API_BASE_URL } from './env';

// Returns the current Clerk session JWT (or null when signed out). Matches the
// shape of `getToken` from `@clerk/expo`'s `useAuth()`.
export type TokenGetter = () => Promise<string | null>;

// Cross-origin: attaches the Clerk session token as a Bearer header.
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

// Writes this device's timezone to the server, for the silent timezone sync.
export async function patchTimezone(
  getToken: TokenGetter,
  zone: string,
): Promise<void> {
  const res = await apiFetch(getToken, '/api/user-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timezone: zone }),
  });
  if (!res.ok) {
    throw new Error(`PATCH /api/user-settings failed: ${res.status}`);
  }
}

// Ask the server for emoji icon suggestions for a project's title/description.
// The caller caches the response on this device; no Project row is mutated.
export async function fetchIconSuggestions(
  getToken: TokenGetter,
  input: { title: string; description?: string | null },
  baseUrl: string = API_BASE_URL,
): Promise<string[]> {
  const res = await apiFetch(
    getToken,
    '/api/projects/icon-suggestions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(
      `POST /api/projects/icon-suggestions failed: ${res.status}`,
    );
  }
  const body = (await res.json()) as { icons: string[] };
  return body.icons;
}

// Ask the server which Project a Task being typed belongs to. Any failure is a
// soft miss, so quick add keeps working without a suggestion.
export async function fetchProjectSuggestion(
  getToken: TokenGetter,
  input: { title: string; projects: ProjectSuggestionCandidate[] },
  signal: AbortSignal,
  baseUrl: string = API_BASE_URL,
): Promise<string | null> {
  const res = await apiFetch(
    getToken,
    '/api/tasks/project-suggestion',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    },
    baseUrl,
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { projectId: string | null };
  return body.projectId;
}
