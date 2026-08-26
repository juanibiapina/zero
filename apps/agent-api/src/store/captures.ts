// The GTD capture Inbox, backed by do-orm over the UserDO's SQLite. Kept
// separate from the agent's Store on purpose: captures are the parallel todo
// app's own concern (the Todoist replacement), so they do not widen the agent's
// interface. A capture is raw, untyped text; Process removes it from the Inbox.

import { asc, eq, isNull, type Database } from "do-orm";

import { captures } from "../UserDO/db/schema";

export interface Capture {
  id: string;
  text: string;
  createdAt: string;
  // Null while in the Inbox; an ISO timestamp once Processed (GTD Clarify).
  processedAt: string | null;
}

export class DbCaptureStore {
  constructor(private db: Database) {}

  // Capture a new item into the Inbox. `id` is a UUID so the client never mints
  // ids; `createdAt` doubles as the Inbox order. New captures are open
  // (processedAt null).
  add(text: string): Capture {
    const capture: Capture = {
      id: crypto.randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      processedAt: null,
    };
    this.db.insert(captures, capture);
    return capture;
  }

  // The Inbox, oldest first (capture order). Processed rows stay in the table.
  list(): Capture[] {
    return this.db.all(captures, {
      where: isNull("processedAt"),
      orderBy: asc("createdAt"),
    });
  }

  // Process a capture (GTD Clarify): stamp processedAt so it leaves the Inbox.
  // Returns the updated row, or null when no row has that id.
  process(id: string): Capture | null {
    this.db.update(
      captures,
      { processedAt: new Date().toISOString() },
      { where: eq("id", id) },
    );
    const row = this.db.get(captures, { where: eq("id", id) });
    return row ?? null;
  }
}
