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

**Collapse to one list (decided 2026-08-31):** the Capture/Task split proved
premature. The user works in a single list the way they do in Todoist and never
adopted the separate Today tab. The **Today tab was removed from the UI** on web
and mobile; the app is one Captures list again. All Task code stays parked in the
tree (table, migration, `DbTaskStore`, `/api/tasks`, the `@zero/agent-core` Task
data layer, both `tasks-collection.ts`) — unreferenced by any UI, deleted
nowhere — so Task can return roughly as a one-screen change once Projects and the
agent give it a reason to exist. The scheduling moves a single list actually
wants (**postpone to a day**, **drag-to-reorder**) are being folded into Capture
instead, which reverses the old "do not add a date to Capture" rule. This is
slice 0 of the Captures postpone/reorder/detail-sheet plan; see that plan for the
full sequence. **Postpone (slice 1), drag-to-reorder (slice 2), and the edit-only
detail sheet (slice 3) have shipped** on web and mobile — a capture carries a `showUpDate`
and a fractional-index `sortKey`, the list orders by that manual key, and tapping
its text opens the editor. Next is the full scheduler (slice 4).

## Entity wiki (draft — grow one at a time)

Grounding: the foundational block is the **Capture** (the entry point);
**Task** is the first typed entity built on top of it, and **Project** is the
third entity, now being built (slice A1 shipped). Everything else below
(Person, Note…) is a vision draft, not committed.

- **Capture** — the foundational block and the entry point. A single raw line of
  text (a thought, task, idea, anything), untyped and uncommitted, added to
  Captures and later Processed out of it. Fully documented in
  `docs/entities/capture.md`.
- **Task** — the first typed entity (named `Task`, not "Todo", which collides
  with the app name). A clarified next-action with a `showUpDate`, completed out
  of the Today view. Built as a sibling of Capture. Fully documented in
  `docs/entities/task.md`. A Capture becoming a Task (the Capture->Task
  transition) and Task belonging to a Project are the next interactions to
  design.
- **Project** — the first container, now being built as entity #3 (plan:
  `docs/plans/todo-project-entity.md`; source of truth: `docs/entities/project.md`).
  Goal-oriented (baby, diploma, buy a house, watch a movie), sometimes
  maintenance-oriented (a "baby maintenance" project should maybe not exist). Has
  a nice icon (baby face, diploma) and a status (active / next / waiting / backlog
  / done). Slices A1 + A2 shipped: name-only create, a status-grouped list, and a
  detail sheet where the status is changed (Done + inline Undo) on both surfaces;
  slice A3 shipped enrichment in that sheet (curated emoji picker, editable title
  and notes). Slice A (the hand-managed entity) is complete. Vision beyond that:
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
changed field set). The sheet gained a curated emoji icon picker, an editable
title, and an editable notes field on both surfaces; field edits commit on
blur/submit (the icon on tap) and keep the sheet open, while a status pick still
dismisses it. The `icon`/`description` columns existed from A1, so A3 needed no
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
`ICON_CHOICES`, `BACKLOG_COLLAPSE_THRESHOLD`, `DONE_UNDO_MS`). The React hooks
(`useDelayed`, `useLoadError`, `useForegroundRefetch`, and the `useUndoableLeave`
hook that now backs both the Done and Delete undo timers) live in one
`screen-hooks` module **per app**, not in `@zero/agent-core`: a workspace lib
that calls React hooks resolves its own React copy (agent-core's would be 19.2.8
vs the mobile app's pinned 19.2.3) and trips the rules-of-hooks dispatcher, so
agent-core stays React-free. `apps/agent-web` also gained a Vitest +
`@testing-library/react` toolchain and a `ProjectsPage` suite, so the web surface
is no longer untested.

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
  mobile on-device verification (EAS/Maestro) still pending. Also fixed a
  pre-existing durable-collection bug where a deleted row reappeared until refresh
  (see `docs/storage.md`).
- **Automatic appearance.** Mobile and web follow the system light or dark
  preference, including native/browser chrome. See `todo-dark-mode.md` for the
  implementation and device proof.

In flight (details in `docs/plans/`):

- `todo-tanstack-db.md` — share the Capture collection across web+mobile and add
  the mobile offline outbox (phase 3). Code-complete on a branch, device-verified,
  with the offline decision gate still open.
- `todo-capture-animations.md` — quick-add morph + done fade-out.

Next:

- **Project detail as a destination** (implemented on a branch, PR pending;
  mobile on-device verification still pending) — a project opens its own screen
  (web `/projects/:id` route; mobile a pushed screen within the Projects tab),
  not a bottom sheet, leading with its tasks and what it's waiting on. Also fixes
  the broken mobile task/waiting renderer (raw React Native rows inside an
  `@expo/ui` sheet host; a pushed RN screen removes the host). Plan:
  `docs/plans/todo-project-detail-rework.md`.
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
