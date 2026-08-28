## Plan: adopt TanStack DB for the Capture Inbox data layer (spike-first)

STATUS: Phase 0 + Phase 1 + Phase 2 DONE; Phase 3 (share + mobile) code-complete
on branch tanstack-phase-3-mobile, DEVICE-VERIFIED on EAS dev build 18 (Pixel 7,
Maestro) with ONE known gap. Verified working on device: the migration (the Inbox
loads real captures through the shared TanStack DB collection on the durable
op-sqlite path — no fallback, no native errors once build 18 shipped the natives),
online capture (FAB -> type -> the row appears), online Process (tap the circle ->
the row leaves), and durable READS (both databases/zero-inbox.sqlite ~176KB synced
snapshot and databases/zero-inbox-outbox.sqlite exist; the Inbox renders instantly
from the local snapshot). OFFLINE WRITES: durable and syncing (device-verified). A capture made while
offline shows in-session and is persisted to the op-sqlite outbox; on reconnect it
replays its POST, drains the outbox, and the synced row appears in the live view.
Two fixes were needed and are in the code: (1) the replay mutationFns refresh the
live view via collection.utils.refetch() (a bare queryClient.invalidateQueries does
NOT refresh a persisted collection); (2) a lenient online detector (online =
netinfo isConnected, not gated on the slow isInternetReachable probe) so a
same-session reconnect replays promptly instead of only on the next app launch.
Verified on device: offline capture -> wifi on -> both queued writes POST within
~20s and render, outbox drains to 0, nothing lost across many offline/online
cycles. REMAINING EDGE (data-safe, not fixed): a pure offline COLD start (app
killed, reopened while still offline) gets stuck on a loading spinner and does not
show the Inbox or the pending capture — Clerk needs the network to restore the
session, and the collection build is gated behind it. The queued write is safe in
the outbox and syncs once the app is online again; this is a Clerk-offline +
cold-start concern beyond the captures data layer. EAS gotcha recorded: the
first two rebuilds (16, 17) returned a cached artifact with the SAME fingerprint
(73bc4af) as the pre-deps build and byte-identical APKs; `eas build --clear-cache`
forced a genuine native recompile (build 18) that actually links op-sqlite. Also:
`unzip` is absent on this box — inspect an APK with python zipfile, not unzip, or
you get false "missing native" readings. Phase 0+1 shipped in PR #50 (merge
99b03e1); Phase 2 (offline SQL persistence) shipped in PR #51 (commit 44f145e on
main). Phase 0+1 shipped
in PR #50 (merge 99b03e1); Phase 2 (offline SQL persistence) shipped in PR #51
(commit 44f145e on main). Phase 3 as built: the Capture collection factory now
lives in packages/agent-core (createCapturesApi + Capture, injecting QueryClient,
auth-bound REST, and a platform persistence + offline executor); web
captures-collection.ts became a thin adapter (browser persistence + cookie REST,
behavior + bundle unchanged — main chunk 550KB/162KB gzip); the mobile Inbox was
moved off its React Query hooks (lib/captures.ts, deleted) onto the shared
collection with op-sqlite persistence (@tanstack/react-native-db-sqlite-persistence
@0.2.18, peer @op-engineering/op-sqlite@18 — the RN adapter takes op-sqlite, NOT
expo-sqlite) and a React Native offline outbox
(@tanstack/offline-transactions/react-native + @react-native-community/netinfo),
whose durable store is a small op-sqlite KV StorageAdapter (RN has no IndexedDB).
Native imports are lazy so jest and any client without the native modules fall
back to the shared in-memory collection. Gotchas found and fixed: (1) agent-core's
TanStack deps must be peerDependencies (not deps) or pnpm makes a second
offline-transactions instance and the OfflineExecutor types stop matching; each
app carries the TanStack packages directly, react-query pinned to one version;
(2) Hermes has no Web Crypto, and @tanstack/db's safeRandomUUID needs
crypto.getRandomValues, so a mobile crypto polyfill from expo-crypto is imported
first in _layout.tsx; (3) jest could not parse fractional-indexing (pure ESM
pulled by @tanstack/db) under pnpm's nested node_modules — fixed by allowlisting
it in the app's transformIgnorePatterns; (4) the query collection leaves a
background timer, so the mobile jest script runs with --forceExit; the collection
is cleaned up on unmount. Checks green: agent-core + web typecheck/lint/build,
mobile typecheck/lint, 29 mobile tests, expo export (Android bundle 6.8MB). /inbox now runs on a TanStack DB collection persisted to SQLite/OPFS for
offline reads, with writes through an IndexedDB-backed offline outbox
(@tanstack/offline-transactions, Option A) that retries on reconnect; it falls
back to the in-memory Query Collection when OPFS/Worker is unavailable (private
browsing, older browsers) so /inbox never hard-crashes. A partial index
(migration 0040, on captures(createdAt) WHERE processedAt IS NULL) keeps the
Inbox query fast. Real package names as shipped: persistence is
@tanstack/browser-db-sqlite-persistence@0.2.18 (re-exports
persistedCollectionOptions; NOT @tanstack/db@0.8.5 core) over wa-sqlite, plus
@tanstack/offline-transactions@1.0.51. Two stores by design: SQLite/OPFS for the
synced read snapshot, IndexedDB for the write outbox. Measured bundle (vite
build, 2026-08-27): the main app chunk is 575KB raw / 169KB gzip (SMALLER than
Phase 1's 609KB — the WASM persistence moved off the main path into a separate,
lazily-loaded worker chunk of 1,698KB raw / 706KB gzip that loads only when OPFS
persistence starts; no standalone .wasm, wa-sqlite is bundled into that worker).
The 0.6-era API names in the "Concrete API" note above are STALE; the Phase 2
plan below carries the corrected 0.8.x names.

STILL OPEN — the deploy-time DECISION GATE (before Phase 3 / mobile): verify real
offline behavior in a browser on the deployed /inbox — offline read (DevTools
offline, reload, last-synced captures render), offline write (capture offline,
reload survives, syncs on reconnect), and the C1 runtime check (the opfs-worker
chunk + wa-sqlite return 200, no 404). This box cannot run it (no workerd, no
browser); it is a post-deploy check. C3 caveat is now FIXED in TanStack Phase 5
(see that plan below): /api/captures dedupes on an Idempotency-Key header carrying
the offline executor's per-write key, so a lost-ACK retry no longer duplicates.

Self-contained plan for a fresh agent. Assume only this doc.

### Goal

Replace the ad-hoc data layers (web hand-rolled `fetch`, mobile React Query, both
over the DO REST API) with ONE local-first data layer built on **TanStack DB**,
giving instant/optimistic writes, offline persistence, and query-driven auto-sync,
shared across web and mobile. Land it spike-first on the isolated web `/inbox`,
prove it, then migrate mobile. Backend stays Cloudflare + the per-user DO +
do-orm + the existing `/api/captures` REST endpoints — no Postgres, no backend
rewrite.

### Why TanStack DB (decision, from a research pass 2026-08-27)

Compared against Zero, ElectricSQL, PowerSync, TinyBase, Legend-State,
WatermelonDB, RxDB, LiveStore, Triplit, Jazz. Most are Postgres/own-backend
engines that fight the Cloudflare per-user DO model. The two that keep the DO
backend and share web+mobile were TinyBase and TanStack DB. Chose TanStack DB:
it reuses the React Query mutation model the mobile app already uses (lowest
learning delta), keeps do-orm + the REST API, persists to SQLite on web (WASM),
Expo/RN, and even Cloudflare Durable Objects (0.6), and its **live-query engine
with joins** is the right foundation for the future typed-entity model
(Captures joined to Projects, Persons, etc.). Accepted tradeoff: Query
Collections are query-driven (refetch/poll), NOT real-time server push. For a
single-user Inbox this is fine; real-time multi-device is a later, optional
add (a custom DO-WebSocket collection or an Electric/PowerSync collection) that
does not throw away the collections + live queries built now. TinyBase's one
edge was a turnkey `WsServerDurableObject` push hub; we trade that for TanStack's
query DX and React-Query reuse.

### Concrete API (grounded in the 0.6 docs; confirm exact package names at impl)

- Packages: `@tanstack/db` (core `createCollection`), `@tanstack/react-db`
  (`useLiveQuery`), `@tanstack/query-db-collection` (`queryCollectionOptions`).
  Persistence (new in 0.6): `persistedCollectionOptions({ persistence,
  schemaVersion, ...<synced options> })` with per-platform SQLite adapters
  (browser SQLite WASM; RN `createReactNativeSQLitePersistence` over op-sqlite or
  expo-sqlite). Durable offline writes: `@tanstack/offline-transactions`. Pin
  versions; these are young (0.6) and churn.
- A capture collection wraps the Query Collection:
  `createCollection(queryCollectionOptions({ queryClient, queryKey:
  ['captures'], queryFn: fetchInbox, getKey: c => c.id, onInsert, onUpdate }))`.
  After any mutation handler resolves it auto-refetches (pass `{ refetch: false }`
  to skip when the server response is applied directly).
- Mutations map to the existing REST:
  - `onInsert` -> `addCapture(text)` (POST /api/captures)
  - `onUpdate` when `processedAt` is set -> `processCapture(id)`
    (POST /api/captures/{id}/process). Process is modeled as an UPDATE that
    stamps `processedAt`; the Inbox live query filters `processedAt == null`, so
    a processed row leaves the view (and stays available for a future
    "processed" view). No delete endpoint exists, so no `onDelete`.
- Read via `useLiveQuery(q => q.from({ c: capturesCollection })
  .where(({ c }) => c.processedAt == null).orderBy(({ c }) => c.createdAt))`.

### Where the code lives

Target: a shared factory `createCapturesCollection({ queryClient, persistence })`
in `packages/agent-core` (today an empty placeholder — this grows it), so the
collection definition, schema, and live queries are shared; each app injects its
platform QueryClient + persistence adapter. The spike MAY start inline in
`apps/agent-web` and extract to `agent-core` when mobile is brought in (Phase 3),
to avoid cross-package wiring before the model is proven.

### Phased plan (each phase independently shippable; a gate before mobile)

- Phase 0 [DONE, PR #50] — toolchain de-risk. Add the deps to `apps/agent-web`; a throwaway
  module that builds a trivial collection + live query. Verify
  `pnpm --filter @zero/agent-web typecheck | lint | build` (esp. that SQLite-WASM
  persistence bundles and its size is acceptable). On mobile, verify
  `expo export` still bundles with the RN persistence dep added. STOP if the
  toolchain fights (esp. Expo native SQLite = a new EAS dev build; see Risks).
- Phase 1 [DONE, PR #50] — web `/inbox` on a Query Collection (in-memory, no persistence).
  Add `@tanstack/react-query` + a `QueryClient` to `agent-web` (it has none
  today). Rebuild `InboxPage` on `capturesCollection` + `useLiveQuery`, with
  optimistic `onInsert`/`onUpdate` calling the existing `lib/captures.ts` REST
  helpers. Removes the hand-rolled `useState`/`useEffect`. Same behavior:
  capture appends, list oldest-first, Process removes, rapid capture,
  loading/empty/error. Still behind the unlinked `/inbox` — zero blast radius.
- Phase 2 [DONE, PR #51, commit 44f145e] — web offline SQL persistence. See the
  dedicated plan below ("Plan: Phase 2 — web offline SQL persistence") for the 0.8.x
  package names and the write-path design. In short: wrap the Query Collection
  in `persistedCollectionOptions` from `@tanstack/browser-db-sqlite-persistence`
  (SQLite-WASM/OPFS, durable reads) and route writes through
  `@tanstack/offline-transactions` (IndexedDB outbox, durable writes). PROVE:
  load `/inbox` offline (devtools offline) and last-synced captures render;
  capture while offline and it persists + syncs on reconnect.
- DECISION GATE. Evaluate DX, bundle size, and real offline behavior on the
  deployed `/inbox` before touching mobile or committing further. Cheap to
  abandon here (web `/inbox` is unlinked, no tests, no other consumer).
- Phase 3 — share + migrate mobile. Extract `createCapturesCollection` to
  `packages/agent-core`; consume it from both apps. Migrate the mobile Inbox off
  React Query hooks (`lib/captures.ts` hooks) onto the shared collection, with the
  RN SQLite persistence adapter. NOTE: local SQLite on mobile is a NATIVE module
  (op-sqlite/expo-sqlite) => a new EAS dev-client build (the app has NO local
  SQLite today; do-orm runs on the DO, not the device). Keep the existing mobile
  behavior tests green as the guard; adapt them to the collection.
- Phase 4 — real-time push (DEFERRED, not now). If multi-device live sync is
  ever needed, add a custom DO-WebSocket collection (or an Electric/PowerSync
  collection) without discarding the collections + live queries. Explicitly out
  of scope for this adoption.

### Backend impact

None for phases 0-3: the REST endpoints and do-orm stay. `queryFn` calls
`GET /api/captures`; handlers call the existing POST endpoints. Optional later:
add `loadSubset`/incremental sync or a WebSocket for Phase 4.

### Tests

`agent-web` has no test harness, so Phases 1-2 verify via typecheck + lint +
build + a deployed browser check (matches the app; the REST API is already
tested). Mobile (Phase 3) keeps its existing behavior tests as the guard, adapted
to the collection. Standing up Vitest Browser Mode for the web Inbox is a flagged
follow-up (front-end-testing skill), not a blocker.

### Verification (this box: no workerd, no emulator)

- Web: `pnpm --filter @zero/agent-web typecheck | lint | build`. No local
  end-to-end (the dev `/api` proxy needs workerd, which this box can't run);
  verify on the deployed `zero.juanibiapina.dev/inbox` after each phase (Phase 2:
  toggle devtools offline).
- Mobile (Phase 3): `pnpm --filter @zero/agent-mobile test | typecheck | lint` +
  `expo export`; device-verify over Metro (and a new EAS build for the native
  SQLite module).

### Risks & mitigations

- Young libraries (0.6), API churn -> pin versions; keep the spike isolated on
  `/inbox`; the DECISION GATE lets us bail cheaply.
- Mobile local SQLite = native module = new EAS build and added bundle/native
  surface -> confirm in Phase 0 `expo export`; treat Phase 3 as its own EAS-build
  increment; Phase 1-2 (web) need no native module (WASM).
- Web bundle size (SQLite WASM is hundreds of KB) -> measure in Phase 0; if
  unacceptable, fall back to a lighter web persistence (localStorage collection)
  or ship Phase 1 (in-memory) only and reconsider.
- Two apps eventually depend on `agent-core` with platform-specific adapters ->
  share only the collection definition/factory; inject QueryClient + persistence
  per app.
- do-orm vs collection shape -> the DO keeps do-orm + the `captures` table as the
  source of truth; TanStack DB is a CLIENT layer over the REST API, not a second
  server store. No server data-model change.

### Skills to use

- evaluate-existing-solutions — the library choice is made; revisit only if
  Phase 0/gate surfaces a blocker.
- development-guidelines — throughout. typescript-strict — collection schema +
  handler types. codebase-design — the `createCapturesCollection` factory
  contract in agent-core (Phase 3). git-commit — commits. open-pr — per phase.
- react-testing / front-end-testing — only if the optional web test harness lands.

### Acceptance criteria

- Phase 1: `/inbox` runs on a TanStack DB Query Collection + live query;
  capture/list/Process behave exactly as today; web checks green.
- Phase 2: `/inbox` shows last-synced captures while offline and queues+retries
  offline writes; verified on deploy.
- Phase 3: web + mobile share one `createCapturesCollection` from agent-core;
  mobile behavior tests green; mobile device-verified on a fresh EAS build.
- Backend unchanged across Phases 0-3; no Postgres introduced.

---

## Plan: Phase 3 — share the Capture collection and migrate mobile

Self-contained plan for a fresh agent. Assume only this doc. Grounded in the repo
and the adapters' 0.2.18 / 1.0.51 npm metadata (2026-08-27).

### Goal

Give web and mobile ONE shared Capture data layer, then move the mobile Inbox off
its React Query hooks onto that shared TanStack DB collection, with durable
offline SQLite on the phone (the same local-first behavior web got in Phase 2).
Extract the collection factory into `packages/agent-core` so the collection
definition, live-query filter, optimistic helpers, and the offline write path are
defined once; each app injects its platform QueryClient, its auth-bound REST
functions, and its platform persistence + offline executor. Backend, DO, do-orm,
and the `/api/captures` REST endpoints stay unchanged. This runs the DECISION
GATE first (see below): do NOT start Phase 3 until the deployed web `/inbox`
offline behavior is confirmed.

### Preconditions (gate before any code)

- Phase 2 DECISION GATE passed on the deployed web `/inbox`: offline read, offline
  write + reconnect sync, and the C1 runtime check all hold. Phase 3 hardens the
  same design on a second platform; do not port an unproven design.
- Cut Phase 3 as its OWN EAS-build increment. It adds native modules (see below),
  so a JS-only hot-reload cannot run it on device; a fresh EAS dev build is
  mandatory (same hazard the keyboard-controller and @expo/ui increments hit).

### Current state (verified in repo)

- Mobile Inbox (`apps/agent-mobile/src/app/(signed-in)/index.tsx`) reads/writes via
  React Query hooks in `src/lib/captures.ts` (`useInbox` / `useAddCapture` /
  `useProcessCapture`), which call the Bearer-token REST helpers in `src/lib/api.ts`
  (`fetchInbox` / `addCapture` / `processCapture`, each taking a `getToken`). The
  root `_layout.tsx` wraps the app in a tuned `QueryClientProvider`
  (`createQueryClient`: retry/backoff, `refetchOnReconnect`, 30s `staleTime`) and
  bridges React Query `focusManager` to `AppState`.
- Web Inbox already runs the target design: `apps/agent-web/src/lib/captures-collection.ts`
  exposes a `CapturesApi` = `{ collection, add(text)->Transaction,
  process(id)->Transaction, offline }` via `getCapturesApi()`, which tries a
  persisted collection (wa-sqlite/OPFS + `@tanstack/offline-transactions` outbox,
  Option A: collection has NO server-calling handlers, all writes flow through the
  executor's `mutationFns`) and falls back to an in-memory Query Collection on
  `PersistenceUnavailableError`. `InboxPage.tsx` reads with `useLiveQuery`
  (`isNull(processedAt)`, `orderBy createdAt asc`) and surfaces write errors via
  `tx.isPersisted.promise.catch`. Web auth is the same-origin COOKIE, so its REST
  helpers take no token.
- `packages/agent-core` is an empty placeholder (`src/index.ts`, no deps). This
  plan grows it.
- Mobile has NO local SQLite today (do-orm runs on the DO, not the device) and no
  native persistence deps.

### The auth split is the core design constraint

Web REST helpers are token-free (cookie); mobile REST helpers take a `getToken`
(cross-origin Bearer). So the shared factory must NOT import either app's
`captures.ts`/`api.ts`. It takes the three REST functions as INJECTED
dependencies, already auth-bound by the caller:

```ts
type CapturesRest = {
  fetchInbox: () => Promise<Capture[]>;
  addCapture: (text: string) => Promise<Capture>;
  processCapture: (id: string) => Promise<Capture>;
};
```

- Web injects closures over its cookie `fetch` helpers (no token).
- Mobile injects closures that bind `getToken`: e.g. `fetchInbox: () =>
  apiFetchInbox(getToken)`. Because `getToken` is only valid once signed in, the
  mobile collection must be BUILT INSIDE the signed-in tree, not at module scope
  like web. See "Mobile token binding" below.

### What moves into `packages/agent-core` (the shared contract)

Extract the platform-agnostic core of the web `captures-collection.ts`, parameterized:

- `type Capture` (`id`, `text`, `createdAt`, `processedAt: string | null`) — the
  shared entity type (today duplicated in web `lib/captures.ts` and mobile
  `lib/api.ts`).
- `type CapturesApi` = `{ collection, add(text)->Transaction,
  process(id)->Transaction, offline: boolean }` — the caller contract both
  Inbox screens already speak.
- `optimisticCapture(text)`, `markProcessed(draft)`, the `isNull(processedAt)` +
  `orderBy(createdAt asc)` live-query shape (export a helper or document the query
  so both pages stay identical).
- `createInMemoryApi({ queryClient, rest })` — the fallback Query Collection with
  server-calling `onInsert`/`onUpdate` handlers built from `rest`.
- `createPersistedApi({ queryClient, rest, persistence, startOfflineExecutor })` —
  the Option A path: persisted collection with NO handlers, writes through an
  injected `startOfflineExecutor`. `persistence` and `startOfflineExecutor` are
  injected because their imports are platform-specific (web `@tanstack/*` browser
  vs RN subpaths); agent-core must not import a platform SQLite engine.
- `createCapturesApi(deps)` — try persisted, catch and fall back to in-memory
  (the web `getCapturesApi` try/catch, made reusable).

agent-core depends on the platform-agnostic `@tanstack/db`,
`@tanstack/query-db-collection`, `@tanstack/react-query`,
`@tanstack/db-sqlite-persistence-core` (types only) and `@tanstack/offline-transactions`
core types — NOT `browser-db-sqlite-persistence` and NOT
`react-native-db-sqlite-persistence`. Each app owns its platform adapter and
passes the built `persistence` + `startOfflineExecutor` in. Keep agent-core
free of React and RN imports so the DO/worker could reuse `Capture` later.

Codebase-design note: the value of this factory is the SHARED collection
definition + write path, not CRUD. Inject the three things that genuinely differ
per platform (QueryClient, auth-bound REST, persistence/executor). Do not widen it
into a generic entity store (see the per-entity data-store decision at the top of
this doc).

### Mobile-specific pieces

- Native deps (BOTH require a new EAS dev build):
  - `@tanstack/react-native-db-sqlite-persistence@0.2.18`, exporting
    `createReactNativeSQLitePersistence({ database })`; its peer is
    `@op-engineering/op-sqlite@^15.2.5` (op-sqlite specifically — this CORRECTS the
    earlier doc note that said op-sqlite OR expo-sqlite; the official RN adapter
    takes an `OpSQLiteDatabaseLike`). op-sqlite supports Expo via autolinking /
    its config plugin; add it and prebuild.
  - `@tanstack/offline-transactions` imported from its `/react-native` subpath, with
    peer `@react-native-community/netinfo` (>=11) for RN online/offline detection
    (the web build used `window.online/offline`; RN has neither). netinfo is an
    Expo-compatible native module.
  - Pin exact versions (adapters are 0.2.x, young, churn expected). Version compat:
    the RN adapter and `offline-transactions@1.0.51` both target
    `@tanstack/db@0.8.5`, the version web already pins.
- Open the op-sqlite database and build the RN persistence in a mobile-only module
  (e.g. `src/lib/captures-collection.native.ts`), then hand `persistence` +
  `startOfflineExecutor` (from the RN subpath) to `createCapturesApi`.
- Token binding: build the collection once inside the `(signed-in)` tree where
  `getToken` from `useAuth()` is valid. Options, in order of preference:
  (1) a `CapturesProvider` mounted in `src/app/(signed-in)/_layout.tsx` that
  memoizes `getCapturesApi` bound to the current `getToken` and exposes it via
  context; the Inbox screen consumes it with `useLiveQuery`. This mirrors web's
  single async init but scoped to the session, and it disposes/rebuilds on
  sign-out. Do NOT put the collection at module scope (web can because cookie auth
  is always valid; mobile cannot).
- Keep the tuned mobile `QueryClient` (`createQueryClient`) as the collection's
  `queryClient` so the flaky-radio retry/backoff + `refetchOnReconnect` +
  `AppState` focus bridging still apply. The offline outbox handles WRITES;
  React Query still governs the READ `queryFn` refetch.

### Mobile screen migration (behavior-preserving)

Rebuild `src/app/(signed-in)/index.tsx` to consume the shared `CapturesApi`:

- Read: `useLiveQuery(q => q.from({ c: api.collection }).where(isNull(processedAt))
  .orderBy(createdAt asc))` replaces `useInbox`.
- Write: `api.add(text)` / `api.process(id)` (returning a `Transaction`) replace
  `useAddCapture` / `useProcessCapture`; surface errors via
  `tx.isPersisted.promise.catch` (same pattern web uses), mapped to the existing
  `ErrorText`/error state.
- KEEP every mobile-only affordance exactly as is: the FAB quick-add morph,
  `KeyboardStickyView` bar, rapid capture, `ConfirmDialog` discard flow, Android
  `BackHandler`, the `Animated.FlatList` with `LinearTransition` + `FadeIn/FadeOut`,
  and the load-error-only-when-empty rule. This is a data-layer swap, not a UI
  change.
- Delete `src/lib/captures.ts` (the React Query hooks) once the screen no longer
  imports it. `src/lib/api.ts` REST helpers STAY (the mobile-bound closures wrap
  them); dedupe the `Capture` type to the agent-core one.

### Tests (keep the existing mobile behavior tests as the guard)

- jest has NO op-sqlite / netinfo native modules, so in the test environment
  `createCapturesApi` MUST fall back to the in-memory Query Collection (same
  fallback that protects web private-browsing). This keeps tests native-free — do
  not mock op-sqlite. Verify the fallback path triggers cleanly under jest-expo.
- `src/app/(signed-in)/__tests__/index.test.tsx` already mocks `@/lib/api` and
  drives the real hooks through it. Adapt it to drive the collection: keep mocking
  the REST functions (the in-memory fallback's handlers call them), assert the same
  behaviors — capture appends, list oldest-first, Process optimistic-remove, rapid
  capture, empty/loading/error. It may need to `await` the async `getCapturesApi`
  init (the render is already async; see the quick-add async-render gotcha in
  PROGRESS).
- `src/lib/__tests__/api.test.ts` (REST helpers hit the right paths with Bearer)
  stays as-is. Add a small agent-core unit test for `createInMemoryApi`
  (add->list->process round-trip) if a harness is cheap; the factory is the new
  shared seam.
- If `useLiveQuery` needs a jest shim under jest-expo, add it to `jest.setup.js`
  (same place the reanimated `Animated.FlatList` and keyboard-controller mocks
  live).

### System-wide impact

- No backend change. `queryFn` still `GET /api/captures`; writes still POST to the
  existing routes. C3 duplicate-on-retry caveat carries over to mobile (no server
  idempotency key); accept rare duplicates for the spike.
- New native surface on mobile (op-sqlite + netinfo) -> a new EAS dev-client build
  and a bundle-size bump; measure `expo export` output and record it. This is the
  app's second and third native deps beyond the Expo/RN + keyboard-controller
  baseline.
- Web is refactor-only: `captures-collection.ts` becomes a thin adapter that
  injects the browser persistence + web REST closures into the shared factory. Web
  behavior must not change; it already passed its gate.

### Verification (this box: no workerd, no emulator)

- agent-core + web: `pnpm --filter @zero/agent-core typecheck | lint`,
  `pnpm --filter @zero/agent-web typecheck | lint | build` (web still green,
  behavior unchanged, bundle unchanged).
- Mobile: `pnpm --filter @zero/agent-mobile test | typecheck | lint`, then
  `expo export` (bundles with the two native deps added — record size). Native
  code cannot run under jest; the in-memory fallback covers tests.
- Device: cut a new EAS dev build (native modules). Device-verify on the Pixel 7
  via the Maestro CLI: Inbox loads real captures; capture + Process work; then the
  offline proof — airplane mode ON, capture a thought, kill+relaunch (still
  offline) the item survives, airplane mode OFF, it syncs to the same UserDO
  (confirm it shows on web `/inbox`). This is the mobile mirror of Phase 2's
  offline read/write proof.

### DECISION GATE (after mobile)

With web + mobile both on the shared collection, decide whether local-first
TanStack DB is the committed data layer for every future entity (Todo, Project,
Person…) or whether the Capture Inbox keeps it while richer entities take another
path. Record the call here.

### Docs / changelog

- No `apps/agent-api/CHANGELOG.md` entry (todo app is a separate surface; the
  mobile Inbox already shipped there). Record mobile-user-visible offline behavior
  here in PROGRESS on completion, plus: the shared `agent-core` factory contract,
  that mobile persistence is op-sqlite (not expo-sqlite), the netinfo dep, the new
  EAS build, and the measured mobile bundle delta.

### Skills to use

- codebase-design — the `createCapturesApi` factory contract in agent-core (the
  central design act; keep it a deep module with injected platform seams, not a
  generic store). structure-codebase — where the shared factory and the two
  platform adapters live. evaluate-existing-solutions — library choice is made;
  revisit only if the RN adapter or op-sqlite fights Expo at the spike.
  development-guidelines, typescript-strict — factory + injected-dependency types.
  refactoring — web is a behavior-preserving refactor onto the shared factory
  (green build as guard). tdd / react-testing — keep the mobile behavior tests
  green through the swap. git-commit, open-pr — per increment (agent-core extract
  + web refactor as one PR; mobile migration + EAS build as its own PR).

### Suggested increments (each its own PR)

- 3a — extract `createCapturesApi` + `Capture` + helpers into `packages/agent-core`;
  refactor web `captures-collection.ts` to consume it (inject browser persistence +
  cookie REST). Web behavior + bundle unchanged; web checks green. No mobile change.
- 3b — mobile toolchain de-risk: add op-sqlite, netinfo, the RN persistence adapter
  + offline-transactions/react-native (pinned). A throwaway module opens an
  op-sqlite DB and builds a persisted collection; `expo export` bundles; record the
  size delta. STOP if op-sqlite/Expo prebuild fights.
- 3c — mobile migration: build the RN adapter module + `CapturesProvider` (token
  binding), swap the Inbox screen onto the shared collection, delete
  `lib/captures.ts`, adapt the tests (in-memory fallback under jest). Cut a new EAS
  dev build and device-verify the offline proof.

### Risks & mitigations

- Native modules (op-sqlite, netinfo) => new EAS build and Expo prebuild friction ->
  isolate in 3b, prove `expo export` + a dev build before touching the screen; op-sqlite
  supports Expo autolinking. If op-sqlite won't prebuild cleanly, fall back to
  reads-only persistence or ship mobile on the in-memory collection (parity with
  web Option B) and defer durable offline writes.
- Token binding (getToken only valid signed-in) -> build the collection inside the
  `(signed-in)` tree via a provider; never module-scope on mobile.
- Test env has no native SQLite -> rely on the in-memory fallback under jest; do not
  mock op-sqlite. Confirm the fallback triggers.
- C3 duplicate-on-retry (no server idempotency key) -> carries to mobile; accept
  rare duplicates for the spike, note that exactly-once needs a backend key.
- Young libraries (0.2.x adapters) -> pin exact versions; the shared factory keeps
  the churn in one place.
- Web regression during the extract -> web already passed its gate; treat 3a as a
  pure refactor with the green build as the guard, no behavior or bundle change.

### Acceptance criteria

- Web + mobile both consume ONE `createCapturesApi` from `packages/agent-core`;
  the `Capture` type is defined once.
- Mobile Inbox behavior is unchanged (capture, oldest-first list, Process
  optimistic-remove + rollback, rapid capture, discard-confirm, Android back,
  FlatList animations, load-error-only-when-empty).
- Mobile is local-first: a capture made offline survives relaunch and syncs on
  reconnect (device-verified on a fresh EAS build); or, if shipped reads-only, that
  deferral is recorded.
- Mobile tests green via the in-memory fallback (no op-sqlite mock); typecheck +
  lint green; `expo export` bundles; mobile bundle delta recorded.
- Web behavior and bundle unchanged; agent-core + web checks green.
- Backend unchanged; no Postgres.
