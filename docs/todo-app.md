# From Todoist to Full Assistant

Living doc, tracked in the repo at `docs/todo-app.md` (source of truth). It holds
the long-term **Vision** (philosophy + entity wiki) and **Project tracking**.
Each entity we actually build is documented on its own in `docs/entities/`; the
wiki below points at those. Detailed implementation plans live in `docs/plans/`.
Keep the tracking section and the per-entity docs current as increments land.

## North star

Replace Todoist as the single entry point to all tasks, then let that entry
point absorb the surrounding workflows: email processing, calendar, AI coding,
life-project management. Build inside `juanibiapina/zero` as a parallel app so it
does not disturb the current agent. Dogfood Zero's own services (ZeroErrors,
ZeroVault).

Why zero and not `juanibiapina/agent`: agent has more features but is hacky and
not scalable as a product. Zero's design is more scalable.

## Design philosophy: entities are Minecraft blocks

Each entity type is like a new block added to Minecraft. Introducing it forces a
deliberate pass over how it interacts with *every* system of the app: how it
looks in the UI, how it interacts with other entities, what workflows it plugs
into, what special behaviors it has. Not just relational DB foreign keys — game
design thinking. Ideal end state: the code should not compile (or should refuse)
if a new entity's required interactions are not wired. Open question: whitelist
of allowed interactions vs blacklist of forbidden ones.

## Data-store strategy (decided 2026-08-27): per-entity, not a generic bag

`DbCaptureStore` is deliberately specific to captures, and future entities
(Project, Person, Note…) get their own thin stores too. NOT a generic
`Repository<T>` / uniform CRUD bag. Reasons:

- do-orm already IS the generic layer (`db.insert/all/get/update` + conditions).
  A per-entity store adds only the entity's DOMAIN methods (capture: `add`,
  `list` = open Captures, `process`) — that is the value, not CRUD.
- A uniform generic store fights the Minecraft-block philosophy above: adding an
  entity should force wiring its behavior, not be a no-op in a shared bag.
- One example is not enough to abstract. Extract a small shared base only at the
  ~third real entity (Rule of Three), and only for genuinely shared plumbing
  (id/createdAt conventions, a `list/get` helper) — never the domain methods.
- Keep product stores separate from the agent's `DbStore` (one namespace per
  product area); do not widen the agent interface with todo-app entities.
- Caveat: the TanStack DB adoption may shrink or dissolve the server-side store
  (client owns collections; the DO persists generically). Settle the sync-engine
  direction before investing in any server-store framework.

The thing to watch is duplicated CRUD boilerplate across future stores, not
specificity; do-orm + a Rule-of-Three base covers it when the time comes.

**Rule-of-Three status (2026-09-04, extracted):** Task (#2) and Project (#3) were
built as deliberate structural siblings of Capture at every layer, and with three
in hand the client plumbing was extracted (plan:
`docs/plans/todo-rule-of-three-extraction.md`). What moved: the offline
collection factory (`packages/agent-core/src/collection/base.ts`: in-memory
fallback, persisted local-first sync, reconcile-after-write, outbox wiring,
client-minted id/createdAt), the list-region view rule (`listView`), and the
per-surface wiring (`apps/agent-mobile/src/lib/entity-api.ts`,
`apps/agent-web/src/lib/entity-api.ts`). Each entity's collection file is now a
verb table over that factory. What stayed per entity on purpose: the domain
verbs and their optimistic drafts, the REST contracts, and the server stores
(do-orm is already the generic layer; the leftover overlap is two 3-line idioms).
See `docs/storage.md`.

**Collapse to one list (decided 2026-08-31; merged 2026-09-12):** the
Capture/Task split proved premature — the user works in one list the way they do
in Todoist. This went through two stages. First the separate **Today tab was
removed** and the app was one **Captures** list, with Capture growing the moves a
single list wants (postpone to a day, drag-to-reorder, the detail sheet + date
scheduler) while Task sat parked. Then the **single-list merge** (2026-09-12,
`docs/plans/todo-single-list-1-merge.md`) finished the job the other way round:
**Capture was collapsed into Task**, so Task is the single entity and the one
list, and Capture is deleted. The scheduling/reorder/visibility behavior that had
been built on Capture moved onto Task. See the shipped entry below and
`docs/entities/task.md`.

## Entity wiki (draft — grow one at a time)

Grounding: **Task** is the foundational block and the entry point (Capture was
collapsed into it by the single-list merge, 2026-09-12), and **Project** is the
container. Everything else below (Person, Note…) is a vision draft, not
committed.

- **Task** — the **single entity and the entry point** (named `Task`, not "Todo",
  which collides with the app name). One line of work: a loose quick-capture with
  no project, or a committed next-action under a project. It owns the nullable
  `showUpDate`, the manual drag-reorder, and the Home/Upcoming visibility split.
  Fully documented in `docs/entities/task.md`.
- **Capture** — **retired.** Collapsed into Task by the single-list merge
  (2026-09-12); a quick-add with no project is a loose task now. Tombstone at
  `docs/entities/capture.md`.
- **Project** — the first container, entity #3 (plan:
  `docs/plans/todo-project-entity.md`; source of truth: `docs/entities/project.md`).
  Goal-oriented (baby, diploma, buy a house, watch a movie), sometimes
  maintenance-oriented (a "baby maintenance" project should maybe not exist). Has
  a nice icon (baby face, diploma) and a status (active / next / waiting / backlog
  / done). Slices A1 + A2 shipped: name-only create and a status-grouped list on
  both surfaces; A3 added enrichment (an emoji icon picker over all standard emoji
  with search, editable title and notes). Slice A (the hand-managed entity) is
  complete. A project now opens **its own screen** (web `/projects/:id`, mobile a
  pushed screen), not a bottom sheet — that is where status is changed, tasks are
  groomed, and what it's waiting on is recorded. Vision beyond that:
  can contain Todos, agent sessions, documents. Can spin off other Projects and
  even People. Notify dependent Projects when they move; can unblock them. Idea:
  project "slots", start with one slot to teach the game.
- **Person** — first-class. New to the user's workflow; named as a gap. Circle
  avatar. Connect to Todos and Projects. "People" is a basic filter: see how
  many people a Todo/Project affects. Family displayed clearly. Seed avatars +
  relationships from Google Contacts. Know where you first met someone.
- **Vault** — holds Notes. Notes shared across Projects on the same Vault. Can be
  one global Vault, per-project, or per-group. Low priority now (all projects
  share one Vault).
- **Note** — generic. Tension: user would rather have *no* generic Note entity
  and instead many specific typed entities, each with special behavior, so UIs
  and interactions can be specialized.
- **Preferences** — written docs of taste (e.g. "I strongly prefer OV movies").
  System should flag violations instantly in context (a movie project that isn't
  OV). Some rules today live in the user's head or in notes skills.
- **Workflow** — e.g. "process email", "watch a movie in the cinema". More than a
  user prompt: needs custom prompting + each entity type contributes its own
  influence to a workflow. Templates could auto-create Projects.
- **Email** — must attach to something, likely a Project. Strict `email ->
  project`? Newsletters, invoices, bills may be their own entities. Present an
  email with all attached entities + suggested updates (todos, calendar,
  timeline); user answers yes / no / ask-for-changes in an AI session.
- **Session** — AI session with tools to work with every entity. UI tracks all
  accessed/saved entities; jump to the note/person/etc. Tools have visuals shown
  in the session trace; following a link is a trackable tool.
- **Deliveries**, **Newsletter**, **Invoice**, **Bill**, **Trip**, **Album**
  (Google Photos), **Google Wallet** (service; auto-use for movie tickets),
  **Movie ticket** — candidate entities.

## Concrete pains that motivate this

- Zero booked a movie calendar event but ignored that the confirmation named 2
  tickets = another person involved. Want required entity interactions encoded.
- Zero's email workflow didn't follow a (safe, read-only) ticket link. Want it
  to follow non-mutating links to extract more info; each fetch is a trackable
  tool with visual output.
- Movie tickets should go to Google Wallet automatically.
- A movie project should ping during/after the movie for a review + photo with
  the poster, and prompt to tag the people who came.
- Starting a new agent session in an existing GitHub project is many manual
  steps in `juanibiapina/agent`: create a Telegram topic, name it, then run
  Telegram commands to bind it to the repo directory (e.g. the zero repo). Every
  new session against the same project repeats the whole ritual. In the todo
  app, spinning up a new session for a known project should be one click/action:
  the Project already knows its repo directory, so the app creates the Session
  and binds it in a single step — no topic naming, no directory-selection
  commands.

## Dreamy / low-confidence ideas (parked)

- Game-like timeline UI.
- Project slots as a teaching mechanic.
- Zero auto-creating projects from templates instead of the user creating them.

---

## Project tracking

Shipped (2026-09-12): **One list — Capture collapsed into Task** (plan series
`docs/plans/todo-single-list-overview.md`, part 1 `todo-single-list-1-merge.md`).
Task is now the single entity and the app's entry point; the Capture entity is
deleted (no `captures` table/route/store/collection/type, no Process, no Refine).
A quick-add with no project creates a **loose task**; Task absorbed the nullable
show-up date, the manual drag-reorder, and the Home/Upcoming visibility split.
Home is one reorderable `sortKey`-ordered list (swipe-right to postpone,
long-press/grip to reorder, complete with the single bottom Undo, tap to
rename/schedule); Upcoming lists every future-dated open task grouped by day.
Migration 0051 drops `captures` and preserves every `tasks` row with a nullable
`showUpDate` + backfilled `sortKey`; the dormant `sourceCaptureId` stays for a
future Refine. Shared helpers moved onto the task module (`homeTasks` gained the
shown-up gate + sortKey ordering; `upcomingSections`, `orderKeyBetween` /
`compareByOrder`, and the date helpers were ported from the deleted `captures/`).
Server + agent-core + web suites pass; mobile unit tests pass and **Pixel 7
device verification is pending**. Parts 2 (move a loose task to a project) and 3
(date-aware project status / derived "waiting until a day") are the next slices.

Shipped (on main, device-verified): the Capture list (Captures) on mobile
(`apps/agent-mobile`) and web (unlinked `/captures`) — add a Capture, Process it
out of Captures — backed by the `captures` table and `/api/captures` in the
per-user UserDO. Mobile UI on Uniwind (Tailwind 4) + `@expo/ui`; Clerk sign-in with a
native user button. The Captures data layer runs on TanStack DB (see
`docs/storage.md`). Captures carry a client-minted UUID id (stable end to end,
and the sole idempotency key for offline replay), so adding and processing a
Capture no longer flickers — the row never blinks out-and-back while the write
settles.

Captures loads local-first and reconciles the server in the background; the
shared `listView` helper in `@zero/agent-core` gates the list on the row count
so a hydrated snapshot shows at once. See `docs/storage.md` for the mechanics.

Shipped (2026-08-30): **Task**, the first typed entity, and the **Today** view
over it (plan: `docs/plans/todo-task-entity.md`). Built as a sibling of the
Capture stack, web first, then mobile: a `tasks` table + `/api/tasks` in the
per-user UserDO (add is exactly-once on the client-minted id; complete flips
`completedAt`; list returns open tasks); a shared `@zero/agent-core` Task type,
`createTasksApi` collection (local-first, offline outbox), and `dueToday` /
`localToday` helpers; and a **Captures | Today** segmented control on
both web (`/captures`) and mobile home. The active segment is the entry target: the
quick-add mints a Capture on Captures and a Task dated today on Today; the circle
completes. Timezone lives on the client (server returns all open tasks; the live
query filters `showUpDate <= localToday`, so overdue rolls in and future stays
hidden). Mobile device verification (Maestro, Pixel 7) still needs a standalone
EAS build for the durable-snapshot path.

Shipped (2026-09-02): **Upcoming** as section #2 on both surfaces (plan:
`docs/plans/todo-upcoming-tab.md`). A second tab (mobile) / nav entry (web) that
lists open, future-dated captures (`showUpDate > today`) grouped into day
sections (Tomorrow and beyond), the complement of the Captures list (which shows
what has already shown up). Grouping is one shared pure helper `upcomingSections`
in `@zero/agent-core`; each surface renders it in its own idiom (a mobile
`SectionList`, a web section list), with process + inline-edit rows, no calendar
strip and no drag-reorder. The mobile Capture data layer is now a shared
singleton so both tabs read one collection. Quick-add-to-a-day and a date strip
are deferred follow-ups.

Shipped (2026-09-02): **navigation chrome** on both surfaces — a native bottom
tab bar on mobile (`NativeTabs`) and a matching web nav (left sidebar on desktop,
bottom bar on phones). One section for now (**Captures**); a second lands next.
The chrome is built per surface (mobile tabs vs web sidebar), sharing only the
`@zero/agent-core` view helpers, since `apps/agent-web` is a separate app, not the
Expo web build. First on-device run of the native tab bar needs a fresh EAS dev
build. This reverses the earlier one-list-no-nav shape (Today tab removal) in
intent: nav returns, but sections grow one real screen at a time.

Shipped (2026-09-04): **Project**, entity #3 and the first container — slice A1
(plan: `docs/plans/todo-project-entity.md`, slice `todo-project-entity-a1.md`;
source of truth: `docs/entities/project.md`). Built as a third full sibling of
Capture/Task, web first then mobile: a `projects` table + `/api/projects` in the
per-user UserDO (`add` is exactly-once on the client-minted id; `list` is
oldest-first), a shared `@zero/agent-core` `Project` type, `createProjectsApi`
collection (local-first, offline outbox), and the shared `listView` count-gate;
a name-only create with outcome-naming helper text over a flat list on web
(`/projects`, a `SideNav` entry) and mobile (a `NativeTabs` Projects tab). First on-device run of the new native tab needs a fresh EAS dev build.

Shipped (slice A2, plan `todo-project-entity-a2.md`): the five-status model.
`DbProjectStore.setStatus` + `PATCH /api/projects/{id}` (list now scoped to the
non-`done` working set), a pure `projectsByStatus` grouping helper, and
`api.setStatus` in the collection (offline-replaying). On both surfaces the list
is grouped into collapsible Active / Next / Waiting / Backlog sections (counts,
hide-empty, Backlog collapsed when large), and a tap opens a detail bottom sheet
with a Status group; setting `done` removes the row with an inline ~5s Undo. The
detail sheet is a generic reusable primitive — web on `@radix-ui/react-dialog`,
mobile on the universal `@expo/ui` `BottomSheet` — shared with the Captures
detail sheet.

Shipped (slice A3, plan `todo-project-entity-a3.md`): enrichment in the detail
sheet. `DbProjectStore.edit` + a widened `PATCH /api/projects/{id}` carrying
title/icon/description alongside status, and `api.edit` in the collection
(offline-replaying; `setStatus` and `edit` share one update, disambiguated by the
changed field set). The sheet gained an emoji icon picker, an editable
title, and an editable notes field on both surfaces; field edits commit on
blur/submit (the icon on tap) and keep the sheet open, while a status pick still
dismisses it. The icon picker later grew from a curated 12-emoji row into a
searchable picker over every standard emoji (`frimousse` on web,
`rn-emoji-keyboard` on mobile); the stored `icon` is still a single emoji
string, and the neutral default is the shared `DEFAULT_ICON` (📁). The `icon`/`description` columns existed from A1, so A3 needed no
migration. This completes **slice A** (the hand-managed Project entity: no AI, no
Task membership). The mobile `@expo/ui` `TextInput` is native, so on-device
verification needs an EAS dev build. The Rule-of-Three extraction of the shared
plumbing (never the domain verbs) followed as its own change.

Shipped (post-A3): **delete a Project**, distinct from `done`. A destructive
Delete button in the detail sheet drops the row behind the same ~5s Undo as
`done`, then hard-removes it server-side (`DbProjectStore.delete` +
`DELETE /api/projects/{id}`, 204 and idempotent so an offline replay is safe).
Offline-safe on web and mobile. This added the shared collection factory's first
`delete` verb kind (`packages/agent-core/src/collection/base.ts`), so every
future entity gets optimistic delete + offline outbox for free.

Tightening (2026-09-04, internal, no user-facing change; plan
`docs/plans/todo-tightening.md`): the six list screens (Captures / Projects /
Upcoming × web + mobile) shared four copies of the same plumbing. The pure,
UI-agnostic pieces moved into `@zero/agent-core` (`messageOf`,
`LOADING_TEXT_DELAY_MS`, the Upcoming `dayLabel` helpers, and the Projects
display data in `projects/display.ts`: `STATUS_LABELS`, `ALL_STATUSES`,
`DEFAULT_ICON`, `BACKLOG_COLLAPSE_THRESHOLD`, `DONE_UNDO_MS`). The React hooks
(`useDelayed`, `useLoadError`, `useForegroundRefetch`, and the `useUndoableLeave`
hook that now backs both the Done and Delete undo timers) live in one
`screen-hooks` module **per app**, not in `@zero/agent-core`: a workspace lib
that calls React hooks resolves its own React copy (agent-core's would be 19.2.8
vs the mobile app's pinned 19.2.3) and trips the rules-of-hooks dispatcher, so
agent-core stays React-free. `apps/agent-web` also gained a Vitest +
`@testing-library/react` toolchain and a `ProjectsPage` suite, so the web surface
is no longer untested.

Shipped (2026-09-06): **Home** — the Today screen reworked (plan:
`docs/plans/todo-home-rework.md`). Renamed Today → Home on both surfaces (web nav
+ mobile tab; the `/captures` route is unchanged). The empty region is now one
Clarify → Engage pipeline: a plate with tasks shows the tasks (each project task
badged with its project's icon); an empty plate with captures shows the inbox
alone; an empty plate *and* inbox shows a state-driven call to action from the
projects' derived statuses — **Plan your day** (Next/Waiting exist, with a
`N Next · M Waiting` summary), **Bring a project forward** (only Backlog/Done), or
**Create your first project** (none) — each routing to Projects. The whole
gate-and-mapping is one shared pure seam `homeCallToAction` in `@zero/agent-core`
(with `homeCallToActionCopy` so web and mobile show identical words), unit-tested;
web and mobile screen tests cover the rename, the CTA cases, and the badge.

Shipped (2026-09-08): **create a Project from Home**. The Home quick-add gained a
third **Project** option beside Capture and Task on both surfaces; submitting in
that mode creates a name-only project, keeps the user on Home, and raises a toast
with a **View** link (the id comes off the optimistic insert transaction). On web
View opens the project's own detail; on mobile it opens the Projects tab (a direct
cross-tab deep link to the detail is blocked by a NativeTabs bug, expo/expo#45786,
that needs a native fix — revisit when it lands). The toast is our **own
primitive**, not a library: a headless controller in `@zero/agent-core` (queue,
timers, dedupe, observable snapshot) behind a tiny `toast()` + `<Toaster>`
interface, with a thin per-surface renderer (web DOM + CSS, mobile RN +
reanimated). We tried `sonner`/`sonner-native` first; sonner-native does not
render on our New-Arch + react-native-screens stack (sonner-native#316), and
react-native-toast-message has an open New-Arch regression (#583) — so no
maintained library fit. Plans: `docs/plans/todo-home-create-project.md` (feature),
`docs/plans/toast-primitive.md` (the primitive). Device-verified on the Pixel 7
(Maestro): the toast renders and View lands on Projects; no EAS rebuild was needed
(the mobile renderer adds no native module).

Shipped (2026-09-09): **immediate complete/done/delete with one bottom Undo
snackbar** (plan: `docs/plans/todo-delete-complete-redesign.md`). The old deferred
model — the acted-on row lingered struck-through with an inline Undo for ~5s
(`DONE_UNDO_MS`) before the write committed — is gone on both surfaces. It had two
faults the user hit: the ghost row lingering, and (because the timer was cleared on
unmount) switching tabs before the window elapsed silently dropped the write.
Everything now commits **immediately** and the row leaves at once. Home
task-complete raises a single global Undo snackbar (fixed toast id, so completing a
second task replaces the first toast — only ever one Undo) that **reopens** the
task on the server (`POST /api/tasks/{id}/reopen`, mirroring complete). Projects
`done` and `delete` commit immediately from the detail screen's ⋯ menu with **no**
toast — they are already three deliberate taps, so an Undo net is low value and the
faithful project-restore path was not worth its cost. The mobile toaster moved to
the **bottom** (above the tab bar), like Todoist. Removed: the deferred
`useUndoableLeave` hook (both apps), the `project-leave` detail→list handoff, the
`DONE_UNDO_MS` constant, and the Home "+ Waiting condition" inline shortcut (it only
existed inside the old completion window; waiting conditions stay on the project
screen).

Shipped (2026-09-09, follow-up): the same single bottom Undo snackbar now covers
**completing a capture** (the inbox "process" action) on Home and Upcoming, both
surfaces. Processing commits immediately (it always did); the new part is the Undo,
which **un-processes** the capture back to the inbox
(`POST /api/captures/{id}/unprocess`, mirroring process — a `unprocess` verb in the
Capture data layer that clears `processedAt`, routed before the catch-all text
edit). One shared `'undo'` toast id across task-complete and capture-complete means
only one Undo is ever on screen. The mobile toaster's bottom offset was also raised
so it clears the native tab bar instead of overlapping it.

Shipped (2026-09-09, follow-up): completing a task from a **project's own
screen/page** now raises the same single bottom Undo snackbar (reopens the task) —
previously the only complete/process action left with no Undo. In the same change
the repeated "commit immediately + raise the shared Undo snackbar" wiring (four
call sites: Home task-complete, Home/Upcoming capture-process, and now
project-detail task-complete) was extracted into one shared `undoableAction` helper
in `@zero/agent-core`, which owns the fixed `'undo'` toast id so "only one Undo on
screen" is an enforced invariant rather than a copy-pasted literal. Plan:
`docs/plans/todo-project-detail-undo-toast.md`.

Shipped (2026-09-09, fix — device-verified on the Pixel 7): the Undo snackbar
now actually **restores** the row on the persisted (device/web) path. On-device
testing revealed that tapping Undo threw `CollectionOperationError: key not found`
and did nothing: completing a task / processing a capture reconciles the row out
of the collection (the server list is open-only), and the Undo was an
`update`-by-id that cannot resurrect an evicted row. This had shipped broken in
the 2026-09-09 snackbar work because the in-memory unit tests keep the row and
never hit the eviction. Fix: `reopen`/`unprocess` are now a fourth collection verb
kind, **`revive`**, that carries the full row and **re-inserts** it when absent
(updates in place when Undo is tapped before the eviction lands), fixing Undo on
all surfaces at once (Home + Upcoming + project screen for tasks; Home + Upcoming
for captures). Verified on the Pixel 7 (reopen and unprocess both restore the row,
`reopenTask`/`unprocessCapture` fire, no `CollectionOperationError`). Plan and
design record: `docs/plans/todo-undo-restore-fix.md`, `docs/storage.md`. This is
why every mobile change must be verified on the Pixel 7 (now a rule in `AGENTS.md`).

Shipped (2026-09-10): **how long a project has been waiting**, on both surfaces
(plan: `docs/plans/todo-project-waiting-time.md`). Each waiting project's row
shows a muted trailing badge with the elapsed time since its oldest unresolved
condition (a readable phrase like "3 days", via date-fns `formatDistanceStrict`),
and the Waiting section is ordered longest-waiting first. Two pure helpers in
`@zero/agent-core` — `waitingSince` (the blocked-since instant, reusing
`unresolvedConditions` so it never disagrees with the derived `waiting` status)
and `waitingLabel` (the phrase, with a sub-minute "just now" floor) — plus an
optional `sortKeyOf` on `projectsByStatus` (the list passes `waitingSince ??
createdAt`, so only the Waiting section reorders). No data-model change. Unit +
web/mobile screen tests; device-verified on the Pixel 7.

Shipped:

- **The "what shows up" availability model** (plan:
  `docs/plans/todo-availability-model.md`; merged via PR #69), built as 8 vertical
  slices, web + mobile. Today is one screen with tasks on top and the capture
  inbox below; a Task belongs to a Project (`projectId`, migration 0047) and is
  groomed in the project sheet; the Today top region is a computed view
  (`homeTasks`) gated by the project's derived display status and per-task
  curation (`takenOnAt`, migration 0048, a take-on/park star); a project's
  `active`/`next`/`waiting` status is **derived** (`projectDisplayStatus`) from its
  taken-on tasks and its **waiting conditions** — the new fourth entity
  (`waiting_conditions`, migration 0049; `docs/entities/waiting-condition.md`),
  free-text (human/AI-resolved) or task-done / project-status (code-resolved);
  completing a task lingers with Undo + a "+ Waiting condition" shortcut; and a
  capture is **Refined** into tasks/projects (`sourceCaptureId`, migration 0050),
  consumed on Done. The availability rule and derivation live in two pure, tested
  modules in `@zero/agent-core` (`homeTasks`, `projectDisplayStatus` +
  `conditionSatisfied`/`unresolvedConditions`). Shipped with unit/route/page tests;
  mobile on-device verification (EAS/Maestro) still pending. Refinement (2026-09-08):
  a taken-on open task now overrides an open waiting condition — starring a task
  on a waiting project brings it back to `active`, and completing that task
  returns it to `waiting` (not `next`), since the condition is still open. Also fixed a
  pre-existing durable-collection bug where a deleted row reappeared until refresh
  (see `docs/storage.md`).
- **Automatic appearance.** Mobile and web follow the system light or dark
  preference, including native/browser chrome. See `todo-dark-mode.md` for the
  implementation and device proof.
- **Add a waiting condition with the "+" affordance, not an inline form**
  (mobile + web; plan `docs/plans/todo-project-waiting-add-fab.md`). On the
  project screen, the waiting-condition add moved off an always-present inline
  composer. Mobile folds it into the project screen's single plus FAB as a
  second **Waiting** mode (beside Task) — free-text only; web opens the same
  three-kind builder in a popover from the "+ Waiting condition" control. Backed
  by a new project-scoped `waiting` add mode in the shared quick-add registry,
  kept out of the global set so Home and the Projects list never offer it. No
  data/API/store/derivation change. Unit + web/mobile screen tests cover the new
  affordance; device-verified on the Pixel 7 (the project + shows Task/Waiting
  pills, Waiting adds a free-text condition to the Waiting-on list — pure-JS, no
  EAS rebuild).
- **Mobile task add on a project is a plus FAB** (not an inline field): the
  project screen's task composer moved to the shared plus button / keyboard-docked
  quick-add bar, task-only (no capture mode, so captures aren't selectable there).
  Tasks-only rework of one screen; no data/API/collection change. Plan:
  `docs/plans/todo-project-task-add-fab.md`. Device-verified on the Pixel 7 (dev
  client + Maestro): FAB adds a parked task, bar docks above the tab bar, Back
  closes the bar before popping. Follow-up: the bar now shows the single
  interactive **Task** pill (the sole mode there), reading exactly like Home's.
  The add-mode concept — its ids, pill copy, and placeholders, previously smeared
  across a duplicate type, a labels map, and an `ADD_PLACEHOLDER` map on each Home
  (web + mobile) — is now one pure registry (`@zero/agent-core`
  `quick-add/modes.ts`) consumed by both surfaces; the quick-add bar renders
  whatever `modes` it is handed and derives the placeholder from the selected mode.
  Follow-up: the **Projects list** + now also shows its single interactive
  **Project** pill (`mode="project"`, `modes={['project']}`), so all three mobile
  quick-add surfaces (Home, the project screen, the Projects list) render pills
  from the one registry — the mobile pill affordance is fully unified. Web has no
  pill concept (the web Projects page is a plain input), so it is unchanged.

- **AI icon suggestions for a Project** (web + mobile shipped) — the
  **first AI integration of the todo app**. Creating a project fires a background
  request that suggests emoji icons from its title; the picker shows them
  instantly from a device-local cache (or a brief loading line), tapping one
  applies it through the existing `edit` path, and Refresh recomputes after the
  title/description changes. Both surfaces put the suggested
  row directly above the full picker in one surface: web in the `frimousse`
  popover, mobile in a plain-RN bottom sheet hosting the inline
  `rn-emoji-keyboard` `EmojiKeyboard` (not the `@expo/ui` native sheet, which
  cannot host raw RN rows) with the chips on top and the searchable grid below. The server side is a stateless
  `POST /api/projects/icon-suggestions` that runs one tool-less model call
  (`suggestProjectIcons` over the `AgentModel` seam, agent label `icon_suggest` at
  `low` effort via the new `AGENT_EFFORT_OVERRIDES` map) and returns single-emoji
  strings, so no new server-side state and a soft miss just returns `[]`. The
  suggestions are an ephemeral client hint (no sync, no server row); the pure
  staleness check lives in `@zero/agent-core`, the cache and fetch per surface.
  Proves the todo app's first server LLM path end to end for heavier features
  (Capture → Project). Plan: `docs/plans/todo-project-icon-suggestions.md`.

Shipped (2026-09-05): **Project detail as a destination** (plan:
`docs/plans/todo-project-detail-rework.md`). Tapping a project now opens its own
screen — a `/projects/:id` route on web (`ProjectDetailPage`) and a pushed screen
within the Projects tab on mobile (`projects/[id].tsx`) — instead of a bottom
sheet. The screen leads with the work (tasks, then what it's waiting on) and keeps
identity compact (icon, editable title, derived-status pill, a `⋯` menu for status
moves/delete); the icon picker and status/delete actions stay as short `@expo/ui`
sheets. This dissolved the broken mobile task/waiting renderer (raw RN rows inside
an `@expo/ui` sheet host): a pushed Expo Router screen is an ordinary RN view tree,
so the rows render correctly. UI/navigation only — no data model, API, store, or
derivation change. Web has a `ProjectsPage` route test; the mobile project screen
was later device-exercised in the Undo-restore fix (2026-09-09).

In flight (details in `docs/plans/`):

- `todo-capture-animations.md` — quick-add morph + done fade-out. **Done fade-out
  shipped** (marking a todo done fades and collapses the row out); the **quick-add
  morph** (FAB expanding into the quick-add bar) is the remaining half.

Next:

- **Reschedule a Task** — swipe-to-tomorrow / pick a future date (v1 dates every
  Task today with no way to change it).
- **AI Capture → Project** — swipe a Capture, propose a Project, confirm (the
  content-driven half of Refine; `docs/plans/todo-capture-to-project-ai.md`).
- **AI-resolve a waiting condition** — from email/calendar/content.
- later: agent `create_task` tool, recurring capture, recurring Tasks,
  structured waiting-condition kinds on mobile.

Dev infra: a physical Pixel 7 is USB-attached to the dev box and driven with the
Maestro CLI for on-device verification (see `apps/agent-mobile/README.md`). Rules
that still bite: the first use of any native or `@expo/ui` component needs a fresh
EAS dev build before it runs on device (pure-JS changes hot-reload); and this dev
box has no workerd and no Android emulator, so verification is unit tests +
`expo export` + the real phone.
