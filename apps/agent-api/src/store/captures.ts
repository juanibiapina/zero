// The GTD capture Inbox, standalone from the agent's Store on purpose so it does
// not widen the agent's interface.

import { asc, eq, isNull, type Database } from "do-orm";

import { captures } from "../UserDO/db/schema";

export interface Capture {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
}

export class DbCaptureStore {
  constructor(private db: Database) {}

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

  // The Inbox is the rows where processedAt IS NULL, oldest first.
  list(): Capture[] {
    return this.db.all(captures, {
      where: isNull("processedAt"),
      orderBy: asc("createdAt"),
    });
  }

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
