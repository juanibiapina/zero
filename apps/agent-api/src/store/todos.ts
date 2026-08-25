// The todo capture list, backed by do-orm over the UserDO's SQLite. Kept
// separate from the agent's Store on purpose: todos are the parallel todo app's
// own concern (see the Todoist-replacement plan), so they do not widen the
// agent's interface.

import { asc, type Database } from "do-orm";

import { todos } from "../UserDO/db/schema";

export interface Todo {
  id: string;
  text: string;
  createdAt: string;
}

export class DbTodoStore {
  constructor(private db: Database) {}

  // Append a captured item. `id` is a UUID so the client never mints ids;
  // `createdAt` doubles as the list order.
  add(text: string): Todo {
    const todo: Todo = {
      id: crypto.randomUUID(),
      text,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(todos, todo);
    return todo;
  }

  // The open list, oldest first (capture order).
  list(): Todo[] {
    return this.db.all(todos, { orderBy: asc("createdAt") });
  }
}
