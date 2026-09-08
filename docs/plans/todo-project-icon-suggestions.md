# AI icon suggestions for a Project

Status: plan, nothing built. The **first AI integration of the todo app**:
suggest emoji icons for a Project from its title and description. Suggestions are
generated automatically in the background when a project is created and cached on
the client, so by the time the user opens the icon picker they are already there
— no button, no wait in the common case.

## Goal

When a user creates a project, the app fires a background request for emoji icon
suggestions and caches them on the device. When the user opens the icon picker,
a suggested row is already populated (or shows a brief "Loading suggested
icons…" if the request is still in flight); tapping a suggestion applies it. A
Refresh control recomputes suggestions after the title or description changes.
The manual emoji picker stays exactly as it is; suggestions are an additive,
pre-warmed shortcut sitting above it.

This is deliberately the smallest useful AI feature: read-only (the model reads
two strings and returns emoji, it writes no entities), one model call, no tool
loop, no chat, and — by caching on the client — **no new server-side state**. It
proves the todo app's first server-side LLM path end to end so heavier features
(Capture → Project, see `docs/plans/todo-capture-to-project-ai.md`) build on a
known-good seam.

## Background a fresh agent needs

- **Project** is entity #3 of the todo app, hand-managed, slice A complete. It
  has `title`, an `icon` (single emoji, default 📁), a nullable `description`,
  and a status. Source of truth: `docs/entities/project.md`. The icon is edited
  today from the project detail screen through a full emoji picker (web
  `frimousse`, mobile `rn-emoji-keyboard`) that commits via the `edit` verb.
- **Create is name-only.** A project is created fast with just a title (like a
  Capture); the description is added later on the detail screen. So the
  create-time suggestion runs on the **title alone** — see the decisions below.
- **The icon edit path already exists.** `DbProjectStore.edit` +
  `PATCH /api/projects/{id}` carry `{ icon }`; the client verb is `editProject`
  in `createProjectsApi` (`packages/agent-core/src/projects/collection.ts`),
  offline-replaying. Applying a suggested emoji reuses this path unchanged — a
  suggestion is just a value fed into the existing `edit`.
- **The create path.** A project is added through `createProjectsApi`'s `add`
  (mints a UUID id, optimistic insert, offline outbox). The create-time
  suggestion fire hangs off this moment on the client.
- **The LLM seam.** Every model call goes through the `AgentModel` port
  (`apps/agent-api/src/agents/protocol.ts`): one method,
  `generate(request) → response`. Build one with
  `createModel(env, clerkUserId, agent)` (`agents/model.ts`), which tags the call
  for AI-Gateway per-user cost attribution (`cf-aig-metadata`). Tests use
  `scriptedModel` / `capturingModel` from `agents/mock-model.ts` — no network.
- **`runAgent` is for tool loops** (interface, learner, onboarding). Icon
  suggestion is a single structured request, so it calls `model.generate`
  directly and does **not** use `runAgent`.
- **The model** is `env.MODEL_ID` (`gpt-5.6-luna`, OpenAI Responses). Every agent
  runs at `DEFAULT_EFFORT = high`, which `agents/model.ts` flags as load-bearing
  for agent *quality*. Icon suggestion is a trivial mapping task, not an agent
  turn, so it should run at **low** effort for latency and cost (see decision
  below).
- **Client persistence already exists per surface** for the entity collections
  (web OPFS via `lib/db.ts`; mobile SQLite). The suggestion cache is a separate,
  tiny keyed store — it is not an entity collection (see below).
- Routes live in `apps/agent-api/src/routes/*.ts`, per-user isolated behind the
  `userId` variable, delegating to the per-user `UserDO`. The projects route is
  `routes/projects.ts`.

## Architecture: where suggestions live

Suggestions are an **ephemeral client-side hint, not entity data**. They are
computed by a stateless server endpoint and cached on the device that asked; the
server stores nothing and nothing syncs across devices. Consequences, all
accepted on purpose:

- The **fast path** is create-time pre-warming on the creating device: by the
  time the picker opens the suggestions are cached and shown instantly.
- The **fallback path** is fetch-on-open: if the cache is empty when the picker
  opens (a different device, an eviction, an offline creation), the picker fires
  the same endpoint then and shows the loading state. Same endpoint, both paths.
- Suggestions **do not sync**. Create on mobile, warm on mobile; open on web and
  it fetches on open. This keeps the backend stateless — the whole point of the
  client-cache design. Storing suggestions on the project row (so they sync)
  would add a column and a recompute policy for a marginal gain; rejected.

## What to change

### Server (essentially the click-version plan; unchanged by the auto trigger)

The trigger and cache are client concerns; the server is the same stateless
endpoint either path calls.

1. **The AI seam.** New deep module `suggestProjectIcons(model: AgentModel,
   input: { title: string; description?: string | null }, opts?: { count?:
   number }): Promise<string[]>` in `apps/agent-api/src/agents/icon-suggest.ts`.
   Fixed system prompt asks for a JSON array of exactly-emoji strings that fit a
   project with the given title and description, no prose. One `model.generate`
   call with the title/description in the user message. Parse the response:
   `JSON.parse` first, then a lenient fallback extracting emoji grapheme clusters
   (`Intl.Segmenter`). Validate single-emoji, drop non-emoji, dedupe, cap at
   `count` (default 6). Any parse failure or empty result returns `[]` (never
   throws). The LLM is true-external behind the injected `AgentModel` port, so
   parsing is unit-tested with a mock adapter, no network.

2. **A new agent label at low effort.** Add `icon_suggest` to the `AgentLabel`
   union in `agents/model.ts` for separate gateway cost attribution. Run at
   **low** effort via a new `AGENT_EFFORT_OVERRIDES: Partial<Record<AgentLabel,
   Effort>>` map mirroring `AGENT_MODEL_OVERRIDES`, read by `resolveModelSpec`
   (falling back to `DEFAULT_EFFORT`), leaving every existing agent at `high`.

3. **A stateless endpoint.** `POST /api/projects/icon-suggestions { title,
   description? }` → `200 { icons: string[] }`; `400` on empty title. Stateless
   on purpose — it takes the two strings, reads/writes no `projects` row, so it
   is a plain route, not a TanStack DB collection verb. The handler builds the
   model with `createModel(env, userId, "icon_suggest")` and calls
   `suggestProjectIcons`. A module `[]` still responds `200 { icons: [] }` (a
   soft miss); only an unexpected throw is `500`. Logs `project_icon_suggested`
   with the user id and count.

### Client: the suggestion cache and trigger (the new part)

- **A tiny per-surface suggestion cache**, keyed by project id, holding
  `{ icons: string[]; basis: { title: string; description: string | null };
  status: "loading" | "ready" | "error" }`. Persisted on the device (web:
  `localStorage`/OPFS; mobile: `AsyncStorage`/SQLite) so it survives reloads and
  is available offline. It is **not** an entity collection — no sync, no outbox,
  no server row — just a keyed hint store. The persistence lives per surface
  (like `screen-hooks`); the pure staleness check
  (`isBasisStale(cached.basis, { title, description })`) lives in
  `@zero/agent-core`.
- **Fire on create.** Right after `add` mints the project (title only, no
  description yet), fire a fire-and-forget request, write `status: "loading"`,
  then fill `icons` + `status: "ready"` (or `"error"`) when it lands. Fire
  **once** per create; never auto-refire on edits or opens. **Reaching the minted
  id:** `api.add(title)` returns a `Transaction`, and the id is minted inside the
  collection verb (`collection.insert(mintRow(...))` in `collection/base.ts`), so
  it is not a return value — read it off `tx.mutations[0].key` at the create call
  site (`ProjectsPage.onAdd` on web, `projects/index.tsx` on mobile) to key the
  cache write.
- **Fetch-on-open fallback.** When the picker opens and the cache has no entry
  for this project, fire the same request then (covers cross-device, eviction,
  and offline-at-creation). Identical loading/ready/error handling.

### Client: web (slice 1 surface)

In `apps/agent-web/src/pages/ProjectDetailPage.tsx`, add a **suggested row** at
the top of the icon picker popover (above the full `frimousse` picker):

- `status: "ready"` → a row of tappable emoji chips. Tapping applies via the
  existing `onEdit(project.id, { icon })` and closes the popover.
- `status: "loading"` → an inline "Loading suggested icons…".
- No entry / `status: "error"` → the row is omitted (or a soft "Couldn't load
  suggestions" line); the full manual picker below is always present and usable.
- A small **Refresh** control (↻) in the row recomputes with the current title +
  description; shown especially when `isBasisStale` is true (the description was
  edited since the cached run). Refresh re-fires the same endpoint and updates the
  cache.
- The create-time fire hangs off the existing web create flow (a new plain fetch
  helper in `apps/agent-web/src/lib/projects.ts`, same-origin cookie auth; not
  part of `ProjectsRest`, since it is not a collection mutation).

### Client: mobile (slice 2 surface)

Mirror on the mobile project detail screen (the pushed screen within the Projects
tab; see `docs/plans/todo-project-detail-rework.md`). Same suggested row inside
the mobile icon picker, same create-time fire off the mobile create flow, same
per-device cache (`AsyncStorage`/SQLite), Refresh, and fetch-on-open fallback.
The fetch helper goes in `apps/agent-mobile/src/lib/api.ts` (Clerk Bearer auth).
Applying reuses the mobile `editProject`. Reuses existing RN/`@expo/ui`
primitives, so first on-device run needs a fresh EAS dev build only if a new
native component is introduced.

## Slicing

- **Slice 1 — server + web (cache, create-time fire, suggested row).** Ships
  value on web alone and iterates fast (no EAS rebuild). Web-first matches the
  project's established pattern.
- **Slice 2 — mobile.** Reuses the slice-1 server endpoint and the shared
  `@zero/agent-core` staleness helper unchanged.

## Decisions already made

- **Auto-suggest at create, cached on the client — not a click.** Suggestions
  are pre-warmed on create so the picker shows them instantly; the click/fetch is
  only the cache-miss fallback. Better UX and it keeps the server stateless.
- **Create-time suggestion runs on title alone.** Create is name-only, so there
  is no description yet. The description-based refinement is the **Refresh**
  control once a description exists (the picker flags a stale basis).
- **Suggestions are an ephemeral client hint; they do not sync.** Per-device
  warming with fetch-on-open elsewhere. Rejected: storing suggestions on the
  project row to sync them (adds a column + recompute policy for marginal gain).
- **Fire once per create; refire only on explicit Refresh.** Projects are created
  rarely, and one low-effort call per create is cheap, so eager firing is a good
  trade; never auto-refire on every edit or open.
- **Stateless endpoint (title/description), not project-scoped.** Both paths
  (create-time and fetch-on-open) call the same endpoint; it depends on no stored
  state and is reusable at creation.
- **Direct `model.generate`, not `runAgent`.** One structured call, no tools, no
  conversation.
- **Model reads the whole emoji space, no curated allow-list.** The stored `icon`
  stays a single emoji string, so any returned emoji is a valid icon.
- **Agent stays read-only; the app applies the pick.** The human tap is the
  write, reusing `editProject`. Matches the fork in
  `todo-capture-to-project-ai.md`.
- **`low` effort via a new effort-override map.** Trivial task; `high` wastes
  latency and money. The map keeps existing agents at `high`.
- **Soft failure, never a lost-work error.** A missed or failed suggestion loses
  nothing (the manual picker remains), so it is logged, not reported as a
  ZeroErrors issue (`docs/error-reporting.md` reserves issues for failures the
  user felt or lost work).

## Test strategy

- **Module (`suggestProjectIcons`)** with `scriptedModel`: a clean JSON array
  parses and caps at `count`; a fenced / prose-wrapped response falls back to
  emoji extraction; non-emoji tokens are dropped; duplicates deduped; garbage and
  empty responses return `[]`. `capturingModel` asserts the title and description
  reach the request.
- **Effort override (`model.ts`)** unit test mirroring the existing
  `AGENT_MODEL_OVERRIDES`/`resolveModelSpec` tests: `resolveModelSpec` returns
  `low` for `icon_suggest` and `high` (`DEFAULT_EFFORT`) for every other label.
  This is the guard the file itself flags as load-bearing (a silent effort drop
  is a silent quality drop).
- **Staleness helper (`isBasisStale`)** pure unit tests in `@zero/agent-core`:
  same title/description not stale; changed description stale; null vs "" handled.
- **Route** (`routes/projects.test.ts` style): `200 { icons }` with a mocked
  suggestion, `400` on empty title, per-user auth; a model that returns nothing
  still yields `200 { icons: [] }`.
- **Web page** (`ProjectDetailPage` Vitest + Testing Library): create fires the
  suggestion request; the picker shows the loading state while in flight and chips
  when ready; tapping a chip calls `onEdit` with that emoji; Refresh re-fires;
  fetch-on-open fires when the cache is empty; a failure leaves the manual picker
  present.
- **Mobile screen** (project detail test, mocked fetch): the same create-fire →
  cache → picker states → apply → refresh → fetch-on-open flow.

## Documentation

- `docs/entities/project.md` — add an **AI icon suggestion** interaction under
  Interactions: created automatically at project creation, cached per device,
  shown in the icon picker, applied through the existing `edit` path; note the
  stateless endpoint. Also correct the stale A3 wording "curated emoji icon
  picker" — the shipped picker is the full `frimousse` (web) /
  `rn-emoji-keyboard` (mobile) picker this feature sits above.
- `docs/todo-app.md` — record the first AI integration under Project tracking /
  the entity wiki, and the new server LLM path.
- Changelogs (each surface it reaches, per `AGENTS.md`):
  - `apps/agent-web/CHANGELOG.md` for slice 1.
  - `apps/agent-mobile/CHANGELOG.md` for slice 2.
  - Not `apps/agent-api/CHANGELOG.md`: this is a todo-app surface change, not a
    Zero-agent-user change.

## Skills to use

- `tdd` — for the suggestion module and the staleness helper (both pure once the
  model port is mocked) and the route.
- `testing` — deciding the mock adapter at the `AgentModel` seam and asserting on
  observable output, not internals.
- `changelog` — before editing either surface changelog.
- `git-commit` — commit each slice with its code, tests, docs, and changelog
  together.
- `reproducible-locally` — verify slice 1 with the web page test and the route
  test (this box has no workerd; run the agent-api package tests directly per
  `AGENTS.md`); verify slice 2 on the Pixel 7 with Maestro.
- `open-pr` — one PR per slice.

## Acceptance criteria

- Creating a project fires a background suggestion request; opening the icon
  picker shows the cached suggestions instantly, or "Loading suggested icons…"
  while in flight.
- Tapping a suggested emoji applies it through the existing edit path; Refresh
  recomputes after a title/description change; a cache miss fetches on open.
- `POST /api/projects/icon-suggestions` returns single-emoji `{ icons }` for a
  real title/description, `400` on empty title, and `{ icons: [] }` when the model
  returns nothing usable.
- A failed or empty suggestion degrades to the manual picker with no blocking;
  gateway logs attribute the call under `icon_suggest` at `low` effort.
- The suggestion module and staleness helper are unit-tested at their interfaces;
  the route and both surfaces have tests; docs and per-surface changelogs updated
  in the same change.

## Risks and mitigations

- **Eager firing costs one call per project created, opened or not.** Mitigated
  by firing once and caching; projects are created rarely and the call is
  low-effort and cheap, so volume is tiny.
- **Cross-device / offline gaps in the client cache.** Mitigated by the
  fetch-on-open fallback: a missing cache never means "no suggestions," just "warm
  on open." Accepted that suggestions do not sync.
- **Emoji parsing robustness** (models wrap JSON in prose or fences). Mitigated by
  the JSON-first, grapheme-extraction-fallback parser and single-emoji validation,
  all unit-tested; anything unparseable degrades to `[]`.
- **Latency of the create-time call vs. opening the picker immediately.**
  Mitigated by the in-picker loading state; `low` effort and a tiny prompt keep it
  to a second or two.
- **Scope creep toward the full Capture → Project feature.** Kept out: no entity
  writes, no chat, no tools. This feature is only "two strings in, emoji out,
  cached on the client."
