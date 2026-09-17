import { RUNTIME_PROFILE } from './runtime-profile';

// Expo inlines `EXPO_PUBLIC_*` env vars at build time (the RN analog of Vite's
// `VITE_*`). Clerk publishable keys are public by design, so this ships in the
// bundle just like on web.
export const CLERK_PUBLISHABLE_KEY =
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

// Native fetch needs an absolute URL. The runtime profile preserves the normal
// override and fixes hermetic E2E traffic to the USB-reversed local worker.
export const API_BASE_URL = RUNTIME_PROFILE.apiBaseUrl;
