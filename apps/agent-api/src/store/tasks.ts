// Tasks: the Today list for the parallel todo app. A Task is a typed, clarified
// next-action with a day, distinct from a Capture (the untyped Captures entry). It
// is standalone from the agent's Store on purpose so it does not widen the
// agent's interface, and separate from DbCaptureStore because the two entities
// have different verbs: a Capture is processed (clarified out), a Task is
// completed (done). do-orm is the shared layer; a store holds only domain verbs
// (see docs/storage.md).

import { asc, eq, isNull, type Database } from "do-orm";

import { tasks } from "../UserDO/db/schema";

export interface Task {
  id: string;
  text: string;
  // Local date (YYYY-MM-DD) the task should show up on. Minted by the client, so
  // it is the user's local day; the DO has no timezone. The "due today" filter
  // (showUpDate <= today) runs client-side against the user's local today.
  showUpDate: string;
  createdAt: string;
  completedAt: string | null;
  // The Project this task belongs to, or null when the task is loose.
  projectId: string | null;
  // When the user took this task on (curated it onto Home), or null when parked.
  takenOnAt: string | null;
  // The capture this task was refined from, or null.
  sourceCaptureId: string | null;
}

// Project a stored row back to the client-facing Task shape.
function toTask(row: {
  id: string;
  text: string;
  showUpDate: string;
  createdAt: string;
  completedAt: string | null;
  projectId: string | null;
  takenOnAt: string | null;
  sourceCaptureId: string | null;
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
  };
}

export class DbTaskStore {
  constructor(private db: Database) {}

  // The client mints the task id, so the add is exactly-once on the id alone: a
  // replay (a retried write after a lost ACK) re-sends the same id and gets the
  // already-stored row back instead of inserting a second one.
  add(
    id: string,
    text: string,
    showUpDate: string,
    projectId: string | null = null,
    takenOnAt: string | null = null,
    sourceCaptureId: string | null = null,
  ): Task {
    const existingById = this.db.get(tasks, { where: eq("id", id) });
    if (existingById) return toTask(existingById);
    const task: Task = {
      id,
      text,
      showUpDate,
      createdAt: new Date().toISOString(),
      completedAt: null,
      projectId,
      takenOnAt,
      sourceCaptureId,
    };
    this.db.insert(tasks, task);
    return task;
  }

  // Take a task on (takenOnAt = a timestamp) or park it (takenOnAt = null). One
  // verb carries both; idempotent on the id, so a replayed offline write is
  // safe. Returns the updated row, or null when no row has that id.
  setTakenOn(id: string, takenOnAt: string | null): Task | null {
    this.db.update(tasks, { takenOnAt }, { where: eq("id", id) });
    const row = this.db.get(tasks, { where: eq("id", id) });
    return row ? toTask(row) : null;
  }

  // All open tasks (completedAt IS NULL), oldest first. The due-today date filter
  // is applied client-side (against the user's local today), so this returns
  // future-dated and overdue tasks alike.
  list(): Task[] {
    return this.db
      .all(tasks, {
        where: isNull("completedAt"),
        orderBy: asc("createdAt"),
      })
      .map(toTask);
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
}
