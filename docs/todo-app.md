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

**Rule-of-Three status (2026-08-30):** **Task** is entity #2, built as a
deliberate structural sibling of Capture at every layer — `DbTaskStore` mirrors
`DbCaptureStore`, the tasks collection mirrors the captures collection, the
mobile `tasks-collection.ts` mirrors `captures-collection.ts` (with its own
SQLite + outbox files), and the web/mobile Today panel mirrors the Captures panel.
The duplication is intentional and kept identical on purpose, so extracting a
shared base (store, collection factory, list screen) is mechanical when entity
**#3** lands. Do not extract before then.

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
full sequence. **Postpone (slice 1) and drag-to-reorder (slice 2) have shipped**
on web and mobile — a capture carries a `showUpDate` and a fractional-index
`sortKey`, and the list orders by that manual key. Next is the detail sheet
(slice 3), then the full scheduler (slice 4).

## Entity wiki (draft — grow one at a time)

Grounding: the foundational block is the **Capture** (the entry point);
**Task** is the first typed entity built on top of it. Everything else below
(Project, Person, Note…) is a vision draft, not committed.

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
- **Project** — goal-oriented (baby, diploma, buy a house, watch a movie).
  Sometimes maintenance-oriented (a "baby maintenance" project should maybe not
  exist). Has a nice icon (baby face, diploma). Can contain Todos, agent
  sessions, documents. Can spin off other Projects and even People. Notify
  dependent Projects when they move; can unblock them. Idea: project "slots",
  start with one slot to teach the game.
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
per-user UserDO. Mobile UI on NativeWind v4 + `@expo/ui`; Clerk sign-in with a
native user button. The Captures data layer runs on TanStack DB (see
`docs/storage.md`). Captures carry a client-minted UUID id (stable end to end,
and the sole idempotency key for offline replay), so adding and processing a
Capture no longer flickers — the row never blinks out-and-back while the write
settles.

Captures loads local-first and reconciles the server in the background; the
shared `capturesView` helper in `@zero/agent-core` gates the list on the row count
so a hydrated snapshot shows at once. See `docs/storage.md` for the mechanics.

Shipped (2026-08-30): **Task**, the first typed entity, and the **Today** view
over it (plan: `docs/plans/todo-task-entity.md`). Built as a sibling of the
Capture stack, web first, then mobile: a `tasks` table + `/api/tasks` in the
per-user UserDO (add is exactly-once on the client-minted id; complete flips
`completedAt`; list returns open tasks); a shared `@zero/agent-core` Task type,
`createTasksApi` collection (local-first, offline outbox), and `todayView` /
`dueToday` / `localToday` helpers; and a **Captures | Today** segmented control on
both web (`/captures`) and mobile home. The active segment is the entry target: the
quick-add mints a Capture on Captures and a Task dated today on Today; the circle
completes. Timezone lives on the client (server returns all open tasks; the live
query filters `showUpDate <= localToday`, so overdue rolls in and future stays
hidden). Mobile device verification (Maestro, Pixel 7) still needs a standalone
EAS build for the durable-snapshot path.

In flight (details in `docs/plans/`):

- `todo-tanstack-db.md` — share the Capture collection across web+mobile and add
  the mobile offline outbox (phase 3). Code-complete on a branch, device-verified,
  with the offline decision gate still open.
- `todo-capture-animations.md` — quick-add morph + done fade-out.

Next:

- **Capture → Task** — Process a Capture into a Task (adds `sourceCaptureId`; not
  yet designed; the richest data-model slice).
- **Reschedule a Task** — swipe-to-tomorrow / pick a future date (v1 dates every
  Task today with no way to change it).
- **Task → Project** — Task belongs to a Project (adds `projectId`).
- later: agent `create_task` tool, recurring capture, recurring Tasks.

Dev infra: a physical Pixel 7 is USB-attached to the dev box and driven with the
Maestro CLI for on-device verification (see `apps/agent-mobile/README.md`). Rules
that still bite: the first use of any native or `@expo/ui` component needs a fresh
EAS dev build before it runs on device (pure-JS changes hot-reload); and this dev
box has no workerd and no Android emulator, so verification is unit tests +
`expo export` + the real phone.
