// Tasks: the Today list for the parallel todo app. A Task is a typed, clarified
// next-action with a day, distinct from a Capture (the untyped Inbox entry). It
// is standalone from the agent's Store on purpose so it does not widen the
// agent's interface, and separate from DbCaptureStore because the two entities
// have different verbs: a Capture is processed (clarified out), a Task is
// completed (done).

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
}

// Project a stored row back to the client-facing Task shape.
function toTask(row: {
  id: string;
  text: string;
  showUpDate: string;
  createdAt: string;
  completedAt: string | null;
}): Task {
  return {
    id: row.id,
    text: row.text,
    showUpDate: row.showUpDate,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

export class DbTaskStore {
  constructor(private db: Database) {}

  // The client mints the task id, so the add is exactly-once on the id alone: a
  // replay (a retried write after a lost ACK) re-sends the same id and gets the
  // already-stored row back instead of inserting a second one.
  add(id: string, text: string, showUpDate: string): Task {
    const existingById = this.db.get(tasks, { where: eq("id", id) });
    if (existingById) return toTask(existingById);
    const task: Task = {
      id,
      text,
      showUpDate,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    this.db.insert(tasks, task);
    return task;
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
}
