// The todo capture list, backed by do-orm over the UserDO's SQLite. Kept
// separate from the agent's Store on purpose: todos are the parallel todo app's
// own concern (see the Todoist-replacement plan), so they do not widen the
// agent's interface.

import { asc, eq, isNull, type Database } from "do-orm";

import { todos } from "../UserDO/db/schema";

export interface Todo {
  id: string;
  text: string;
  createdAt: string;
  // Null while open; an ISO timestamp once marked done.
  doneAt: string | null;
}

export class DbTodoStore {
  constructor(private db: Database) {}

  // Append a captured item. `id` is a UUID so the client never mints ids;
  // `createdAt` doubles as the list order. New items are open (doneAt null).
  add(text: string): Todo {
    const todo: Todo = {
      id: crypto.randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      doneAt: null,
    };
    this.db.insert(todos, todo);
    return todo;
  }

  // The open list, oldest first (capture order). Done rows stay in the table.
  list(): Todo[] {
    return this.db.all(todos, {
      where: isNull("doneAt"),
      orderBy: asc("createdAt"),
    });
  }

  // Mark a todo done. Returns the updated row, or null when no row has that id.
  markDone(id: string): Todo | null {
    this.db.update(
      todos,
      { doneAt: new Date().toISOString() },
      { where: eq("id", id) },
    );
    const row = this.db.get(todos, { where: eq("id", id) });
    return row ?? null;
  }
}
