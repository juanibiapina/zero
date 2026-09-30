# Restore Android launcher icons from the Home todo count

## Goal and decision

Restore Android's launcher icon so it reflects the number of Tasks visible on Home, for both guest and signed-in workspaces. Mount the existing `HomeAppIconSync` inside `TodoDataProvider` and remove the layout's signed-out reset to `Default`.

The existing count projection and Android activity aliases already support this behavior. The confirmed defect is in how the layout connects the modules. Keep the fix in that composition and add verification through the real layout.

## Findings and evidence

Research used `vocabulary`, `deep-modules`, `documentation`, and `plan`, with `expo-overview`, `investigate`, `testing`, and `reproducible-locally` for the mobile investigation and proof design. The checkout was clean and matched `origin/main` after `git fetch`. The researched revision was `2246f646f1b5a29aec7b33c89136e48268a4cb88`.

### Confirmed cause

In [`src/app/(todo)/_layout.tsx`](../../apps/agent-mobile/src/app/%28todo%29/_layout.tsx), `HomeAppIconSync` is a sibling of `TodoDataProvider`. Its `useTodoReplica()` reads that provider's context and receives `null`. The synchronizer returns without deriving a count or requesting a native icon.

Commit `327dbb63d` on 2026-09-26 changed the synchronizer's data hooks to depend on todo context. The layout retained the sibling placement. Previously, those hooks could fall back to a separate Task data source.

Commit `25e919191` introduced guest todo use on 2026-09-27. The layout retained an effect that requests `Default` whenever Clerk is signed out. Guests now have a real Home list, so authentication status cannot select their launcher count.

### Reproduction

A temporary Jest probe exercised the current `TodoLayout`, real `TodoDataProvider`, real `HomeAppIconSync`, and an in-memory TinyBase replica with one visible Task. It substituted the workspace-opening hook, Clerk, native tabs, timezone transport, and Android icon adapter. It kept the todo context and count path real.

Observed results:

| Case | Expected request | Observed request |
| --- | --- | --- |
| Positive control: synchronizer inside the real provider | `OneTask` | `OneTask` |
| Current signed-in layout with the same workspace | `OneTask` | No request |
| Current guest layout with the same workspace | `OneTask` | `Default` |

The probe produced one passing control and two failing regression cases. Its files are temporary artifacts at `/tmp/zero-launcher-icon-plan-5nnm6_f8`; permanent regression tests must reproduce these cases in the repository.

```bash
pnpm --dir apps/agent-mobile exec jest \
  --config /tmp/zero-launcher-icon-plan-5nnm6_f8/jest.config.json \
  --runInBand --forceExit
```

The existing layout and icon-helper suites passed all 16 tests. The synchronizer suite could not start because `packages/agent-core/node_modules/tinybase` is missing locally. The probe resolved TinyBase from mobile's installation. Restore workspace dependencies with the frozen lockfile before implementing and running the normal suites.

A read-only inspection of the attached Pixel found all six launcher aliases in the installed package and `MainActivityIconEmpty` enabled. This establishes that the installed native module has the alias family. Native switching after the proposed fix remains to be verified.

## Behavior to preserve

The count is `homeTasks(tasks, projects, today).length`, using the same projection and local-day source as Home:

| Visible Home Tasks | Icon |
| --- | --- |
| 0 | `Empty`: checkmark |
| 1 | `OneTask` |
| 2 | `TwoTasks` |
| 3 | `ThreeTasks` |
| 4 or more | `FourPlusTasks` |

Completed and future Tasks do not count. Loose undated Tasks count immediately. Project Tasks count only when their date has arrived and their owning Project is in play. Projects shown when Home is clear do not add to the Task count.

The native module queues the latest changed bucket while the app is active and applies it on background entry. Rapid changes must settle on the latest bucket without interrupting Task interactions. Changes received after a stopped process require the next app load or sync and background transition.

The manifest's static three-row `Default` remains the initial icon before the first successful workspace load. An opening, failed, locked, or mismatched workspace must not be treated as an empty Home. It queues no count until accessible data is ready. Safe sign-out opens a fresh guest workspace; its hydrated Home determines the next icon.

## Implementation steps

### 1. The real layout exposes the regression in tests

Extend `src/app/__tests__/todo-layout.test.tsx` with signed-in and guest cases containing one visible Task. Use the real todo provider and synchronizer with the existing in-memory replica support. Replace their current pass-through and null mocks in the icon cases. Substitute the native icon adapter and external dependencies at their seams.

Assert the requested launcher state. Both cases must fail on the current layout. Replace the old assertion that every signed-out state requests `Default` with the guest count behavior. Include a not-ready workspace case that requests no count.

### 2. Every ready workspace supplies the launcher count

In `src/app/(todo)/_layout.tsx`, place the gated `HomeAppIconSync` and tabs inside the same `TodoDataProvider`. Remove the signed-out `Default` effect and its unused import. Keep the runtime profile gate at the call site.

`HomeAppIconSync` remains the module that owns hydration, visibility, bucketing, and native requests behind its render-nothing interface. The caller supplies the ready workspace through the existing context. No additional data owner or adapter seam is needed.

Dependency classification: count and visibility are in-process; the replica has an existing local in-memory adapter; Android package state is verified on a device. Clerk and native framework dependencies use test adapters in Jest.

### 3. Count changes remain correct through the existing interface

Extend `src/components/__tests__/home-app-icon-sync.test.tsx` through the real replica's Task and Project operations. Cover:

- Empty, one, two, three, four, and five visible Tasks.
- Adding, completing, and reopening Tasks, including a final return to `Empty`.
- Completed and future Tasks, undated Project Tasks, and dated Tasks in backlog Projects being excluded.
- An owning Project entering or leaving play changing its dated Task's visibility.
- A future Task becoming available when the shared local day advances.
- Changes within the four-plus bucket avoiding another icon request.

Use existing bucket, platform, and adapter-failure tests where they already cover the behavior. Close test replicas and unmount rendered trees. Do not mock live queries or the Home projection.

### 4. A Pixel run proves the Android alias actually changes

The current `e2e:pixel` harness sets `launcherCountSyncEnabled: false` in its hermetic profile. Passing that suite alone cannot verify this fix's native effect.

Add an explicit launcher proof mode to that harness, with a behavior flow under `.maestro/hermetic/` named for the launcher following Home. A proposed command is:

```bash
E2E_LAUNCHER_ICON_PROOF=1 pnpm --filter @zero/agent-mobile e2e:pixel
```

The mode must retain fake Clerk, the local Worker, isolated workspace files, and disabled remote updates. Enable launcher synchronization only for this explicit hermetic proof. Validate the new toggle and cover it in runtime-profile tests. Select the dedicated flow explicitly so the ordinary suite retains its existing launcher isolation.

Interleave Maestro actions with Android launcher-resolver assertions. Exercise `0 → 1 → 2 → 3 → 4 → 5 → 0` visible Tasks, backgrounding between checkpoints. Assert exactly one effective launcher alias with the expected name after each transition. Include a foreground checkpoint to prove alias switching waits for background entry. Verify guest-to-account binding and safe sign-out produce icons from their resulting Home lists.

Before the run, capture each alias's enabled-setting override, including manifest defaults. Stop the app before restoring those settings in cleanup on success, failure, or interruption. Then compare the restored state with the snapshot. Retain the existing production database checksum and installed-package checks. Use the existing Pixel development client; its six aliases are present.

### 5. The fix has passing checks and a user-facing record

Stop Metro and local Gradle builds before package checks. Run Jest serially, mobile lint, and mobile typecheck. Run the ordinary Pixel suite and the explicit launcher proof sequentially.

Run `gob run bin/ci` before completion. The current local gob client is 3.8.0 and its daemon is 3.7.0; resolve that mismatch before this gate. On NixOS, record the documented host `workerd` failure if whole-repository CI reaches it, run the applicable package checks, and require green GitHub CI. The Pixel harness runs its Worker in Podman.

Load `changelog` before editing `apps/agent-mobile/CHANGELOG.md`. Add a dated entry in the same change, for example:

> - YYYY-MM-DD: The Android home-screen icon once again matches the tasks visible on Home, including when you use the app without signing in.

Update the mobile README's Brand assets section to describe workspace-driven counts and the explicit device proof. Remove its obsolete signed-out-default statement. Keep that section as the behavior's documentation source of truth; `docs/todo-app.md` already links to it.

The production fix changes JavaScript composition. Follow `docs/mobile-releases.md`: compare the native fingerprint and use the routine EAS Update path when compatible. A native build is required only if implementation introduces a native fingerprint change.

## Acceptance criteria

- A signed-in or guest Home with one visible Task requests `OneTask` through the real layout.
- After backgrounding, the Android launcher resolves exactly the alias for the hydrated Home count.
- All five count buckets work, including five Tasks using the four-plus state and completion restoring the checkmark.
- Date, completion, and Project changes use Home's existing visibility rules.
- Opening or inaccessible workspaces queue no fabricated count.
- The ordinary hermetic suite preserves launcher state; the explicit proof restores it on every exit path.
- Focused regression tests, mobile checks, device proof, and required CI evidence are recorded.
- The mobile changelog and README ship with the fix.

## Out of scope

- New icon artwork, resource generation, or changes to Android alias definitions.
- Launcher updates while the app process is stopped.
- iOS badges or alternate icons, and web or splash changes.
- Changes to todo visibility rules, synchronization, or authentication behavior.

## Skills to use during implementation

- `vocabulary` — use the repository's module and interface terms.
- `deep-modules` — keep count behavior in the existing synchronizer and test through its interface.
- `documentation` — update the README without duplicating behavior facts.
- `expo-overview` — confirm SDK 57 and the Expo workflow before implementation.
- `testing` — build real-layout regression coverage with existing in-memory data adapters.
- `reproducible-locally` — assert Android launcher postconditions in the Pixel proof.
- `changelog` — load before adding the mobile release entry.
- `expo-module` — apply if device evidence requires changing native lifecycle handling.
- `git-commit` — apply when committing the implementation.

## Implementation verification — 2026-09-30

The provider wiring and guest reset fix are implemented. The new layout tests
failed before the fix and pass with the real provider and synchronizer.

- Mobile Jest: 32 suites and 206 tests pass. Mobile lint and typecheck pass.
- `gob run bin/ci`: 15 lint jobs, 15 typecheck jobs, three build jobs, and 10
  package test jobs pass. The dashboard's Cloudflare test pool then fails to
  start host `workerd` with the documented NixOS dynamic-executable error and
  `EPIPE`. The remaining CI stages require a compatible host or GitHub CI.
- Explicit launcher proof: passes in 545 seconds on the existing Pixel 7
  development client. It verifies all count buckets, foreground deferral,
  guest/account binding, completion, and safe sign-out. Artifacts:
  `/tmp/zero-mobile-e2e/20260930T024106Z-3419956-11264`.
- Ordinary hermetic suite: all four flows pass in 681 seconds. Artifacts:
  `/tmp/zero-mobile-e2e/20260930T025946Z-3427107-18366`.
- Both device runs preserve production database checksums and installed APK
  identity. The explicit proof restores the original six alias overrides;
  the ordinary suite preserves them without launcher synchronization.
- Android native fingerprint before and after the application changes:
  `e70671aa4d3092a9b432fb7ee11edcaaaa98ae43`. The proof flag lives in the
  application runtime module so it does not require an APK rebuild.

Device evidence required two harness adjustments. Android rejected alias
restoration from the shell UID; restoration now uses the debug app's owning
UID through `run-as`. Cold launches through an alias failed to load the test
surface, including one Fabric `MountingCoordinator` crash. Ordinary flows now
open the explicit Metro link through `MainActivity`, including the guest
persistence restart. The launcher proof cold-loads that same link, then resumes
`MainActivity` between count checkpoints.
