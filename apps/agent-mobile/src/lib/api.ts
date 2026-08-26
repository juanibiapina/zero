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

export type Capture = {
  id: string;
  text: string;
  createdAt: string;
  // Null while in the Inbox; an ISO timestamp once Processed (GTD Clarify).
  processedAt: string | null;
};

// The caller's Inbox (open captures), oldest first.
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

// Capture a new item; returns the created row (with its server id).
export async function addCapture(
  getToken: TokenGetter,
  text: string,
  baseUrl: string = API_BASE_URL,
): Promise<Capture> {
  const res = await apiFetch(
    getToken,
    '/api/captures',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

// Process a capture (GTD Clarify); returns the updated row. The Inbox excludes
// it after.
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
