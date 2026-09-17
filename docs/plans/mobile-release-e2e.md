# Plan: Mobile release E2E suite (hermetic, mocked auth, local worker)

> Superseded for local Pixel execution by
> `docs/plans/todo-mobile-metro-e2e.md`. The Pixel now keeps its development
> client and loads hermetic JavaScript from Metro. This plan's fake-auth and
> local-Worker rationale still applies to the optional emulator adapter.

Status: implemented. Owner: mobile. Scope: `apps/agent-mobile`, `apps/agent-api`
(test config only), `docs/`, `.github/workflows/`.

## Goal

A separate tier of end-to-end UI tests that verify the important mobile flows
before a release. They may be slow and heavy, so they run on demand, never in
the per-push/PR dev pipeline. Primary runner is the **Pixel 7 attached to
`mini`**; CI runs the same flows on an Android emulator. Tests must not touch
production data and must not require a second Google account.

## Decision (top down)

Ship an **E2E variant of the app** whose auth layer is faked (no Google, no
Clerk network) and whose API points at a **local worker** that trusts the fake
token and stores in a throwaway local Durable Object. The stack is fully
hermetic: no production data (local DO wiped per run), no Google account (auth
mocked), deterministic. Because auth is mocked, the important **signed-in** flows
run in CI on the emulator, not just on the device.

This supersedes an earlier idea (route the real account to a `:e2e` DO suffix in
the production worker). That was dropped: it shipped test code to the production
worker and left CI stuck at a signed-out smoke.

### Why this shape

- CI gains the real flows: mocking auth removes the Google-OAuth wall, so the
  emulator reaches signed-in screens (capture, task, offline sync).
- No test code in the deployed worker: the auth bypass lives only in the test
  wrangler config (`ENVIRONMENT=test`), never in production.
- No production data by construction: the DO is a local miniflare store cleared
  per run, not a suffix of the real user's DO.
- Reuses the repo's existing local-worker test pattern (`packages/agent-e2e`
  mocks Telegram/OpenAI via `wrangler.test.jsonc`); this extends it to `/api/*`.

### What it does not cover, and how that is covered

The suite does not exercise the real Clerk/Google OAuth round-trip or the real
Cloudflare edge/DO. Keep the existing signed-out smoke flows
(`.maestro/ci/sign-in.yaml`, `.maestro/ci/probe.yaml`) against the true Clerk
instance as a thin real-auth check, plus an occasional manual real-account pass
on the device. Auth round-trip is a narrow, stable surface; it does not need the
full flow matrix.

## Architecture of the test stack

### App: fake-auth build variant

The app has **no auth seam today**: `@clerk/expo` and `@clerk/expo/native` are
imported directly in four files:

- `src/app/_layout.tsx` — `ClerkProvider`, `tokenCache`.
- `src/app/sign-in.tsx` — `useAuth`, `useSSO`.
- `src/app/(signed-in)/_layout.tsx` — `useAuth` gate (`isLoaded`, `isSignedIn`).
- `src/app/(signed-in)/index.tsx` — `useAuth` (`getToken`) and `UserButton`
  from `@clerk/expo/native`.

Introduce the fake with a **Metro resolver alias gated by
`EXPO_PUBLIC_E2E_FAKE_AUTH=1`** (in `metro.config.js`), swapping both
`@clerk/expo` and `@clerk/expo/native` to an in-repo fake module. Do **not**
rewrite the screen imports. The fake surface must supply exactly what the four
files use:

- `ClerkProvider` — pass-through provider (renders children).
- `useAuth()` — `{ isLoaded: true, isSignedIn: true, getToken: async () =>
  'e2e-test-user', signOut: async () => {} }`.
- `useSSO()` — stub (unused once signed in; keep it non-crashing).
- `tokenCache` — no-op object.
- `@clerk/expo/native` `UserButton` — a plain stub view.

Rationale for the alias over a `@/lib/auth` wrapper: zero source churn in the
screens, and the jest suite already `jest.mock('@clerk/expo', ...)`, proving the
fake shape is small and known.

The E2E build also sets `EXPO_PUBLIC_API_URL` to the local worker
(`http://10.0.2.2:8787` for the emulator; `http://localhost:8787` for the device
over `adb reverse`) via its own `eas.json` profile / env, and keeps
`EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` set (the root layout throws without it even
though the fake never uses it — cheaper to keep it than to special-case the
throw).

Native note: `app.json` keeps the Clerk config plugin, so the native module is
still linked into the APK; the aliased JS never calls it, so it is inert. No
`app.json` change.

### Worker: gated auth bypass in the test config

`app.ts` guards `/api/*` with `clerkMiddleware()` and reads `CLERK_SECRET_KEY`;
`wrangler.test.jsonc` sets no Clerk keys, so the middleware cannot verify. Add a
narrow branch in the `/api/*` guard: when `env.ENVIRONMENT === 'test'` (already
set in `wrangler.test.jsonc`), skip `clerkMiddleware` and set
`userId = <bearer>` directly (the fake sends `Authorization: Bearer
e2e-test-user`). Production config never sets `ENVIRONMENT=test`, so the branch
is inert in prod. Cover with a worker unit test: with `ENVIRONMENT=test` a bearer
sets `userId`; without it the real guard runs and a missing/invalid token 401s.

Local data: `wrangler dev` runs local by default (miniflare), so KV/R2/DO are
local simulators and the real resource IDs in `wrangler.test.jsonc` are never
hit. Persist DO/SQLite to a temp dir via `--persist-to` and delete it per run for
a clean slate. The test config's migration list lags production (only `UserDO` +
`TelegramAccountDO`, no `ScheduleDO`/`LearningDO`); tasks and captures live in
`UserDO`, so the flows work, but validate this in the phase-0 spike.

### Running the local worker on `mini`

`workerd` will not start on the NixOS box directly, but **containers are already
enabled**: `virtualisation.oci-containers.backend = "podman"` (Home Assistant),
rootless podman verified working for `juan` (`Rootless: true`, overlay,
subuid/subgid mapped, `hello-world` ran), and `npx workerd@latest --version`
printed `workerd 2026-08-30` inside `node:22-slim`. **No `dotfiles` change is
required** to run the worker in a container.

Device path: `podman run` a node image serving `pnpm wrangler dev --config
wrangler.test.jsonc --persist-to <tmp> --port 8787`, publish the port
(`-p 8787:8787`), then `adb reverse tcp:8787 tcp:8787` so the Pixel's localhost
reaches mini's host port. `adb` is already set up in
`nix/hosts/mini/modules/android.nix`.

CI path: run `pnpm wrangler dev` on the ubuntu runner (workerd runs natively
there); the emulator reaches it at `10.0.2.2:8787`.

## Test tiers and flow layout

Split the Maestro flows by capability so a run selects a folder:

- `.maestro/ci/` — signed-out, `clearState: true`. Existing `sign-in.yaml`
  (boot/init smoke against real Clerk) and `probe.yaml` (OAuth redirect
  handling). Runs on emulator and device.
- `.maestro/release/` — the hermetic signed-in suite (fake auth, local worker).
  `launchApp` without `clearState`. Runs on emulator (CI) and Pixel 7 (mini).

The two never mix in one run: a `clearState` flow would reset state mid-suite.

### Release flows (`.maestro/release/`)

Each starts from a wiped local DO (harness clears `--persist-to` before the
run) and ends with `takeScreenshot`:

1. **Capture to Inbox** — quick-add a capture, assert it in the Inbox, process
   it, assert it leaves the open list.
2. **Task to Today** — add a task for today, assert it shows, complete it,
   assert it clears. (Moves today's `today.yaml` here; drop its self-cleanup
   note, the DO wipe handles cleanup.)
3. **Offline capture then sync** — disable connectivity, add a capture, assert
   it shows locally (optimistic), restore connectivity, relaunch, assert it
   persisted (exercises the op-sqlite outbox). Heaviest and most timing-
   sensitive; use generous `extendedWaitUntil` and a single retry.
4. **Cross-tab consistency** — add a task and a capture, switch tabs, assert
   each shows in the right list and not the other.

## Harness and scripts

- `apps/agent-mobile/.maestro/run-release.sh` (device, on `mini`): start the
  worker container with a fresh `--persist-to` temp dir, publish 8787,
  `adb reverse tcp:8787 tcp:8787`, wait for the device, `maestro test
  apps/agent-mobile/.maestro/release`, capture screenshot + `ui.xml` on exit,
  tear down the container. Mirrors the capture/retry shape of `run-e2e.sh`.
- CI: point the existing manual `mobile-e2e.yml` at `.maestro/ci/` for the
  signed-out smoke, and add a second manual workflow (or a job) that boots the
  worker, the emulator, installs the fake-auth APK, and runs `.maestro/release/`.
  Neither is wired into push/PR.
- Build the E2E APK: add an `e2e` profile to `eas.json` mirroring `preview` plus
  `env: { EXPO_PUBLIC_E2E_FAKE_AUTH: "1", EXPO_PUBLIC_API_URL: "..." }`. Build
  locally on `mini` in the Nix Android shell (documented `eas build --local`
  path) to spare EAS quota, then `adb install -r`. CI builds it the same way the
  current APK job does, with the extra env.

## Implementation phases

0. **Spike (de-risk):** in a container on `mini`, run `pnpm wrangler dev --config
   wrangler.test.jsonc --persist-to <tmp>`, add the `ENVIRONMENT=test` bypass,
   `curl` `/api/tasks` with `Authorization: Bearer e2e-test-user`, confirm a
   task round-trips and lands in the local DO. Then hit it from the Pixel over
   `adb reverse`. Confirms the whole spine before building UI flows.
1. Worker: add the gated `ENVIRONMENT=test` auth bypass + unit tests.
2. App: fake auth module + Metro alias gated by `EXPO_PUBLIC_E2E_FAKE_AUTH`;
   `e2e` `eas.json` profile.
3. Flows: split folders; write the four `.maestro/release/` flows.
4. Harness: `run-release.sh`; repoint `mobile-e2e.yml` to `.maestro/ci/`; add the
   release CI workflow/job.
5. Docs.

## Test strategy

- **Worker unit tests** (fast, in the normal pipeline): the `ENVIRONMENT=test`
  bypass sets `userId` from the bearer; without it the real guard runs and a bad
  token 401s.
- **App jest**: a small test that the fake auth module reports signed-in and
  yields the static token (guards against fake drift vs the real surface).
- **Maestro release flows**: the four above, device + emulator, manual only.
- **Maestro CI flows**: unchanged smoke + probe against real Clerk.
- The release suite is excluded from `turbo run test` and every push/PR path.

## Documentation and changelog

- `apps/agent-mobile/README.md`: new "Release E2E suite" section (folder split,
  fake-auth build, local worker in a podman container + `adb reverse`,
  `run-release.sh`, why there is no second account).
- `docs/e2e-tests.md`: cross-link this tier and the shared local-worker pattern.
- Note the `ENVIRONMENT=test` `/api/*` bypass near the auth description in the
  worker docs.
- **Changelog:** test/infra only, no user-visible change, so per `AGENTS.md` no
  entry. Keep the fake-auth path build-gated so it never reaches users.

## Skills to use

- `tdd` — worker bypass + fake-auth module tests before the code.
- `expo-overview` then `expo-router` — the fake module and Metro alias wiring.
- `reproducible-locally` — the phase-0 spike proves the spine before UI work.
- `documentation` — README + docs edits.
- `git-commit` — when committing.

## Acceptance criteria

- `bash apps/agent-mobile/.maestro/run-release.sh` on `mini` drives the Pixel 7
  through all four release flows and passes, starting from a wiped local DO.
- The same flows pass on the CI emulator against a runner-local worker.
- No Google account and no real Clerk session are used by the release suite;
  auth is the fake module.
- The tester's production task/capture lists are unchanged after a run (nothing
  leaves the local worker).
- The manual `mobile-e2e.yml` emulator run stays green against `.maestro/ci/`.
- Worker unit tests cover the `ENVIRONMENT=test` bypass; the release suite is
  absent from all push/PR CI.

## Risks and mitigations

- **Fake-auth surface drift** vs the real Clerk API — keep the fake tiny (only
  the members the four files use) and unit-test it; a build error surfaces a
  missing member immediately.
- **Test bypass in the worker** — gated on `ENVIRONMENT=test`, absent from prod
  config, unit-tested inert without the flag.
- **Offline→sync flakiness** — generous `extendedWaitUntil`, single retry, and
  assert after a relaunch rather than racing the flush.
- **Container worker slowness** (pnpm install per run) — mount the repo and pnpm
  store, or bake a prebuilt image; keep the worker container warm across a run.
- **Test-config migration lag** (no `ScheduleDO`/`LearningDO`) — validate the
  task/capture path under `wrangler.test.jsonc` in phase 0.
- **`workerd` in the container** — de-risked: the binary runs in `node:22-slim`;
  phase 0 still proves a full `wrangler dev` serving `/api/*`, not just the bare
  binary.

## Verification findings folded in (adversarial review)

- Auth is imported directly in four files with no seam; fake must be a Metro
  alias, not a source rewrite. (Confirmed by reading the four files.)
- `clerkMiddleware` needs `CLERK_SECRET_KEY` the test config lacks, so the
  bypass must branch before it. (Confirmed in `app.ts` / `clerk.ts`.)
- Offline outbox is real (`@tanstack/offline-transactions` + op-sqlite), so the
  sync flow is meaningful but timing-sensitive. (Confirmed in
  `tasks-collection.ts`.)
- Containers already enabled on `mini` (rootless podman), and `workerd` runs in
  a container; no `dotfiles` change needed. (Verified live.)
