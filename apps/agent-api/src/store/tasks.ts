// Tasks: the single list of the todo app (the Todoist replacement) and the
// app's entry point. A loose task (NULL projectId) is a quick capture; a project
// task belongs to a Project. Standalone from the agent's Store on purpose so it
// does not widen the agent's interface. do-orm is the shared layer; a store
// holds only domain verbs (see docs/storage.md).
//
// This store absorbed the former DbCaptureStore in the single-list merge
// (migration 0051): it owns the nullable show-up date, the manual sort key +
// drag reorder, and the backfill that keyed legacy rows. See
// docs/plans/todo-single-list-1-merge.md.

import { asc, desc, eq, isNull, type Database } from "do-orm";
import { generateKeyBetween } from "fractional-indexing";

import { tasks } from "../UserDO/db/schema";

export interface Task {
  id: string;
  text: string;
  // Local day (YYYY-MM-DD) the task should show up on, or null for a loose,
  // always-relevant task. Minted by the client, so it is the user's local day;
  // the DO has no timezone. The shown-up split (showUpDate == null || <= today)
  // runs client-side against the user's local today.
  showUpDate: string | null;
  createdAt: string;
  completedAt: string | null;
  // The Project this task belongs to, or null when the task is loose.
  projectId: string | null;
  // When the user took this task on (curated it onto Home), or null when parked.
  takenOnAt: string | null;
  // The capture this task was refined from, or null. Dormant after the merge.
  sourceCaptureId: string | null;
  // Fractional-index sort key for the manual list order, or null (unkeyed,
  // sorts last). In practice every stored row is keyed (add mints, reorder sets,
  // backfill keys legacy rows on DO init); null is only a transient
  // pre-backfill state. See schema.ts / migration 0051.
  sortKey: string | null;
}

// Project a stored row back to the client-facing Task shape.
function toTask(row: {
  id: string;
  text: string;
  showUpDate: string | null;
  createdAt: string;
  completedAt: string | null;
  projectId: string | null;
  takenOnAt: string | null;
  sourceCaptureId: string | null;
  sortKey: string | null;
}): Task {
  return {
    id: row.id,
    text: row.text,
    showUpDate: row.showUpDate,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    projectId: row.projectId,
    takenOnAt: row.takenOnAt,
    sourceCaptureId: row.sourceCaptureId,
    sortKey: row.sortKey,
  };
}

// The manual list order: by sortKey ascending, NULLs last, createdAt ascending
// as the tiebreak. sortKey is compared by raw codepoint (not localeCompare):
// fractional-indexing's base-62 charset (0-9A-Za-z) sorts by ASCII order, but
// localeCompare folds case (A ≈ a) and would corrupt the key sequence. The
// createdAt tiebreak keeps localeCompare (ISO strings are digit-only). This is
// the SAME rule as agent-core's compareByOrder (duplicated, not imported, so
// agent-api gains no build coupling to the browser/RN package) — keep the two
// in lockstep. NULLs sort last here too so a stray/legacy unkeyed row degrades
// gracefully (falls to the bottom) instead of misordering.
function byOrder(a: Task, b: Task): number {
  if (a.sortKey == null && b.sortKey == null) {
    return a.createdAt.localeCompare(b.createdAt);
  }
  if (a.sortKey == null) return 1;
  if (b.sortKey == null) return -1;
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt);
}

export class DbTaskStore {
  constructor(private db: Database) {}

  // The client mints the task id, so the add is exactly-once on the id alone: a
  // replay (a retried write after a lost ACK) re-sends the same id and gets the
  // already-stored row back instead of inserting a second one. `showUpDate`
  // defaults to null (a loose quick-capture has no day); the sort key is minted
  // trailing so the new task appends to the bottom of the manual order.
  add(
    id: string,
    text: string,
    showUpDate: string | null = null,
    projectId: string | null = null,
    takenOnAt: string | null = null,
    sourceCaptureId: string | null = null,
  ): Task {
    const existingById = this.db.get(tasks, { where: eq("id", id) });
    if (existingById) return toTask(existingById);
    const max = this.db.get(tasks, { orderBy: desc("sortKey") });
    const task: Task = {
      id,
      text,
      showUpDate,
      createdAt: new Date().toISOString(),
      completedAt: null,
      projectId,
      takenOnAt,
      sourceCaptureId,
      sortKey: generateKeyBetween(max?.sortKey ?? null, null),
    };
    this.db.insert(tasks, task);
    return task;
  }

  // All open tasks (completedAt IS NULL), in manual order. Future-dated rows are
  // included: the client splits the open set into Home (shown up) and Upcoming
  // (future-dated) against its own local day, so the shown-up split is a client
  // concern and the server returns the whole open list.
  list(): Task[] {
    return this.db
      .all(tasks, {
        where: isNull("completedAt"),
        orderBy: asc("createdAt"),
      })
      .map(toTask)
      .sort(byOrder);
  }

  // Take a task on (takenOnAt = a timestamp) or park it (takenOnAt = null). One
  // verb carries both; idempotent on the id, so a replayed offline write is
  // safe. Returns the updated row, or null when no row has that id.
  setTakenOn(id: string, takenOnAt: string | null): Task | null {
    this.db.update(tasks, { takenOnAt }, { where: eq("id", id) });
    const row = this.db.get(tasks, { where: eq("id", id) });
    return row ? toTask(row) : null;
  }

  // Returns the updated row, or null when no row has that id.
  complete(id: string): Task | null {
    this.db.update(
      tasks,
      { completedAt: new Date().toISOString() },
      { where: eq("id", id) },
    );
    const row = this.db.get(tasks, { where: eq("id", id) });
    return row ? toTask(row) : null;
  }

  // The inverse of complete: clear completedAt so the task returns to the open
  // list. Backs the Home task-complete Undo. Idempotent on the id; returns the
  // updated row, or null when no row has that id.
  reopen(id: string): Task | null {
    this.db.update(tasks, { completedAt: null }, { where: eq("id", id) });
    const row = this.db.get(tasks, { where: eq("id", id) });
    return row ? toTask(row) : null;
  }

  // Replace a task's text. Same-key idempotent update (the client-minted id is
  // the primary key), so a replayed edit re-applies the same text harmlessly.
  // Returns the updated row, or null when no row has that id.
  editText(id: string, text: string): Task | null {
    this.db.update(tasks, { text }, { where: eq("id", id) });
    const row = this.db.get(tasks, { where: eq("id", id) });
    return row ? toTask(row) : null;
  }

  // Set (or clear, with null) a task's show-up date. Same-key idempotent update
  // on the stable id. A future date parks the task in Upcoming; null makes it
  // loose (always relevant) again. Returns the updated row, or null when no row
  // has that id.
  reschedule(id: string, showUpDate: string | null): Task | null {
    this.db.update(tasks, { showUpDate }, { where: eq("id", id) });
    const row = this.db.get(tasks, { where: eq("id", id) });
    return row ? toTask(row) : null;
  }

  // Move a task into a project (projectId = a uuid) or back to loose (null).
  // Moving INTO a project also clears takenOnAt in the same update: a loose task
  // is always on Home, but once it belongs to a project it must obey the
  // project's curation gate (taken-on + active) rather than silently staying on
  // Home, so filing it parks it. Moving OUT to loose leaves takenOnAt untouched
  // (a loose task ignores it). Same-key idempotent update on the stable id;
  // returns the updated row, or null when no row has that id.
  setProject(id: string, projectId: string | null): Task | null {
    this.db.update(
      tasks,
      projectId != null ? { projectId, takenOnAt: null } : { projectId },
      { where: eq("id", id) },
    );
    const row = this.db.get(tasks, { where: eq("id", id) });
    return row ? toTask(row) : null;
  }

  // Set a task's manual sort key. Same-key idempotent update on the stable id.
  // The client mints the key strictly between the drop position's two neighbors,
  // so this only writes the moved row. Returns the updated row, or null when no
  // row has that id.
  reorder(id: string, sortKey: string): Task | null {
    this.db.update(tasks, { sortKey }, { where: eq("id", id) });
    const row = this.db.get(tasks, { where: eq("id", id) });
    return row ? toTask(row) : null;
  }

  // Delete every task belonging to a project, open or completed. Called when the
  // project itself is deleted (the cascade lives in UserDO.deleteProject, the
  // composition root that holds every store), so a project delete never leaves
  // orphaned tasks pointing at a missing project. A completed task is deleted
  // too: it is just as orphaned. Idempotent — a project with no tasks deletes 0.
  // Returns the number of rows removed.
  deleteByProject(projectId: string): number {
    const rows = this.db.all(tasks, { where: eq("projectId", projectId) });
    if (rows.length > 0) {
      this.db.delete(tasks, { where: eq("projectId", projectId) });
    }
    return rows.length;
  }

  // One-shot backfill of sort keys for rows that predate the column (sortKey IS
  // NULL). Assigns sequential fractional keys in createdAt order, so the list's
  // manual order starts out matching the old oldest-first order. Idempotent:
  // after the first run no NULL rows remain, so a second call is a cheap empty
  // select. Called from the UserDO constructor's init block. Keys every NULL
  // row regardless of completedAt, so a reopened task already has a key.
  backfillSortKeys(): void {
    const rows = this.db.all(tasks, {
      where: isNull("sortKey"),
      orderBy: asc("createdAt"),
    });
    let prev: string | null = null;
    for (const row of rows) {
      prev = generateKeyBetween(prev, null);
      this.db.update(tasks, { sortKey: prev }, { where: eq("id", row.id) });
    }
  }
}
