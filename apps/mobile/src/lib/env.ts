// Expo inlines `EXPO_PUBLIC_*` env vars at build time (the RN analog of Vite's
// `VITE_*`). Clerk publishable keys are public by design, so this ships in the
// bundle just like on web.
export const CLERK_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

// Absolute base URL for the worker API. Native fetch needs an absolute URL (no
// dev proxy). Override per build to point at a tunnel/staging.
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'https://zero.juanibiapina.dev';
