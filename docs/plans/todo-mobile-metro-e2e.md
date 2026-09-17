# Todo mobile: hermetic Metro E2E on the Pixel 7

Status: implemented 2026-09-17.

## Bottom line

Make one local command the default behavioral proof for mobile changes:

```bash
pnpm --filter @zero/agent-mobile e2e:pixel
```

The command will set one toggle, `EXPO_PUBLIC_HERMETIC_E2E=1`, then load the current JavaScript from Metro into the existing Pixel 7 development client. That toggle selects fake Clerk auth, the fixed localhost Worker URL, isolated local storage, disabled launcher synchronization, and E2E-native configuration together. It will not install another APK, use the real Clerk account, call production, or open the production SQLite/outbox files. Starting Metro without the toggle restores the real Clerk session, production URL, and production storage.

Start with one current flow: add a loose Task from Home, observe it in the list, restart the app, observe it again, and confirm through the local Worker's HTTP interface that the Task persisted. Add broader coverage later as product flows are reviewed.

A successful run prints one short PASS summary. A failure prints the failed stage and artifact directory, with complete Metro, Worker, Maestro, logcat, screenshot, and UI-hierarchy evidence retained outside the model context.

## Goal

Replace routine manual Pixel walkthroughs with repeatable behavioral evidence while preserving real-device coverage.

When this increment is complete:

- pure JavaScript mobile behavior can be verified from the current checkout through Metro;
- the attached Pixel 7 remains a development-client-only device;
- test writes use a local fake user and a fresh local Durable Object, never the user's production account or production data;
- one environment toggle selects fake auth, localhost networking, isolated storage, and suppressed test-only side effects as one runtime profile;
- test mode has its own device-side collection database, offline outbox, and AsyncStorage keys;
- removing the toggle restores the production profile without deleting or replacing the real Clerk session;
- one command owns setup, execution, diagnostics, and cleanup;
- manual inspection is reserved for appearance, motion quality, accessibility judgment, or a native change that cannot yet be asserted automatically;
- future mobile work adds or updates a Maestro flow instead of repeating an undocumented walkthrough.

## Current state

The repository already contains most of the hard infrastructure, but its local interface is no longer usable for the current app.

### Reusable modules

- `apps/agent-mobile/metro.config.js` aliases Clerk modules to in-repo fakes when the current auth-only flag `EXPO_PUBLIC_E2E_FAKE_AUTH=1` is set.
- The fake returns the local identity `e2e-test-user`; no Google account is needed.
- `apps/agent-api/wrangler.e2e.jsonc` runs the real Task, Project, and Waiting HTTP routes against local Durable Objects.
- The Worker auth guard trusts the bearer only when `ENVIRONMENT=test`; unit tests prove the bypass is inert otherwise.
- `apps/agent-mobile/.maestro/run-release.sh` already starts that Worker in rootless Podman because native `workerd` cannot run on this NixOS host.
- `.github/workflows/mobile-release-e2e.yml` already runs the hermetic stack on an Android emulator by manual dispatch.
- The Pixel 7 is connected, Maestro 2.8.0 and Podman are installed, and the installed app is development-client build 83 with Android's `DEBUGGABLE` flag.

### Gaps to close

1. **The local hermetic harness requires a standalone E2E APK.** That conflicts with the current device rule: the Pixel must retain the development client and load unreleased JavaScript from Metro.
2. **The remaining hermetic flows are stale.** `.maestro/release/01-capture-inbox.yaml` and `03-offline-sync.yaml` still target the retired Capture entity and the removed Captures screen. The Task and cross-tab flows were deleted when the earlier Today tab was removed.
3. **Device persistence is not isolated by runtime mode.** `src/lib/db.ts` always opens `zero-app.sqlite` and `zero-app-outbox-v2.sqlite`. Pointing a fake-auth Metro bundle at the local Worker today could reconcile the user's cached production rows against an empty test server or replay a production outbox transaction to the test Worker.
4. **Two AsyncStorage callers also share production keys.** Timezone sync uses `zero.timezone.synced`; icon suggestions use `zero.icon-suggestions.v1`. Future Project flows must not mix test cache state into those keys.
5. **The dynamic Home launcher icon is a native side effect.** A test Task must not change the launcher's production task-count alias when the test process backgrounds.
6. **The Clerk fake has drifted.** Root layout now imports `@clerk/expo/resource-cache`, but Metro does not alias that module. The fake-auth mode should not import any real Clerk persistence adapter.
7. **Hermetic behavior is split across independent variables.** Fake auth and the local Worker URL can be enabled separately today, allowing unsafe combinations such as fake auth with the production URL or real auth with test storage.
8. **The harness is noisy and incomplete.** It does not start Metro, does not prove that production local files stayed closed, and streams Maestro progress on success.
9. **The written policy still describes emulator-only automation and production-backed Pixel writes.** It does not make the hermetic Metro command the default verification interface.

## Decision

### Use the existing fake local identity, not a second real account

Retain `e2e-test-user` as the test identity, but use it only against the local Worker. A dedicated Clerk account against production would still introduce OAuth, network, cleanup, and accidental cross-account risks. A local fake identity plus a throwaway local Durable Object removes those risks by construction.

The local Worker is the production HTTP/store implementation behind a test-only auth adapter and local Cloudflare adapters. Tests cross the same mobile and HTTP interfaces as the app; they do not mock screen internals.

### Make the Pixel development client the default runner

The local command starts a dedicated headless Metro instance and deep-links the installed development client to it over `adb reverse`. The Pixel never receives the E2E, preview, or production APK.

Use dedicated ports so the harness owns its processes without killing an unrelated development session:

- Metro: host/device `8082`;
- local Worker: host/device `8787`.

The harness must fail before testing if the installed package is absent or not debuggable. That check prevents a standalone APK from silently ignoring Metro.

### Use one toggle for the complete runtime profile

Replace the narrow `EXPO_PUBLIC_E2E_FAKE_AUTH` flag with `EXPO_PUBLIC_HERMETIC_E2E`. One runtime-profile module accepts that value and returns every safety-sensitive choice:

- real or fake Clerk modules and token;
- production or fixed `http://localhost:8787` Worker origin;
- production or E2E SQLite/outbox names;
- production or E2E AsyncStorage keys;
- enabled or disabled launcher-count synchronization;
- enabled or disabled EAS Update and Android cleartext configuration for native E2E builds;
- optional visible/test-accessible mode identity for diagnostics.

The profile is fail-closed. Hermetic mode ignores the ordinary `EXPO_PUBLIC_API_URL` override and always uses localhost; startup fails if configuration attempts to pair hermetic mode with a remote origin. Normal mode keeps the current real Clerk modules, production storage names, launcher behavior, and `EXPO_PUBLIC_API_URL` override/default. There is no supported mixed profile.

`metro.config.js`, `app.config.js`, and application code must consume the same pure profile resolver. Build tooling can call it from CommonJS; TypeScript receives a typed declaration or wrapper. Expo still sees a direct static read of `process.env.EXPO_PUBLIC_HERMETIC_E2E`, so the value is inlined correctly. Switching profiles requires restarting Metro because module aliases are selected at Metro startup; hot reload alone is insufficient.

### Isolate every app-owned persistent side effect

Create one runtime-configuration module whose interface exposes the persistence names and native-side-effect policy for normal and hermetic modes. Production values remain byte-for-byte compatible:

| State | Production | Hermetic E2E |
|---|---|---|
| collection database | `zero-app.sqlite` | `zero-app-e2e.sqlite` |
| offline outbox | `zero-app-outbox-v2.sqlite` | `zero-app-e2e-outbox-v2.sqlite` |
| timezone key | `zero.timezone.synced` | `zero.e2e.timezone.synced` |
| icon-suggestion key | `zero.icon-suggestions.v1` | `zero.e2e.icon-suggestions.v1` |
| launcher-count sync | enabled | disabled |

Derive these values from the unified runtime profile selected by `EXPO_PUBLIC_HERMETIC_E2E=1`. Keep the mode decision in one module so `db.ts`, timezone sync, icon suggestions, `HomeAppIconSync`, HTTP configuration, Metro aliases, and native app configuration do not each reinterpret the environment.

The harness force-stops the app before the run, removes only the E2E SQLite/outbox files with Android `run-as`, and uses a fresh Worker persistence directory. It must never run `pm clear`, uninstall the package, delete production SQLite files, clear SecureStore, or sign out the real Clerk session.

Alias `@clerk/expo/resource-cache` to a no-op fake alongside the existing Clerk aliases. The fake provider, token cache, resource cache, native user button, and hooks then have no path to real Clerk storage or network.

### Put orchestration behind one deep interface

Add `apps/agent-mobile/.maestro/run-metro-e2e.sh` and expose it as the `e2e:pixel` package script. Callers learn one command; the implementation owns:

1. Pixel/dev-client preflight;
2. dedicated port checks;
3. temporary directories and artifact paths;
4. the Podman Worker with fresh local persistence;
5. headless Metro with the hermetic environment;
6. Worker and Metro readiness probes;
7. `adb reverse` for ports 8082 and 8787;
8. E2E device-store cleanup;
9. dev-client launch with the encoded Metro URL;
10. one `maestro --no-ansi test` invocation over the hermetic flow folder;
11. an HTTP postcondition against the local Worker;
12. failure artifact capture;
13. process, container, reverse-port, test-store, and app cleanup.

Use traps so Ctrl-C and every failure path clean up. Give the Podman container and temporary paths per-run names rather than one global `zero-release-worker` name.

### Keep successful output small and failed output useful

Redirect Metro, Worker, Maestro, and logcat output to the run artifact directory. On success, print at most a short PASS line with flow count and elapsed time. Do not print installation, bundling, or per-step Maestro progress.

On failure, print:

- the failed stage;
- the artifact directory;
- the concise Maestro failure/JUnit summary;
- only the relevant tail of the failing process log.

Always retain full files for focused follow-up:

- `maestro.log` and JUnit XML;
- Maestro debug output;
- `metro.log`;
- `worker.log`;
- `logcat.txt`;
- final screenshot;
- compact Maestro hierarchy and `uiautomator` XML.

Support `E2E_VERBOSE=1` for a human diagnostic rerun without changing the quiet default.

## Technical approach

### 1. Establish the two complete runtime profiles

Add the shared profile resolver and replace the auth-only toggle. The normal profile must preserve every current production value. The hermetic profile must select fake auth, the fixed localhost origin, separate storage names, disabled launcher alias changes, disabled updates for native E2E builds, and cleartext permission only where localhost requires it.

Tests at this interface must prove:

- every production name and URL is unchanged;
- every E2E storage name differs from its production counterpart;
- normal mode selects real auth, the production/default URL, and Home icon sync;
- hermetic mode selects fake auth, exactly `http://localhost:8787`, and no Home icon sync;
- an ordinary API URL override cannot change hermetic mode's origin;
- unknown toggle values fail rather than silently selecting a mixed profile.

Use that profile in:

- `apps/agent-mobile/metro.config.js`;
- `apps/agent-mobile/app.config.js`;
- `apps/agent-mobile/src/lib/env.ts` and HTTP configuration;
- `apps/agent-mobile/src/lib/db.ts`;
- `apps/agent-mobile/src/lib/timezone-sync.ts`;
- `apps/agent-mobile/src/lib/icon-suggestions.ts`;
- `apps/agent-mobile/src/components/home-app-icon-sync.tsx` or its caller.

Do not add an account abstraction or a generic storage adapter. The mode varies; the existing SQLite and AsyncStorage adapters do not.

### 2. Complete fake-auth isolation

Extend `metro.config.js` with a fake for `@clerk/expo/resource-cache` and add the small fake module beside the existing token-cache fake. Select the complete alias table from the shared runtime profile; remove the old auth-only flag.

Keep screen imports unchanged. The Metro resolver remains an internal seam: the normal profile resolves real Clerk; the hermetic profile resolves every Clerk import to a fake.

Add a hermetic Android export check to verification. The existing fake-auth unit test proves values, but only a Metro export proves all current Clerk import paths and aliases bundle together.

### 3. Build the Metro/Worker/Maestro harness

Replace the Pixel behavior of `run-release.sh` with `run-metro-e2e.sh`; do not preserve a second standalone-APK path for the Pixel.

The harness sequence is:

1. Select the attached Pixel and verify `model:Pixel_7`, package presence, and `DEBUGGABLE`.
2. Refuse to start if dedicated ports 8082 or 8787 are occupied.
3. Force-stop the app.
4. Record the production collection/outbox filenames and checksums while the app is stopped.
5. Delete only `zero-app-e2e*.sqlite*` under the package's `databases/` directory.
6. Start `wrangler dev --config wrangler.e2e.jsonc` in the existing rootless Podman shape with a new temporary `--persist-to` directory.
7. Wait for unauthenticated `/api/tasks` to return 401, then require authenticated `GET /api/tasks` for `e2e-test-user` to return an empty list.
8. Start Expo headless from the mobile package with only `EXPO_PUBLIC_HERMETIC_E2E=1` as the profile selector, plus the public Clerk key required by root layout, port 8082, and a cleared Metro cache. The profile itself supplies `http://localhost:8787`; the harness must not set a second URL variable.
9. Wait for Metro's status endpoint.
10. Reverse 8082 and 8787, then open `zeroagent://expo-development-client/?url=http://localhost:8082` with the package-targeted Android intent.
11. Run one Maestro command over `apps/agent-mobile/.maestro/hermetic`.
12. Require authenticated `GET /api/tasks` to contain exactly the Task created by the flow.
13. Force-stop and relaunch the same test bundle once; the flow asserts the Task remains visible after restart.
14. Force-stop the app, compare production collection/outbox checksums, capture diagnostics, remove test files/reverse ports, and stop Metro/Podman.

The restart can live inside the Maestro flow; the HTTP assertion stays in the harness because it verifies through the Worker's public HTTP interface instead of trusting only the optimistic UI.

Phase 0 must verify that the installed debug development client accepts cleartext localhost traffic. If Android blocks it, apply the existing `with-cleartext` plugin to development builds as well as hermetic standalone builds, rebuild the `development-pixel` client once, and keep preview/production cleartext disabled. Do not introduce a tunnel merely to avoid this one debug manifest setting.

### 4. Replace stale flows with one current Task flow

Move the shared hermetic flow set to `apps/agent-mobile/.maestro/hermetic/` and delete the two Capture-era release flows.

Add `01-add-task.yaml`:

1. launch without `clearState`;
2. wait for Home;
3. open the Task add drawer;
4. enter deterministic text such as `E2E loose task`;
5. submit through the current accessibility interface;
6. assert the Task row appears;
7. stop and relaunch the app;
8. assert Home and the same Task row appear again.

The Worker and E2E device stores start empty, so a deterministic title is safe. The test does not clean up through product UI; harness teardown deletes the local Worker state and E2E device stores.

Do not add screenshot assertions. Maestro asserts behavior; screenshots are failure diagnostics or deliberate visual-review evidence.

### 5. Reuse the existing emulator path because it already exists

Point the manual `Mobile Release E2E` workflow and `run-release-emulator.sh` at the same `.maestro/hermetic` flow. Keep its hermetic standalone APK and local Worker because CI has no installed Pixel development client. Update the EAS profile and workflow to set only `EXPO_PUBLIC_HERMETIC_E2E=1`; remove their independent fake-auth and API-URL settings.

Do not add this workflow to push or pull-request gates. It remains manual and optional. Dispatch it once after implementation if the existing cached-build path makes the run practical; local Pixel success is the required acceptance proof.

Keep `.github/workflows/mobile-e2e.yml` and `.maestro/ci/` separate. They test signed-out Clerk initialization and redirect handling, not signed-in product behavior.

### 6. Make the new loop the repository policy

Update documentation without duplicating mechanisms:

- `apps/agent-mobile/README.md` owns the command, architecture, prerequisites, quiet/failure output, storage isolation, and optional emulator workflow.
- Root `AGENTS.md` states the policy: use `e2e:pixel` for behavioral device proof; add/update a hermetic flow for changed behavior; use manual inspection only for visual or otherwise non-assertable qualities; use a fresh dev-client build for native fingerprint changes.
- `docs/e2e-tests.md` links the mobile hermetic tier to the local Worker pattern.
- `docs/todo-app.md` records the shipped testing foundation and leaves the all-functionality coverage review as a later tracked increment.
- Existing historical plans remain historical. Mark `docs/plans/mobile-release-e2e.md` as superseded for local Pixel execution, while retaining its rationale for fake auth and the local Worker.

This is test infrastructure only. Add no mobile changelog entry.

## Future flow rule

For each later mobile behavior change:

1. keep pure derivation and screen-state coverage in Jest;
2. add or update a behavior-named Maestro flow when native rendering, persisted collections, gestures, routing, or real screen composition matter;
3. run the full hermetic folder through `e2e:pixel` before calling the change done;
4. inspect manually only when the acceptance criterion is visual, auditory, tactile, or not yet machine-assertable.

Do not build a fixture/reset HTTP interface for the first flow. One fresh Worker and one fresh E2E device store are sufficient. Add a reset/fixture seam only when a second independent flow proves that per-flow isolation is needed; then both the Pixel harness and emulator adapter must use the same interface.

A separate follow-up will inventory Home, Upcoming, Projects, project detail, scheduling, completion/Undo, offline replay, reordering, swipes, Waiting, After, recurrence, and navigation, then select a small behavior-oriented flow set. This increment creates the reliable runner and one proof, not that full inventory.

## Out of scope

- Full Maestro coverage of all current Todo functionality.
- Visual regression snapshots or screenshot diffing.
- Automating Google OAuth.
- Testing against production or a test suffix in the production Worker.
- Installing an E2E/preview/production APK on the Pixel.
- Running Android emulators on `mini`, which has no KVM.
- Adding the emulator workflow to every push or pull request.
- iOS coverage.
- Replacing Jest screen tests or package checks with Maestro.
- A generic fixture framework before multiple flows need it.

## Test strategy

### Fast checks

- Unit-test both runtime profiles for unchanged production values, fixed localhost E2E networking, disjoint E2E storage, correct Clerk selection, disabled E2E launcher sync, and rejection of unknown/mixed configuration.
- Extend fake-auth tests for the resource-cache fake.
- Run mobile Jest serially, lint, and typecheck with Metro and Gradle stopped.
- Run an Android Metro export in normal mode and another with the hermetic environment to prove both resolver paths bundle.
- Run `bash -n` on changed harnesses and `git diff --check`.
- Run the affected agent Worker tests, lint, and typecheck only if Worker source or `wrangler.e2e.jsonc` changes.

### Real-device proof

Run exactly:

```bash
pnpm --filter @zero/agent-mobile e2e:pixel
```

The proof is valid only if:

- the current checkout bundles through Metro;
- the Task is visible before and after restart;
- the local Worker returns the Task for `e2e-test-user`;
- the production SQLite/outbox checksums are unchanged;
- no standalone APK was installed;
- teardown succeeds.

No manual tap-through or screenshot review is required for this internal testing change.

### Optional emulator proof

Manually dispatch `Mobile Release E2E` once to prove that the shared flow still runs through the existing emulator adapter. Keep this out of normal CI.

## Implementation phases

1. **One toggle selects one safe profile.** Add the shared profile resolver; migrate Metro, native config, HTTP origin, SQLite/outbox names, AsyncStorage keys, and launcher policy; remove the auth-only/URL split; add fail-closed tests.
2. **Fake auth is complete again.** Alias and test Clerk resource-cache through the hermetic profile, then prove a hermetic Metro export bundles.
3. **One command owns the Pixel stack.** Add the quiet Metro/Worker/Maestro harness and package script, including preflight, readiness, postconditions, artifacts, and cleanup.
4. **The first current behavior has repeatable proof.** Replace Capture-era flows with the Task add/restart flow and pass it on the Pixel.
5. **The existing emulator adapter shares the flow.** Repoint the manual release workflow and run it once when practical.
6. **Repository policy points to automation.** Update README, AGENTS, E2E docs, Todo tracking, and the superseded-plan note.

## Skills to use during implementation

- `expo-overview` — load first for the Expo SDK 57 package and version-specific rules.
- `expo-dev-client` — preserve the development-client-only Pixel workflow and Metro launch path.
- `testing` — assert behavior through the app and Worker interfaces without screen-internal mocks.
- `deep-modules` — keep orchestration behind one command and persistence-mode knowledge in one runtime module.
- `reproducible-locally` — record the exact Pixel command, HTTP postcondition, isolation proof, and result.
- `documentation` — update each current source of truth once.
- `git-commit` — commit the harness, flow, tests, and docs together when requested.

## Acceptance criteria

- `pnpm --filter @zero/agent-mobile e2e:pixel` is the only command required after the Pixel development client is installed and USB-connected.
- The command sets only `EXPO_PUBLIC_HERMETIC_E2E=1`; that one toggle selects fake Clerk, localhost networking, isolated storage, disabled launcher sync, and E2E-native policy together.
- Removing the toggle restores real Clerk, normal URL selection, production storage, updates, and launcher behavior; no mixed profile is accepted.
- The command starts and stops its own Metro and local Worker, drives one Maestro flow, and leaves no process or reverse-port mapping behind.
- The Pixel keeps the same development-client package/version; the harness never installs an APK.
- The flow adds `E2E loose task`, sees it on Home, restarts, and sees it again.
- The local Worker returns that Task for `e2e-test-user`.
- Production HTTP is not used; the Worker persistence directory is temporary and removed.
- Production collection/outbox filenames and checksums are unchanged, production AsyncStorage keys remain unchanged by construction, the real Clerk session remains signed in, and E2E stores are removed after the run.
- A test Task never changes the Home launcher alias.
- Normal Metro/export builds still resolve real Clerk; hermetic Metro/export builds resolve all Clerk fakes, including resource cache.
- Success output is no more than a short summary; failure output names the failed stage and artifact directory while preserving full diagnostics in files.
- The manual emulator workflow points at and can run the same current flow, but no new push/PR CI gate exists.
- Mobile tests, lint, typecheck, normal export, hermetic export, shell syntax checks, and the Pixel command pass.
- README, AGENTS, E2E docs, and Todo tracking describe the new default without conflicting instructions.
- No changelog entry is added because users observe no product change.

## Risks and mitigations

- **Auth, URL, and storage could drift into a mixed profile.** Expose one toggle, derive every choice from one resolver, hardcode localhost in hermetic mode, and reject unknown or conflicting settings.
- **A test bundle could open production local state.** Centralize all names, keep production literals unchanged, wipe only E2E files, and compare production SQLite/outbox checksums while the app is stopped.
- **AsyncStorage can still share one physical database.** Use disjoint keys and test their exact values; never clear the AsyncStorage database.
- **The launcher alias could leak test state.** Disable Home icon sync in hermetic mode and unit-test the policy.
- **Metro could resolve real Clerk persistence.** Alias resource cache as well as provider/token/native modules and run a hermetic Metro export.
- **A standalone APK could silently ignore Metro.** Require the installed package to be debuggable and launch it through the development-client URL; never call `adb install`.
- **Android could block local cleartext HTTP.** Probe before the first flow; if blocked, enable cleartext only for development/E2E native builds and rebuild the development client once.
- **Optimistic UI could pass without server persistence.** Restart in the flow and assert the Task through the Worker's HTTP interface after Maestro.
- **Quiet output could hide the cause.** Preserve complete logs/artifacts and print focused tails on failure; support `E2E_VERBOSE=1`.
- **A stale process could make the test nondeterministic.** Use dedicated ports, readiness probes, per-run container names, and trap-based cleanup.
- **Future flows could depend on execution order.** Start this increment with one flow; add a shared reset/fixture interface only when the second independent flow demonstrates the need.
- **The optional emulator build is slow.** Keep it manual and reuse the existing APK cache; the Pixel Metro command remains the required fast loop.
