import type { Capture } from '@zero/agent-core';

import { API_BASE_URL } from './env';

// The Capture entity type is shared across web + mobile.
export type { Capture };

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

export async function fetchInbox(
  getToken: TokenGetter,
  baseUrl: string = API_BASE_URL,
): Promise<Capture[]> {
  const res = await apiFetch(getToken, '/api/captures', {}, baseUrl);
  if (!res.ok) {
    throw new Error(`GET /api/captures failed: ${res.status}`);
  }
  const body = (await res.json()) as { captures: Capture[] };
  return body.captures;
}

export async function addCapture(
  getToken: TokenGetter,
  text: string,
  idempotencyKey: string,
  baseUrl: string = API_BASE_URL,
): Promise<Capture> {
  const res = await apiFetch(
    getToken,
    '/api/captures',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ text }),
    },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`POST /api/captures failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}

export async function processCapture(
  getToken: TokenGetter,
  id: string,
  baseUrl: string = API_BASE_URL,
): Promise<Capture> {
  const res = await apiFetch(
    getToken,
    `/api/captures/${id}/process`,
    { method: 'POST' },
    baseUrl,
  );
  if (!res.ok) {
    throw new Error(`POST /api/captures/${id}/process failed: ${res.status}`);
  }
  const body = (await res.json()) as { capture: Capture };
  return body.capture;
}
