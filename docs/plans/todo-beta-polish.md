# Todo beta polish

## Goal and scope

Ship the existing Android todo flows without lost edits, unsafe deletion, hidden
failures, or inaccessible controls. Implement and commit each numbered slice
separately, in order, then push main once and publish a local preview APK.

The review numbers are retained. **11 (native colors) and 12 (contrast) are
excluded at the user's request.** No theme tokens, new entities, search, recurring
tasks, or new status semantics. Web is unchanged unless shared infrastructure
needs a backward-compatible extension. Preserve unrelated untracked plans.

## Architecture and verification

The mobile app uses Expo SDK 57, TanStack DB's durable offline outbox, and one
shared task editor across Home, Upcoming, and project detail. Editors must queue
writes before filtering removes the selected row; awaiting the network would
break offline use. Keep this behavior inside `useTaskDetail`. Reuse `useQuickAdd`
for creation. Keep platform timeout/accessibility handling in the mobile toaster;
shared controller changes must preserve web defaults and durable verb names.

For each slice: add regression tests at the module/screen interface, run the
touched tests with Metro stopped, run lint/typecheck, restart headless Metro,
exercise the change on the USB Pixel 7 dev client, add a mobile changelog bullet,
record proof here, and commit. Use only `ZZ Beta polish` throwaway entities for
writes; delete their project and verify cleanup. Native controls may be mocked in
unit tests but require real device evidence. Screenshots and Maestro logs live
outside the repo. Do not install preview onto this dev-client-only Pixel.

Run `gob run bin/ci`; where NixOS workerd prevents the full suite, record the
failure and run package checks. Final verification includes Android export,
CI on main, offline/reconnect and restart checks. No silent bypass of failures.

Skills: testing for regression cases; expo-ui for native controls; impeccable
for preserving the existing design; changelog and documentation for release
notes; git-commit for each slice; eas-app-stores and gdcli for local preview
build and replacement publication.

## 1. Preserve task text through every editor action

- Save a changed, nonempty title before opening date/project pickers and before
  completion. Reuse one draft-commit implementation for dismissal and actions.
- Queue edits through the existing durable verb; carry the edited task into Undo
  so resurrection cannot reintroduce its old text. Avoid duplicate/no-op writes.
- Test rename → future date, rename → project move, and rename → complete → Undo.
- Pixel acceptance: renamed text survives Home → Tomorrow → Upcoming and refresh.
- Changelog: task edits survive scheduling, moving, and completion.

## 2. Confirm permanent project deletion

- Use a native confirmation after Delete project, naming the project and stating
  that all tasks (including completed ones) and waiting conditions are deleted.
  Never show an incomplete count as the full cascade size.
- Cancel/Back must leave data unchanged; Delete commits once then navigates back.
- Test cancel and confirm, retaining cascade refresh coverage.
- Pixel acceptance: cancel keeps a throwaway project, confirm removes it and its
  tasks. Changelog: project deletion asks before permanently removing its work.

## 3. Give Undo a usable, accessible lifetime

- Preserve the single Undo behavior and immediate durable completion. Increase
  mobile action-toast duration to at least 8 seconds without changing web defaults.
- Respect Android's recommended accessibility timeout and pause expiration while
  the app is backgrounded. Protect replacement toasts from stale timeout promises.
- Test timeout, replacement, dismissal, and delayed Undo after row reconciliation.
- Pixel acceptance: complete, wait beyond four seconds, Undo, refresh, and reopen
  the app; the task remains restored. Changelog: more time to Undo completion.

## 4. Bound and scroll the project picker

- Use a bounded panel and virtualized list; keep title and No project reachable.
- Add a visible check and selected accessibility state, including No project.
- Preserve selection and cancel semantics; allow long titles and larger fonts.
- Test many projects and selection; Pixel scroll from first to last project and
  return without changing existing entities. Changelog: every project stays
  reachable in the picker.

## 5. Unify project creation and draft protection

- Replace the Projects-list-only quick-add bar with `useQuickAdd`, project-only.
  Add a small successful-create navigation option so this entry still opens the
  new project's screen immediately; Home/project-detail creation stays in place.
- Preserve draft on keyboard dismissal; Back/scrim asks before discard.
- Test cancel/discard/submit and direct navigation. Pixel exercise all three
  creation entry points, using throwaway projects only.
- Changelog: project creation uses the same drawer and draft protection everywhere.

## 6. Keep departure failures visible

- Report failed project Done/Delete through a global, dismissible error toast
  rather than the screen being unmounted. Handle synchronous failure too.
- Describe the failed action in plain language; do not promise automatic retry
  for a rejected terminal transaction. Distinguish saved delete from refetch
  failure. Keep durable queued operations offline without false success claims.
- Tests reject terminal persistence after navigation and verify visible recovery
  copy. Pixel exercise navigation plus offline queue/reconnect with throwaways;
  use a development-only injected failure if needed, never mutate production to
  induce an error. Changelog: project action errors remain visible after leaving.

## 7. Explain task destination changes

- Show one concise destination toast for actual schedule/project changes and
  off-screen quick-adds. Skip unchanged selections. Offer View for project or
  Upcoming destinations when the editor has closed; avoid invisible actions under
  a native Modal. Reuse existing toast and navigation interfaces.
- Cover loose/project null dates and future dates; never imply every project task
  is visible on Home, since project status gates it.
- Tests assert message and destination; Pixel reschedule and file throwaway tasks.
- Changelog: scheduling and moving explain where to find the task.

## 8. Guide the empty project flow

- When the project has no open tasks, show concise next-step text and an Add task
  action wired to the existing composer. Explain Today/Home only for an in-play
  project; Backlog needs distinct wording.
- Preserve waiting conditions and normal list layout; no new onboarding screen.
- Test empty/nonempty/backlog states. Pixel add from the empty state and verify
  guidance disappears. Changelog: empty projects explain how to start.

## 9. Explain status without changing its rules

- Add a disclosure affordance to the existing status pill. In its sheet explain
  the derived status from tasks/waits and how scheduling a task affects it.
- Replace Put in play with Move out of backlog; explain the resulting status is
  automatic. Keep Mark done and Move to backlog behavior unchanged.
- Test copy and existing transitions. Pixel use the status pill on a throwaway.
- Changelog: status controls explain automatic project states.

## 10. Make picker copy and calendar reopening contextual

- Project picker title is Project during creation and Move to project in editing.
- Reset the calendar month to the selected date (or today) on every open; browsing
  and dismissing must not leak a stale month into another edit/create session.
- Test browse/cancel/reopen and changed selection. Pixel reopen after choosing a
  date outside the current month. Changelog: date pickers reopen at the chosen day.

## 13. Complete non-color accessibility

- Announce toast messages without hiding their actions from TalkBack. Expose
  expanded sections, selected calendar dates, and contextual waiting actions.
- Make small controls at least 48dp; support larger text with scrolling sheets
  and wrapping labels. Use full spoken dates rather than ISO strings.
- Test semantics, labels, and sizing; Pixel inspect hierarchy and increased font
  scale, restoring the original device setting afterward. No color changes.
- Changelog: clearer screen-reader feedback and easier-to-tap controls.

## Release

After all slices pass: run mobile/core checks and Android export, verify the
combined flows and clean up throwaways, update `docs/todo-app.md`, commit, and
push main once. Wait for GitHub CI; check whether Cloudflare watch paths trigger
any Worker (mobile-only changes should not). Build locally in the Nix Android
shell using `preview --local`, inspect versionCode/artifact, upload to the
existing Zero Agent releases Drive folder, share, then trash older APKs only
after verifying the new upload. Report commit, CI, versionCode, download link,
and any remaining verification limits.

## Execution evidence

- Slice 1: 112 mobile tests, lint, and typecheck pass. Pixel flow `/tmp/beta-1.yaml`
  renamed a throwaway task, scheduled Tomorrow, and confirmed the new name after
  refresh in Upcoming (2026-09-13_210006 Maestro run). The shared fixture project
  `ZZ Beta polish` is retained for subsequent slices and must be deleted at closeout.
- `gob run bin/ci` started but its parallel whole-repo lint consumed several
  minutes; stopped to avoid memory competition. Package checks are the local gate;
  full CI is still required on GitHub. No check failure was bypassed.
