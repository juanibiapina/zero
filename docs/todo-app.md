# From Todoist to Full Assistant

Living doc, tracked in the repo at `docs/todo-app.md` (source of truth). Two
layers: the long-term **Vision** (philosophy + entity wiki) and the **Spec**
(what we actually build next, one small slice at a time). We grow the entity wiki
one entity at a time as we build. Keep the PROGRESS block and build order current
as increments land.

---

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

## Entity wiki (draft — grow one at a time)

- **Todo** — belongs to a Project. Basic actions: add, mark done. First slice.
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

## Spec map (the part we actually build)

story:   Replace Todoist as my task entry point with a parallel app in zero.
decisions:
  - Scope this session to the first shippable slice; vision stays a growing wiki.
  - Surface: extend the existing Expo mobile app (apps/agent-mobile) so there's a
    real dock icon on the phone. It already has Clerk login. Not a PWA. Phone is
    Android (package dev.juanibiapina.zeroagent).
  - Build additive in place (option A): new todos table in the existing UserDO,
    new /api/todos routes, new screen in the existing mobile app. Reuses Clerk
    auth + the DO + app shell; does not touch agent turn logic. Chosen because
    the todo app is meant to BECOME the main way to interact with Zero, with the
    agent living inside it later. Not a separate worker/DO.
  - Verification reality on this dev box: no workerd, no Android emulator. Verify
    via unit tests (pnpm --filter @zero/agent-api test, mobile api test) + a
    real-phone check (expo start on device, or an EAS preview build). No local
    end-to-end.
  - Mobile UI stack: NativeWind v4 (stable) + react-native-reusables (shadcn for
    RN). Chosen to match the web stack (agent-web/dashboard-web/landing already
    on Tailwind 4 + shadcn: agent-web has components.json, packages/ui is the
    shared shadcn lib) for one design language across web+mobile, best
    AI-assisted UI generation, and owned components that suit the bespoke
    game-like vision. NativeWind v5 is preview only; use v4.
    Compat verified (Jan 2026): NativeWind 4.2.6 peers (tailwindcss, reanimated,
    safe-area-context) already satisfied by the app (reanimated 4.5.1,
    safe-area-context 5.7.0, gesture-handler 2.32.0). Both libs ship NO native
    modules, so adopting them needs no new EAS build, only a metro/babel config
    change + `expo start --clear`. New Architecture (SDK 57) supported by v4.
rules:
  - rule: Capture an item to a single flat inbox list
    examples:
      - Type "buy milk", tap add -> "buy milk" appears in the list
  - rule: Optionally set a scheduled "show-up" date (NOT a deadline) while adding
    examples:
      - Add "pay rent", pick tomorrow -> item hidden today, shows up tomorrow
      - Add "call mom" with no date -> shows in the list now
  - rule: See the list = what's due to show up now (scheduled <= today, plus undated)
    examples:
      - Open the app -> today's + undated open items are visible in one list
  - rule: List is hand-ordered; position IS the priority (no priority field)
    examples:
      - New captures append at the bottom
      - User reorders items to set priority (top = do first)
  - rule: Postpone an item to tomorrow (FREQUENT, core action)
    examples:
      - Tap postpone on "call mom" -> leaves today's list, returns tomorrow
  - rule: Mark an item done
    examples:
      - Tap done on "buy milk" -> vanishes from the list instantly (still stored)

deferred (later slices, in rough order):
  - Separate the two roles of the list: a pure capture inbox vs a today/do-list
    (a known Todoist pain the product should fix; not needed to match flow now)
  - Triage: move captured items into Projects (the next-day workflow; richest
    for data-model learning)
  - Use the list as a daily to-do list (second mode of the same surface)
  - Recurring tasks
  - Reminders / push notifications
  - (not used in Todoist today, likely never: subtasks, priorities, labels)

questions:
  - Slice-1 list view: ordering, and what happens to done items (see Q5)

acceptance criteria: matched by the ordered increments below

# Build order (each = one vertical increment, its own PR, shippable + usable).
# "Slice" earlier just meant one of these increments; the sequence is what matters.
#
# PROGRESS (all on main, device-verified):
#   inc 0 UI foundation ......... DONE  commit 368a6c9
#   inc 1 add + list todos ...... DONE  commit 82dc1e7 (works on phone)
#   loading-state fix ........... DONE  commit c46319d (works on phone)
#   UI: Todoist-style quick add . NEXT (not planned yet)
#   inc 2 mark done ............. after
#   inc 3 scheduled date ........ todo
#   inc 4 postpone tomorrow ..... todo
#   inc 5 manual reorder ........ todo
#
# NEXT — UI: Todoist-style quick add (improve the capture UI):
#   - Replace the top inline "Input + Add" row with a circular add button (FAB)
#     pinned bottom-right (Todoist's "Dynamic Add Button", bottom-right).
#   - Tapping it opens an input that is already focused, so the keyboard comes up
#     immediately; type the item and submit to add.
#   - Todoist keeps quick-add fast/capture-focused and lets you add several in a
#     row; consider keeping the input open + cleared after each add.
#   - Check Todoist mobile for inspiration. Plan this when we get to it.
# Local branches increment-0-nativewind / increment-1-todos /
# fix-todos-loading-state are merged to main, not yet deleted.
build order (capture point):
  0. [DONE, on main, commit 368a6c9] UI foundation: adopt NativeWind v4.
     Gotcha found: under pnpm, react-native-css-interop (NativeWind's engine)
     must be a DIRECT dep or Metro can't resolve `react-native-css-interop/
     jsx-runtime` (typecheck passes, bundling fails). Caught via
     `expo export --platform android` (bundles locally, no device/emulator).
     babel-preset-expo also had to be added explicitly once a babel.config.js
     existed. Skipped react-native-reusables CLI init; hand-placed Button/Text in
     src/components/ui with a cn() helper (clsx + tailwind-merge) matching web.
     No changelog entry: pure restyle, no behavior change.
     (original) UI foundation: adopt NativeWind v4 + react-native-reusables. Add tailwindcss,
     metro.config.js (withNativeWind), babel preset, tailwind.config.js (design
     tokens: color/spacing/type), global.css, nativewind-env.d.ts. Scaffold base
     components (Text, Button, Input) via react-native-reusables. Restyle the two
     existing screens (sign-in, home) through them. No behavior change. Verify on
     the real phone with `expo start --clear`. Independently shippable PR.
  1. [DONE, on main, commit 82dc1e7] Walking skeleton: signed-in user adds a text
     item on mobile; it persists in agent-api (per-user store) and shows in a
     list. No done/dates/order yet. Verified on the phone.
  2. Mark done: tap done -> vanishes from list, still stored.
  3. Scheduled date + today view: optional show-up date on add; list shows
     scheduled<=today + undated; future-dated hidden until their day.
  4. Postpone to tomorrow: one-tap reschedule.
  5. Manual reorder: drag to order, persisted. Position = priority.
  # After #5: capture point matches today's Todoist flow (minus recurring).
then later: recurring -> inbox/today split -> triage into Projects

---

## Plan: increment 1 (walking skeleton) — [DONE, commit 82dc1e7; kept for history]

Goal: a signed-in user adds a text todo on the mobile screen; it persists in the
per-user UserDO and shows in a list. No done, no dates, no order yet.

Backend (apps/agent-api):
- Migration `0037_todos.sql`: `todos(id TEXT PRIMARY KEY, text TEXT NOT NULL,
  created_at TEXT NOT NULL)`. id = crypto.randomUUID(). done/date/position land
  in later increments, added by their own migrations.
- Todos store module + schema entry following the existing UserDO db patterns
  (see UserDO/db/schema.ts, migrations.ts).
- UserDO RPC methods on UserDO/index.ts: `addTodo(text): Todo`,
  `listTodos(): Todo[]` (newest last / insertion order for now).
- Route file `routes/todos.ts` (OpenAPIHono, Clerk-authed like
  routes/user-settings.ts): `POST /api/todos {text} -> 201 todo`,
  `GET /api/todos -> { todos }`. Reach the DO via getUserDO(c.env, userId).
- Wire the router into app.ts next to the other /api routes.

Mobile (apps/agent-mobile):
- lib/api.ts: `addTodo(getToken, text)`, `fetchTodos(getToken)` using apiFetch.
- Home screen becomes the todo list: text input + Add button + list of todos.
  Keep sign-out reachable. (This screen is the future main surface.)

Tests:
- UserDO store test: add then list returns the item.
- Route test following user-settings.test.ts: POST then GET round-trips; two
  different users don't see each other's todos (DO isolation).
- Mobile lib/__tests__/api.test.ts: addTodo/fetchTodos hit the right path with
  the Bearer token.

Docs / changelog:
- Add a user-facing bullet to apps/agent-api/CHANGELOG.md (new todo list in the
  app). It ships as Zero's in-product Changelog topic.

Skills to use:
- development-guidelines (throughout), tdd (backend store + routes + mobile api),
  react-testing / front-end-testing (mobile screen), typescript-strict,
  changelog (the entry), git-commit (committing), open-pr (PR).

Acceptance criteria:
- POST /api/todos persists and returns the todo with an id.
- GET /api/todos returns only the caller's todos.
- On the phone: type text, tap Add, the item appears in the list; relaunching
  the app still shows it (persisted).
- lint + typecheck + unit tests green.

---

## Increment 1 + loading fix: DONE, on main, verified on device

Increment 1 = commit 82dc1e7. Loading-state fix = commit c46319d (list shows
"Loading your todos…" until the first fetch settles, instead of flashing the
empty message). Both merged to main and confirmed working on the phone.

Backend: migration 0037_todos.sql + todos schema, store/todos.ts (DbTodoStore),
UserDO addTodo/listTodos RPC, routes/todos.ts (POST/GET /api/todos) wired in
app.ts. Tests: store 3, routes 4. agent-api 928 tests pass, typecheck+lint clean.
Mobile: Input component, addTodo/fetchTodos in api.ts, home screen = Todos
(Input + Add + list). Tests: Input 2, api 2, HomeScreen 2. 14 tests pass,
typecheck+lint clean, expo export bundles.

Learnings (increment 1):
- do-orm ships an in-memory mock storage at `do-orm/src/test-utils`
  (createMockStorage) that runs INSERT/SELECT/ORDER BY, enough to unit-test a
  do-orm store WITHOUT workerd. But it does NOT implement MAX(), so do-orm's
  `migrate()` crashes on it — don't call migrate in those tests; the mock
  creates tables lazily on first insert.
- RN Testing Library: an async onPress handler needs the interactions wrapped in
  `await act(async () => { fireEvent... })`, else the changeText re-render isn't
  flushed and the button fires a stale handler (sees empty text). Product code
  was correct; only the test needed act.
- Used a mapped ScrollView instead of FlatList for the (short) capture list:
  simpler and avoids VirtualizedList act noise in tests. Revisit FlatList if the
  list grows long.

## Plan: loading-state fix (small, mobile only) — [DONE, commit c46319d]

Goal: while the first todo fetch is in flight, show a loading state instead of
the "No todos yet. Add one above." empty message. Distinguish "not loaded yet"
from "loaded and empty".

Only file: apps/agent-mobile/src/app/(signed-in)/index.tsx.

Change:
- Add a `loading` boolean state, initial `true`. In the load effect, set it
  `false` in a `finally` (so both success and error clear it). Keep `todos: Todo[]`
  as is (starts []), and the existing `error` state.
- List area render order: if `loading` -> a loading indicator
  (react-native ActivityIndicator, or a Text "Loading your todos…"); else if
  `todos.length === 0` -> the empty message; else the mapped list. `error` still
  renders above, as now.
- The add flow is unchanged (append to `todos`).

Tests (apps/agent-mobile/src/app/(signed-in)/__tests__/index.test.tsx):
- New: while the fetch is pending (a deferred promise that is not yet resolved),
  the loading indicator is shown and the "No todos yet" message is NOT present.
  Resolve the promise, then assert the empty message appears.
- Existing "shows fetched todos" and "adds a typed todo" tests still pass (they
  resolve the fetch, so loading clears). The add test already waits for the empty
  message after load, which now only appears once loading is false — still valid.

Verification: pnpm --filter @zero/agent-mobile typecheck|lint|test, expo export,
then reload on the phone (Metro job sw5) and confirm a brief loading state, not a
flash of "No todos yet", on launch. No backend change, so no deploy needed; this
is mobile-only and does not touch main's worker.

Skills: tdd (the loading test first), react-testing/front-end-testing, git-commit.

Acceptance:
- On launch, the list area shows a loading state until the first fetch settles.
- After it settles with no todos, the empty message shows; with todos, the list.
- All mobile checks green.

---

## Plan: increment 1 (detailed) — walking skeleton — [DONE, commit 82dc1e7; history]

Self-contained plan for a fresh agent.

Goal: a signed-in user types a todo on the mobile home screen, it POSTs to
agent-api, persists in the per-user UserDO SQLite, and shows in a list that
survives relaunch. No done/date/order (later increments).

Backend patterns (verified in the repo):
- Schema uses `do-orm`: `table()/column()` in `apps/agent-api/src/UserDO/db/
  schema.ts`. Migrations are `.sql` files imported into `db/migrations.ts` as a
  `migrations` object; `UserDO`'s constructor runs `migrate(ctx.storage,
  migrations)` inside `blockConcurrencyWhile`, so a new numbered file auto-applies
  on next DO wake. `createDb(ctx.storage)` gives `this.db: Database`; query
  helpers (`eq`, `asc`, `desc`, `and`) come from `do-orm`.
- The agent's big `Store` interface lives in `store/db.ts` (`DbStore`). Todos are
  a NEW, parallel concern, so DO NOT extend that interface. Add a dedicated
  small `TodoStore` (own module) over `Database`, keeping todos decoupled from
  the agent. This matches the "additive, non-interfering, becomes its own app"
  decision.
- Routes: OpenAPIHono routers mounted in `app.ts`. `/api/*` already has
  `clerkMiddleware()` + a guard that sets `c.get("userId")` (verified Clerk
  user). Reach the DO via `getUserDO(c.env, userId)` (`UserDO/stub.ts`).
  Follow `routes/user-settings.ts` for shape.

Backend changes:
1. `db/migrations/0037_todos.sql`: create table `todos` — `id TEXT PRIMARY KEY`,
   `text TEXT NOT NULL`, `created_at TEXT NOT NULL`. Register `m0037` in
   `db/migrations.ts` (import + add to the `migrations` object).
2. `db/schema.ts`: add `todos` do-orm table matching the migration (camelCase
   keys: `id`, `text`, `createdAt`).
3. `store/todos.ts`: `TodoStore` class over `Database` with `add(text): Todo`
   (id = crypto.randomUUID(), createdAt = new Date().toISOString()) and
   `list(): Todo[]` (order by createdAt asc). Pure over the db; unit-testable
   with an in-memory do-orm db like other store tests.
4. `UserDO/index.ts`: construct a `TodoStore` in the constructor; add RPC
   methods `addTodo(text: string): Promise<Todo>` and `listTodos():
   Promise<Todo[]>` delegating to it.
5. `routes/todos.ts`: `POST /api/todos { text } -> 201 { todo }` and
   `GET /api/todos -> 200 { todos }`, both reading `c.get("userId")` and calling
   the DO. Validate `text` non-empty with zod. Mount in `app.ts` after the auth
   guard, next to `createUserSettingsRoutes()`.

Mobile changes (agent-mobile, built on increment 0's NativeWind + components):
6. `src/components/ui/input.tsx`: base text input styled with className (mirrors
   Button/Text pattern).
7. `src/lib/api.ts`: `addTodo(getToken, text)` (POST) and `fetchTodos(getToken)`
   (GET), using the existing `apiFetch`. Add a `Todo` type.
8. `src/app/(signed-in)/index.tsx`: replace the settings demo with the todo
   screen — an Input + Add button that calls `addTodo` then refreshes, and a list
   (FlatList) of todos from `fetchTodos`. Keep sign-out reachable (e.g. header
   or footer). Loading + error states.

Tests:
- `store/todos.test.ts`: add then list round-trips; list is per-store isolated.
- `routes/todos.test.ts` (follow `user-settings.test.ts`): POST then GET
  round-trips through a real UserDO; two different `userId`s don't see each
  other's todos (DO isolation).
- `src/lib/__tests__/api.test.ts`: extend — addTodo/fetchTodos hit the right
  path/method with the Bearer token.
- `src/components/ui/__tests__/input.test.tsx`: renders, onChangeText fires.

Docs / changelog:
- Add a user-facing bullet to `apps/agent-api/CHANGELOG.md` (this ships as Zero's
  in-product Changelog topic): a new todo list in the app where you add items
  and see them. This IS user-observable, unlike increment 0.

Verification (this dev box: no workerd, no emulator):
- `pnpm --filter @zero/agent-api test`, `pnpm --filter @zero/agent-api typecheck`,
  `pnpm --filter @zero/agent-api lint` for backend.
- `pnpm --filter @zero/agent-mobile typecheck|lint|test` and
  `expo export --platform android` for the mobile bundle.
- On the phone: expo start (gob job, .env.local has the Clerk key), add a todo,
  see it, relaunch, still there. Note: mobile calls EXPO_PUBLIC_API_URL (default
  https://zero.juanibiapina.dev per README) — the /api/todos routes must be
  deployed (push to main) for the phone to reach them, since no local worker runs
  here. So: land the backend on main first, then verify on device.

Skills to use:
- development-guidelines (throughout), tdd (backend store + routes + mobile api +
  Input), typescript-strict, react-testing/front-end-testing (mobile),
  changelog (the entry), git-commit (committing), open-pr (if a PR).

Acceptance criteria:
- POST /api/todos persists and returns the todo with an id; GET returns only the
  caller's todos.
- On the phone: type text, tap Add, item appears; relaunch still shows it.
- All backend + mobile checks green; expo export bundles.

Open decision to confirm before building:
- API base URL for the phone. The dev client hits the DEPLOYED worker
  (zero.juanibiapina.dev / production UserDO). Fine for a single-user dogfood,
  but it means increment 1's backend must be on main before the device test,
  and todos land in the same production UserDO as the agent. Acceptable given
  the "additive in the same DO" decision; flag if you'd rather point the app at
  a separate/staging URL.
candidate terms:
  - Entity-as-block: each entity type must define its interactions with all app systems
  - Slot: a capacity limit on active projects, possibly a teaching mechanic
  - Workflow: entity-aware procedure (e.g. process-email) beyond a plain prompt
