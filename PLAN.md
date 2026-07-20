# Plan: Mobile sign-in (first step toward web parity)

## Goal

Give the Expo app (`apps/mobile`) a working Clerk sign-in so a user can
authenticate with the **same account** they use on the web app, and so mobile
can make authenticated `/api/*` calls to the worker. This is the foundation
every other parity feature (Telegram link, Google connect, settings) builds on.

## Current state

- `apps/mobile` is a bare Expo SDK 57 / expo-router app. `src/app/index.tsx`
  renders a static "Zero Agent" screen; `_layout.tsx` is a headerless `Stack`.
  No auth, no API client, no env wiring.
- The web app (`apps/web`) authenticates with Clerk (`@clerk/react`):
  `ClerkProvider` wraps the app, `useAuth()` gates routes, and an
  unauthenticated user sees Clerk's drop-in `<SignIn/>`. Publishable key comes
  from `VITE_CLERK_PUBLISHABLE_KEY`.
- The worker (`apps/api/src/app.ts`) protects `/api/*` with `clerkMiddleware()`
  + a guard that reads `getAuth(c).userId`. `clerkMiddleware` accepts a Clerk
  session JWT via the `Authorization: Bearer <token>` header, so no backend auth
  change is needed for mobile. CORS is set to `origin: ["http://localhost:5176"]`
  with `credentials: true`; native fetch does not enforce CORS and uses a Bearer
  token (not cookies), so this does not block mobile.
- API is served at `https://zero.juanibiapina.dev` (worker route in
  `wrangler.jsonc`); the web dev proxy targets `localhost:8790`. Mobile must call
  an **absolute** base URL.

## What to change and why

### 1. Add Clerk Expo + secure token storage

Add dependencies to `apps/mobile` (Clerk's official Expo install set):
- `@clerk/clerk-expo` — Clerk SDK for React Native. Accounts match web because
  both point at the **same Clerk instance via the publishable key**, not because
  the SDK versions match. Note the skew: web uses `@clerk/react` v6, while
  `@clerk/clerk-expo` v2 bundles `@clerk/clerk-react` v5 internally. This is
  fine — the publishable key format is stable across versions.
- `expo-secure-store` — backs Clerk's token cache so the session survives app
  restarts.
- `expo-auth-session` — **required** (non-optional) peer of `@clerk/clerk-expo`;
  the SSO/OAuth flow needs it for `makeRedirectUri`. Absent today, so this is the
  one missing dep that would break the build.
- `expo-crypto` — recommended peer; powers OAuth PKCE. Included in Clerk's
  documented install command.

Install with `npx expo install` so versions are pinned to SDK 57.

Use Clerk's **shipped** token cache — import it from
`@clerk/clerk-expo/token-cache` (or the `@clerk/clerk-expo/secure-store` export)
rather than hand-rolling a get/save wrapper. Less code, fewer bugs, tracks
Clerk's updates.

Clerk Expo does **not** ship a drop-in `<SignIn/>` component like web; sign-in UI
is built from hooks. Use the current `useSSO` hook (not the deprecated
`useOAuth`). See decision below.

**New Architecture:** RN 0.86 (SDK 57) defaults to the New Architecture;
`@clerk/clerk-expo` v2 supports it, so no extra config is needed.

### 2. Provide the publishable key to the app

Use `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (Expo inlines `EXPO_PUBLIC_*` at build
time, the RN analog of `VITE_*`). Read it in the provider and throw a clear error
if missing, mirroring `App.tsx`. Document it in `apps/mobile/README.md` and add it
to the `env` block of each `eas.json` build profile so preview/dev-client builds
get it. Clerk **publishable** keys are public by design (`pk_...`, already shipped
in the web bundle), so commit it in `eas.json` — do **not** use EAS Secrets, which
are for real secrets. It is the same publishable key value the web app uses.

### 3. Wrap the app in `ClerkProvider` with a token cache

In `src/app/_layout.tsx`, wrap the `Stack` in `<ClerkProvider>` configured with:
- `publishableKey` from the env var,
- `tokenCache` imported from `@clerk/clerk-expo/token-cache` (Clerk's shipped,
  secure-store-backed cache — do not hand-roll it).

### 4. Auth-gated routing

Split routes so signed-out users only see the sign-in screen and signed-in users
see the home screen. Use `useAuth()`'s `isLoaded` / `isSignedIn` from
`@clerk/clerk-expo`, mirroring the web `AuthGate`:
- While `!isLoaded`: a loading state.
- `!isSignedIn`: sign-in screen.
- `isSignedIn`: the existing home screen (keep the "Zero Agent" placeholder for
  now — parity features land later).

With expo-router, express this as a redirect in a layout (e.g. a `(signed-in)`
group guarded by an auth check, plus a `sign-in` route), or a conditional render
in `_layout.tsx`. Prefer the router-group approach so later screens slot in
cleanly.

### 5. Sign-in screen

**Decision to confirm before building:** which Clerk strategy the web Clerk
instance has enabled. Two viable paths:

- **Google OAuth via `useSSO`** (recommended default). Google OAuth is
  **confirmed enabled** on the Clerk instance — the web onboarding uses
  `strategy: "oauth_google"` and reads `externalAccounts` with provider
  `"google"`. The product is Google-centric (users connect Google Workspace
  anyway), and OAuth avoids building email/password/verification UI. Uses
  `expo-web-browser` + `expo-auth-session` (see deps) to complete the handshake
  via the app `scheme` (`zeroagent`, already in `app.json`). `useSSO` +
  `expo-auth-session`'s `makeRedirectUri` largely handle the native callback;
  verify against current Clerk docs whether `zeroagent://` must also be added as
  an allowed redirect in the Clerk dashboard before treating it as a hard
  prerequisite.
- **Email + password / email code** via `useSignIn`. More screens (identifier,
  password or OTP, error states) but no OAuth provider config.

Pick one strategy for this first step to keep scope minimal; the other can be
added later. Recommend Google OAuth (confirmed enabled). On success Clerk sets
the active session and the auth gate flips to the home screen.

### 6. Authenticated API client

Add a small `src/lib/api.ts`:
- Base URL from `EXPO_PUBLIC_API_URL` (default `https://zero.juanibiapina.dev`),
  so dev builds can point at a tunnel/staging.
- A `fetch` wrapper that calls `getToken()` from `useAuth()` (via a hook or
  passed-in getter) and sets `Authorization: Bearer <token>`.

Prove the token end-to-end by calling `GET /api/user-settings` (already
Clerk-authed, returns onboarding/timezone) after sign-in and logging/showing the
result. This validates the whole chain without building parity UI yet. No backend
change required.

## System-wide impact

- **Backend:** none. `clerkMiddleware` already accepts Bearer tokens. If a future
  check needs the mobile app's origin, revisit CORS — not now.
- **Clerk dashboard:** add the `zeroagent://` redirect/allowed origin if using
  OAuth SSO. One-time, document it.
- **EAS:** new env var(s) must reach builds via each profile's `env` block.
  Native rebuild required because the new deps add native modules
  (`expo-secure-store`, `expo-auth-session`, `expo-crypto`) — per the README,
  JS-only changes hot-reload but adding native modules needs a new
  dev-client/preview build. Batch all of them into one rebuild.

## Test strategy

- Follow the existing Jest + `@testing-library/react-native` setup (`jest-expo`
  preset, `test: "jest --passWithNoTests"`).
- Unit-test the auth gate's render branches (loading / signed-out / signed-in) by
  mocking `@clerk/clerk-expo`'s `useAuth`.
- Unit-test the API client attaches the Bearer header from a mocked `getToken`
  and prefixes the base URL.
- OAuth/browser handshake is hard to unit-test; cover it with a manual check on a
  device via a dev-client build.
- Keep the app in the root Turbo `lint`/`typecheck`/`test` pipeline.

## Documentation

- Update `apps/mobile/README.md`: the new env vars
  (`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_API_URL`), the Clerk
  dashboard redirect setup, and that sign-in is now the entry screen.
- Add a `CHANGELOG.md` entry (root) per repo policy — user-visible: "You can now
  sign in to the Zero Agent mobile app with your Zero account." Include it in the
  same change.

## Skills to use

- `code` — implementing the screens, provider, and API client.
- `testing` — deciding what to mock (Clerk hooks, fetch) and designing the client
  for testability.
- `changelog` — writing the user-facing `CHANGELOG.md` entry.
- `git-commit` — committing.

## Acceptance criteria

- Launching the app while signed out shows a sign-in screen; completing sign-in
  shows the home screen.
- The session persists across app restarts (secure-store token cache).
- The signed-in app makes a successful authenticated `GET /api/user-settings`
  against production, proving Bearer-token auth works.
- The same Clerk account works on both web and mobile.
- `lint`, `typecheck`, `test` pass via Turbo; `CHANGELOG.md` updated.

## Risks / open questions

- ~~**Which Clerk strategy is enabled**~~ — resolved: Google OAuth
  (`oauth_google`) is enabled, confirmed by the web onboarding code.
- **EAS quota:** the new native modules force a native rebuild (free tier is
  30 builds/month); batch native changes into one build.
- **Dev testing:** if the Clerk dashboard requires the `zeroagent://` redirect,
  sign-in fails only at the redirect step (works in unit tests, fails on device).
  Verify the current native-SSO redirect requirement in Clerk docs first.
