import { API_BASE_URL } from './env';

// Returns the current Clerk session JWT (or null when signed out). Matches the
// shape of `getToken` from `@clerk/clerk-expo`'s `useAuth()`.
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
