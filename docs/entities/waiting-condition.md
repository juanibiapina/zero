# Waiting condition

The fourth entity of the todo app expresses why work is unavailable. A waiting
condition attaches to a **Project**. Ordinary conditions produce the soft
**Waiting** status when no arrived task overrides them. The project-status/Done
subset is a hard project-completion dependency and produces **Blocked**.
Introduced in slice 6 of `docs/plans/todo-availability-model.md`.

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
- **Project-completion dependency** — a `project-status` condition with
  `targetStatus: "done"`; `projectId` is the dependent and `refId` is the
  prerequisite.
- **Open** — `resolvedAt IS NULL`.
- **Satisfied** — whether a condition is currently met (`conditionSatisfied`).
  Free-text resolution and project-completion settlement persist `resolvedAt`.
  Other structured conditions remain dynamically satisfied from their referent.

## Data shape

`waiting_conditions` table in the per-user `UserDO` (migration 0049). Client type
`WaitingCondition` (`@zero/agent-core`): `id` (client-minted UUID), `projectId`,
`kind`, `text`, `refId`, `targetStatus`, `resolvedAt`, `createdAt`. Partial index
`waiting_conditions_open` on `("projectId") WHERE "resolvedAt" IS NULL`.

## Behavior

- **Add** a condition to a project (client mints the id; exactly-once on it).
- **List** the open conditions (across projects; the client filters by project).
- **Resolve** a free-text condition (sets `resolvedAt`; drops it from the open
  list).
- **Depend on Project completion** through a validated convenience verb. The
  directed graph rejects self, duplicate, missing, Done-target, and cyclic edges.
- **Settle Project completion** when the prerequisite becomes Done. The server
  sets `resolvedAt` before the Done project leaves working collections and keeps
  the first timestamp on retries.
- **Delete** a condition (idempotent on the id). Deleting either Project removes
  relationship rows that would otherwise dangle.

## Derivation (where the logic lives)

Project-completion dependencies are interpreted by the shared dependency module.
An in-play Project with one or more unresolved dependencies is Blocked before
arrived tasks, ordinary conditions, or future dates are considered. Every task
in that Project stays off Home while blocked; dates remain unchanged and take
effect when the final relationship settles or is removed.

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

- **UI** — project-completion rows appear under **Depends on** as navigable
  Project identities with a separate Remove action. Every other condition stays
  under **Waiting on**; free-text has Resolve, and historical structured rows
  retain automatic presentation. Mobile creates completion dependencies from
  the status sheet and creates free-text waits from the plus drawer. Web creates
  completion dependencies through the builder's **Project completion** branch,
  which has only an eligible prerequisite picker. A derived task date is not a
  waiting-condition row on mobile.
- **Storage** — `DbWaitingConditionStore` owns ordinary writes plus completion
  edge listing, canonical dependency insertion, idempotent terminal settlement,
  and deletion by owner or referenced prerequisite. See `docs/storage.md`.
- **API** — per-user isolated: `GET /api/waits`, `POST /api/waits`,
  `POST /api/waits/{id}/resolve`, `DELETE /api/waits/{id}` (204, idempotent). Logs
  `waiting_condition_added` / `_resolved` / `_deleted`.
- **Data layer** — `createWaitsApi` (`@zero/agent-core`) exposes
  `dependOnProject` while retaining `addWaitingCondition` as the durable mutation
  name. Resolve and delete retain their existing durable verbs; every row with a
  non-null `resolvedAt` leaves the open collection.
- **Other entities** — attaches to **Project** (blocks it) and references a
  **Task** (`task-done`) or another **Project** (`project-status`). The AI
  resolving a free-text condition from content is a later slice.

## Next

- AI-resolve a free-text condition from email/calendar/content.
- Other structured-kind creation on mobile; project completion is now available.
