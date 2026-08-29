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
  `list` = open Inbox, `process`) — that is the value, not CRUD.
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

## Entity wiki (draft — grow one at a time)

Grounding: the foundational block, and the only entity we are certain of, is the
**Capture** — the entry point. Everything else below (Todo, Project, Person,
Note…) is a vision draft, not committed.

- **Capture** — the foundational block and the entry point; the only entity we
  are certain of. A single raw line of text (a thought, task, idea, anything),
  untyped and uncommitted, added to the Inbox and later Processed out of it.
  Fully documented in `docs/entities/capture.md`.
- **Todo** — a typed entity a Capture could become, NOT the entry point. The
  single concrete next step, belongs to a Project.
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

## Dreamy / low-confidence ideas (parked)

- Game-like timeline UI.
- Project slots as a teaching mechanic.
- Zero auto-creating projects from templates instead of the user creating them.

---

## Changelog

- 2026-08-29: The Inbox list now shows each item as a spaced card with more room
  around it, larger tap targets, and a roomier capture bar, on both web and
  mobile.

## Project tracking

Shipped (on main, device-verified): the Capture Inbox on mobile
(`apps/agent-mobile`) and web (unlinked `/inbox`) — add a Capture, Process it out
of the Inbox — backed by the `captures` table and `/api/captures` in the per-user
UserDO. Mobile UI on NativeWind v4 + `@expo/ui`; Clerk sign-in with a native user
button. The Inbox data layer runs on TanStack DB with offline SQLite persistence.
Captures carry a client-minted UUID id (stable end to end, and the sole
idempotency key for offline replay), so adding and processing a Capture no longer
flickers — the row never blinks out-and-back while the write settles.

The Inbox now paints instantly from the local snapshot: the list region gates on
the row count, not the collection's `isLoading`, so a hydrated snapshot shows at
once and the network sync updates it in place instead of a spinner covering
stale rows. The rule lives in a shared `inboxView` helper in `@zero/agent-core`,
used by both the web and mobile screens. Root cause it fixes: the persisted
collection (`persistedCollectionOptions` wrapping a query collection) marks the
collection ready only after the first network `fetchInbox` resolves, so a
fully-hydrated local snapshot sat behind "Loading your inbox…" until the network
answered.

Dev-testing note: the installed dev client loading JS from Metro over USB falls
back to the in-memory Query Collection (persistence throws `Expected
HMRClient.setup() call at startup`), so the durable-snapshot path only runs on a
standalone EAS build, not the dev client. Verify Inbox loading behavior on a
`preview`/`production` build, not `expo start`.

In flight (details in `docs/plans/`):

- `todo-tanstack-db.md` — share the Capture collection across web+mobile and add
  the mobile offline outbox (phase 3). Code-complete on a branch, device-verified,
  with the offline decision gate still open.
- `todo-capture-animations.md` — quick-add morph + done fade-out.

Next:

- **Process into typed entities** — a Capture becomes a typed entity (not yet
  designed; the richest data-model slice).
- **Scheduled show-up date** — an optional date on a Capture plus a "due today"
  view (date <= today + undated; future-dated hidden until their day).
- later: recurring capture.

Dev infra: a physical Pixel 7 is USB-attached to the dev box and driven with the
Maestro CLI for on-device verification (see `apps/agent-mobile/README.md`). Rules
that still bite: the first use of any native or `@expo/ui` component needs a fresh
EAS dev build before it runs on device (pure-JS changes hot-reload); and this dev
box has no workerd and no Android emulator, so verification is unit tests +
`expo export` + the real phone.
