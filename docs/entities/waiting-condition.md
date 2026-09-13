# Waiting condition

The fourth entity of the todo app, and the first that expresses *why* something
is blocked. A waiting condition attaches to a **Project** and answers "what is
this project waiting on". Any unresolved condition makes the project display as
`waiting` and hides its tasks from Today. Introduced in slice 6 of
`docs/plans/todo-availability-model.md`.

This file is the source of truth for the waiting condition; keep it current as
the entity grows.

## Why it is its own entity (not a `blockedReason` string on Project)

A plain string could not: carry **more than one** reason, be **resolved in code**
for the structured cases, or later **attach to other entities**. A condition is a
row with a typed `kind`, an optional reference, and a resolved state — so the
model can settle the structured cases automatically and leave the prose to a
human or the AI. It attaches only to **Project** today (the Minecraft whitelist:
when the block is introduced, its allowed connections are chosen deliberately;
extend the list when a new target makes sense in the UI).

## Vocabulary

- **Waiting condition** — the item (table `waiting_conditions`, type
  `WaitingCondition`).
- **Kind** — one of:
  - `free-text` — a prose condition ("the letter comes back"). Resolved by hand
    or the AI (sets `resolvedAt`).
  - `task-done` — `refId` is a task id; **code**-satisfied when that task is
    completed.
  - `project-status` — `refId` is a project id, `targetStatus` the status it must
    reach; **code**-satisfied when it does.
- **Open** — `resolvedAt IS NULL`. Structured kinds stay open in storage and are
  *derived-satisfied* on the client; only free-text persists `resolvedAt`.
- **Satisfied** — whether a condition is currently met (`conditionSatisfied`);
  the free-text principle in one function — code settles the structured kinds, a
  human/AI settles the prose.

## Data shape

`waiting_conditions` table in the per-user `UserDO` (migration 0049). Client type
`WaitingCondition` (`@zero/agent-core`): `id` (client-minted UUID), `projectId`,
`kind`, `text`, `refId`, `targetStatus`, `resolvedAt`, `createdAt`. Partial index
`waiting_conditions_open` on `("projectId") WHERE "resolvedAt" IS NULL`.

## Behavior

- **Add** a condition to a project (client mints the id; exactly-once on it).
- **List** the open conditions (across projects; the client filters by project).
- **Resolve** a free-text condition (sets `resolvedAt`; drops it from the open
  list). Structured kinds are not resolved by hand; they clear when their
  referent changes.
- **Delete** a condition (idempotent on the id).

## Derivation (where the logic lives)

`projectDisplayStatus`, `conditionSatisfied`, and `unresolvedConditions` live in
one module (`packages/agent-core/src/projects/derive.ts`) because a
`project-status` condition asks for another project's status, so they are
mutually recursive; the condition check compares against a project's *base*
status (active/next/backlog/done, ignoring waiting) to keep that finite. A
project with an unresolved condition displays `waiting` **only when nothing is
dated-and-arrived**: a shown-up dated open task makes the project display `active`
even with an open condition (dating a task overrides waiting — the date is the
sole commitment gate, see `docs/plans/todo-retire-take-on.md`). So the order is
active (shown-up dated open task) → waiting (open condition, nothing dated) →
next. Completing that task drops the project back to waiting, not next, because
the condition is still open. `homeTasks` gates on that derived status: a waiting
project's tasks leave Home, and dating one brings it (and the task) back.

The oldest unresolved condition also fixes **how long the project has been
waiting**: `waitingSince` (same module) returns that condition's `createdAt`, and
the Projects list turns it into a readable badge (`waitingLabel`, e.g. "3 days")
and orders the Waiting section longest-first. Resolving or code-satisfying a
condition drops it from the set, so the badge and order always match the derived
`waiting` status.

### Derived date wait (no stored condition)

A project can also display `waiting` with **no** `waiting_conditions` row: when it
holds a future-dated open task, it waits until that task's day.
`waitingUntil` (same module) returns the soonest such `showUpDate`, and
`projectDisplayStatus` reads `waiting` when it is set and nothing is
active/otherwise-waiting. The day the task's date arrives it becomes shown-up,
which makes the project `active` again — no row is written or resolved on either
transition. This is deliberately **not** a `date`-kind condition: the status is
already computed from the tasks, so a stored row would duplicate state that
desyncs when the task is completed or re-postponed, and "which date" is ambiguous
with several postponed tasks. Conditions remain only for reasons that are *not* a
task date (`free-text` / `task-done` / `project-status`). The Projects list badges
a date wait "until <day>" (via `waitingBadge`, which folds both wait kinds into
one label + sort key: elapsed time for a condition wait, the target day for a date
wait). On mobile project detail, the status reads `Waiting · until <day>` and the
source task reads `Scheduled · <day>`; **Waiting on** stays reserved for actual
conditions. Web still shows the derived day as an automatic row because its task
list presents scheduling through inline date controls. See
`docs/plans/todo-single-list-3-date-availability.md` and
`docs/plans/todo-project-task-list-clarity.md`.

## Interactions (per system)

- **UI** — the project screen's **Waiting-on** section lists the open condition
  entities (each with Resolve for free-text, or an "auto" tag for structured,
  and a delete). A derived task date is not one of these rows on mobile. Adding
  is behind a **"+" affordance**, not an inline form:
  mobile adds a **Waiting** mode to the project screen's plus FAB (beside Task),
  free-text only; web opens the builder in a **popover** from a "+" control,
  offering all three kinds (free-text + task/project pickers). Structured kinds
  stay web-first for now (still shown and auto-resolved on mobile).
- **Storage** — `DbWaitingConditionStore` (`add` / `listOpen` / `resolve` /
  `delete`), a per-entity store over do-orm. See `docs/storage.md`.
- **API** — per-user isolated: `GET /api/waits`, `POST /api/waits`,
  `POST /api/waits/{id}/resolve`, `DELETE /api/waits/{id}` (204, idempotent). Logs
  `waiting_condition_added` / `_resolved` / `_deleted`.
- **Data layer** — `createWaitsApi` (`@zero/agent-core`), a verb table
  (`addWaitingCondition` / `resolveWaitingCondition` / `deleteWaitingCondition`)
  over the shared collection factory; a resolved free-text condition leaves the
  open set (`leavesCollection`).
- **Other entities** — attaches to **Project** (blocks it) and references a
  **Task** (`task-done`) or another **Project** (`project-status`). The AI
  resolving a free-text condition from content is a later slice.

## Next

- AI-resolve a free-text condition from email/calendar/content.
- Structured-kind creation on mobile (web-first today).
