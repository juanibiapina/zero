# Fix mobile midnight rollover and empty-Home refresh

## Bottom line

Fix two independent mobile defects that combine into the reported failure:

1. Home reads the device day with `localToday()` only when React renders. A continuously open, otherwise idle app does not render at midnight, so a task whose `showUpDate` has arrived remains hidden until another state change or a process restart.
2. Home replaces its `ReorderableTaskList` with a plain call-to-action view when no task is visible. That branch has no scroll host or `RefreshControl`, so a pull gesture cannot call the existing three-collection `refetchAll` function.

Add one mobile local-day clock behind a `useLocalDay()` interface, and keep Home's reorderable scroll host mounted for both rows and the empty call to action. The date rollover must remain local-first and work without a network request; pull-to-refresh remains the explicit server reconciliation path.

## Goal

When Home is empty before midnight and a locally stored task is scheduled for the next day, that task appears just after the device enters the new local day without a pull, foreground transition, or app restart. While Home still has no visible task, pulling anywhere over the empty call to action starts the normal refresh and re-pulls Tasks, Projects, and Waiting Conditions.

## Confirmed current behavior and root cause

- `@zero/agent-core` deliberately keeps date derivation pure. The server returns every open task, including future-dated tasks, and mobile passes an explicit `today` string into `homeTasks`, project-status derivation, Upcoming grouping, and schedule labels. No backend write or date-filtered request is required at midnight.
- `apps/agent-mobile/src/app/(signed-in)/index.tsx` currently computes `const today = localToday()` during render. No timer invalidates that value when the app remains active across midnight. `useForegroundRefetch` only reacts to a later `AppState === 'active'` event, and an unchanged collection reconciliation need not cause the date-derived view to render.
- Killing the app creates a new render and therefore reads the new day, which matches the reported recovery.
- `HomeCallToActionView` is rendered instead of `ReorderableTaskList` for the hydrated empty state. `RefreshControl` lives inside `ReorderableTaskList`, so that state has no refresh gesture at all.
- The existing Home refresh regression test seeds a visible task before pulling. It proves the populated-list path but cannot detect the empty-state defect.
- Upcoming always mounts a `SectionList`, including for its empty message. Project detail always mounts `ReorderableTaskList`. The reported missing refresh surface is specific to Home's conditional empty branch.
- Since this plan was written, commit `1900c143a` added `expo-updates`, a `fingerprint` runtime policy, and automatic publication to the Android `preview` channel after green `main` CI. It did not change `apps/agent-mobile/src` or `packages/agent-core/src`, so both root causes and the implementation strategy above remain current. This fix changes TypeScript only and should retain the installed `1.1.0` preview APK's native fingerprint.

## What to change and why

### 1. One reactive local-day module owns rollover lifecycle

Add `apps/agent-mobile/src/lib/local-day.ts` with one external interface:

```ts
useLocalDay(): string
```

Implement it as a shared external store consumed with `useSyncExternalStore`, so every mounted caller observes one current `YYYY-MM-DD` value while the app owns only one timer and one `AppState` listener.

The implementation must:

- initialize and resynchronize from the existing pure `localToday(new Date())` helper;
- schedule against the next **local calendar midnight** with a local `Date` constructor, not a fixed 24-hour interval, so daylight-saving changes do not move the boundary;
- read the clock again when the timeout fires, notify subscribers only if the day changed, and schedule the next boundary;
- resynchronize and reschedule whenever React Native reports `AppState === 'active'`, covering a timer suspended while the app was backgrounded and device date/timezone changes made while it was away;
- start native/timer resources for the first subscriber and remove them after the last subscriber, including Fast Refresh and test cleanup.

Keep `localToday(now)` in `@zero/agent-core` pure and unchanged. Do not hide a clock inside shared derivation or add React to `agent-core`; explicit `today` arguments remain its deterministic interface.

Use `useLocalDay()` at every long-lived mobile render that derives date-sensitive state or copy:

- Home;
- Upcoming;
- Projects;
- project detail;
- `HomeAppIconSync`;
- the quick-add date controls;
- task detail and its schedule sheet.

An event handler that calls `localToday()` only at the moment of an action, such as destination feedback, can keep that direct read. The rule is that mounted date-derived output subscribes to the local-day module instead of relying on an unrelated render.

A midnight transition must not call `refetch` by itself. The persisted Task collection already holds future open tasks, so making rollover depend on the network would regress offline behavior. Existing foreground and pull reconciliation continue to handle remote changes.

### 2. Home's empty state remains inside the refreshable task-list module

Extend the `ReorderableTaskList` interface in `apps/agent-mobile/src/components/reorderable-task-list.tsx` with an optional empty renderer and pass it to the underlying list's `ListEmptyComponent`.

Reshape Home's non-loading rendering so `ReorderableTaskList` remains the single scroll host for both populated and hydrated-empty states:

- rows continue through `data={list}` with all existing swipe, reorder, complete, and open behavior;
- an empty list renders the existing centered `HomeCallToActionView` inside the list;
- the existing `contentContainerStyle={{ flexGrow: 1, ... }}` makes the empty renderer fill the viewport and makes the full empty area pull-responsive;
- loading still uses the current delayed loading presentation;
- load/write errors and the quick-add drawer retain their current positions and behavior.

Do not add a second `ScrollView` around Home. Nested scroll hosts would reintroduce the gesture arbitration problems already documented in `docs/investigations/mobile-home-list-no-scroll.md`.

## Out of scope

- Periodic background synchronization or a general live-push channel for changes made on Telegram, web, or another device. Existing foreground and pull refresh behavior remains responsible for remote reconciliation.
- Backend routes, storage, schema, migrations, or changes to the explicit date interfaces in `@zero/agent-core`.
- Recurring tasks, timed tasks, notifications, or server-owned timezone decisions.
- The equivalent browser-tab rollover improvement in `apps/agent-web`. This report and its pull-to-refresh symptom identify the native mobile surface; web can adopt its own visibility-aware clock in a separate change.
- Redesigning Home's empty call to action or changing populated-list gestures.

## Tests

Implement red-green-refactor against observable behavior.

1. Add tests for the `useLocalDay()` interface with a rendered probe and Jest's controlled clock:
   - starting just before local midnight returns the old date, then advancing past midnight publishes the new date;
   - moving the controlled clock across a day without running the timeout, then emitting `AppState === 'active'`, publishes the new date immediately;
   - two rendered subscribers stay on the same day, and removing one does not prevent the remaining subscriber from receiving the next rollover; after all subscribers unmount, a later remount reads the current day.
2. Add a Home regression test with a loose task dated for the next local day:
   - before midnight, Home shows its empty call to action and not the task;
   - after advancing through midnight, the task appears without remounting and without another `fetchTasks` call, proving the local-first rollover path.
3. Add a Home empty-refresh regression test:
   - hydrate Tasks, Projects, and Waiting Conditions as empty and wait for the call to action;
   - locate the mounted scroll host's `RefreshControl`, invoke its `onRefresh`, and assert all three fetch functions run again;
   - keep the existing populated-list pull test so the repaired empty path cannot regress the established row/gesture path.
4. Update affected schedule, Upcoming, Projects, project-detail, and launcher-icon tests only where controlled dates or the new hook subscription require deterministic setup. Assert user-visible output rather than timer call counts or store internals.

## Documentation

- Add this user-facing entry at the top of `apps/agent-mobile/CHANGELOG.md` using the implementation date: `Home now brings scheduled tasks in automatically when the day changes, and pull-to-refresh works while Home is empty.`
- After implementation and Pixel verification, add one concise shipped item to the Project tracking section of `docs/todo-app.md`, linking this plan and recording the automated and device evidence.
- Do not duplicate the mechanism in the mobile README. Its existing statement about date-based launcher changes while the process is stopped remains correct; update it only if implementation changes that contract.

## Verification

On the `mini` host, stop Metro and any Gradle process before checks, then run the mobile package directly because this NixOS machine cannot complete the repository-wide `workerd` checks:

```bash
pnpm --filter @zero/agent-mobile test
pnpm --filter @zero/agent-mobile lint
pnpm --filter @zero/agent-mobile typecheck
pnpm --filter @zero/agent-mobile exec expo export --platform android --output-dir /tmp/zero-mobile-midnight-refresh
cd apps/agent-mobile
pnpm dlx eas-cli@latest fingerprint:generate \
  --build-profile preview --platform android --json --non-interactive
```

The Android preview fingerprint must remain `02b05f3014c70d1c67ddcfb8654e9471190f2488`, the runtime already installed by the `1.1.0` preview APK. A throwaway TypeScript-source probe against the current checkout produced that same hash, confirming that this plan's source-only change remains eligible for EAS Update.

Verify the user-visible change on the attached Pixel 7 with the development client, USB-reversed headless Metro, and Maestro:

1. Create only throwaway data. Prefer a throwaway project containing a task scheduled for the next device-local day, because deleting the project removes the task cleanly afterward.
2. Through Android's Date & time settings, temporarily set the device close to local midnight, return to Home before the boundary, and leave the app running. Confirm the scheduled task appears after the boundary without pulling or relaunching. Restore automatic date/time immediately afterward.
3. With Home naturally empty, pull over the call-to-action region and confirm the native spinner appears and a throwaway task created from another surface arrives. Do not complete, reschedule, or hide existing user tasks to manufacture an empty state. If production Home is not naturally empty, use the hermetic mobile E2E dataset for the exact empty-state path while still completing the midnight transition on the Pixel.
4. Confirm Upcoming drops the arrived task, relevant project status/copy uses the new day, and the launcher count is correct after backgrounding.
5. Delete the throwaway project and confirm its task is gone. Capture a screenshot and UI hierarchy as review evidence.

No new native module is required, so the installed development client can load this change from Metro.

## Delivery

This is a routine EAS Update release, not a preview-APK release:

1. Commit the mobile source, tests, `apps/agent-mobile/CHANGELOG.md`, this plan, and `docs/todo-app.md` together.
2. Push to `main`. The changed `apps/agent-mobile/**` paths make `.github/workflows/ci.yml` run `mobile-update` after lint, typecheck, build, tests, and deploy dry-run pass.
3. Confirm the publisher creates one Android update on the `preview` branch/channel with the unchanged runtime fingerprint. Do not build or replace the Drive APK.
4. On the separate preview device, cold-launch once to download the update, stop the app fully, then cold-launch again to run it. Repeat the midnight and empty-Home checks there without changing existing production entities.
5. After metrics propagate, inspect the update group with `eas update:insights <group-id> --platform android`; record installs, failed installs, and crash rate as delivery evidence. Metrics are evidence after publication, not an implementation gate.

The USB Pixel remains on the development client. Do not install the preview APK on it.

## Skills to use

- `tdd` — write the midnight and empty-refresh regressions before implementation.
- `testing` — test the local-day and list interfaces through observable output without mocking their internal implementation.
- `deep-modules` — keep timer/AppState behavior behind one `useLocalDay()` interface and refresh gesture behavior inside the task-list module.
- `expo-data-fetching` — preserve the local-first collection behavior and existing explicit reconciliation paths.
- `reproducible-locally` — collect automated behavioral evidence and Pixel proof.
- `eas-update-insights` — confirm adoption and crash health after the automatic Android update publishes.
- `changelog` — write the mobile changelog entry in the required user-facing format.
- `documentation` — update todo tracking after verification without duplicating the mechanism.
- `git-commit` — commit code, tests, changelog, and tracking updates together.

## Acceptance criteria

- A task already present in the local collection with `showUpDate` equal to the newly arrived day moves from Upcoming to Home just after local midnight while the app remains open, including offline.
- Returning from background after crossing midnight updates the date-derived views immediately even if the suspended timeout did not run.
- Home, Upcoming, Projects, project detail, task date controls, and the Home launcher count read the same reactive mobile day.
- A hydrated empty Home keeps its current centered call to action and exposes a working pull-to-refresh gesture across the empty region.
- Empty Home pull-to-refresh re-pulls Tasks, Projects, and Waiting Conditions and always clears its spinner after success or failure.
- Populated Home still scrolls, pulls from a row, swipes to Tomorrow, reorders after long press, opens tasks, and completes tasks.
- No backend, persisted-data, or native-build change is introduced, and the Android preview fingerprint remains `02b05f3014c70d1c67ddcfb8654e9471190f2488`.
- Mobile tests, lint, typecheck, Android export, and Pixel 7 verification pass; testing mutates only throwaway entities and removes them afterward.
- The mobile changelog and todo tracking update ship in the same commit as the fix.
- Green `main` CI publishes one compatible Android update to `preview`; a separate preview device downloads and runs it after the documented two-cold-launch sequence without an APK replacement.
