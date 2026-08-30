// The GTD Captures list, standalone from the agent's Store on purpose so it does
// not widen the agent's interface.

import { asc, eq, isNull, type Database } from "do-orm";

import { captures } from "../UserDO/db/schema";

export interface Capture {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
}

// Project a stored row back to the client-facing Capture shape.
function toCapture(row: {
  id: string;
  text: string;
  createdAt: string;
  processedAt: string | null;
}): Capture {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
  };
}

export class DbCaptureStore {
  constructor(private db: Database) {}

  // The client mints the capture id, so the add is exactly-once on the id alone:
  // a replay (a retried write after a lost ACK) re-sends the same id and gets the
  // already-stored row back instead of inserting a second one.
  add(id: string, text: string): Capture {
    const existingById = this.db.get(captures, { where: eq("id", id) });
    if (existingById) return toCapture(existingById);
    const capture: Capture = {
      id,
      text,
      createdAt: new Date().toISOString(),
      processedAt: null,
    };
    this.db.insert(captures, capture);
    return capture;
  }

  // Captures are the rows where processedAt IS NULL, oldest first.
  list(): Capture[] {
    return this.db
      .all(captures, {
        where: isNull("processedAt"),
        orderBy: asc("createdAt"),
      })
      .map(toCapture);
  }

  // Returns the updated row, or null when no row has that id.
  process(id: string): Capture | null {
    this.db.update(
      captures,
      { processedAt: new Date().toISOString() },
      { where: eq("id", id) },
    );
    const row = this.db.get(captures, { where: eq("id", id) });
    return row ? toCapture(row) : null;
  }
}
