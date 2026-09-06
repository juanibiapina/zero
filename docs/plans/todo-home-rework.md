# Rework the Today screen into Home

## Goal

Turn the current **Today** screen into **Home**: rename it, give it visual
hierarchy that communicates state at a glance, add project context to the tasks
you're working on, and replace the dead-end "No tasks yet" message with a
**state-driven call to action** that reflects your projects and inbox. Ship on
both surfaces (web `apps/agent-web`, mobile `apps/agent-mobile`), sharing one new
pure helper in `@zero/agent-core`.

## Background (what exists today)

This is the **todo app** (mobile `apps/agent-mobile` + `apps/agent-web` + the
per-user `UserDO` in `apps/agent-api`), not the Zero agent. The screen in scope:

- **Web:** `apps/agent-web/src/pages/HomePage.tsx`, route `/captures` (the file
  is already named `HomePage`; only the visible label still says "Today"). Nav
  entry in `apps/agent-web/src/components/SideNav.tsx` labeled "Today".
- **Mobile:** `apps/agent-mobile/src/app/(signed-in)/index.tsx`, the first
  `NativeTabs` tab. Header title "Today" (via `ScreenHeader`), tab label "Today"
  in `apps/agent-mobile/src/app/(signed-in)/_layout.tsx`.

Both render the same two regions, stacked:

1. **Plate (tasks):** the tasks you have taken on, computed by the shared pure
   seam `homeTasks(tasks, projects, conditions)` in
   `packages/agent-core/src/tasks/home.ts`. A loose task (no `projectId`) always
   shows; a project task shows only when it is **taken on** (`takenOnAt` set)
   **and** its project's *derived display status* is `active`.
2. **Inbox (captures):** the open captures — drag-reorderable, swipe/hover to
   postpone, tap to edit, "Refine" into tasks/projects.

Domain facts the call-to-action builds on (all already implemented and tested):

- A project's **display status** is derived on the client by
  `projectDisplayStatus(project, tasks, conditions, projects)` in
  `packages/agent-core/src/projects/derive.ts`: `backlog` / `done` are the stored
  column (manual parking); `waiting` = has an unresolved waiting condition;
  `active` = in play, unblocked, **has a taken-on open task**; `next` = in play,
  unblocked, **nothing taken on** ("come take on more").
- A task is surfaced by **taking it on**: `TasksApi.takeOn(id)` stamps
  `takenOnAt`; project-screen tasks are added parked and starred on.
- Because `homeTasks` only surfaces project tasks of `active` projects, **an empty
  plate means no project is `active`** — so the working project states left to
  reflect are exactly `next`, `waiting`, and `backlog`.

## Design decisions (resolved with the user)

### 1. Rename to Home; keep the `/captures` route

Change only user-visible strings: web `h1`, `SideNav` label, mobile
`ScreenHeader` title, mobile tab `Trigger.Label`, and the stale "Today" /
"start it from a capture on Today" comments in the touched files
(`refine-session.ts`, `RefineBanner.tsx` / `refine-banner.tsx`). The route path
`/captures` and the mobile file name `index.tsx` **stay** — renaming them churns
bookmarks and tests for no user value; this is a deliberate non-change. Update the
`signed-in-layout.test.tsx` assertion that greps for "Today".

### 2. The populated plate communicates project context

`homeTasks` stays a flat list ordered by `createdAt`. Each **project** task row
shows its project's **icon** (`project.icon`, defaulting via `ICON_CHOICES[0]`)
as a small badge, so you see which project a task belongs to; a **loose** task
shows none. Keep every existing plate behavior (complete-with-undo, the
`+ Waiting condition` shortcut, the park star). Grouping the plate *by project*
is a stronger "looks great" move but changes the `homeTasks` shape and is
deferred to its own slice — not in this rework.

### 3. Home content model — captures and project state drive the empty plate

The two regions form a Clarify → Engage pipeline top to bottom. What Home shows:

| Plate | Inbox | Home shows |
|---|---|---|
| has tasks | any | the plate (tasks with project-icon badges) + the inbox below |
| empty | has captures | the inbox only — the captures are the implicit "clarify these first"; no plate message |
| empty | empty | the **project call to action** (see below) |

So the call to action is the genuine **"all clear"** state: it appears only when
**plate and inbox are both empty**. When the plate is empty but captures exist,
Home simply shows the captures — they are your unclarified work sitting right
there, and no line of copy improves on showing them. (This matches how the user
actually works: captures are refined into tasks/projects *before* taking on
project work, so a non-empty inbox is the Clarify step and needs no nudge.)

### 4. The call to action is one state-driven, tested seam

Add a pure helper in `@zero/agent-core` (place with projects; sibling of
`derive.ts` / `sections.ts`). It owns the **whole** empty-region decision —
*whether* a CTA shows and *which* — so neither the gate nor the mapping is
duplicated across the two surfaces:

```
homeCallToAction(plateCount, captureCount, projects, tasks, conditions):
  if plateCount > 0    → null   // render the plate; no CTA
  if captureCount > 0  → null   // render the inbox only; no CTA
  next, waiting, backlog = counts by derived display status
  if next + waiting > 0  → { kind: 'plan',            next, waiting }
  if backlog > 0         → { kind: 'activate-backlog', backlog }
  else                  → { kind: 'create' }
```

`plateCount` is the length of the already-computed `homeTasks` list (passed in,
not recomputed). A `null` result means "render the plate and inbox normally, no
CTA"; a non-`null` result is the CTA to show in the empty-plate region. The
caller does not re-implement the gate — the *when-and-which* decision lives in
this one tested seam (this is deliberate: per the deep-modules lens, the gate is
the place a bug would otherwise hide across two call sites). Both surfaces render
their own idiom from the value — the "project state → next action" mapping lives
in exactly one place, which is the point (entity properties feed other systems).

An all-`done` user (no next/waiting/backlog) falls into `create`, which is honest
because the Projects list hides done projects anyway; no separate "all done"
state.

### 5. Call-to-action copy (researched)

Empty-state microcopy best practice is **Context + Value + Action**, a
**verb-first** button, human tone, and — for a user-reached empty state — a calm,
not-a-frown feel. The three cases map onto GTD's Reflect/Engage vocabulary. Every
button routes to the existing **Projects** screen; only the framing differs. This
rework does not embed a take-on picker on Home — it launches *toward* Projects,
where taking tasks on already works.

- **`plan`** (Next/Waiting exist): context line "Nothing on your plate yet" plus
  a state summary showing the non-zero counts, e.g. **"1 Next · 3 Waiting"**;
  button **"Plan your day"** → Projects. (The summary carries the full picture so
  a single Next project no longer hides several Waiting ones — planning sweeps
  both.)
- **`activate-backlog`** (only Backlog/Done): context "Your plate's clear —
  everything's on the backburner"; button **"Bring a project forward"** →
  Projects.
- **`create`** (no projects): context states the value, "Projects are the
  outcomes you work toward"; button **"Create your first project"** → Projects'
  create affordance.

## What to change

**`packages/agent-core`**
- Add `homeCallToAction` (pure) + its result type (a discriminated union over
  `'plan' | 'activate-backlog' | 'create'` with the relevant counts, or `null`
  for the no-CTA cases). Export both from `src/index.ts`.

**`apps/agent-web/src/pages/HomePage.tsx`**
- `h1` "Today" → "Home".
- Plate: add the project-icon badge to project task rows.
- Empty-plate rendering per the content model: call `homeCallToAction(plateLen,
  captureLen, projects, tasks, conditions)`; a `null` result renders the plate
  and inbox normally, a non-`null` result renders a CTA card in the empty-plate
  region, button → Projects (`create` → the Projects create affordance).
- Rework section headers/spacing so the plate reads as the primary region and the
  inbox as secondary; replace the tiny uppercase micro-labels with real headings.

**`apps/agent-web/src/components/SideNav.tsx`**
- `/captures` label "Today" → "Home".

**`apps/agent-mobile/src/app/(signed-in)/index.tsx`**
- `ScreenHeader title` "Today" → "Home".
- `TasksTop`: add the project-icon badge to project task rows; render the
  empty-plate content model from `homeCallToAction` (same gated call as web — a
  `null` renders plate/inbox normally, a non-`null` renders the CTA, button →
  Projects). Keep it inside the existing
  `ListHeaderComponent` region — no second scroll container, and no raw RN rows
  inside an `@expo/ui` sheet host.

**`apps/agent-mobile/src/app/(signed-in)/_layout.tsx`**
- Tab `Trigger.Label` "Today" → "Home"; update the "Three sections: Today…"
  comment.

**Stale comments** naming the screen "Today" in the touched files → "Home".

## Tests to add or update

- **agent-core:** unit-test `homeCallToAction` through its interface — `null`
  when `plateCount > 0`; `null` when the plate is empty but `captureCount > 0`;
  `plan` when the plate and inbox are empty and any next/waiting (counts
  correct); `activate-backlog` when only backlog/done; `create` when no projects;
  the all-`done` → `create` case; derived status is used (a project with a
  taken-on open task is `active` and excluded from the working counts).
- **Web:** extend `apps/agent-web/src/pages/HomePage.test.tsx` — header says
  "Home"; empty plate + captures shows the inbox and no CTA; empty plate + empty
  inbox shows the correct CTA per project state and its button targets Projects;
  a populated plate shows the project-icon badge on a project task.
- **Mobile:** update
  `apps/agent-mobile/src/app/(signed-in)/__tests__/index.test.tsx` and
  `apps/agent-mobile/src/app/__tests__/signed-in-layout.test.tsx` for the "Home"
  label, the empty-state content model, and the badge.

## Docs to update

- `docs/todo-app.md`: add a **new** shipped bullet for the Home rework (rename +
  state-driven empty state + project-icon badges). Do **not** rewrite the
  existing shipped-log entries that say "Today"/"Today tab" — that section is a
  historical record of what shipped when and must stay as written. Only fix
  present-tense/vision references that name the *live* screen, and never touch
  "today" where it means the date (e.g. "dated today").
- **Changelogs (same change, per AGENTS.md):**
  - `apps/agent-web/CHANGELOG.md` — web entry.
  - `apps/agent-mobile/CHANGELOG.md` — mobile entry.
  - **Not** `apps/agent-api/CHANGELOG.md` (that ships to Zero agent users).
  From the user's perspective, e.g. "The Today screen is now Home. When your
  plate and inbox are both empty, it shows your projects and a next step — plan
  your day, bring a project forward, or create your first one."

## Skills to use

- `impeccable` — the visual hierarchy, header, badges, and CTA card design.
- `vocabulary` / `deep-modules` — keep `homeCallToAction` a single deep, pure
  seam; do not scatter the state→action mapping across both screens.
- `tdd` — write the `homeCallToAction` unit tests before the helper.
- `changelog` — the two changelog entries.
- `git-commit` — commit code + both changelogs + docs together.
- Mobile on-device verification per `apps/agent-mobile/README.md`: this is
  pure-JS over existing components, so it hot-reloads on the Pixel 7 dev client;
  verify with Maestro after wiring. No new native component, so no fresh EAS dev
  build is required.

## Acceptance criteria

- Both surfaces show **Home** as screen title, nav label, and mobile tab label;
  no user-visible "Today" remains for this screen. `/captures` route unchanged.
- A populated plate reads with clear hierarchy; each project task shows its
  project icon; loose tasks show none; the inbox is visually secondary.
- Empty plate + captures present → Home shows the inbox only, no CTA.
- Empty plate + empty inbox → Home shows the state-driven CTA (`plan` /
  `activate-backlog` / `create`) with the researched copy; the button routes to
  Projects.
- `homeCallToAction` is unit-tested; web and mobile screen tests cover the
  rename, the empty-state content model, and the badge; existing plate/inbox
  behaviors still pass.
- Both changelogs and `docs/todo-app.md` updated in the same change.

## Out of scope (deliberate)

- The **daily planning ritual** — a guided flow that sweeps Next/Waiting projects
  and takes on tasks one by one — is its own future change. This rework's empty
  state only *launches toward* Projects; it does not embed a take-on picker, and
  the `takeOnCandidates` helper that a picker/wizard would need is not added here.
- **Grouping the plate by project.**
- Pre-expanding the Backlog section when arriving from `activate-backlog`.

## Risks and notes

- `/captures` route unchanged is deliberate; do not "fix" it to `/home`.
- **No server work.** `takeOn` and the derived-status helpers already exist; this
  is a client-only rework. If an interaction seems to need a new verb, stop — none
  is expected.
